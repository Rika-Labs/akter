import { Effect, Option, Result } from "effect"
import type { Catalog } from "../execution/durable.ts"
import { Entry, EntryCodec, Origin } from "../execution/entries.ts"
import { Recovery, effectsText } from "../snapshots/recovery.ts"
import type { Bucket } from "../store/bucket.ts"
import type { Build } from "../store/build.ts"
import { decodeManifest, decodePage, decodeSegment } from "../store/codec.ts"
import {
  checkpointOffset,
  checkpointPrefix,
  logPrefix,
  pageKey,
  segmentOffset,
} from "../store/keys.ts"
import type { StoredSegment } from "../store/log.ts"

/** A checkpoint as the simulator reads it: its offset and its state page. */
export interface StoredCheckpoint {
  readonly offset: number
  readonly bytes: Uint8Array
}

/** What one shard's log holds, as the simulator reads it. */
export interface ShardLogContent {
  readonly shard: number
  readonly checkpoints: ReadonlyArray<StoredCheckpoint>
  readonly segments: ReadonlyArray<StoredSegment>
}

/** One entry the engine published, with the shard and offset it said was durable. */
export interface Publication {
  readonly shard: number
  readonly offset: number
  readonly entry: Entry
}

const stored = (bucket: Bucket, key: string) =>
  Effect.flatMap(bucket.get(key), (bytes) =>
    Option.isNone(bytes)
      ? Effect.die(new Error(`${key} was listed but is not stored`))
      : Effect.succeed(bytes.value),
  )

/** Reads one shard's segments and checkpoints straight from the bucket, around the store and its faults. */
const read = (bucket: Bucket, shard: number): Effect.Effect<ShardLogContent> =>
  Effect.gen(function* () {
    const segments: Array<StoredSegment> = []
    for (const key of yield* bucket.list(logPrefix(shard))) {
      const offset = segmentOffset(shard, key)
      if (Option.isNone(offset)) continue
      const segment = yield* decodeSegment(key)(yield* stored(bucket, key))
      segments.push({ ...segment, offset: offset.value })
    }
    const checkpoints: Array<StoredCheckpoint> = []
    for (const key of yield* bucket.list(checkpointPrefix(shard))) {
      const offset = checkpointOffset(shard, key)
      if (Option.isNone(offset)) continue
      const manifest = yield* decodeManifest(key)(yield* stored(bucket, key))
      for (const hash of manifest.statePages) {
        const page = yield* stored(bucket, pageKey(hash))
        checkpoints.push({
          offset: Number(offset.value),
          bytes: yield* decodePage(hash)(page.slice()),
        })
      }
    }
    return {
      shard,
      segments,
      checkpoints: checkpoints.sort((left, right) => left.offset - right.offset),
    }
  }).pipe(Effect.orDie)

const entriesOf = (segment: StoredSegment): Array<Entry> | undefined => {
  const entries: Array<Entry> = []
  for (const bytes of segment.entries) {
    const decoded = EntryCodec.decode(bytes)
    if (Result.isFailure(decoded)) return undefined
    entries.push(decoded.success)
  }
  return entries
}

/**
 * I1 over one shard's log: every segment with entries was written through the newest lease opened
 * before it. An open segment starts a lease at its own offset, so a later write carrying an older
 * open offset came from a fenced owner.
 */
const fenced = (log: ShardLogContent): Array<string> => {
  const violations: Array<string> = []
  let current: bigint | undefined
  for (const segment of log.segments) {
    if (segment.entries.length === 0 && segment.open === segment.offset) {
      current = segment.open
      continue
    }
    if (segment.open !== current)
      violations.push(
        `I1: shard ${log.shard} offset ${segment.offset} was written by the lease opened at ${segment.open} while the one opened at ${current ?? "nothing"} owned it`,
      )
  }
  return violations
}

/**
 * I4 and I5 over the whole log: no action id appears in two durable entries (a command ran at most
 * once), no stream sequence was applied twice, and every send its sender marked `Delivered` was
 * applied by its receiver.
 */
const once = (logs: ReadonlyArray<ShardLogContent>): Array<string> => {
  const violations: Array<string> = []
  const actions = new Map<string, number>()
  const applied = new Set<string>()
  const delivered: Array<string> = []
  for (const log of logs)
    for (const segment of log.segments) {
      const entries = entriesOf(segment)
      if (entries === undefined) {
        violations.push(`log: shard ${log.shard} segment ${segment.offset} does not decode`)
        continue
      }
      for (const entry of entries) {
        if (Entry.guards.Delivered(entry)) delivered.push(`${entry.stream}#${entry.sequence}`)
        if (!Entry.guards.Action(entry)) continue
        actions.set(entry.commandId, (actions.get(entry.commandId) ?? 0) + 1)
        if (Origin.guards.Delivery(entry.origin)) {
          const key = `${entry.origin.stream}#${entry.origin.sequence}`
          if (applied.has(key)) violations.push(`I5: send ${key} applied twice`)
          applied.add(key)
        }
      }
    }
  for (const [commandId, count] of actions)
    if (count > 1) violations.push(`I4: command ${commandId} is durable ${count} times`)
  for (const key of delivered)
    if (!applied.has(key)) violations.push(`I5: send ${key} marked delivered but never applied`)
  return violations
}

/**
 * I3 and I6 for one shard: replaying its log from nothing and from every checkpoint must reach the
 * live durable image exactly, with every replayed outcome equal to the recorded one. Every build's
 * segments are replayed, since a run can hold the segments of runners of several builds; which
 * build may replay a tail is the recovery policy's question, not an invariant.
 */
const replays = (
  catalog: Catalog,
  build: Build,
  log: ShardLogContent,
  live: string,
): Array<string> => {
  const violations: Array<string> = []
  const starts: Array<StoredCheckpoint | undefined> = [undefined, ...log.checkpoints]
  for (const checkpoint of starts) {
    const recovered = Recovery.recover(
      catalog,
      log.shard,
      checkpoint?.bytes,
      log.segments,
      build,
      "current",
    )
    const from =
      checkpoint === undefined ? "the empty log" : `the checkpoint at ${checkpoint.offset}`
    if (Result.isFailure(recovered)) {
      violations.push(
        `I3: shard ${log.shard} from ${from}: ${recovered.failure._tag} ${recovered.failure.message}`,
      )
      continue
    }
    const fingerprint = Recovery.fingerprint(recovered.success)
    if (fingerprint !== live)
      violations.push(
        `I6: shard ${log.shard} from ${from} differs from the live state:\n  live     ${live}\n  replayed ${fingerprint}`,
      )
  }
  return violations
}

/** I2 for every published entry: the log holds it, with the same effects, at the offset it was published from. */
const published = (
  logs: ReadonlyArray<ShardLogContent>,
  publications: ReadonlyArray<Publication>,
): Array<string> => {
  const violations: Array<string> = []
  for (const { shard, offset, entry } of publications) {
    const segment = logs[shard]?.segments.find((candidate) => candidate.offset === BigInt(offset))
    if (segment === undefined) {
      violations.push(`I2: shard ${shard} published from offset ${offset}, which is not in the log`)
      continue
    }
    const expected = Entry.guards.Action(entry) ? entry.commandId : undefined
    const found = entriesOf(segment)?.find((candidate) =>
      expected === undefined
        ? true
        : Entry.guards.Action(candidate) && candidate.commandId === expected,
    )
    if (found === undefined)
      violations.push(
        `I2: shard ${shard} offset ${offset} does not hold the published entry ${expected ?? ""}`,
      )
    else if (
      Entry.guards.Action(found) &&
      Entry.guards.Action(entry) &&
      effectsText(found.effects) !== effectsText(entry.effects)
    )
      violations.push(
        `I2: shard ${shard} offset ${offset} published ${expected ?? ""} with effects other than the log's`,
      )
  }
  return violations
}

/** The invariant checks the simulator runs when a run settles. */
export const Invariants = { read, fenced, once, replays, published }
