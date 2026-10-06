import { connect, Socket as NetSocket } from "node:net"
import {
  Context,
  Crypto,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashRing,
  Layer,
  Option,
  Queue,
  Redacted,
  Schedule,
  Scope,
} from "effect"
import { RunnerAddress, RunnerServer, Runners, RunnerStorage } from "effect/cluster"
import { NetAddress } from "effect/net"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import { Socket, SocketServer } from "effect/socket"
import { SqlClient } from "effect/sql"
import { InternalActors } from "../runtime/actors.ts"
import type { ActorRef } from "../identity/caller.ts"
import { Database } from "../runtime/layer.ts"
import { RunnerWiring } from "../runtime/runner.ts"
import { admissionSharding } from "../runtime/topology/admission.ts"
import { ActorTest, ClusterMember, type TestOptions } from "./actor-test.ts"

/** Enough shards that every runner of a small cluster owns several, so actors spread and a killed runner's actors move. */
const SHARDS = 32

/** Shorter than Cluster's defaults so a test sees runner changes within a second; lock timing is the caller's `shardLockExpiration`. */
const TIMINGS = {
  refreshAssignmentsInterval: "250 millis",
  entityMessagePollInterval: "250 millis",
  sendRetryInterval: "50 millis",
  entityTerminationTimeout: "2 seconds",
} as const

/** Services each runner provides to effects run with `cluster.on(runner)`. */
export type RunnerServices = Layer.Success<ReturnType<typeof ActorTest.layer>>

export interface ClusterOptions<ROut, E, RIn> extends TestOptions {
  /** Number of runners, at least 1. */
  readonly runners: number
  /** How long a runner's shard locks outlive its last heartbeat. Whole seconds; Cluster rounds up. */
  readonly shardLockExpiration: Duration.Input
  /** Application layers (`X.toLayer`, `X.toQueryLayer`, ...) that every runner builds. */
  readonly actors: Layer.Layer<ROut, E, RIn>
  /** Layers only some runners build, such as an effect layer one runner lacks. */
  readonly runnerActors?: (runner: number) => Layer.Layer<never, never, RunnerServices>
  /**
   * Runners that hold connections but are never assigned actor shards, so an
   * actor is always owned by another runner and killing its owner leaves the
   * holder alive.
   */
  readonly holdersOnly?: ReadonlyArray<number>
}

/** Sessions per pool for each runner unless a cluster says otherwise; three runners hold 24 sessions at most. */
const RUNNER_CONNECTIONS = 4

export class ActorCluster extends Context.Service<
  ActorCluster,
  {
    readonly runners: number
    /** The tenant every runner of this cluster runs its actors under. */
    readonly tenant: string
    /**
     * A connection pool of the cluster's own to the shared database, for
     * inspection: `kill` never cuts it.
     */
    readonly sql: SqlClient.SqlClient
    /**
     * Runs `effect` on `runner`: its handles dispatch through that runner, and
     * its `ActorTest` fault points and inspection belong to that runner. An
     * effect already running when its runner is killed is not interrupted; its
     * calls fail or time out, so call through a surviving runner.
     */
    readonly on: (
      runner: number,
    ) => <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, Exclude<R, RunnerServices>>
    /**
     * Stops `runner` the way a crash does: its connections close, rolling back
     * open turns, and its shard locks and heartbeat are left to expire.
     */
    readonly kill: (runner: number) => Effect.Effect<void>
    /**
     * Stops `runner` the way a graceful process exit does: its layer closes,
     * so its activations end and it releases its shard locks for the others
     * to take at once. Drain it first to finish or interrupt its work.
     */
    readonly shutdown: (runner: number) => Effect.Effect<void>
    /**
     * Delays every database reply to every runner, without dropping it, as a
     * partition between the database and its clients would: statements a turn
     * sends still run, but it hears nothing back until `failover`. A COMMIT
     * sent meanwhile is made by the database and unknown to its runner.
     */
    readonly holdReplies: Effect.Effect<void>
    /**
     * Cuts every runner's open database connections at once, discarding held
     * replies, and lets the runners reconnect to the same database, as they
     * do when a primary fails over to a promoted standby at the same address:
     * open turns lose their connection, and shard locks, which are table
     * rows, survive.
     */
    readonly failover: Effect.Effect<void>
    /** Starts a stopped runner again as a new process, under a new address. */
    readonly restart: (runner: number) => Effect.Effect<void>
    /**
     * Stops `runner` writing heartbeats and lock refreshes while it keeps
     * serving the shards it holds: other runners take its shards once its
     * locks expire, and only the database fence stands between the two.
     */
    readonly pauseHeartbeat: (
      runner: number,
    ) => Effect.Effect<{ readonly resume: Effect.Effect<void> }>
    /**
     * The runner holding an unexpired lock on the shard that places `ref`.
     * While a runner's heartbeat is paused, it may still serve the actor too.
     */
    readonly owner: (ref: ActorRef) => Effect.Effect<number | undefined>
    /** Waits until every running runner holds exactly the shards assigned to it. */
    readonly ready: Effect.Effect<void>
  }
>()("@rikalabs/akter/testing/cluster/ActorCluster") {}

interface Runner {
  address: RunnerAddress.RunnerAddress
  /** Open database sockets; `undefined` once the runner is killed, so none can open. */
  sockets: Set<NetSocket> | undefined
  scope: Scope.Closeable | undefined
  context: Context.Context<RunnerServices> | undefined
  heartbeat: "running" | "paused" | "killed"
  /** The runners this runner last saw; a paused runner keeps seeing them. */
  runners: Effect.Success<RunnerStorage.RunnerStorage["Service"]["getRunners"]> | undefined
}

const key = (address: RunnerAddress.RunnerAddress) => `${address.host}:${address.port}`

const unreachable = (address: RunnerAddress.RunnerAddress) =>
  Socket.SocketError.make({
    reason: Socket.SocketOpenError.make({
      kind: "Unknown",
      cause: new Error(`Runner ${key(address)} is unreachable`),
    }),
  })

/**
 * The accepting end of a connection, whose writes fail once its reader has
 * closed, as they do on a closed TCP socket. `Socket.fromTransformStream`
 * holds such a write until a reader opens again, which lets a client ride out
 * a redial, but an accepted connection never opens again. Its reader also
 * closes asynchronously, and the runner server keeps sending to the
 * connection until that close finishes, from a region that cannot be
 * interrupted: a reply sent meanwhile would wait forever and keep the killed
 * runner's server from closing.
 */
const accepted = (socket: Socket.Socket) => {
  let closed = false

  const refused = Socket.SocketError.make({
    reason: Socket.SocketWriteError.make({ cause: new Error("Connection closed") }),
  })

  return Socket.make({
    reader: socket.reader.pipe(
      Effect.tap(() =>
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true
          }),
        ),
      ),
    ),
    writer: socket.writer.pipe(
      Effect.map((writer): Socket.Writer => ({
        write: (chunk) =>
          Effect.suspend(() => (closed ? Effect.fail(refused) : writer.write(chunk))),
        writeAll: (chunks) =>
          Effect.suspend(() => (closed ? Effect.fail(refused) : writer.writeAll(chunks))),
      })),
    ),
  })
}

/**
 * Runner-to-runner connections inside one process. Every frame is encoded and
 * decoded as it would be on a socket, and a killed runner's connections fail
 * mid-stream.
 */
const makeNetwork = Effect.sync(() => {
  const listeners = new Map<string, Queue.Queue<Socket.Socket>>()
  const links = new Map<string, Set<() => void>>()

  const pipe = (sever: Set<() => void>) => {
    let controller: TransformStreamDefaultController<Uint8Array> | undefined

    const stream = new TransformStream<Uint8Array, Uint8Array>({
      start: (started) => {
        controller = started
      },
    })

    sever.add(() => controller?.error(new Error("Runner killed")))

    return stream
  }

  const dial = (address: RunnerAddress.RunnerAddress) =>
    Effect.suspend(() => {
      const accept = listeners.get(key(address))
      const sever = links.get(key(address))

      if (accept === undefined || sever === undefined) return Effect.fail(unreachable(address))

      const up = pipe(sever)
      const down = pipe(sever)

      return Socket.fromTransformStream(
        Effect.succeed({ readable: up.readable, writable: down.writable }),
      ).pipe(
        Effect.flatMap((socket) => Queue.offer(accept, accepted(socket))),
        Effect.as({ readable: down.readable, writable: up.writable }),
      )
    })

  const listen = (address: RunnerAddress.RunnerAddress) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const accept = yield* Queue.unbounded<Socket.Socket>()
        listeners.set(key(address), accept)
        links.set(key(address), new Set())

        return SocketServer.SocketServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", address.port),
          run: (handler) =>
            Queue.take(accept).pipe(
              Effect.flatMap((socket) => Effect.forkChild(handler(socket))),
              Effect.forever,
            ),
        })
      }),
      () => Effect.sync(() => close(address)),
    )

  const close = (address: RunnerAddress.RunnerAddress) => {
    listeners.delete(key(address))

    for (const sever of links.get(key(address)) ?? []) sever()
    links.delete(key(address))
  }

  const serialization = RpcSerialization.ndjson

  const clients = Runners.RpcClientProtocol.of({
    codecFor: serialization.codecFor,
    make: (address) =>
      Socket.fromTransformStream(dial(address)).pipe(
        Effect.flatMap((socket) =>
          RpcClient.makeProtocolSocket().pipe(Effect.provideService(Socket.Socket, socket)),
        ),
        Effect.provideService(RpcSerialization.RpcSerialization, serialization),
      ),
  })

  const runner = (address: RunnerAddress.RunnerAddress) =>
    RunnerServer.layer.pipe(
      Layer.provideMerge(admissionSharding),
      Layer.provideMerge(Runners.layerRpc),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(Layer.effect(SocketServer.SocketServer, listen(address))),
      Layer.provide(Layer.succeed(Runners.RpcClientProtocol, clients)),
      Layer.provide(Layer.succeed(RpcSerialization.RpcSerialization, serialization)),
    )

  return { runner, close }
})

/**
 * Provides an `ActorCluster` of `options.runners` real runners sharing one Postgres database, each serving runner RPCs on its own listener.
 * The first runner migrates the database and the rest start together. Runner rows carry the cluster's tenant, so rows another cluster left in the same database are never mistaken for this one's.
 * `kill` cuts a runner's database and runner connections at once so Postgres rolls back its open turns; a graceful exit closes its layer first so it releases its locks.
 * Fails to build when `database` is missing or is not a Postgres URL, since PGlite has a single connection.
 */
export const clusterLayer = <ROut, E, RIn>(options: ClusterOptions<ROut, E, RIn>) =>
  Layer.effect(
    ActorCluster,
    Effect.gen(function* () {
      const { database } = options

      if (database === undefined || !Redacted.isRedacted(database))
        return yield* Effect.die(
          new Error(
            "ActorTest.cluster needs a Postgres database URL; PGlite has a single connection, so it cannot host several runners",
          ),
        )

      if (!Number.isInteger(options.runners) || options.runners < 1)
        return yield* Effect.die(new Error("ActorTest.cluster needs at least one runner"))

      if (
        Array.from({ length: options.runners }).every((_, index) =>
          (options.holdersOnly ?? []).includes(index),
        )
      )
        return yield* Effect.die(new Error("ActorTest.cluster needs a runner that hosts actors"))

      const expiration = Duration.fromInputUnsafe(options.shardLockExpiration)
      const expirationSeconds = Math.ceil(Duration.toSeconds(expiration))
      const crypto = yield* Crypto.Crypto
      const tenant = yield* crypto.randomUUIDv4.pipe(Effect.orDie)
      const network = yield* makeNetwork
      const services = yield* Effect.context<Crypto.Crypto | Exclude<RIn, RunnerServices>>()

      const sql = Context.get(
        yield* Layer.build(Database.postgres({ url: database, maxConnections: 2 })).pipe(
          Effect.orDie,
        ),
        SqlClient.SqlClient,
      )

      const host = `runner-${tenant}`
      let incarnation = 0
      const runners: Array<Runner> = []
      const addresses = new Map<string, number>()
      const stopping: Array<Fiber.Fiber<void>> = []
      const url = new URL(Redacted.value(database))

      let holding = false

      const failover = Effect.sync(() => {
        holding = false

        for (const runner of runners) for (const socket of runner.sockets ?? []) socket.destroy()
      })

      const hostsActors = (runner: Runner) =>
        !(options.holdersOnly ?? []).includes(runners.indexOf(runner))

      /**
       * Bound to one incarnation's socket set, so a killed process that is
       * still winding down cannot reach the database again once its runner
       * has started as a new process.
       */
      const dial = (runner: Runner, incarnationSockets: Set<NetSocket>) => () => {
        const sockets = runner.sockets === incarnationSockets ? incarnationSockets : undefined

        if (sockets === undefined) {
          const refused = new NetSocket()
          queueMicrotask(() => refused.destroy(new Error("Runner killed")))

          return refused
        }

        const socket = connect({
          host: url.hostname,
          port: Number(url.port || 5432),
          noDelay: true,
        })

        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))

        if (holding) socket.pause()

        return socket
      }

      /**
       * A killed process that is still winding down stays killed when its
       * runner starts again under a new address.
       */
      const storage =
        (runner: Runner, mine: RunnerAddress.RunnerAddress) =>
        (inner: RunnerStorage.RunnerStorage["Service"]): RunnerStorage.RunnerStorage["Service"] => {
          const state = (): Runner["heartbeat"] =>
            runner.address === mine ? runner.heartbeat : "killed"

          return {
            ...inner,
            getRunners: Effect.suspend(() =>
              state() === "running" || runner.runners === undefined
                ? inner.getRunners.pipe(
                    Effect.tap((seen) =>
                      Effect.sync(() => {
                        runner.runners = seen
                      }),
                    ),
                  )
                : Effect.succeed([...runner.runners]),
            ),
            refresh: (address, shardIds) =>
              Effect.suspend(() => {
                if (state() === "running") return inner.refresh(address, shardIds)

                return Effect.succeed(state() === "paused" ? Array.from(shardIds) : [])
              }),
            acquire: (address, shardIds) =>
              Effect.suspend(() =>
                state() === "running" ? inner.acquire(address, shardIds) : Effect.succeed([]),
              ),
            release: (address, shardId) =>
              Effect.suspend(() =>
                state() === "running" ? inner.release(address, shardId) : Effect.void,
              ),
            releaseAll: (address) =>
              Effect.suspend(() =>
                state() === "running" ? inner.releaseAll(address) : Effect.void,
              ),
            unregister: (address) =>
              Effect.suspend(() =>
                state() === "running" ? inner.unregister(address) : Effect.void,
              ),
            setRunnerHealth: (address, healthy) =>
              Effect.suspend(() =>
                state() === "running" ? inner.setRunnerHealth(address, healthy) : Effect.void,
              ),
          }
        }

      const start = Effect.fnUntraced(function* (runner: Runner) {
        incarnation += 1
        runner.address = RunnerAddress.RunnerAddress.make({ host, port: incarnation })
        runner.heartbeat = "running"
        runner.runners = undefined
        const sockets = new Set<NetSocket>()
        runner.sockets = sockets
        addresses.set(key(runner.address), runners.indexOf(runner))

        const scope = yield* Scope.make()
        runner.scope = scope

        const layer = Layer.merge(
          options.actors,
          options.runnerActors?.(runners.indexOf(runner)) ?? Layer.empty,
        ).pipe(
          Layer.provideMerge(
            ActorTest.layer({
              ...options,
              maxConnections: options.maxConnections ?? RUNNER_CONNECTIONS,
            }).pipe(
              Layer.provide([
                Layer.succeed(ClusterMember, { tenant, connect: dial(runner, sockets) }),
                Layer.succeed(RunnerWiring, {
                  config: {
                    ...TIMINGS,
                    runnerAddress: Option.some(runner.address),
                    shardsPerGroup: SHARDS,
                    assignedShardGroups: hostsActors(runner) ? ["default"] : [],
                    shardLockExpiration: expiration,
                    shardLockDisableAdvisory: true,
                  },
                  sharding: network.runner(runner.address),
                  storage: storage(runner, runner.address),
                }),
              ]),
            ),
          ),
        )

        runner.context = yield* Layer.buildWithMemoMap(layer, yield* Layer.makeMemoMap, scope).pipe(
          Effect.provideContext(services),
          Effect.orDie,
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
      })

      const stop = Effect.fnUntraced(function* (runner: Runner) {
        const { scope, sockets } = runner

        runner.heartbeat = "killed"
        runner.scope = undefined
        runner.context = undefined
        runner.sockets = undefined
        network.close(runner.address)

        for (const socket of sockets ?? []) socket.destroy()

        if (scope !== undefined)
          stopping.push(yield* Effect.forkDetach(Scope.close(scope, Exit.void)))
      })

      const shutdown = Effect.fnUntraced(function* (runner: Runner) {
        const scope = runner.scope

        runner.scope = undefined
        runner.context = undefined

        if (scope !== undefined) yield* Scope.close(scope, Exit.void)
        yield* stop(runner)
      })

      const at = (index: number) =>
        Effect.suspend(() => {
          const runner = runners[index]

          return runner === undefined
            ? Effect.die(new Error(`No runner ${index}; the cluster has ${runners.length}`))
            : Effect.succeed(runner)
        })

      const live = (index: number) =>
        at(index).pipe(
          Effect.flatMap((runner) =>
            runner.context === undefined
              ? Effect.die(new Error(`Runner ${index} is stopped`))
              : Effect.succeed(runner.context),
          ),
        )

      const locks = sql<{ shard_id: string; address: string }>`
        SELECT shard_id, address FROM cluster_locks
        WHERE acquired_at >= NOW() - ${`${expirationSeconds} seconds`}::interval
          AND address LIKE ${`${host}:%`}`.pipe(Effect.orDie)

      const ready = Effect.gen(function* () {
        const serving = runners.filter(
          (runner) => runner.heartbeat === "running" && hostsActors(runner),
        )

        if (serving.length === 0) return true

        const ring = HashRing.make<RunnerAddress.RunnerAddress>()

        for (const runner of serving) HashRing.add(ring, runner.address, { weight: 1 })
        const expected = HashRing.getShards(ring, SHARDS)!
        const held = new Map((yield* locks).map((lock) => [lock.shard_id, lock.address]))

        return expected.every((address, index) => held.get(`default:${index + 1}`) === key(address))
      }).pipe(
        Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (settled) => settled }),
        Effect.timeoutOrElse({
          duration: "60 seconds",
          orElse: () => Effect.die(new Error("Cluster runners did not settle their shards")),
        }),
        Effect.asVoid,
      )

      yield* Effect.addFinalizer(() =>
        Effect.forEach(runners, stop, { discard: true }).pipe(
          Effect.andThen(Fiber.awaitAll(stopping)),
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.die(new Error("Killed cluster runners did not wind down")),
          }),
        ),
      )

      for (let index = 0; index < options.runners; index++)
        runners.push({
          address: RunnerAddress.RunnerAddress.make({ host: "runner", port: 0 }),
          sockets: undefined,
          scope: undefined,
          context: undefined,
          heartbeat: "killed",
          runners: undefined,
        })

      yield* start(runners[0]!)
      yield* Effect.forEach(runners.slice(1), start, { concurrency: "unbounded", discard: true })
      yield* ready

      return ActorCluster.of({
        runners: options.runners,
        tenant,
        sql,
        on: (index) => (effect) =>
          live(index).pipe(Effect.flatMap((context) => Effect.provideContext(effect, context))),
        holdReplies: Effect.sync(() => {
          holding = true

          for (const runner of runners) for (const socket of runner.sockets ?? []) socket.pause()
        }),
        failover,
        kill: (index) => at(index).pipe(Effect.flatMap(stop)),
        shutdown: (index) => at(index).pipe(Effect.flatMap(shutdown)),
        restart: (index) =>
          at(index).pipe(
            Effect.tap((runner) => (runner.scope === undefined ? Effect.void : stop(runner))),
            Effect.flatMap(start),
          ),
        pauseHeartbeat: (index) =>
          at(index).pipe(
            Effect.flatMap((runner) =>
              runner.heartbeat === "running"
                ? Effect.sync(() => {
                    const paused = runner.address
                    runner.heartbeat = "paused"

                    return {
                      resume: Effect.sync(() => {
                        if (runner.heartbeat === "paused" && runner.address === paused)
                          runner.heartbeat = "running"
                      }),
                    }
                  })
                : Effect.die(new Error(`Runner ${index} is not running`)),
            ),
          ),
        owner: Effect.fnUntraced(function* (ref: ActorRef) {
          const serving = runners.find((runner) => runner.context !== undefined)

          if (serving === undefined) return undefined

          const shard = yield* Context.get(serving.context!, InternalActors).shardId(ref)
          const holder = (yield* locks).find((lock) => lock.shard_id === shard)

          return holder === undefined ? undefined : addresses.get(holder.address)
        }),
        ready,
      })
    }),
  )
