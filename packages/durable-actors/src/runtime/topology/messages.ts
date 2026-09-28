import { Effect, Layer } from "effect"
import { MessageStorage } from "effect/unstable/cluster"

const persisted = (operation: string) =>
  Effect.die(new Error(`${operation}: commands are direct, so no Cluster message is persisted`))

/**
 * Cluster message storage for direct commands: it keeps nothing, and the
 * command's receipt is the only deduplication record.
 *
 * It is deliberately not `MessageStorage.noop`. Each entity manager records
 * every request id it answers, and only Sharding's storage-read loop forgets
 * them, once per poll; Sharding starts that loop for any storage except
 * `noop`. Under `noop` the set grows by one id per command for the runner's
 * lifetime. Here the loop runs, reads nothing, and forgets the ids, so a
 * request id redelivered after a poll is admitted again and answered from
 * its receipt. Persisting a message dies, as it does under `noop`.
 */
export const directMessages: Layer.Layer<MessageStorage.MessageStorage> = Layer.effect(
  MessageStorage.MessageStorage,
  MessageStorage.make({
    saveRequest: () => persisted("saveRequest"),
    saveEnvelope: () => persisted("saveEnvelope"),
    saveReply: (reply) => Effect.succeed(reply),
    clearReplies: () => Effect.void,
    repliesFor: () => Effect.succeed([]),
    repliesForUnfiltered: () => Effect.succeed([]),
    requestIdForPrimaryKey: () => Effect.succeedNone,
    unprocessedMessages: () => Effect.succeed([]),
    unprocessedMessagesById: () => Effect.succeed([]),
    resetAddress: () => Effect.void,
    resetAddresses: () => Effect.void,
    clearAddress: () => Effect.void,
    resetShards: () => Effect.void,
    withTransaction: (effect) => effect,
  }),
)
