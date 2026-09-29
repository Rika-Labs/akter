import { Crypto, Effect, Option, Schedule, Schema } from "effect"
import { ClusterError, EntityId, Sharding, ShardingConfig } from "effect/unstable/cluster"
import {
  type Deliver,
  type Delivered,
  HolderEntity,
  holderEntityId,
  holderGroup,
} from "./protocol.ts"

const LOCAL = "local"

/** How long an owner waits for a holder to acknowledge one message, before one retry. */
const ACK_TIMEOUT = "1 second"

/** A holder could not be reached: the owner treats its connections as lost. */
export class HolderUnreachable extends Schema.TaggedError<HolderUnreachable>()(
  "HolderUnreachable",
  { message: Schema.String },
) {}

/**
 * This runner's transport identity and the channel to every other runner's
 * holder. A runner with a Cluster address hosts a holder entity in a shard
 * group named after that address; an unclustered runtime reaches only itself.
 */
export interface Transport {
  readonly holder: string
  readonly epoch: string
  readonly deliver: (
    holder: string,
    epoch: string,
    message: Deliver,
  ) => Effect.Effect<Delivered, HolderUnreachable>
  /** Whether the runner `holder` is still running the process that took `epoch`. */
  readonly ping: (holder: string, epoch: string) => Effect.Effect<boolean>
}

/**
 * A runner that hosts no actors still hosts its own holder, so its group is
 * assigned regardless of the configured ones.
 */
export const holderShardGroups = (config: Partial<ShardingConfig.ShardingConfig["Service"]>) =>
  Option.match(config.runnerAddress ?? Option.none(), {
    onNone: () => ({}),
    onSome: (address) => ({
      availableShardGroups: ["default", holderGroup(address)],
      assignedShardGroups: [...(config.assignedShardGroups ?? ["default"]), holderGroup(address)],
    }),
  })

/**
 * Shard placement for the holder's own group can lag a moment behind registration,
 * so an unassigned entity is retried.
 */
export const holderTransport = Effect.fnUntraced(function* (
  local: (message: Deliver) => Effect.Effect<Delivered>,
) {
  const config = yield* ShardingConfig.ShardingConfig
  const sharding = yield* Sharding.Sharding
  const crypto = yield* Crypto.Crypto
  const epoch = yield* crypto.randomUUIDv7.pipe(Effect.orDie)

  const holder = Option.match(config.runnerAddress, {
    onNone: () => LOCAL,
    onSome: holderGroup,
  })

  const clustered = holder !== LOCAL && config.assignedShardGroups.includes(holder)

  if (clustered)
    yield* sharding.registerEntity(
      HolderEntity,
      Effect.succeed(
        HolderEntity.of({
          Deliver: ({ payload }) =>
            payload.epoch === epoch
              ? local(payload)
              : Effect.succeed({ wrongEpoch: true, unknown: [] }),
          Ping: ({ payload }) => Effect.succeed(payload.epoch === epoch),
        }),
      ),
      { concurrency: "unbounded" },
    )

  const client = clustered ? yield* sharding.makeClient(HolderEntity) : undefined

  const deliver: Transport["deliver"] = (target, targetEpoch, message) => {
    if (target === holder)
      return targetEpoch === epoch
        ? local(message)
        : Effect.succeed({ wrongEpoch: true, unknown: [] })

    if (client === undefined || target === LOCAL)
      return Effect.fail(HolderUnreachable.make({ message: `Holder ${target} is not reachable` }))

    return client(EntityId.make(holderEntityId({ holder: target, epoch: targetEpoch })))
      .Deliver(message)
      .pipe(
        Effect.retry({
          while: (error) =>
            ClusterError.EntityNotAssignedToRunner.is(error) ||
            ClusterError.RunnerUnavailable.is(error),
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout(ACK_TIMEOUT),
        Effect.retry({ times: 1 }),
        Effect.mapError(() =>
          HolderUnreachable.make({ message: `Holder ${target} did not acknowledge` }),
        ),
      )
  }

  const ping: Transport["ping"] = (target, targetEpoch) => {
    if (target === holder) return Effect.succeed(targetEpoch === epoch)

    if (client === undefined || target === LOCAL) return Effect.succeed(false)

    return client(EntityId.make(holderEntityId({ holder: target, epoch: targetEpoch })))
      .Ping({ epoch: targetEpoch })
      .pipe(
        Effect.timeout(ACK_TIMEOUT),
        Effect.retry({ times: 1 }),
        Effect.orElseSucceed(() => false),
      )
  }

  return { holder, epoch, deliver, ping } satisfies Transport
})
