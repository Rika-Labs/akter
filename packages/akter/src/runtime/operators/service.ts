import { Effect, Option, Predicate, Result, Schema, Stream } from "effect"
import { Durable } from "../../execution/durable.ts"
import type { Engine } from "../../execution/engine.ts"
import { Entry, EntryCodec, Origin, Outcome } from "../../execution/entries.ts"
import type { ActionEntry } from "../../execution/entries.ts"
import { Lists } from "../../handlers/lists.ts"
import { Layouts } from "../../execution/layout.ts"
import { pendingClocks } from "../../execution/workflow.ts"
import { Checkpoints } from "../../snapshots/checkpoint.ts"
import { Recovery } from "../../snapshots/recovery.ts"
import { PagedCheckpoints } from "../../snapshots/pages.ts"
import { PageCache } from "../../handlers/page-tree.ts"
import { auditIdentity } from "../../store/audit.ts"
import type { AuditRecord } from "../../store/audit.ts"
import { authorizing } from "./grants.ts"
import type { OperatorAction, OperatorGrant, Resource } from "./grants.ts"

const Target = Schema.Union([
  Schema.Struct({ actorType: Schema.NonEmptyString, actorId: Schema.Json }),
  Schema.Struct({ shard: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.Struct({ store: Schema.Literal(true) }),
])

/** Operator requests are independent of the application caller and RPC group. */
export const OperatorRequest = Schema.Struct({
  operation: Schema.Literals([
    "inspect",
    "log",
    "snapshot",
    "replay",
    "outcomes",
    "audit",
    "retention",
  ]),
  target: Target,
  tenant: Schema.NonEmptyString,
  reason: Schema.String,
  from: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  replay: Schema.optionalKey(Schema.Literals(["matching", "current"])),
  commandId: Schema.optionalKey(Schema.String),
  retentionMillis: Schema.optionalKey(Schema.Finite),
})
export type OperatorRequest = typeof OperatorRequest.Type

/** Opaque operator failures carry no state, payload or credential. */
export class OperatorRefused extends Schema.TaggedError<OperatorRefused>()("OperatorRefused", {
  reason: Schema.Literals([
    "scope",
    "not_found",
    "unavailable",
    "recovery",
    "not_refused",
    "invalid_target",
    "range",
    "conflict",
  ]),
}) {}

const actions: Record<OperatorRequest["operation"], OperatorAction> = {
  inspect: "inspect",
  log: "log.read",
  snapshot: "snapshot.read",
  replay: "replay",
  outcomes: "outcomes.read",
  audit: "audit.read",
  retention: "retention.set",
}

const decodeJson = Schema.decodeResult(Schema.fromJsonString(Schema.Json))
const json = <A>(value: A): Schema.Json =>
  Result.getOrThrow(
    decodeJson(
      JSON.stringify(value, (_, item: A) => (Predicate.isBigInt(item) ? String(item) : item)),
    ),
  )

type Writable<T> = { -readonly [K in keyof T]: T[K] }

/** Reads bounded checkpoint-plus-tail positions without acquiring a lease or activating an actor. */
const make = (engine: Engine) => {
  const store = engine.store
  const pages = new PageCache()
  const point = (shard: number) =>
    Effect.gen(function* () {
      const { checkpoint, damaged } = yield* store.recoveryPoint(shard)
      const manifest = Option.getOrUndefined(checkpoint)
      const page = manifest?.statePages[0]
      const bytes = page === undefined ? undefined : yield* PagedCheckpoints.read(page, store)
      const tail = yield* Stream.runCollect(store.read(shard, manifest?.offset ?? 0n))
      return { manifest, bytes, tail, damaged }
    })
  const run = (
    grant: OperatorGrant,
    request: OperatorRequest,
  ): Effect.Effect<Schema.Json, OperatorRefused> =>
    Effect.gen(function* () {
      const target = request.target
      if (request.operation === "retention") {
        if (!("store" in target) || request.tenant !== "*")
          return yield* OperatorRefused.make({ reason: "invalid_target" })
        const result = yield* store
          .setRetention(request.retentionMillis ?? Number.NaN, {
            grant,
            reason: request.reason,
          })
          .pipe(
            Effect.catchTags({
              RetentionRefused: (error) =>
                Effect.fail(OperatorRefused.make({ reason: error.reason })),
              RetentionConflict: () => Effect.fail(OperatorRefused.make({ reason: "conflict" })),
            }),
            Effect.mapError((error) =>
              Schema.is(OperatorRefused)(error)
                ? error
                : OperatorRefused.make({ reason: "unavailable" }),
            ),
          )
        return json({ retentionMillis: result.retentionMillis, revision: result.revision })
      }
      if ("store" in target) return yield* OperatorRefused.make({ reason: "invalid_target" })
      const actorTarget = "actorType" in target ? target : undefined
      const resource: Writable<Resource> = { tenant: request.tenant }
      if (request.commandId !== undefined) resource.commandId = request.commandId
      if (actorTarget !== undefined && request.operation !== "audit") {
        resource.actorType = actorTarget.actorType
        resource.actorId = actorTarget.actorId
      }
      const action = actions[request.operation]
      const capability = authorizing({ grant, action, resource })
      const auditTarget: Writable<AuditRecord["target"]> = { ...resource }
      if ("shard" in target) auditTarget.shard = target.shard
      const audit: Writable<AuditRecord> = {
        ...(yield* auditIdentity),
        operator: grant.operator,
        action,
        capability: Option.getOrUndefined(capability),
        target: auditTarget,
        reason: request.reason,
        outcome: "allowed",
      }
      if (request.operation === "replay") audit.replay = request.replay ?? "matching"
      const record = (outcome: AuditRecord["outcome"]) =>
        store
          .audit({ ...audit, outcome })
          .pipe(Effect.mapError(() => OperatorRefused.make({ reason: "unavailable" })))
      if (Option.isNone(capability) || request.tenant !== "default") {
        yield* record("denied")
        return yield* OperatorRefused.make({ reason: "scope" })
      }
      const shard =
        "shard" in target
          ? target.shard
          : engine.shardOf(Durable.addressOf(target.actorType, target.actorId))
      if (
        shard >= store.meta.shards ||
        (actorTarget !== undefined && !engine.catalog.actors.has(actorTarget.actorType))
      ) {
        yield* record("refused")
        return yield* OperatorRefused.make({ reason: "invalid_target" })
      }
      if (request.operation === "replay") {
        if (
          actorTarget !== undefined ||
          engine.status(shard).status !== "refused" ||
          !engine.status(shard).assigned
        ) {
          yield* record("refused")
          return yield* OperatorRefused.make({ reason: "not_refused" })
        }
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const lease = yield* store.open(shard)
            const page = Option.getOrUndefined(lease.checkpoint)?.statePages[0]
            const bytes = page === undefined ? undefined : yield* PagedCheckpoints.read(page, store)
            const tail = yield* Stream.runCollect(
              store.read(shard, Option.getOrUndefined(lease.checkpoint)?.offset ?? 0n),
            )
            const recovered = yield* pages.resolve(store, () =>
              Recovery.recover(
                engine.catalog,
                shard,
                bytes,
                tail,
                store.build,
                request.replay ?? "matching",
                pages,
              ),
            )
            if (Result.isFailure(recovered))
              return yield* OperatorRefused.make({ reason: "recovery" })
            const image = recovered.success
            image.offset = Number(lease.head + 1n)
            const paged = Array.from(image.actors.values()).some(
              (actor) => Layouts.of(actor.actor).lists.size > 0,
            )
            let replayPage: string | undefined
            const append = (replayed: Entry) =>
              store.append(lease, [
                EntryCodec.encode(replayed),
                EntryCodec.encode(Entry.cases.Audit.make({ record: audit })),
              ])
            image.offset = Number(
              paged
                ? yield* store.gc.protect(PagedCheckpoints.write(image, store, pages), (prepared) =>
                    Effect.gen(function* () {
                      replayPage = prepared.hash
                      const offset = yield* append(
                        Entry.cases.Replayed.make({ page: prepared.hash }),
                      )
                      prepared.committed()
                      return offset
                    }),
                  )
                : yield* pages
                    .resolve(store, () =>
                      Entry.cases.Replayed.make({
                        checkpoint: new TextDecoder().decode(
                          Checkpoints.encode(Checkpoints.capture(image)),
                        ),
                      }),
                    )
                    .pipe(Effect.flatMap(append)),
            )
            let nextDue: number | undefined
            for (const timer of image.timers.values())
              nextDue = Math.min(nextDue ?? Infinity, timer.timer.at)
            for (const job of image.jobs.values())
              for (const at of pendingClocks(job.workflow))
                nextDue = Math.min(nextDue ?? Infinity, at)
            yield* Effect.ignore(
              store.gc.protect(
                replayPage === undefined
                  ? Effect.map(PagedCheckpoints.write(image, store, pages), ({ hash }) => hash)
                  : Effect.succeed(replayPage),
                (hash) =>
                  Effect.gen(function* () {
                    yield* store.checkpoint(lease, {
                      offset: BigInt(image.offset),
                      statePages: [hash],
                      indexPages: [hash],
                      nextDue,
                    })
                    yield* store.append(lease, [EntryCodec.encode(Entry.cases.Released.make({}))])
                  }),
              ),
            )
            yield* engine.assign([shard])
            return json({
              shard,
              offset: image.offset,
              build: store.build,
              replay: request.replay ?? "matching",
            })
          }).pipe(
            Effect.catchDefect(() => Effect.fail(OperatorRefused.make({ reason: "recovery" }))),
          ),
        )
        if (Result.isSuccess(result)) return result.success
        yield* record("refused")
        return yield* OperatorRefused.make({ reason: "recovery" })
      }
      const result = yield* Effect.result(
        Effect.gen(function* () {
          if (request.operation === "audit")
            return json(
              (yield* store.audits).filter((record) => record.target.tenant === request.tenant),
            )
          if (request.operation === "log") {
            const { checkpoint } = yield* store.recoveryPoint(shard)
            const segments = yield* Stream.runCollect(
              store.history.read(shard, BigInt(request.from ?? 0)),
            )
            const entries = segments
              .flatMap((segment) =>
                segment.entries.map((bytes) => ({
                  offset: Number(segment.offset),
                  writer: segment.writer,
                  build: segment.build,
                  entry: Result.getOrThrow(EntryCodec.decode(bytes)),
                })),
              )
              .filter(
                ({ entry }) =>
                  actorTarget === undefined ||
                  ((Entry.guards.Action(entry) || Entry.guards.Seed(entry)) &&
                    entry.actor === actorTarget.actorType &&
                    JSON.stringify(entry.key) === JSON.stringify(actorTarget.actorId)),
              )
            return json({
              shard,
              head: Math.max(
                request.from ?? 0,
                Number(segments.at(-1)?.offset ?? Option.getOrUndefined(checkpoint)?.offset ?? 0n),
              ),
              entries,
            })
          }
          const captured = yield* point(shard)
          if (request.operation === "inspect" && actorTarget === undefined)
            return json({
              shard,
              head: Number(captured.tail.at(-1)?.offset ?? captured.manifest?.offset ?? 0n),
              owner: captured.tail.at(-1)?.writer ?? null,
              checkpoint: captured.manifest ?? null,
              status: engine.status(shard).status,
              refusal: engine.shards().find((value) => value.id === shard)?.refusal?._tag ?? null,
              damaged: captured.damaged.map((damage) => damage.key),
            })
          if (request.operation === "snapshot") {
            if (captured.bytes === undefined)
              return yield* OperatorRefused.make({ reason: "not_found" })
            const checkpoint = Result.getOrThrow(Checkpoints.decode(captured.bytes))
            if (actorTarget === undefined) return json({ manifest: captured.manifest, checkpoint })
            const actor = checkpoint.actors.find(
              (value) =>
                value.actor === actorTarget.actorType &&
                JSON.stringify(value.key) === JSON.stringify(actorTarget.actorId),
            )
            if (actor?.created !== true) return yield* OperatorRefused.make({ reason: "not_found" })
            return json({ manifest: captured.manifest, actor })
          }
          const recovered = yield* pages.resolve(store, () =>
            Recovery.recover(
              engine.catalog,
              shard,
              captured.bytes,
              captured.tail,
              store.build,
              "matching",
              pages,
            ),
          )
          if (Result.isFailure(recovered))
            return yield* OperatorRefused.make({ reason: "recovery" })
          const image = recovered.success
          const address =
            actorTarget === undefined
              ? undefined
              : Durable.addressOf(actorTarget.actorType, actorTarget.actorId)
          const record = address === undefined ? undefined : image.actors.get(address)
          if (address !== undefined && record?.created !== true)
            return yield* OperatorRefused.make({ reason: "not_found" })
          if (request.operation === "outcomes")
            return json(
              Array.from(image.clients.values())
                .flatMap((bucket) => Array.from(bucket.values()))
                .filter(
                  (client) =>
                    (address === undefined || client.address === address) &&
                    (request.commandId === undefined || request.commandId === client.commandId),
                )
                .map(({ commandId, outcome }) => ({ commandId, outcome })),
            )
          if (record === undefined) return yield* OperatorRefused.make({ reason: "invalid_target" })
          const lists = yield* pages.resolve(store, () =>
            Array.from(Layouts.of(record.actor).lists, ([field, layout]) => ({
              field,
              items: Lists.all(record.image.lists.get(field) ?? Lists.empty, layout.ordering).map(
                layout.item.encode,
              ),
            })),
          )
          const retained = yield* Stream.runCollect(store.read(shard, 0n))
          const rejections = retained
            .filter((segment) => Number(segment.offset) <= image.offset)
            .flatMap((segment) =>
              segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))),
            )
            .filter(
              (entry): entry is ActionEntry =>
                Entry.guards.Action(entry) &&
                Origin.guards.Delivery(entry.origin) &&
                !Outcome.guards.Success(entry.effects.outcome) &&
                Durable.addressOf(entry.actor, entry.key) === address,
            )
            .map((entry) => ({
              commandId: entry.commandId,
              member: entry.member,
              outcome: entry.effects.outcome._tag,
            }))
          return json({
            actor: record.actor.name,
            id: record.keyJson,
            offset: image.offset,
            state: record.image.encoded,
            lists,
            rejections,
            timers: Array.from(image.timers.values())
              .filter((timer) => timer.address === address)
              .map(({ timer }) => ({
                commandId: timer.commandId,
                at: timer.at,
                member: timer.member,
              })),
            jobs: Array.from(image.jobs.values())
              .filter((job) => job.address === address)
              .map((job) => ({
                jobId: job.jobId,
                job: job.job,
                attempt: job.attempt,
                done: job.done ?? null,
                suspended: job.suspended ?? null,
              })),
            outcomes: Array.from(image.clients.values())
              .flatMap((bucket) => Array.from(bucket.values()))
              .filter((client) => client.address === address)
              .map(({ commandId, outcome }) => ({ commandId, outcome: outcome._tag })),
          })
        }).pipe(
          Effect.catchDefect(() => Effect.fail(OperatorRefused.make({ reason: "recovery" }))),
        ),
      )
      yield* record(Result.isSuccess(result) ? "allowed" : "refused")
      return Result.isSuccess(result)
        ? result.success
        : yield* Schema.is(OperatorRefused)(result.failure)
            ? result.failure
            : OperatorRefused.make({ reason: "recovery" })
    })
  return { run }
}

/** Audited reads and build-checked replay over store bytes, never speculative engine state. */
export const Operators = { make }
