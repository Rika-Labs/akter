import { Context, Duration, Effect, HashRing, Layer, Option, PrimaryKey } from "effect"
import {
  MessageStorage,
  RunnerAddress,
  RunnerHealth,
  Runners,
  RunnerServer,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  ShardId,
} from "effect/cluster"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { SocketServer } from "effect/socket"
import { SqlClient } from "effect/sql"
import { admissionSharding, MailboxRefusals } from "./topology/admission.ts"

/**
 * Whether a command to an entity on this runner is encoded and decoded the
 * way a remote delivery is. Off by default: a local hop hands the owner the
 * request the runtime built and validated, and only a remote hop needs the
 * bytes. Test runtimes turn it on so every delivery still checks the request
 * schema.
 */
export const LocalRequestSerialization = Context.Reference<boolean>(
  "@rikalabs/akter/runtime/runner/LocalRequestSerialization",
  { defaultValue: () => false },
)

/** Package-internal wiring shared by production runners and fault-injecting test runners. */
export class RunnerWiring extends Context.Service<
  RunnerWiring,
  {
    readonly config: Partial<ShardingConfig.ShardingConfig["Service"]>
    readonly sharding: Layer.Layer<
      Sharding.Sharding,
      never,
      | ShardingConfig.ShardingConfig
      | MessageStorage.MessageStorage
      | RunnerStorage.RunnerStorage
      | RunnerHealth.RunnerHealth
      | MailboxRefusals
    >
    readonly storage: (
      storage: RunnerStorage.RunnerStorage["Service"],
    ) => RunnerStorage.RunnerStorage["Service"]
    readonly production?: boolean
  }
>()("@rikalabs/akter/runtime/runner/RunnerWiring") {}

/** The public runner's readiness checks acquired shards, not just a reachable database. */
export class RunnerReadiness extends Context.Service<
  RunnerReadiness,
  {
    readonly acquired: (
      sharding: Pick<Sharding.Sharding["Service"], "hasShardId">,
    ) => Effect.Effect<boolean>
  }
>()("@rikalabs/akter/runtime/runner/RunnerReadiness") {}

/** How many runners other than this one the cluster's runner storage lists. */
export class RunnerPeers extends Context.Service<
  RunnerPeers,
  {
    /** Healthy or not; undefined when the storage could not be read. */
    readonly peers: Effect.Effect<number | undefined>
  }
>()("@rikalabs/akter/runtime/runner/RunnerPeers") {}

/** Counts the runners the storage lists under any address but this runner's own. */
export const runnerPeers = Effect.gen(function* () {
  const config = yield* ShardingConfig.ShardingConfig
  const storage = yield* RunnerStorage.RunnerStorage
  const self = Option.map(config.runnerAddress, PrimaryKey.value)

  return RunnerPeers.of({
    peers: storage.getRunners.pipe(
      Effect.map(
        (runners) =>
          runners.filter(
            ([runner]) => Option.isNone(self) || PrimaryKey.value(runner.address) !== self.value,
          ).length,
      ),
      Effect.orElseSucceed(() => undefined),
    ),
  })
})

/** Builds assignment expectations independently of the runner's local acquisition state. */
export const acquiredShards = Effect.gen(function* () {
  const config = yield* ShardingConfig.ShardingConfig
  const storage = yield* RunnerStorage.RunnerStorage
  const self = Option.getOrThrow(config.runnerAddress)
  const key = PrimaryKey.value(self)

  return RunnerReadiness.of({
    acquired: (sharding) =>
      Effect.gen(function* () {
        const runners = yield* storage.getRunners

        if (
          !runners.some(([runner, healthy]) => healthy && PrimaryKey.value(runner.address) === key)
        )
          return false

        for (const group of config.assignedShardGroups) {
          const ring = HashRing.make<RunnerAddress.RunnerAddress>()

          for (const [runner, healthy] of runners)
            if (healthy && runner.groups.includes(group))
              HashRing.add(ring, runner.address, { weight: runner.weight })

          const expected = HashRing.getShards(ring, config.shardsPerGroup)

          if (expected === undefined) return false

          for (const [index, address] of expected.entries())
            if (
              PrimaryKey.value(address) === key &&
              !sharding.hasShardId(ShardId.make(group, index + 1))
            )
              return false
        }

        return true
      }).pipe(
        Effect.timeoutOption("2 seconds"),
        Effect.map(Option.getOrElse(() => false)),
        Effect.orElseSucceed(() => false),
      ),
  })
})

/** Production TCP runner configuration. All runners use the same shard count and lock expiration. */
export interface SocketRunnerOptions<E> {
  /** A unique, stable address reachable directly by every other runner; never a load-balancer address. */
  readonly address: { readonly host: string; readonly port: number }
  /** Bind address, defaulting to the advertised address. Use a private interface or an isolated network. */
  readonly listenAddress?: { readonly host: string; readonly port: number }
  /** Platform TCP server and client layers, such as BunClusterSocket's layerSocketServer and layerClientProtocol. */
  readonly transport: Layer.Layer<
    SocketServer.SocketServer | Runners.RpcClientProtocol,
    E,
    ShardingConfig.ShardingConfig | RpcSerialization.RpcSerialization
  >
  /** Default 256; changing this requires stopping every runner. */
  readonly shardsPerGroup?: number
  /** Default 35 seconds; finite and at least 3 seconds. Not an end-to-end recovery deadline. */
  readonly shardLockExpiration?: Duration.Input
  /** Default 10 seconds, capped by Cluster at a third of the expiration. */
  readonly shardLockRefreshInterval?: Duration.Input
  /** Default 1 second. */
  readonly refreshAssignmentsInterval?: Duration.Input
  /** Default 15 seconds, bounding activation shutdown during a shard handoff. */
  readonly entityTerminationTimeout?: Duration.Input
}

const address = (value: { readonly host: string; readonly port: number }, advertise: boolean) => {
  if (
    value.host.trim().length === 0 ||
    (advertise && ["0.0.0.0", "::", "*"].includes(value.host)) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  )
    throw new Error(
      "Runner address needs a host and a port between 1 and 65535; advertise a reachable host, not a wildcard",
    )

  return RunnerAddress.RunnerAddress.make(value)
}

const duration = (value: Duration.Input, name: string, minimum = 1) => {
  const result = Duration.fromInputUnsafe(value)

  if (!Number.isFinite(Duration.toMillis(result)) || Duration.toMillis(result) < minimum)
    throw new Error(`${name} must be finite and at least ${minimum} milliseconds`)

  return result
}

/**
 * Joins separate processes over platform TCP sockets. Provide this layer to
 * `Actors.layer`; the framework keeps direct commands, SQL ownership, receipts,
 * and outbox recovery, rather than enabling Cluster's persisted message store.
 * Socket transport is trusted infrastructure: isolate it from public clients.
 */
export const socket = <E>(options: SocketRunnerOptions<E>) => {
  const shardsPerGroup = options.shardsPerGroup ?? 256

  if (!Number.isSafeInteger(shardsPerGroup) || shardsPerGroup < 1 || shardsPerGroup > 65536)
    throw new Error("shardsPerGroup must be an integer between 1 and 65536")

  const config: Partial<ShardingConfig.ShardingConfig["Service"]> = {
    runnerAddress: Option.some(address(options.address, true)),
    runnerListenAddress: Option.some(address(options.listenAddress ?? options.address, false)),
    shardsPerGroup,
    shardLockDisableAdvisory: true,
    shardLockExpiration: duration(
      options.shardLockExpiration ?? "35 seconds",
      "shardLockExpiration",
      3000,
    ),
    shardLockRefreshInterval: duration(
      options.shardLockRefreshInterval ?? "10 seconds",
      "shardLockRefreshInterval",
    ),
    refreshAssignmentsInterval: duration(
      options.refreshAssignmentsInterval ?? "1 second",
      "refreshAssignmentsInterval",
    ),
    entityMessagePollInterval: "1 second",
    entityTerminationTimeout: duration(
      options.entityTerminationTimeout ?? "15 seconds",
      "entityTerminationTimeout",
    ),
  }

  const sharding = RunnerServer.layer.pipe(
    Layer.provideMerge(admissionSharding),
    Layer.provideMerge(Runners.layerRpc),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(options.transport),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.orDie,
  )

  return Layer.succeed(RunnerWiring, {
    config,
    sharding,
    storage: (storage) => storage,
    production: true,
  })
}

/** Runner-to-runner transport and ownership configuration, provided to `Actors.layer`. */
export const Runner = { socket }

/** Refuses a routing layout mismatch before any runner registers or takes shards. */
export const checkRunnerConfiguration = Effect.fnUntraced(function* (
  wiring: RunnerWiring["Service"] | undefined,
) {
  const sql = yield* SqlClient.SqlClient

  if (wiring?.production === true) {
    const shards = wiring.config.shardsPerGroup!
    const expiration = Duration.toMillis(
      Duration.fromInputUnsafe(wiring.config.shardLockExpiration!),
    )
    yield* sql`UPDATE actor_deployment SET runner_shards = ${shards}, runner_lock_expiration_ms = ${expiration}
      WHERE runner_shards IS NULL`
    const [row] = yield* sql<{
      runner_shards: number
      runner_lock_expiration_ms: string
    }>`SELECT runner_shards, runner_lock_expiration_ms::text FROM actor_deployment`

    if (row!.runner_shards !== shards || Number(row!.runner_lock_expiration_ms) !== expiration)
      return yield* Effect.die(
        new Error(
          "Runner shard count or lock expiration differs from the deployment; stop all runners and migrate explicitly",
        ),
      )
  } else if (wiring === undefined) {
    const [row] = yield* sql<{
      runner_shards: number | null
    }>`SELECT runner_shards FROM actor_deployment`

    if (row!.runner_shards !== null)
      return yield* Effect.die(
        new Error(
          "This database requires Runner.socket configuration; a single embedded runner cannot join it",
        ),
      )
  }
})
