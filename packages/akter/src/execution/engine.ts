import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Latch,
  Option,
  PubSub,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect"
import { Caller, System } from "../contract/caller.ts"
import {
  ActorError,
  ActorUnavailable,
  CommandExpired,
  InvalidCommandId,
  Unauthorized,
} from "../contract/errors.ts"
import type { AnyActor } from "../contract/make.ts"
import type { Action } from "../contract/members.ts"
import { Recovery, effectsText } from "../snapshots/recovery.ts"
import { CorruptLog } from "../snapshots/recovery.ts"
import type { RecoveryError, ReplayPolicy } from "../snapshots/recovery.ts"
import { Checkpoints } from "../snapshots/checkpoint.ts"
import { Actions } from "./action.ts"
import type { Ran } from "./action.ts"
import { Durable } from "./durable.ts"
import type { ActorRecord, Catalog, PendingSend, ShardImage, TimerRecord } from "./durable.ts"
import { Entry, EntryCodec, Origin, Outcome } from "./entries.ts"
import type { ActionEntry, Emit } from "./entries.ts"
import { Layouts } from "./layout.ts"
import type { Image } from "./layout.ts"
import { StaleEpoch } from "../store/errors.ts"
import type { Lease } from "../store/log.ts"
import { Store } from "../store/service.ts"

/** How an engine runs: its shards, replay policy, batch bound and simulation hooks. */
export interface EngineOptions {
  readonly shards: number
  /** Milliseconds a shard answers reads from memory after its last append or lease check; at most the store's `validFor`. */
  readonly validFor: number
  readonly policy: ReplayPolicy
  readonly maxBatch: number
  readonly checkpointEvery: number
  readonly doubleRun: boolean
  readonly observer: Observer | undefined
}

/** What the simulator watches: every published outcome and every determinism violation. */
export interface Observer {
  readonly published: (shard: number, offset: number, entry: Entry) => void
  readonly violation: (invariant: string, detail: string) => void
}

/** One action to run on its owner: the id, the origin that decides deduplication, and the call. */
export interface Command {
  readonly origin: Origin
  readonly commandId: string
  readonly actor: AnyActor
  readonly keyJson: Schema.Json
  readonly member: string
  readonly payload: Schema.Json
  readonly caller: Caller
  readonly connection: string | undefined
}

/** One entry executed but not yet durable, with whoever waits for it. */
interface Pending {
  readonly entry: Entry
  readonly after: Image | undefined
  readonly address: string | undefined
  readonly done: Deferred.Deferred<Outcome, ActorError>
}

type Status = "closed" | "restarting" | "opening" | "open" | "refused"

/** A shard on this owner: its durable image, speculative actor images, and the work not yet durable. */
interface Shard {
  readonly id: number
  status: Status
  generation: number
  opened: Deferred.Deferred<void, ActorError>
  settled: Deferred.Deferred<void>
  scope: Scope.Closeable
  lease: Lease | undefined
  confirmedAt: number
  durable: ShardImage
  refusal: RecoveryError | undefined
  readonly speculative: Map<string, Image>
  readonly pending: Map<string, Pending>
  readonly batch: Array<Array<Pending>>
  inFlight: ReadonlyArray<Pending>
  lastAt: number
  sinceCheckpoint: number
  readonly firing: Set<string>
  readonly acked: Set<string>
  readonly armed: Set<string>
  readonly delivering: Set<string>
  readonly wake: Latch.Latch
}

/** A shard rebuilt from the store: the lease that fenced earlier owners, and the image or why not. */
interface Recovered {
  readonly lease: Lease | undefined
  readonly startedAt: number
  readonly recovered: Result.Result<ShardImage, RecoveryError>
}

const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n))

/** Per-address publication channels; they live as long as the engine, across shard crashes. */
interface Channel {
  version: number
  readonly changes: PubSub.PubSub<number>
  readonly events: PubSub.PubSub<Emit>
}

const unavailable = (): ActorError => ActorError.make({ reason: ActorUnavailable.make({}) })

/**
 * The engine on one owner: shards in memory, each with one committer. An action runs synchronously
 * inside one block that also stages its group in the shard's batch, so per-actor order is admission
 * order and a same-shard send's entry always follows its sender's in the same segment. Nothing is
 * published until the segment holding it is durable; a lost or unknown append closes the shard
 * and discards everything speculative.
 */
const make = (catalog: Catalog, options: EngineOptions) =>
  Effect.gen(function* () {
    const store = yield* Store
    const root = yield* Effect.scope
    const shards = new Map<number, Shard>()
    const channels = new Map<string, Channel>()
    const afterDurable: Array<(shard: number) => Effect.Effect<void>> = []

    const channel = (address: string): Effect.Effect<Channel> =>
      Effect.suspend(() => {
        const existing = channels.get(address)
        if (existing !== undefined) return Effect.succeed(existing)
        return Effect.map(
          Effect.all([PubSub.unbounded<number>(), PubSub.unbounded<Emit>()]),
          ([changes, events]) => {
            const raced = channels.get(address)
            if (raced !== undefined) return raced
            const created: Channel = { version: 0, changes, events }
            channels.set(address, created)
            return created
          },
        )
      })

    const notify = (address: string): void => {
      const target = channels.get(address)
      if (target === undefined) return
      target.version++
      PubSub.publishUnsafe(target.changes, target.version)
    }

    const shardOf = (address: string): number => Durable.shardOf(address, catalog.shards)

    const fresh = (id: number): Shard => ({
      id,
      status: "closed",
      generation: 0,
      opened: Deferred.makeUnsafe<void, ActorError>(),
      settled: Deferred.makeUnsafe<void>(),
      scope: Scope.makeUnsafe(),
      lease: undefined,
      confirmedAt: 0,
      durable: Durable.empty(id),
      refusal: undefined,
      speculative: new Map(),
      pending: new Map(),
      batch: [],
      inFlight: [],
      lastAt: 0,
      sinceCheckpoint: 0,
      firing: new Set(),
      acked: new Set(),
      armed: new Set(),
      delivering: new Set(),
      wake: Latch.makeUnsafe(false),
    })

    const shardRuntime = (id: number): Shard => {
      const existing = shards.get(id)
      if (existing !== undefined) return existing
      const created = fresh(id)
      Deferred.doneUnsafe(created.settled, Exit.void)
      shards.set(id, created)
      return created
    }

    /**
     * Drops everything this owner holds for the shard without publishing: speculative images, the
     * batch, and every waiter, which sees a retryable `ActorUnavailable`. The durable truth is the
     * log; the next open rebuilds from it. The returned effect closes the shard's scope, which
     * interrupts its committer and any append still in flight, then reopens the shard unless another
     * owner fenced it, so its timers, sends and jobs go on without waiting for a caller.
     */
    const crash = (shard: Shard, fenced: boolean): Effect.Effect<void> => {
      if (shard.status !== "open" && shard.status !== "opening") return Effect.void
      shard.status = fenced ? "closed" : "restarting"
      shard.generation++
      const waiters = new Set([...shard.pending.values(), ...shard.batch.flat(), ...shard.inFlight])
      shard.pending.clear()
      shard.batch.length = 0
      shard.speculative.clear()
      shard.firing.clear()
      shard.acked.clear()
      shard.armed.clear()
      shard.delivering.clear()
      shard.inFlight = []
      for (const waiter of waiters) Deferred.doneUnsafe(waiter.done, Exit.fail(unavailable()))
      Deferred.doneUnsafe(shard.opened, Exit.fail(unavailable()))
      const closing = Scope.close(shard.scope, Exit.void)
      return fenced ? closing : Effect.andThen(closing, restart(shard))
    }

    /**
     * Reopens a shard this owner lost through its own failure, backing off while the log is
     * unavailable. It stops once the shard is open, refused, crashed again or fenced.
     */
    const restart = (shard: Shard): Effect.Effect<void> =>
      Effect.gen(function* () {
        let backoff = 10
        while (true) {
          const exit = yield* Effect.exit(open(shard))
          if (Exit.isSuccess(exit) || shard.status !== "closed") return
          shard.status = "restarting"
          yield* Effect.sleep(Duration.millis(backoff))
          backoff = Math.min(backoff * 2, 5_000)
        }
      })

    /**
     * Opens the shard in the store, which fences every earlier owner, then rebuilds it from the
     * newest checkpoint and the segments after it. The running build is the one on the lease's own
     * open segment, since that is what this owner's appends will carry. A corrupt log refuses the
     * shard like a failed replay; anything else is unavailable and retried.
     */
    const recoverShard = (id: number): Effect.Effect<Recovered, ActorError> =>
      Effect.gen(function* () {
        const startedAt = yield* monotonicMillis
        const lease = yield* store.open(id)
        const manifest = Option.getOrUndefined(lease.checkpoint)
        const page = manifest?.statePages[0]
        const checkpoint = page === undefined ? undefined : yield* store.getPage(page)
        const tail = yield* Stream.runCollect(store.read(id, manifest?.offset ?? 0n))
        const own = tail.find((segment) => segment.offset === lease.open)
        if (own === undefined)
          return yield* Effect.die(
            new Error(`Shard ${id}'s open segment ${lease.open} is missing from its log`),
          )
        const recovered = Recovery.recover(catalog, id, checkpoint, tail, own.build, options.policy)
        return { lease, startedAt, recovered }
      }).pipe(
        Effect.catchTag("CorruptSegment", (error) =>
          Effect.succeed({
            lease: undefined,
            startedAt: 0,
            recovered: Result.fail(
              CorruptLog.make({ shard: id, offset: -1, detail: error.message }),
            ),
          }),
        ),
        Effect.mapError(() => unavailable()),
      )

    /**
     * Opens the shard in a fiber of the engine's own scope, so a caller that gives up never leaves
     * it half open: the attempt always ends open, refused, or closed with every waiter failed. An
     * attempt starts only after the one before it ended, because an abandoned open that lands late
     * creates a newer epoch and would fence the owner's own current lease.
     */
    const open = (shard: Shard): Effect.Effect<void, ActorError> =>
      Effect.suspend(() => {
        if (shard.status === "open") return Effect.void
        if (shard.status === "refused") return Effect.fail(unavailable())
        if (shard.status === "opening") return Deferred.await(shard.opened)
        shard.status = "opening"
        shard.opened = Deferred.makeUnsafe<void, ActorError>()
        const generation = ++shard.generation
        const opened = shard.opened
        const previous = shard.settled
        const settled = Deferred.makeUnsafe<void>()
        shard.settled = settled
        const attempt = Effect.andThen(Deferred.await(previous), recoverShard(shard.id)).pipe(
          Effect.flatMap(({ lease, startedAt, recovered }) =>
            Effect.suspend(() => {
              if (shard.generation !== generation) return Effect.fail(unavailable())
              if (Result.isFailure(recovered)) {
                shard.status = "refused"
                shard.refusal = recovered.failure
                options.observer?.violation(
                  "recovery",
                  `${recovered.failure._tag}: ${recovered.failure.message}`,
                )
                Deferred.doneUnsafe(opened, Exit.fail(unavailable()))
                return Effect.fail(unavailable())
              }
              shard.durable = recovered.success
              shard.lease = lease
              shard.confirmedAt = startedAt
              shard.lastAt = recovered.success.lastAt
              shard.sinceCheckpoint = 0
              shard.scope = Scope.makeUnsafe()
              shard.status = "open"
              Deferred.doneUnsafe(opened, Exit.void)
              for (const address of recovered.success.actors.keys())
                if (channels.has(address)) notify(address)
              return Effect.forkIn(committer(shard, generation), shard.scope).pipe(
                Effect.andThen(after(shard)),
              )
            }),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (
                Exit.isSuccess(exit) ||
                shard.generation !== generation ||
                shard.status !== "opening"
              )
                return
              shard.status = "closed"
              Deferred.doneUnsafe(opened, Exit.fail(unavailable()))
            }),
          ),
          Effect.ensuring(Deferred.done(settled, Exit.void)),
        )
        return Effect.andThen(Effect.forkIn(attempt, root), Deferred.await(opened))
      })

    /**
     * The shard's one committer: whenever the log is free it takes every group staged so far, up to
     * the batch bound, as one segment. While an append is in flight new groups accumulate, so the
     * batch grows with load and shrinks to one entry when idle.
     */
    const committer = (shard: Shard, generation: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (shard.generation === generation) {
          yield* shard.wake.await
          Latch.closeUnsafe(shard.wake)
          while (shard.generation === generation && shard.batch.length > 0) {
            const groups: Array<Array<Pending>> = []
            let size = 0
            while (
              shard.batch.length > 0 &&
              (groups.length === 0 || size + (shard.batch[0]?.length ?? 0) <= options.maxBatch)
            ) {
              const group = shard.batch.shift()
              if (group === undefined) break
              groups.push(group)
              size += group.length
            }
            const entries = groups.flat()
            shard.inFlight = entries
            const lease = shard.lease
            if (lease === undefined) return
            const startedAt = yield* monotonicMillis
            const appended = yield* Effect.exit(
              store.append(
                lease,
                entries.map((pending) => EntryCodec.encode(pending.entry)),
              ),
            )
            if (shard.generation !== generation) return
            if (Exit.isFailure(appended)) {
              const fenced = Exit.findErrorOption(appended).pipe(
                Option.exists(Schema.is(StaleEpoch)),
              )
              yield* Effect.forkIn(crash(shard, fenced), root)
              return
            }
            const offset = Number(appended.value)
            shard.confirmedAt = startedAt
            shard.inFlight = []
            for (const pending of entries) publish(shard, pending, offset)
            yield* after(shard)
            shard.sinceCheckpoint++
            if (options.checkpointEvery > 0 && shard.sinceCheckpoint >= options.checkpointEvery) {
              shard.sinceCheckpoint = 0
              yield* checkpoint(shard, lease)
            }
          }
        }
      })

    /**
     * Writes the shard's durable image as one page and records it as a checkpoint at its offset,
     * with the earliest timer as the store's wake time. A failed checkpoint changes nothing: the log
     * still holds every entry, and the next one tries again.
     */
    const checkpoint = (shard: Shard, lease: Lease): Effect.Effect<void> =>
      Effect.gen(function* () {
        const image = shard.durable
        let nextDue: number | undefined
        for (const { timer } of image.timers.values())
          if (nextDue === undefined || timer.at < nextDue) nextDue = timer.at
        const hash = yield* store.putPage(Checkpoints.encode(Checkpoints.capture(image)))
        yield* store.checkpoint(lease, {
          offset: BigInt(image.offset),
          statePages: [hash],
          indexPages: [],
          nextDue,
        })
      }).pipe(Effect.ignore)

    /** Applies one durable entry: the shard image moves, the waiter gets its outcome, streams hear of it. */
    const publish = (shard: Shard, pending: Pending, offset: number): void => {
      Durable.record(shard.durable, catalog, pending.entry, pending.after)
      shard.durable.offset = offset
      const entry = pending.entry
      const commandId = Entry.guards.Action(entry) ? entry.commandId : undefined
      if (commandId !== undefined && shard.pending.get(commandId) === pending)
        shard.pending.delete(commandId)
      if (pending.address !== undefined && shard.speculative.get(pending.address) === pending.after)
        shard.speculative.delete(pending.address)
      options.observer?.published(shard.id, offset, entry)
      if (Entry.guards.Action(entry) && pending.address !== undefined) {
        const changed =
          Object.keys(entry.effects.set).length > 0 ||
          entry.effects.unset.length > 0 ||
          entry.effects.lists.length > 0
        if (changed) notify(pending.address)
        const events = channels.get(pending.address)?.events
        if (events !== undefined)
          for (const event of entry.effects.events) PubSub.publishUnsafe(events, event)
      }
      if (Entry.guards.Seed(entry) && pending.address !== undefined) notify(pending.address)
      Deferred.doneUnsafe(
        pending.done,
        Exit.succeed(
          Entry.guards.Action(entry)
            ? entry.effects.outcome
            : Outcome.cases.Success.make({ value: null }),
        ),
      )
    }

    /** The image an action runs on: the newest speculative one, else the durable one. */
    const current = (shard: Shard, record: ActorRecord): Image =>
      shard.speculative.get(record.address) ?? record.image

    const runAction = (command: Command, record: ActorRecord, image: Image, at: number): Ran => {
      const { actor, registered } = Durable.bound(catalog, command.actor.name)
      const declaration: Action | undefined = actor.actions[command.member]
      const presence = command.member === "connect" || command.member === "disconnect"
      const handler = registered.handlers.get(command.member)
      if (handler === undefined || (declaration === undefined && !presence))
        return defectRun(command, image, `'${command.member}' is not an action of ${actor.name}`)
      const payloadSchema = declaration === undefined ? actor.presence : declaration.payload
      let payload
      try {
        payload = Layouts.codec(payloadSchema).decode(command.payload)
      } catch (error) {
        return defectRun(command, image, String(error))
      }
      const invocation = {
        actor,
        handler,
        declaration,
        image,
        commandId: command.commandId,
        member: command.member,
        payload,
        caller: command.caller,
        at,
        key: record.key,
        address: record.address,
        connection: command.connection,
      }
      const ran = Actions.run(invocation)
      if (options.doubleRun) {
        const layout = Layouts.of(actor)
        const clone = Actions.apply(
          actor,
          layout.initial,
          image.encoded,
          [],
          Array.from(layout.lists, ([field, list]) => ({
            field,
            put: Array.from(image.lists.get(field) ?? [], ([, item]) => list.item.encode(item)),
            delete: [],
          })),
        )
        const again = Actions.run({ ...invocation, image: clone })
        const first = effectsText(ran.effects)
        const second = effectsText(again.effects)
        if (first !== second)
          options.observer?.violation(
            "I9",
            `${actor.name}.${command.member} (${command.commandId}) is not deterministic: ${first} then ${second}`,
          )
      }
      return ran
    }

    const defectRun = (command: Command, image: Image, detail: string): Ran => ({
      image,
      effects: {
        outcome: Outcome.cases.Defect.make({
          kind: "DecodeFailure",
          detail: `${command.actor.name}.${command.member}: ${detail}`,
        }),
        set: {},
        unset: [],
        lists: [],
        sends: [],
        timers: [],
        starts: [],
        events: [],
        ids: 0,
        randoms: 0,
      },
    })

    /**
     * Runs a command and every same-shard send it causes, depth first, staging all their entries
     * as one group so they reach the log in the same segment.
     */
    const stage = (shard: Shard, command: Command, at: number, group: Array<Pending>): Pending => {
      const record = Durable.resident(shard.durable, catalog, command.actor.name, command.keyJson)
      const { effects, image: after } = runAction(command, record, current(shard, record), at)
      const entry = Entry.cases.Action.make({
        commandId: command.commandId,
        origin: command.origin,
        actor: command.actor.name,
        key: command.keyJson,
        member: command.member,
        payload: command.payload,
        digest: Durable.payloadDigest(command.payload),
        caller: command.caller,
        at,
        connection: command.connection,
        effects,
      })
      const pending: Pending = {
        entry,
        after,
        address: record.address,
        done: Deferred.makeUnsafe(),
      }
      shard.speculative.set(record.address, after)
      shard.pending.set(command.commandId, pending)
      group.push(pending)
      for (const send of effects.sends) {
        const target = Durable.bound(catalog, send.actor).actor
        const address = Durable.addressOf(send.actor, send.key)
        if (shardOf(address) !== shard.id) continue
        stage(
          shard,
          {
            origin: Origin.cases.Local.make({}),
            commandId: send.commandId,
            actor: target,
            keyJson: send.key,
            member: send.member,
            payload: send.payload,
            caller: System.make({
              source: "send",
              subject: `actor:${record.address}`,
              ref: record.address,
              onBehalfOf: Durable.principalOf(command.caller),
            }),
            connection: undefined,
          },
          at,
          group,
        )
      }
      return pending
    }

    type Admission =
      | { readonly kind: "wait"; readonly pending: Pending }
      | { readonly kind: "done"; readonly outcome: Outcome }
      | { readonly kind: "refused"; readonly error: ActorError }

    const refuse = (error: ActorError): Admission => ({ kind: "refused", error })

    const sameCaller = (left: Caller, right: Caller): boolean =>
      JSON.stringify(Durable.encodeCaller(left)) === JSON.stringify(Durable.encodeCaller(right))

    /** Checks a retried client id against what it was first admitted with. */
    const matchStored = (
      command: Command,
      stored: {
        readonly member: string
        readonly digest: string
        readonly caller: Caller
        readonly address: string
      },
    ): ActorError | undefined => {
      if (
        stored.member !== command.member ||
        stored.digest !== Durable.payloadDigest(command.payload) ||
        stored.address !== Durable.addressOf(command.actor.name, command.keyJson)
      )
        return ActorError.make({
          reason: InvalidCommandId.make({ commandId: command.commandId, code: "conflict" }),
        })
      if (!sameCaller(stored.caller, command.caller))
        return ActorError.make({ reason: Unauthorized.make({ code: "outcome_access_denied" }) })
      return undefined
    }

    /**
     * Admission on the owner, in one synchronous block: the admission time, expiry, the duplicate
     * lookup (pending first, then the durable tables for the command's origin), and only then the
     * run and its staging.
     */
    const admit = (shard: Shard, command: Command, now: number): Admission => {
      const at = Math.max(now, shard.lastAt)
      shard.lastAt = at
      const pending = shard.pending.get(command.commandId)
      const origin = command.origin
      if (Origin.guards.External(origin)) {
        if (origin.expiresAt <= at)
          return refuse(
            ActorError.make({ reason: CommandExpired.make({ commandId: command.commandId }) }),
          )
        if (pending !== undefined && Entry.guards.Action(pending.entry)) {
          const mismatch = matchStored(command, {
            member: pending.entry.member,
            digest: pending.entry.digest,
            caller: pending.entry.caller,
            address: pending.address ?? "",
          })
          return mismatch === undefined ? { kind: "wait", pending } : refuse(mismatch)
        }
        const stored = shard.durable.clients
          .get(Durable.bucketOf(origin.expiresAt))
          ?.get(command.commandId)
        if (stored !== undefined) {
          const mismatch = matchStored(command, stored)
          return mismatch === undefined
            ? { kind: "done", outcome: stored.outcome }
            : refuse(mismatch)
        }
      } else if (pending !== undefined) return { kind: "wait", pending }
      if (Origin.guards.Delivery(origin)) {
        const watermark = shard.durable.received.get(origin.stream) ?? 0
        if (origin.sequence <= watermark)
          return { kind: "done", outcome: Outcome.cases.Success.make({ value: null }) }
        if (origin.sequence !== watermark + 1) return refuse(unavailable())
      }
      if (Origin.guards.JobCall(origin)) {
        const stored = shard.durable.calls.get(origin.jobId)?.get(command.commandId)
        if (stored !== undefined) return { kind: "done", outcome: stored }
      }
      if (Origin.guards.Fired(origin)) {
        if (!shard.durable.timers.has(command.commandId) || shard.firing.has(command.commandId))
          return { kind: "done", outcome: Outcome.cases.Success.make({ value: null }) }
        shard.firing.add(command.commandId)
      }
      const group: Array<Pending> = []
      const staged = stage(shard, command, at, group)
      shard.batch.push(group)
      Latch.openUnsafe(shard.wake)
      return { kind: "wait", pending: staged }
    }

    const ready = (address: string): Effect.Effect<Shard, ActorError> =>
      Effect.suspend(() => {
        const shard = shardRuntime(shardOf(address))
        return Effect.as(open(shard), shard)
      })

    /**
     * Runs a command on its owner and waits until its entry is durable. `replayed` is decided by
     * admission: true when this command found its id's stored outcome or joined its pending run.
     */
    const admitted = (
      command: Command,
    ): Effect.Effect<{ readonly outcome: Outcome; readonly replayed: boolean }, ActorError> =>
      Effect.gen(function* () {
        const address = Durable.addressOf(command.actor.name, command.keyJson)
        const shard = yield* ready(address)
        const now = yield* Clock.currentTimeMillis
        const pendingBefore = shard.pending.get(command.commandId)
        const admission = yield* Effect.sync(() =>
          shard.status === "open" ? admit(shard, command, now) : refuse(unavailable()),
        )
        if (admission.kind === "refused") return yield* admission.error
        if (admission.kind === "done") return { outcome: admission.outcome, replayed: true }
        const replayed = pendingBefore !== undefined && admission.pending === pendingBefore
        return { outcome: yield* Deferred.await(admission.pending.done), replayed }
      })

    /** Runs a command on its owner and waits until its entry is durable; the outcome is the reply. */
    const execute = (command: Command): Effect.Effect<Outcome, ActorError> =>
      Effect.map(admitted(command), (result) => result.outcome)

    /** Stages an engine entry (journal, delivery acknowledgement, retirement) and waits until it is durable. */
    const journal = (shardId: number, entry: Entry): Effect.Effect<void, ActorError> =>
      Effect.gen(function* () {
        const shard = shardRuntime(shardId)
        yield* open(shard)
        const pending = yield* Effect.sync(() => {
          if (shard.status !== "open") return undefined
          const staged: Pending = {
            entry,
            after: undefined,
            address: undefined,
            done: Deferred.makeUnsafe(),
          }
          shard.batch.push([staged])
          Latch.openUnsafe(shard.wake)
          return staged
        })
        if (pending === undefined) return yield* unavailable()
        yield* Deferred.await(pending.done)
      })

    /** Writes an operator's initial state for an instance, before its first action. */
    const seed = (
      actor: AnyActor,
      keyJson: Schema.Json,
      set: Readonly<Record<string, Schema.Json>>,
      lists: ActionEntry["effects"]["lists"],
    ) =>
      Effect.gen(function* () {
        const address = Durable.addressOf(actor.name, keyJson)
        const shard = yield* ready(address)
        const pending = yield* Effect.sync(() => {
          if (shard.status !== "open") return undefined
          const record = Durable.resident(shard.durable, catalog, actor.name, keyJson)
          const after = Actions.apply(actor, current(shard, record), set, [], lists)
          const staged: Pending = {
            entry: Entry.cases.Seed.make({
              actor: actor.name,
              key: keyJson,
              set: { ...set },
              lists: [...lists],
            }),
            after,
            address,
            done: Deferred.makeUnsafe(),
          }
          shard.speculative.set(address, after)
          shard.batch.push([staged])
          Latch.openUnsafe(shard.wake)
          return staged
        })
        if (pending === undefined) return yield* unavailable()
        yield* Deferred.await(pending.done)
      })

    /**
     * Opens the shard and, once it has gone `validFor` without an append or lease check, checks the
     * lease in the store before a read is answered, so an owner fenced while idle stops answering
     * from memory. Each confirmation counts from before its request was sent. A fenced shard
     * closes; an unreachable store is unavailable.
     */
    const readable = (shard: Shard): Effect.Effect<Shard, ActorError> =>
      Effect.gen(function* () {
        yield* open(shard)
        const lease = shard.lease
        if (lease === undefined) return yield* unavailable()
        const startedAt = yield* monotonicMillis
        if (startedAt - shard.confirmedAt <= options.validFor) return shard
        const generation = shard.generation
        const verified = yield* Effect.exit(store.verify(lease))
        if (Exit.isSuccess(verified)) {
          if (shard.generation === generation)
            shard.confirmedAt = Math.max(shard.confirmedAt, startedAt)
          return shard
        }
        if (
          shard.generation === generation &&
          Exit.findErrorOption(verified).pipe(Option.exists(Schema.is(StaleEpoch)))
        )
          yield* Effect.forkIn(crash(shard, true), root)
        return yield* unavailable()
      })

    /** The durable record of an instance, opening its shard if needed; reads never see speculation. */
    const durableRecord = (
      actor: AnyActor,
      keyJson: Schema.Json,
    ): Effect.Effect<ActorRecord, ActorError> =>
      Effect.map(readable(shardRuntime(shardOf(Durable.addressOf(actor.name, keyJson)))), (shard) =>
        Durable.resident(shard.durable, catalog, actor.name, keyJson),
      )

    /** Every created instance of an actor type, across all shards. */
    const instances = (actor: AnyActor): Effect.Effect<ReadonlyArray<ActorRecord>, ActorError> =>
      Effect.map(
        Effect.forEach(
          Array.from({ length: catalog.shards }, (_, id) => id),
          (id) => readable(shardRuntime(id)),
        ),
        (opened) =>
          opened.flatMap((shard) =>
            Array.from(shard.durable.actors.values()).filter(
              (record) => record.created && record.actor.name === actor.name,
            ),
          ),
      )

    /**
     * What some shard is still doing at `now`: opening, staged or in-flight entries, waiters,
     * undelivered sends or due timers. A shard fenced by another owner while it still held sends
     * or timers counts too, since nothing on this owner will finish them. `undefined` once every
     * shard is quiet.
     */
    const busy = (now: number): string | undefined => {
      for (const shard of shards.values()) {
        if (shard.status === "opening" || shard.status === "restarting")
          return `shard ${shard.id} is ${shard.status}`
        if (
          shard.status === "closed" &&
          (Array.from(shard.durable.outbox.values()).some((queue) => queue.length > 0) ||
            Array.from(shard.durable.timers.values()).some(({ timer }) => !timer.cron))
        )
          return `shard ${shard.id} is closed with sends or timers left`
        if (shard.status !== "open") continue
        if (shard.batch.length > 0 || shard.inFlight.length > 0)
          return `shard ${shard.id} has ${shard.batch.length} staged groups and ${shard.inFlight.length} entries in flight`
        if (shard.pending.size > 0)
          return `shard ${shard.id} has ${shard.pending.size} actions waiting for durability`
        for (const [stream, queue] of shard.durable.outbox)
          if (queue.length > 0)
            return `shard ${shard.id} has ${queue.length} undelivered sends on ${stream}`
        for (const timer of shard.durable.timers.values())
          if (timer.timer.at <= now)
            return `shard ${shard.id} has timer ${timer.timer.member} due at ${timer.timer.at}`
      }
      return undefined
    }

    /** When the earliest armed one-shot timer is due on an open shard; cron ticks never end, so they do not count. */
    const nextTimer = (): number | undefined => {
      let earliest: number | undefined
      for (const shard of shards.values()) {
        if (shard.status !== "open") continue
        for (const { timer } of shard.durable.timers.values())
          if (!timer.cron && (earliest === undefined || timer.at < earliest)) earliest = timer.at
      }
      return earliest
    }

    const fork = (shard: Shard, effect: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.asVoid(Effect.forkIn(effect, shard.scope))

    /** Sleeps until a timer is due, then fires it as a `System` action with the timer's own id. */
    const arm = (shard: Shard, record: TimerRecord): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (record.timer.at > now) yield* Effect.sleep(Duration.millis(record.timer.at - now))
        const owner = shard.durable.actors.get(record.address)
        if (owner === undefined) return
        yield* execute({
          origin: Origin.cases.Fired.make({}),
          commandId: record.timer.commandId,
          actor: owner.actor,
          keyJson: owner.keyJson,
          member: record.timer.member,
          payload: record.timer.payload,
          caller: System.make({
            source: record.timer.cron ? "cron" : "timer",
            subject: record.timer.cron ? `cron:${owner.actor.name}` : `actor:${record.address}`,
            ref: record.address,
          }),
          connection: undefined,
        }).pipe(Effect.ignore)
      })

    /**
     * Delivers a stream's pending sends in sequence order until each receiver's segment holding it
     * is durable, then records `Delivered`. A failed delivery is retried with the same sequence and id.
     */
    const deliver = (shard: Shard, stream: string, generation: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (shard.generation === generation) {
          const next: PendingSend | undefined = (shard.durable.outbox.get(stream) ?? []).find(
            (pending) => !shard.acked.has(`${stream}#${pending.sequence}`),
          )
          if (next === undefined) break
          const target = Durable.bound(catalog, next.send.actor).actor
          const result = yield* Effect.exit(
            execute({
              origin: Origin.cases.Delivery.make({ stream, sequence: next.sequence }),
              commandId: next.send.commandId,
              actor: target,
              keyJson: next.send.key,
              member: next.send.member,
              payload: next.send.payload,
              caller: System.make({
                source: "send",
                subject: `actor:${next.ref}`,
                ref: next.ref,
                onBehalfOf: next.onBehalfOf,
              }),
              connection: undefined,
            }),
          )
          if (shard.generation !== generation) return
          if (Exit.isFailure(result)) {
            yield* Effect.sleep(Duration.millis(50))
            continue
          }
          shard.acked.add(`${stream}#${next.sequence}`)
          yield* journal(
            shard.id,
            Entry.cases.Delivered.make({ stream, sequence: next.sequence }),
          ).pipe(Effect.ignore)
        }
        if (shard.generation === generation) shard.delivering.delete(stream)
      })

    const followUps = (shard: Shard): Effect.Effect<void> =>
      Effect.suspend(() => {
        const generation = shard.generation
        const work: Array<Effect.Effect<void>> = []
        for (const timer of shard.durable.timers.values()) {
          if (shard.armed.has(timer.timer.commandId)) continue
          shard.armed.add(timer.timer.commandId)
          work.push(fork(shard, arm(shard, timer)))
        }
        for (const stream of shard.durable.outbox.keys()) {
          if (shard.delivering.has(stream)) continue
          shard.delivering.add(stream)
          work.push(fork(shard, deliver(shard, stream, generation)))
        }
        for (const extra of afterDurable) work.push(extra(shard.id))
        return Effect.all(work, { discard: true })
      })

    /** Starts what newly durable entries made due: timers, deliveries, and whatever the job runner adds. */
    function after(shard: Shard): Effect.Effect<void> {
      return followUps(shard)
    }

    return {
      catalog,
      options,
      execute,
      admitted,
      journal,
      seed,
      durableRecord,
      instances,
      busy,
      nextTimer,
      channel,
      shardOf,
      crash: (id: number) => crash(shardRuntime(id), false),
      shards: () => Array.from(shards.values()),
      store,
      afterDurable: (hook: (shard: number) => Effect.Effect<void>) => {
        afterDurable.push(hook)
      },
      durableImage: (id: number): ShardImage | undefined => {
        const shard = shards.get(id)
        return shard?.status === "open" ? shard.durable : undefined
      },
      generation: (id: number): number => shardRuntime(id).generation,
      fork: (id: number, effect: Effect.Effect<void>) => fork(shardRuntime(id), effect),
    }
  })

/** The engine: shards, admission, group commit, publication after durability. */
export const Engine = { make }

/** The engine built by `Engine.make`. */
export type Engine = Effect.Success<ReturnType<typeof make>>
