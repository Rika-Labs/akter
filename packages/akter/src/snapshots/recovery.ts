import { Predicate, Result, Schema } from "effect"
import { Actions } from "../execution/action.ts"
import type { Ran } from "../execution/action.ts"
import { Durable } from "../execution/durable.ts"
import type { ActorRecord, Catalog, ShardImage } from "../execution/durable.ts"
import { Effects, Entry, EntryCodec } from "../execution/entries.ts"
import type { ActionEntry } from "../execution/entries.ts"
import { Layouts } from "../execution/layout.ts"
import type { Decoded } from "../execution/layout.ts"
import type { Build } from "../store/build.ts"
import type { StoredSegment } from "../store/log.ts"
import { Builds } from "./build.ts"
import { Checkpoints } from "./checkpoint.ts"

/** A replayed action did something other than what its entry records: the shard stops. */
export class ReplayMismatch extends Schema.TaggedError<ReplayMismatch>()("ReplayMismatch", {
  shard: Schema.Int,
  commandId: Schema.String,
  recorded: Schema.String,
  replayed: Schema.String,
}) {}

/** The tail was written by another build; this runner refuses the shard. */
export class BuildMismatch extends Schema.TaggedError<BuildMismatch>()("BuildMismatch", {
  shard: Schema.Int,
  offset: Schema.Int,
  recorded: Schema.String,
  running: Schema.String,
}) {}

/** A segment or checkpoint does not decode: the shard is refused, never defaulted. */
export class CorruptLog extends Schema.TaggedError<CorruptLog>()("CorruptLog", {
  shard: Schema.Int,
  offset: Schema.Int,
  detail: Schema.String,
}) {}

/** Why a shard could not be rebuilt. */
export type RecoveryError = ReplayMismatch | BuildMismatch | CorruptLog

/** Which builds may replay a tail: only the writer's, or the running one when the operator opts in. */
export type ReplayPolicy = "matching" | "current"

const encodeEffects = Schema.encodeResult(Effects)

/** The encoded effects as one string, the form two runs are compared in. */
export const effectsText = (effects: Effects): string =>
  JSON.stringify(Result.getOrThrow(encodeEffects(effects)))

/**
 * Runs the handler of a recorded action again over `record`'s image, with the recorded command id,
 * admission time, caller and payload, so it sees the same `now`, `id` and `random` values.
 */
const rerun = (catalog: Catalog, record: ActorRecord, entry: ActionEntry): Ran => {
  const { actor, registered } = Durable.bound(catalog, entry.actor)
  const declaration = actor.actions[entry.member]
  const presence = entry.member === "connect" || entry.member === "disconnect"
  const handler = registered.handlers.get(entry.member)
  if (handler === undefined)
    throw new Error(`Actor ${actor.name} has no handler for '${entry.member}'`)
  const payloadSchema =
    declaration === undefined ? (presence ? actor.presence : undefined) : declaration.payload
  return Actions.run({
    actor,
    handler,
    declaration,
    image: record.image,
    commandId: entry.commandId,
    member: entry.member,
    payload: Layouts.codec(payloadSchema).decode(entry.payload),
    caller: entry.caller,
    at: entry.at,
    key: record.key,
    address: record.address,
    connection: entry.connection,
  })
}

/**
 * Replays segments onto a shard image in offset order. Each action runs again and its effects must
 * equal the recorded ones; a segment from another build is refused unless the policy is `current`.
 * Only `Action` and `Seed` entries run application code (handlers and state schemas), so a segment
 * without them replays the same on any build and is never refused: an open segment, which carries
 * no entries, a drained owner's `Released` segment, and the engine's own bookkeeping.
 */
const replay = (
  catalog: Catalog,
  image: ShardImage,
  segments: ReadonlyArray<StoredSegment>,
  build: Build,
  policy: ReplayPolicy,
): Result.Result<ShardImage, RecoveryError> => {
  for (const segment of segments) {
    if (Number(segment.offset) <= image.offset) continue
    const entries = segment.entries.map((bytes) => EntryCodec.decode(bytes))
    const approved = entries.some(
      (entry) =>
        Result.isSuccess(entry) &&
        Entry.guards.Audit(entry.success) &&
        entry.success.record.action === "replay" &&
        entry.success.record.outcome === "allowed" &&
        entry.success.record.target.shard === image.shard,
    )
    for (const entry of entries) {
      if (Result.isFailure(entry) || !Entry.guards.Replayed(entry.success)) continue
      if (!approved)
        return Result.fail(
          CorruptLog.make({
            shard: image.shard,
            offset: Number(segment.offset),
            detail: "Replay image has no audit in its segment",
          }),
        )
      const decoded = Checkpoints.decode(new TextEncoder().encode(entry.success.checkpoint))
      if (Result.isFailure(decoded) || decoded.success.shard !== image.shard)
        return Result.fail(
          CorruptLog.make({
            shard: image.shard,
            offset: Number(segment.offset),
            detail: "Replay image is invalid",
          }),
        )
      try {
        image = Checkpoints.restore(catalog, decoded.success)
        image.offset = Number(segment.offset)
      } catch {
        return Result.fail(
          CorruptLog.make({
            shard: image.shard,
            offset: Number(segment.offset),
            detail: "Replay image cannot be decoded",
          }),
        )
      }
    }
  }
  for (const stored of segments) {
    const offset = Number(stored.offset)
    if (offset <= image.offset) continue
    const entries: Array<Entry> = []
    for (const bytes of stored.entries) {
      const decoded = EntryCodec.decode(bytes)
      if (Result.isFailure(decoded))
        return Result.fail(
          CorruptLog.make({ shard: image.shard, offset, detail: decoded.failure.message }),
        )
      entries.push(decoded.success)
    }
    const runsCode = entries.some((entry) => Entry.guards.Action(entry) || Entry.guards.Seed(entry))
    if (runsCode && policy === "matching" && !Builds.same(stored.build, build))
      return Result.fail(
        BuildMismatch.make({
          shard: image.shard,
          offset,
          recorded: JSON.stringify(stored.build),
          running: JSON.stringify(build),
        }),
      )
    for (const entry of entries) {
      if (!Entry.guards.Action(entry)) {
        Durable.record(image, catalog, entry, undefined)
        continue
      }
      const record = Durable.resident(image, catalog, entry.actor, entry.key)
      const ran = rerun(catalog, record, entry)
      const recorded = effectsText(entry.effects)
      const replayed = effectsText(ran.effects)
      if (recorded !== replayed)
        return Result.fail(
          ReplayMismatch.make({
            shard: image.shard,
            commandId: entry.commandId,
            recorded,
            replayed,
          }),
        )
      Durable.record(image, catalog, entry, ran.image)
    }
    image.offset = offset
  }
  return Result.succeed(image)
}

/**
 * Rebuilds a shard from its newest checkpoint, or from nothing, plus the segments after it: the
 * same procedure an owner runs on open and the simulator runs to check that any checkpoint
 * reproduces the live state.
 */
const recover = (
  catalog: Catalog,
  shard: number,
  checkpoint: Uint8Array | undefined,
  segments: ReadonlyArray<StoredSegment>,
  build: Build,
  policy: ReplayPolicy,
): Result.Result<ShardImage, RecoveryError> => {
  if (checkpoint === undefined)
    return replay(catalog, Durable.empty(shard), segments, build, policy)
  const decoded = Checkpoints.decode(checkpoint)
  if (Result.isFailure(decoded))
    return Result.fail(CorruptLog.make({ shard, offset: -1, detail: decoded.failure.message }))
  let image: ShardImage
  try {
    image = Checkpoints.restore(catalog, decoded.success)
  } catch (error) {
    return Result.fail(
      CorruptLog.make({ shard, offset: decoded.success.offset, detail: String(error) }),
    )
  }
  return replay(catalog, image, segments, build, policy)
}

const canonical = (value: Decoded): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value === null || value === undefined || !Predicate.isObject(value))
    return JSON.stringify(value) ?? "null"
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`
}

const byText = (items: ReadonlyArray<Schema.Json>): Array<string> => items.map(canonical).sort()

/**
 * The durable content of a shard image in a canonical order: created actors with their state and
 * lists, client outcomes, stream watermarks, job call outcomes, timers, pending sends and open
 * jobs. Two images with the same fingerprint hold the same states and outcomes.
 */
const fingerprint = (image: ShardImage): string => {
  const checkpoint = Checkpoints.capture(image)
  return JSON.stringify({
    actors: byText(checkpoint.actors.filter((snapshot) => snapshot.created)),
    index: byText(checkpoint.index ?? []),
    clients: byText(checkpoint.clients),
    received: byText(checkpoint.received),
    calls: byText(
      checkpoint.calls.map(({ jobId, outcomes }) => ({ jobId, outcomes: byText(outcomes) })),
    ),
    timers: byText(checkpoint.timers),
    outbox: byText(checkpoint.outbox),
    jobs: byText(checkpoint.jobs.map((job) => ({ ...job, steps: byText(job.steps) }))),
  })
}

/** Recovery: checkpoint plus replay, with the determinism backstop. */
export const Recovery = { recover, replay, fingerprint }
