import {
  Context,
  Clock,
  Deferred,
  Duration,
  Effect,
  Equal,
  Fiber,
  HashRing,
  Layer,
  Option,
  Result,
  Schema,
  Stream,
} from "effect"
import {
  Entity,
  EntityId,
  MessageStorage,
  RunnerAddress,
  RunnerHealth,
  RunnerStorage,
  ShardId,
  Sharding as Cluster,
  ShardingConfig,
  SocketRunner,
} from "effect/cluster"
import { Headers } from "effect/http"
import { Rpc, RpcSerialization } from "effect/rpc"
import { Caller } from "../contract/caller.ts"
import { ActorError, ActorUnavailable, ShardMoved, Unauthorized } from "../contract/errors.ts"
import type { CallRequest, Transport } from "../contract/handle.ts"
import type { AnyActor } from "../contract/make.ts"
import { Durable } from "../execution/durable.ts"
import type { Command, DrainReport, Engine } from "../execution/engine.ts"
import { Origin, Outcome } from "../execution/entries.ts"
import { Transports } from "../execution/transport.ts"
import { ErrorEnvelope, FindCodec, FindPayload, Frame, RangePayload } from "../rpc/group.ts"
import { runnerDefaults, runnerStorage } from "../store/runners.ts"
import { StaleEpoch } from "../store/errors.ts"
import type { Readiness } from "./drain.ts"
import { mtls, PeerHealth } from "./peering/transport.ts"
import type { MutualTlsOptions } from "./peering/transport.ts"
import { PersistenceError } from "effect/cluster/ClusterError"

/** A runner's directly reachable peer listener and bucket coordination timings. */
export interface RunnerOptions {
  readonly address: { readonly host: string; readonly port: number }
  readonly listenAddress?: { readonly host: string; readonly port: number }
  /** A stable peering identity shared across releases of this store, never a release id. */
  readonly peering: MutualTlsOptions<unknown>
  readonly shardLockExpiration?: Duration.Input
  readonly refreshAssignmentsInterval?: Duration.Input
  readonly shardLockRefreshInterval?: Duration.Input
  readonly drainDeadline?: Duration.Input
  /** One peer request's bound; a retry repeats the command id. Default 10 seconds. */
  readonly requestTimeout?: Duration.Input
}

const CALLER = "x-akter-peer-caller"

const Target = Schema.Struct({ actor: Schema.String, id: Schema.Json })
const Member = Schema.Struct({ ...Target.fields, member: Schema.String, payload: Schema.Json })
const CommandPayload = Schema.Struct({
  ...Member.fields,
  commandId: Schema.String,
  origin: Origin,
  connection: Schema.optional(Schema.String),
})
const Admission = Schema.Struct({ outcome: Outcome, replayed: Schema.Boolean })
const Rows = Schema.Array(Schema.Struct({ id: Schema.Json, order: Schema.Json }))

const entity = Entity.make("AkterShard", [
  Rpc.make("Admit", { payload: CommandPayload, success: Admission, error: ErrorEnvelope }),
  Rpc.make("Execute", { payload: CommandPayload, success: Outcome, error: ErrorEnvelope }),
  Rpc.make("State", { payload: Target, success: Frame, error: ErrorEnvelope, stream: true }),
  Rpc.make("View", { payload: Member, success: Schema.Json, error: ErrorEnvelope, stream: true }),
  Rpc.make("Event", { payload: Member, success: Schema.Json, error: ErrorEnvelope, stream: true }),
  Rpc.make("Range", {
    payload: Schema.Struct({ actor: Schema.String, member: Schema.String, ...RangePayload.fields }),
    success: Schema.Array(Schema.Json),
    error: ErrorEnvelope,
  }),
  Rpc.make("Watch", {
    payload: Schema.Struct({ actor: Schema.String, member: Schema.String, ...RangePayload.fields }),
    success: Schema.Array(Schema.Json),
    error: ErrorEnvelope,
    stream: true,
  }),
  Rpc.make("Join", { payload: Member, success: Schema.Void, error: ErrorEnvelope, stream: true }),
  Rpc.make("Find", {
    payload: Schema.Struct({ actor: Schema.String, ...FindPayload.fields }),
    success: Rows,
    error: ErrorEnvelope,
  }),
])

const moved = () => ActorError.make({ reason: ShardMoved.make({}) })
const unavailable = () => ActorError.make({ reason: ActorUnavailable.make({}) })
const callerOf = (headers: Headers.Headers) =>
  Option.match(Headers.get(headers, CALLER), {
    onNone: () =>
      Effect.fail(ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })),
    onSome: (value) =>
      Schema.decodeEffect(Schema.fromJsonString(Caller))(value).pipe(
        Effect.mapError(() =>
          ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) }),
        ),
      ),
  })

/** Routing and graceful ownership changes over volatile Cluster messages; the engine log remains authority. */
export class Sharding extends Context.Service<
  Sharding,
  {
    readonly reads: (caller: Caller) => Omit<Transport, "call">
    readonly admitted: (
      caller: Caller,
      commandId: string,
      request: CallRequest,
    ) => Effect.Effect<{ readonly reply: AwaitedReply; readonly replayed: boolean }, ActorError>
    readonly execute: (command: Command) => Effect.Effect<Outcome, ActorError>
    readonly readiness: Effect.Effect<Readiness>
    readonly drain: (deadline: Duration.Input) => Effect.Effect<DrainReport>
  }
>()("@rikalabs/akter/runtime/sharding") {}

type AwaitedReply = Effect.Success<ReturnType<typeof Transports.reply>>

const engineReady = (engine: Engine, ids: Iterable<number>): Effect.Effect<Readiness> =>
  Effect.gen(function* () {
    for (const id of ids) {
      if (engine.status(id).status !== "open") return { ready: false, reason: "routing" }
      const lease = engine.lease(id)
      if (lease === undefined) return { ready: false, reason: "routing" }
      const verified = yield* engine.store
        .verify(lease)
        .pipe(Effect.result, Effect.timeoutOption("1 second"))
      if (Option.isNone(verified)) return { ready: false, reason: "storage" }
      if (Result.isFailure(verified.value))
        return {
          ready: false,
          reason: Schema.is(StaleEpoch)(verified.value.failure) ? "routing" : "storage",
        }
    }
    return { ready: true }
  })

/** A single process uses the same control surface without a peer listener. */
const local = (engine: Engine) =>
  Effect.gen(function* () {
    let draining = false
    let completed = false
    let report: Deferred.Deferred<DrainReport> | undefined
    yield* engine.assign(Array.from({ length: engine.catalog.shards }, (_, id) => id))
    return Sharding.of({
      reads: (caller) => Transports.reads(engine, caller),
      admitted: (caller, id, request) => Transports.admitted(engine, caller, id, request),
      execute: engine.execute,
      readiness: Effect.suspend(() =>
        draining
          ? Effect.succeed<Readiness>({ ready: false, reason: completed ? "drained" : "draining" })
          : engineReady(
              engine,
              Array.from({ length: engine.catalog.shards }, (_, id) => id),
            ),
      ),
      drain: (deadline) =>
        Effect.suspend(() => {
          if (report !== undefined) return Deferred.await(report)
          draining = true
          report = Deferred.makeUnsafe<DrainReport>()
          return engine.drain(deadline).pipe(
            Effect.tap((value) => {
              completed = true
              return Deferred.succeed(report!, value)
            }),
            Effect.uninterruptible,
          )
        }),
    })
  })

const clustered = (engine: Engine, options: RunnerOptions) =>
  Effect.gen(function* () {
    if (["0.0.0.0", "::", "*", ""].includes(options.address.host) || options.address.port < 1)
      return yield* Effect.die(
        new Error("Runner address must be directly reachable and name a nonzero port"),
      )
    const config = {
      ...ShardingConfig.defaults,
      ...runnerDefaults,
      ...Object.fromEntries(
        Object.entries({
          shardLockExpiration: options.shardLockExpiration,
          refreshAssignmentsInterval: options.refreshAssignmentsInterval,
          shardLockRefreshInterval: options.shardLockRefreshInterval,
        }).filter(([, value]) => value !== undefined),
      ),
      runnerAddress: Option.some(RunnerAddress.RunnerAddress.make(options.address)),
      runnerListenAddress: Option.fromUndefinedOr(options.listenAddress).pipe(
        Option.map((value) => RunnerAddress.RunnerAddress.make(value)),
      ),
      shardsPerGroup: engine.catalog.shards,
      preemptiveShutdown: false,
    }
    const address = Option.getOrThrow(config.runnerAddress)
    const raw = yield* runnerStorage.pipe(
      Effect.provideService(ShardingConfig.ShardingConfig, config),
    )
    let draining = false
    let registered = false
    let registration: Effect.Success<ReturnType<typeof raw.register>> | undefined
    let storageHealthy = true
    let completed = false
    let drainReport: Deferred.Deferred<DrainReport> | undefined
    const held = new Set<number>()
    const blocked = new Set<number>()
    const expected = new Set<number>()
    const healthy = <A, E, R>(run: Effect.Effect<A, E, R>) =>
      run.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            storageHealthy = true
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            storageHealthy = false
          }),
        ),
      )
    const storage = RunnerStorage.RunnerStorage.of({
      ...raw,
      getRunners: healthy(raw.getRunners).pipe(
        Effect.tap((runners) =>
          Effect.sync(() => {
            const ring = HashRing.make<RunnerAddress.RunnerAddress>()
            for (const [runner, isHealthy] of runners)
              if (isHealthy) HashRing.add(ring, runner.address, { weight: runner.weight })
            expected.clear()
            for (const [id, owner] of (
              HashRing.getShards(ring, engine.catalog.shards) ?? []
            ).entries())
              if (Equal.equals(owner, address)) expected.add(id)
          }),
        ),
      ),
      register: (runner, healthy) =>
        Effect.suspend(() =>
          draining && registration !== undefined
            ? Effect.succeed(registration)
            : raw.register(runner, healthy).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    registered = true
                  }),
                ),
                Effect.tap((id) =>
                  Effect.sync(() => {
                    registration = id
                  }),
                ),
                Effect.tap(() => (draining ? raw.unregister(runner.address) : Effect.void)),
              ),
        ),
      acquire: (runner, ids) =>
        Effect.gen(function* () {
          if (draining) return []
          const acquired = yield* healthy(raw.acquire(runner, ids))
          const fresh = acquired.map((id) => id.id - 1).filter((id) => !held.has(id))
          for (const id of fresh) held.add(id)
          yield* engine.assign(fresh)
          return acquired
        }),
      refresh: (runner, ids) =>
        Effect.gen(function* () {
          if (draining) return []
          const requested = Array.from(ids)
          const refreshed = yield* healthy(raw.refresh(runner, requested))
          const kept = new Set(refreshed.map((id) => id.id - 1))
          const lost = requested.map((id) => id.id - 1).filter((id) => !kept.has(id))
          for (const id of lost) held.delete(id)
          yield* engine.unassign(lost)
          return refreshed
        }),
      release: (runner, id) =>
        Effect.gen(function* () {
          if (!draining && held.has(id.id - 1)) {
            const released = yield* engine
              .release(id.id - 1)
              .pipe(Effect.timeoutOption(options.drainDeadline ?? "15 seconds"))
            if (!Option.contains(released, true)) blocked.add(id.id - 1)
          }
          if (!draining && blocked.has(id.id - 1))
            return yield* PersistenceError.make({
              cause: new Error(`Shard ${id.id - 1} did not durably release`),
            })
          held.delete(id.id - 1)
          blocked.delete(id.id - 1)
          yield* raw.release(runner, id)
        }),
      releaseAll: (runner) =>
        Effect.gen(function* () {
          yield* engine.unassign(Array.from(held))
          held.clear()
          yield* raw.releaseAll(runner)
        }),
    })
    const clusterLayer = SocketRunner.layer.pipe(
      Layer.provideMerge(mtls(options.peering)),
      Layer.provide(Layer.succeed(RunnerStorage.RunnerStorage, storage)),
      Layer.provide(MessageStorage.layerNoop),
      Layer.provide(RunnerHealth.layerNoop),
      Layer.provide(ShardingConfig.layer(config)),
      Layer.provide(RpcSerialization.layerNdjson),
    )
    const services = yield* Layer.build(clusterLayer)
    const cluster = Context.get(services, Cluster.Sharding)
    const peerHealth = Context.get(services, PeerHealth)
    const keys: Array<string> = []
    for (let shard = 0; shard < engine.catalog.shards; shard++) {
      let candidate = 0
      while (true) {
        const key = `${shard}:${candidate++}`
        if (cluster.getShardId(EntityId.make(key), "default").id === shard + 1) {
          keys.push(key)
          break
        }
      }
    }
    const actorOf = (name: string): AnyActor => Durable.bound(engine.catalog, name).actor
    const commandOf = (payload: typeof CommandPayload.Type, caller: Caller): Command => ({
      ...payload,
      actor: actorOf(payload.actor),
      keyJson: payload.id,
      caller,
      connection: payload.connection,
    })
    const read = (headers: Headers.Headers) =>
      Effect.map(callerOf(headers), (caller) => Transports.reads(engine, caller))
    yield* cluster.registerEntity(
      entity,
      Effect.gen(function* () {
        const own = yield* Entity.CurrentAddress
        const shard = own.shardId.id - 1
        const target = (payload: typeof Target.Type) => ({
          actor: actorOf(payload.actor),
          id: payload.id,
        })
        const member = (payload: typeof Member.Type) => ({
          ...target(payload),
          member: payload.member,
          params: payload.payload,
        })
        const range = (
          payload: typeof RangePayload.Type & { readonly actor: string; readonly member: string },
        ) => ({ ...target(payload), member: payload.member, range: payload })
        const guard = <A, E, R>(run: Effect.Effect<A, E, R>): Effect.Effect<A, E | ActorError, R> =>
          Effect.suspend<A, E | ActorError, R>(() =>
            draining || !cluster.hasShardId(own.shardId) ? Effect.fail(moved()) : run,
          )
        return entity.of({
          Admit: ({ payload, headers }) =>
            guard(
              Effect.flatMap(callerOf(headers), (caller) =>
                Transports.admitted(engine, caller, payload.commandId, {
                  ...target(payload),
                  member: payload.member,
                  payload: payload.payload,
                }).pipe(
                  Effect.map(({ reply, replayed }) => ({
                    outcome:
                      reply.kind === "Success"
                        ? Outcome.cases.Success.make({ value: reply.value })
                        : Outcome.cases.Failure.make({ error: reply.error }),
                    replayed,
                  })),
                ),
              ),
            ),
          Execute: ({ payload, headers }) =>
            guard(
              Effect.flatMap(callerOf(headers), (caller) =>
                engine.execute(commandOf(payload, caller)),
              ),
            ),
          State: ({ payload, headers }) =>
            Stream.unwrap(
              guard(Effect.map(read(headers), (reads) => reads.state(target(payload)))),
            ).pipe(Stream.interruptWhen(engine.ownerClosed(shard))),
          View: ({ payload, headers }) =>
            Stream.unwrap(
              guard(Effect.map(read(headers), (reads) => reads.view(member(payload)))),
            ).pipe(Stream.interruptWhen(engine.ownerClosed(shard))),
          Event: ({ payload, headers }) =>
            Stream.unwrap(
              guard(Effect.map(read(headers), (reads) => reads.event(member(payload)))),
            ).pipe(Stream.interruptWhen(engine.ownerClosed(shard))),
          Range: ({ payload, headers }) =>
            guard(Effect.flatMap(read(headers), (reads) => reads.range(range(payload)))),
          Watch: ({ payload, headers }) =>
            Stream.unwrap(
              guard(Effect.map(read(headers), (reads) => reads.watch(range(payload)))),
            ).pipe(Stream.interruptWhen(engine.ownerClosed(shard))),
          Join: ({ payload, headers }) =>
            Stream.unwrap(
              guard(
                Effect.map(read(headers), (reads) =>
                  Stream.unwrap(
                    Effect.as(
                      reads.join({ ...target(payload), presence: payload.payload }),
                      Stream.concat(Stream.make(undefined), Stream.never),
                    ),
                  ),
                ),
              ),
            ).pipe(Stream.interruptWhen(engine.ownerClosed(shard))),
          Find: ({ payload, headers }) =>
            guard(
              Effect.gen(function* () {
                const caller = yield* callerOf(headers)
                const actor = actorOf(payload.actor)
                const query = yield* FindCodec.decode(actor, payload)
                const ids = yield* Transports.reads(engine, caller, [shard]).find({ actor, query })
                return yield* Effect.forEach(ids, (id) =>
                  Effect.map(engine.durableRecord(actor, id), (record) => ({
                    id,
                    order:
                      payload.orderBy === undefined
                        ? null
                        : (record.image.encoded[payload.orderBy.field] ?? null),
                  })),
                )
              }),
            ),
        })
      }),
      { concurrency: "unbounded", maxIdleTime: Duration.infinity, disableFatalDefects: true },
    )
    const clients = yield* cluster.makeClient(entity)
    const clientFor = (actor: AnyActor, id: Schema.Json) =>
      clients(keys[engine.shardOf(Durable.addressOf(actor.name, id))]!)
    const header = (caller: Caller) => ({
      headers: { [CALLER]: JSON.stringify(caller) },
    })
    const refail = <A, E, R>(
      run: Effect.Effect<A, E | ActorError, R>,
    ): Effect.Effect<A, ActorError, R> =>
      run.pipe(
        Effect.mapError((error) => (Schema.is(ActorError)(error) ? error : unavailable())),
        Effect.timeoutOrElse({
          duration: options.requestTimeout ?? "10 seconds",
          orElse: () => Effect.fail(unavailable()),
        }),
      )
    const streamRefail = <A, E>(run: Stream.Stream<A, E | ActorError>) =>
      run.pipe(Stream.mapError((error) => (Schema.is(ActorError)(error) ? error : unavailable())))
    const payloadOf = (command: Command) => ({
      ...command,
      actor: command.actor.name,
      id: command.keyJson,
    })
    const execute = (command: Command) =>
      refail(
        clientFor(command.actor, command.keyJson).Execute(
          payloadOf(command),
          header(command.caller),
        ),
      )
    engine.route(execute)
    const reads = (caller: Caller): Omit<Transport, "call"> => ({
      state: (request) =>
        streamRefail(
          clientFor(request.actor, request.id).State(
            { actor: request.actor.name, id: request.id },
            header(caller),
          ),
        ),
      view: (request) =>
        streamRefail(
          clientFor(request.actor, request.id).View(
            {
              actor: request.actor.name,
              id: request.id,
              member: request.member,
              payload: request.params,
            },
            header(caller),
          ),
        ),
      event: (request) =>
        streamRefail(
          clientFor(request.actor, request.id).Event(
            {
              actor: request.actor.name,
              id: request.id,
              member: request.member,
              payload: request.params,
            },
            header(caller),
          ),
        ),
      range: (request) =>
        refail(
          clientFor(request.actor, request.id).Range(
            { actor: request.actor.name, id: request.id, member: request.member, ...request.range },
            header(caller),
          ),
        ),
      watch: (request) =>
        streamRefail(
          clientFor(request.actor, request.id).Watch(
            { actor: request.actor.name, id: request.id, member: request.member, ...request.range },
            header(caller),
          ),
        ),
      join: (request) =>
        Effect.gen(function* () {
          const joined = yield* Deferred.make<void, ActorError>()
          const joining = yield* streamRefail(
            clientFor(request.actor, request.id).Join(
              {
                actor: request.actor.name,
                id: request.id,
                member: "join",
                payload: request.presence,
              },
              header(caller),
            ),
          ).pipe(
            Stream.runForEach(() => Deferred.succeed(joined, undefined)),
            Effect.tapError((error) => Deferred.fail(joined, error)),
            Effect.forkScoped,
          )
          yield* Effect.addFinalizer(() => Fiber.interrupt(joining))
          yield* Deferred.await(joined)
        }),
      find: (request) =>
        Effect.gen(function* () {
          const payload = yield* FindCodec.encode(request.actor, request.query)
          const partitions = yield* Effect.forEach(
            keys,
            (key) =>
              refail(clients(key).Find({ actor: request.actor.name, ...payload }, header(caller))),
            { concurrency: "unbounded" },
          )
          const rows = partitions.flat()
          const order = request.query.orderBy
          if (order !== undefined)
            rows.sort((a, b) =>
              a.order === b.order
                ? 0
                : ((a.order ?? "") < (b.order ?? "") ? -1 : 1) *
                  (order.direction === "desc" ? -1 : 1),
            )
          return rows.slice(0, request.query.limit ?? 1_000).map((row) => row.id)
        }),
    })
    return Sharding.of({
      execute,
      reads,
      admitted: (caller, commandId, request) =>
        Effect.gen(function* () {
          const admission = yield* refail(
            clientFor(request.actor, request.id).Admit(
              {
                actor: request.actor.name,
                id: request.id,
                member: request.member,
                payload: request.payload,
                commandId,
                origin: Origin.cases.External.make({ expiresAt: 0 }),
                connection: undefined,
              },
              header(caller),
            ),
          )
          return {
            reply: yield* Transports.reply(request.actor, request.member, admission.outcome),
            replayed: admission.replayed,
          }
        }),
      readiness: Effect.gen(function* () {
        if (draining) return { ready: false, reason: completed ? "drained" : "draining" }
        if (!(yield* peerHealth.healthy)) return { ready: false, reason: "peering" }
        if (!storageHealthy) return { ready: false, reason: "storage" }
        if (!registered || (yield* cluster.isShutdown)) return { ready: false, reason: "routing" }
        for (let id = 0; id < engine.catalog.shards; id++) {
          if (
            expected.has(id) &&
            (!cluster.hasShardId(ShardId.make("default", id + 1)) ||
              engine.status(id).status !== "open")
          )
            return { ready: false, reason: "routing" }
        }
        return yield* engineReady(engine, expected)
      }),
      drain: (deadline) =>
        Effect.suspend(() => {
          if (drainReport !== undefined) return Deferred.await(drainReport)
          draining = true
          drainReport = Deferred.makeUnsafe<DrainReport>()
          return Effect.gen(function* () {
            const started = yield* Clock.monotonicTimeNanos
            const report = yield* engine.drain(deadline)
            const elapsed = Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000
            const remaining = Math.max(
              0,
              Duration.toMillis(Duration.fromInputUnsafe(deadline)) - elapsed,
            )
            yield* raw
              .unregister(address)
              .pipe(
                Effect.andThen(raw.releaseAll(address)),
                Effect.ignore,
                Effect.timeoutOption(Duration.millis(remaining)),
              )
            completed = true
            yield* Deferred.succeed(drainReport!, report)
            return report
          }).pipe(Effect.uninterruptible)
        }),
    })
  })

/** Builds local routing or the bucket-backed socket cluster for one engine. */
export const Routing = {
  make: (engine: Engine, options?: RunnerOptions) =>
    options === undefined ? local(engine) : clustered(engine, options),
}
