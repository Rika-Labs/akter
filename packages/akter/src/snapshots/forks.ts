import { Clock, Context, Effect, Layer, Option, Result, Schema, Schedule, Stream } from "effect"
import type { AnyActor } from "../contract/make.ts"
import { Actions } from "../execution/action.ts"
import { CommandIds } from "../execution/command-ids.ts"
import { Durable } from "../execution/durable.ts"
import type { Catalog } from "../execution/durable.ts"
import { Engine } from "../execution/engine.ts"
import { Entry, EntryCodec } from "../execution/entries.ts"
import { Layouts } from "../execution/layout.ts"
import { Lists, PagedItems } from "../handlers/lists.ts"
import { PageCache, PageDocuments, PageTrees } from "../handlers/page-tree.ts"
import { Store } from "../store/service.ts"
import type { App } from "../runtime/app.ts"
import { Checkpoints } from "./checkpoint.ts"
import { PagedCheckpoints } from "./pages.ts"
import { PagePublicationBusy } from "../store/gc.ts"
import { authorizing } from "../runtime/operators/grants.ts"
import type { OperatorGrant } from "../runtime/operators/grants.ts"

/** A fork names a version, instant, or a fully qualified segment position, never a bare offset. */
export type ForkPosition =
  | { readonly version: number }
  | { readonly before: number }
  | { readonly offset: number; readonly index: number }

/** Why an operator fork did not install anything. */
export class ForkRefused extends Schema.TaggedError<ForkRefused>()("ForkRefused", {
  reason: Schema.Literals(["scope", "position", "retention", "source", "target"]),
}) {}

export interface ForkOptions {
  readonly actor: AnyActor
  readonly from: Schema.Json
  readonly to?: Schema.Json
  readonly at: ForkPosition
  readonly grant: OperatorGrant
  readonly tenant?: string
  readonly withWork?: boolean
}

const same = (left: Schema.Json, right: Schema.Json): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const forkOnce = (target: Engine, options: ForkOptions, source: Store["Service"] = target.store) =>
  Effect.gen(function* () {
    const { actor, from, at, grant } = options
    const tenant = options.tenant ?? "default"
    const capability = authorizing({
      grant,
      action: "fork",
      resource: { tenant, actorType: actor.name, actorId: from },
    })
    if (tenant !== "default" || Option.isNone(capability))
      return yield* ForkRefused.make({ reason: "scope" })
    if (
      ("version" in at && (!Number.isSafeInteger(at.version) || at.version < 0)) ||
      ("before" in at && !Number.isFinite(at.before)) ||
      ("offset" in at &&
        (!Number.isSafeInteger(at.offset) ||
          at.offset < 1 ||
          !Number.isSafeInteger(at.index) ||
          at.index < 0))
    )
      return yield* ForkRefused.make({ reason: "position" })
    const layout = Layouts.of(actor)
    layout.key.decode(from)
    const shard = Durable.shardOf(Durable.addressOf(actor.name, from), source.meta.shards)
    const catalog: Catalog = { ...target.catalog, shards: source.meta.shards }
    const now = yield* Clock.currentTimeMillis
    const cutoff = now - source.meta.retentionMillis
    const cache = new PageCache()
    const available = yield* source.history.checkpoints(shard)
    let base: ReturnType<typeof Checkpoints.capture> | undefined
    for (const retained of available) {
      const decoded = Result.getOrThrow(
        Checkpoints.decode(yield* PagedCheckpoints.read(retained.statePages[0]!, source)),
      )
      const snapshot = decoded.actors.find(
        (candidate) => candidate.actor === actor.name && same(candidate.key, from),
      )
      const suitable =
        "offset" in at
          ? decoded.offset < at.offset
          : "before" in at
            ? decoded.lastAt < at.before
            : snapshot === undefined || (snapshot.version ?? 0) <= at.version
      if (suitable && (base === undefined || decoded.offset > base.offset)) base = decoded
    }
    const image =
      base === undefined ? Durable.empty(shard) : Checkpoints.restore(catalog, base, cache)
    const start = base?.offset ?? 0
    const initial = image.actors.get(Durable.addressOf(actor.name, from))
    let position: (typeof Entry.cases.Forked.Type)["position"] | undefined =
      initial?.position === undefined
        ? undefined
        : {
            shard,
            offset: initial.position.offset,
            index: initial.position.index,
            version: initial.version,
          }
    let admittedAt = initial?.position?.at ?? 0
    const segments =
      "version" in at && position?.version === at.version
        ? []
        : yield* Stream.runCollect(source.history.read(shard, BigInt(start)))
    entries: for (const segment of segments) {
      for (const [index, bytes] of segment.entries.entries()) {
        const entry = Result.getOrThrow(EntryCodec.decode(bytes))
        const own =
          (Entry.guards.Action(entry) || Entry.guards.Seed(entry) || Entry.guards.Forked(entry)) &&
          entry.actor === actor.name &&
          same(entry.key, from)
        if ("before" in at && Entry.guards.Action(entry) && entry.at >= at.before) break entries
        if (
          "offset" in at &&
          (Number(segment.offset) > at.offset ||
            (Number(segment.offset) === at.offset && index > at.index))
        )
          break entries
        yield* cache.resolve(source, () => {
          if (Entry.guards.Action(entry)) {
            const record = Durable.resident(image, catalog, entry.actor, entry.key)
            Durable.record(
              image,
              catalog,
              entry,
              Actions.apply(
                record.actor,
                record.image,
                entry.effects.set,
                entry.effects.unset,
                entry.effects.lists,
              ),
              cache,
            )
          } else Durable.record(image, catalog, entry, undefined, cache)
        })
        image.offset = Number(segment.offset)
        if (!own) continue
        const record = Durable.resident(image, catalog, actor.name, from)
        admittedAt =
          Entry.guards.Action(entry) || Entry.guards.Forked(entry) ? entry.at : image.lastAt
        record.position = { offset: Number(segment.offset), index, at: admittedAt }
        position = { shard, offset: Number(segment.offset), index, version: record.version }
        if ("version" in at && record.version === at.version) break
      }
      if ("version" in at && position?.version === at.version) break
      if ("offset" in at && Number(segment.offset) >= at.offset) break
    }
    const record = image.actors.get(Durable.addressOf(actor.name, from))
    if (record === undefined || !record.created || position === undefined)
      return yield* ForkRefused.make({ reason: "source" })
    if (admittedAt < cutoff) return yield* ForkRefused.make({ reason: "retention" })
    if ("version" in at && position.version !== at.version)
      return yield* ForkRefused.make({ reason: "position" })
    if ("offset" in at && (position.offset !== at.offset || position.index !== at.index))
      return yield* ForkRefused.make({ reason: "position" })
    const to =
      options.to ??
      CommandIds.derive(
        `${source.meta.store}/${Durable.addressOf(actor.name, from)}`,
        "fork",
        position.offset,
        position.index,
      )
    layout.key.decode(to)
    if (source.meta.store === target.store.meta.store && same(from, to))
      return yield* ForkRefused.make({ reason: "target" })
    if ((yield* target.durableRecord(actor, to)).created)
      return yield* ForkRefused.make({ reason: "target" })
    const publish = Effect.gen(function* () {
      const snapshot = Checkpoints.capture(image, false).actors.find(
        (candidate) => candidate.actor === actor.name && same(candidate.key, from),
      )!
      const roots: Array<{ field: string; keys: string; ordered: string }> = []
      const refreshed = new Set<string>()
      const copy = (
        hash: string,
      ): Effect.Effect<void, import("../store/errors.ts").StorageUnavailable> =>
        Effect.gen(function* () {
          if (refreshed.has(hash)) return
          refreshed.add(hash)
          const bytes =
            cache.get(hash) ??
            (yield* target.store.getPage(hash).pipe(Effect.catchCause(() => source.getPage(hash))))
          for (const child of PageDocuments.references(bytes)) yield* copy(child)
          yield* target.store.putPage(bytes)
        })
      for (const [field, list] of layout.lists) {
        const items = record.image.lists.get(field) ?? Lists.empty
        const tree =
          items instanceof PagedItems
            ? items
            : new PagedItems(
                PageTrees.empty,
                PageTrees.empty,
                cache,
                list.ordering,
                list.item,
              ).apply({ put: Lists.all(items, list.ordering), delete: [] })
        const keys = yield* PageTrees.persist(tree.keys, target.store, cache)
        const ordered = yield* PageTrees.persist(tree.ordered, target.store, cache)
        yield* copy(keys)
        yield* copy(ordered)
        roots.push({ field, keys, ordered })
      }
      const manifest = yield* target.store.putPage(
        PageDocuments.encode({
          kind: "actor",
          references: roots.flatMap((root) => [root.keys, root.ordered]),
          value: PageDocuments.json({
            ...snapshot,
            key: to,
            version: 0,
            lists: roots.map((root) => ({ ...root, items: [] })),
          }),
        }),
      )
      const identity = CommandIds.derive(
        manifest,
        "fork",
        source.meta.store,
        position.offset,
        position.index,
        Durable.addressOf(actor.name, to),
      )
      const timers =
        options.withWork === true
          ? Array.from(image.timers.values())
              .filter((timer) => timer.address === record.address)
              .map(({ timer }, ordinal) => ({
                ...timer,
                commandId: CommandIds.derive(identity, "timer", ordinal),
              }))
          : []
      const jobs =
        options.withWork === true
          ? Array.from(image.jobs.values())
              .filter((job) => job.address === record.address && job.done === undefined)
              .map((job, ordinal) => ({
                jobId: CommandIds.derive(identity, "job", ordinal),
                job: job.job,
                payload: job.payload,
                key: job.key,
                steps: Array.from(job.steps, ([name, value]) => ({ name, value })),
              }))
          : []
      yield* target.installFork(
        Entry.cases.Forked.make({
          actor: actor.name,
          key: to,
          from,
          position,
          at: now,
          manifest,
          state: snapshot.state,
          lists: roots,
          timers,
          jobs,
        }),
        Entry.cases.Audit.make({
          record: {
            id: identity,
            at: now,
            operator: grant.operator,
            action: "fork",
            capability: Option.getOrUndefined(capability),
            target: {
              tenant,
              shard: target.shardOf(Durable.addressOf(actor.name, to)),
              actorType: actor.name,
              actorId: to,
            },
            reason: "Retained actor image forked",
            outcome: "allowed",
          },
        }),
      )
      return { actor: actor.name, id: to, position, manifest, withWork: options.withWork === true }
    })
    return yield* target.store.gc.protect(publish)
  })

const fork = (target: Engine, options: ForkOptions, source: Store["Service"] = target.store) =>
  forkOnce(target, options, source).pipe(
    Effect.retry({
      while: Schema.is(PagePublicationBusy),
      schedule: Schedule.max([Schedule.spaced("10 millis"), Schedule.recurs(100)]),
    }),
  )

/** Runs a local operator fork with the application's schemas and handlers, then durably drains it. */
const run = (app: App, source: Store["Service"], target: Store["Service"], options: ForkOptions) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(app.layer)
    const catalog: Catalog = {
      actors: new Map(
        app.actors.map((actor) => [
          actor.name,
          { actor, registered: Context.get(context, actor.implementation) },
        ]),
      ),
      shards: target.meta.shards,
    }
    const engine = yield* Engine.make(catalog, {
      shards: target.meta.shards,
      policy: "matching",
      maxBatch: 64,
      checkpointEvery: 0,
      cronSkipIfOlderThan: 3_600_000,
      doubleRun: false,
      observer: undefined,
    }).pipe(Effect.provideService(Store, target))
    yield* engine.assign(Array.from({ length: target.meta.shards }, (_, shard) => shard))
    const result = yield* fork(engine, options, source)
    const drained = yield* engine.drain("1 minute")
    if (drained.outcome !== "clean") return yield* ForkRefused.make({ reason: "target" })
    return result
  })

/** Operator-only retained-history forks; neither the actor contract nor `/rpc` exposes this API. */
export const Forks = { fork, run }
