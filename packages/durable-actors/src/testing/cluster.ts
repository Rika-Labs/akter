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
import {
  RunnerAddress,
  RunnerServer,
  Runners,
  RunnerStorage,
} from "effect/unstable/cluster"
import { NetAddress } from "effect/unstable/net"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Socket, SocketServer } from "effect/unstable/socket"
import { SqlClient } from "effect/unstable/sql"
import { InternalActors } from "../handles/actors.ts"
import type { ActorRef } from "../identity/caller.ts"
import { Database } from "../runtime/layer.ts"
import { type TestOptions, testLayer } from "./actor-test.ts"

// Enough shards that every runner of a small cluster owns several, so actors
// spread and a killed runner's actors move.
const SHARDS = 32

// Shorter than Cluster's defaults so a test sees runner changes within a
// second; lock timing itself is the caller's `shardLockExpiration`. A killed
// runner's leftover entity fibers get the termination timeout to wind down.
const TIMINGS = {
  refreshAssignmentsInterval: "250 millis",
  entityMessagePollInterval: "250 millis",
  sendRetryInterval: "50 millis",
  entityTerminationTimeout: "2 seconds",
} as const

/** Services each runner provides to effects run with `cluster.on(runner)`. */
export type RunnerServices = Layer.Success<ReturnType<typeof testLayer>>

export interface ClusterOptions<ROut, E, RIn> extends TestOptions {
  /** Number of runners, at least 1. */
  readonly runners: number
  /** How long a runner's shard locks outlive its last heartbeat. Whole seconds; Cluster rounds up. */
  readonly shardLockExpiration: Duration.Input
  /** Application layers (`X.toLayer`, `X.toQueryLayer`, ...) that every runner builds. */
  readonly actors: Layer.Layer<ROut, E, RIn>
}

export class ActorCluster extends Context.Service<
  ActorCluster,
  {
    readonly runners: number
    /**
     * Runs `effect` on `runner`: its handles dispatch through that runner, and
     * its `ActorTest` fault points and inspection belong to that runner.
     */
    readonly on: (
      runner: number,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, RunnerServices>>
    /**
     * Stops `runner` the way a crash does: its connections close, rolling back
     * open turns, and its shard locks and heartbeat are left to expire.
     */
    readonly kill: (runner: number) => Effect.Effect<void>
    /** Starts a stopped runner again as a new process, under a new address. */
    readonly restart: (runner: number) => Effect.Effect<void>
    /**
     * Stops `runner` writing heartbeats and lock refreshes while it keeps
     * serving the shards it holds: other runners take its shards once its
     * locks expire, and only the database fence stands between the two.
     */
    readonly pauseHeartbeat: (runner: number) => Effect.Effect<{ readonly resume: Effect.Effect<void> }>
    /** The runner holding an unexpired lock on the shard that places `ref`. */
    readonly owner: (ref: ActorRef) => Effect.Effect<number | undefined>
    /** Waits until every running runner holds exactly the shards assigned to it. */
    readonly ready: Effect.Effect<void>
  }
>()("durable-actors/testing/cluster/ActorCluster") {}

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
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({
      kind: "Unknown",
      cause: new Error(`Runner ${key(address)} is unreachable`),
    }),
  })

/**
 * Runner-to-runner connections inside one process. Every frame is encoded and
 * decoded as it would be on a socket, and a killed runner's connections fail
 * mid-stream.
 */
const makeNetwork = Effect.gen(function* () {
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
        Effect.flatMap((socket) => Queue.offer(accept, socket)),
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

  // A runner serves runner RPCs on its own listener and dials the others.
  const runner = (address: RunnerAddress.RunnerAddress) =>
    RunnerServer.layerWithClients.pipe(
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(Layer.effect(SocketServer.SocketServer, listen(address))),
      Layer.provide(Layer.succeed(Runners.RpcClientProtocol, clients)),
      Layer.provide(Layer.succeed(RpcSerialization.RpcSerialization, serialization)),
    )

  return { runner, close }
})

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

      const expiration = Duration.fromInputUnsafe(options.shardLockExpiration)
      const expirationSeconds = Math.ceil(Duration.toSeconds(expiration))
      const crypto = yield* Crypto.Crypto
      const tenant = yield* crypto.randomUUIDv4.pipe(Effect.orDie)
      const network = yield* makeNetwork
      const services = yield* Effect.context<Crypto.Crypto | Exclude<RIn, RunnerServices>>()
      const sql = Context.get(
        yield* Layer.build(Database.postgres({ url: database, maxConnections: 2 })).pipe(Effect.orDie),
        SqlClient.SqlClient,
      )

      let incarnation = 0
      const runners: Array<Runner> = []
      const addresses = new Map<string, number>()
      const stopping: Array<Fiber.Fiber<void>> = []
      const url = new URL(Redacted.value(database))

      const dial = (runner: Runner) => () => {
        const sockets = runner.sockets

        if (sockets === undefined) {
          const refused = new NetSocket()
          queueMicrotask(() => refused.destroy(new Error("Runner killed")))

          return refused
        }

        const socket = connect({ host: url.hostname, port: Number(url.port || 5432), noDelay: true })
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))

        return socket
      }

      const storage =
        (runner: Runner) =>
        (inner: RunnerStorage.RunnerStorage["Service"]): RunnerStorage.RunnerStorage["Service"] => ({
          ...inner,
          getRunners: Effect.suspend(() =>
            runner.heartbeat === "running" || runner.runners === undefined
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
              if (runner.heartbeat === "running") return inner.refresh(address, shardIds)
              // A paused runner believes every lock it asks about is still its own.
              return Effect.succeed(runner.heartbeat === "paused" ? Array.from(shardIds) : [])
            }),
          acquire: (address, shardIds) =>
            Effect.suspend(() =>
              runner.heartbeat === "running" ? inner.acquire(address, shardIds) : Effect.succeed([]),
            ),
          release: (address, shardId) =>
            Effect.suspend(() =>
              runner.heartbeat === "running" ? inner.release(address, shardId) : Effect.void,
            ),
          releaseAll: (address) =>
            Effect.suspend(() =>
              runner.heartbeat === "running" ? inner.releaseAll(address) : Effect.void,
            ),
          unregister: (address) =>
            Effect.suspend(() =>
              runner.heartbeat === "running" ? inner.unregister(address) : Effect.void,
            ),
          setRunnerHealth: (address, healthy) =>
            Effect.suspend(() =>
              runner.heartbeat === "running" ? inner.setRunnerHealth(address, healthy) : Effect.void,
            ),
        })

      const start = Effect.fnUntraced(function* (runner: Runner) {
        incarnation += 1
        runner.address = RunnerAddress.RunnerAddress.make({ host: "runner", port: incarnation })
        runner.heartbeat = "running"
        runner.runners = undefined
        runner.sockets = new Set()
        addresses.set(key(runner.address), runners.indexOf(runner))

        const scope = yield* Scope.make()
        runner.scope = scope

        const layer = options.actors.pipe(
          Layer.provideMerge(
            testLayer(options, {
              tenant,
              wiring: {
                config: {
                  ...TIMINGS,
                  runnerAddress: Option.some(runner.address),
                  shardsPerGroup: SHARDS,
                  shardLockExpiration: expiration,
                  shardLockDisableAdvisory: true,
                },
                sharding: network.runner(runner.address),
                storage: storage(runner),
              },
              connect: dial(runner),
            }),
          ),
        )

        runner.context = yield* Layer.buildWithMemoMap(layer, yield* Layer.makeMemoMap, scope).pipe(
          Effect.provideContext(services),
          Effect.orDie,
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
      })

      // A crash cuts the runner's database and runner connections at once, so
      // Postgres rolls back its open turns and nothing it runs afterwards can
      // reach anyone. Its fibers then wind down in the background, where a
      // dead process's would simply vanish.
      const stop = Effect.fnUntraced(function* (runner: Runner) {
        const { scope, sockets } = runner

        runner.heartbeat = "killed"
        runner.scope = undefined
        runner.context = undefined
        runner.sockets = undefined
        network.close(runner.address)
        for (const socket of sockets ?? []) socket.destroy()

        if (scope !== undefined) stopping.push(yield* Effect.forkDetach(Scope.close(scope, Exit.void)))
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
        WHERE acquired_at >= NOW() - ${`${expirationSeconds} seconds`}::interval`.pipe(Effect.orDie)

      const ready = Effect.gen(function* () {
        const serving = runners.filter((runner) => runner.heartbeat === "running")

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

      // The first runner migrates the database; the rest start together.
      yield* start(runners[0]!)
      yield* Effect.forEach(runners.slice(1), start, { concurrency: "unbounded", discard: true })
      yield* ready

      return ActorCluster.of({
        runners: options.runners,
        on: (index) => (effect) =>
          live(index).pipe(Effect.flatMap((context) => Effect.provideContext(effect, context))),
        kill: (index) => at(index).pipe(Effect.flatMap(stop)),
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
                    runner.heartbeat = "paused"

                    return {
                      resume: Effect.sync(() => {
                        if (runner.heartbeat === "paused") runner.heartbeat = "running"
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
