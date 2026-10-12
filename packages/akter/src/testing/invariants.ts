import { Result } from "effect"
import type { Catalog } from "../execution/durable.ts"
import { Entry, Origin, SegmentCodec } from "../execution/entries.ts"
import type { Build, Segment } from "../execution/entries.ts"
import { Recovery, effectsText } from "../snapshots/recovery.ts"
import type { StoredSegment } from "../snapshots/recovery.ts"

/** What one shard's log holds, as the simulator reads it. */
export interface ShardLogContent {
  readonly shard: number
  readonly checkpoints: ReadonlyArray<StoredSegment>
  readonly segments: ReadonlyArray<StoredSegment>
}

const decode = (stored: StoredSegment): Segment | undefined => {
  const decoded = SegmentCodec.decode(stored.bytes)
  return Result.isSuccess(decoded) ? decoded.success : undefined
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
    for (const stored of log.segments) {
      const segment = decode(stored)
      if (segment === undefined) {
        violations.push(`log: shard ${log.shard} segment ${stored.offset} does not decode`)
        continue
      }
      for (const entry of segment.entries) {
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
 * live durable image exactly, with every replayed outcome equal to the recorded one.
 */
const replays = (
  catalog: Catalog,
  build: Build,
  log: ShardLogContent,
  live: string,
): Array<string> => {
  const violations: Array<string> = []
  const starts: Array<StoredSegment | undefined> = [undefined, ...log.checkpoints]
  for (const checkpoint of starts) {
    const recovered = Recovery.recover(catalog, log.shard, checkpoint?.bytes, log.segments, build, "matching")
    const from = checkpoint === undefined ? "the empty log" : `the checkpoint at ${checkpoint.offset}`
    if (Result.isFailure(recovered)) {
      violations.push(`I3: shard ${log.shard} from ${from}: ${recovered.failure._tag} ${recovered.failure.message}`)
      continue
    }
    const fingerprint = Recovery.fingerprint(recovered.success)
    if (fingerprint !== live)
      violations.push(`I6: shard ${log.shard} from ${from} differs from the live state:\n  live     ${live}\n  replayed ${fingerprint}`)
  }
  return violations
}

/** I2 for one published entry: the log holds it, at the offset it was published from. */
const published = (bytes: Uint8Array | undefined, shard: number, offset: number, entry: Entry): string | undefined => {
  if (bytes === undefined) return `I2: shard ${shard} published from offset ${offset}, which is not in the log`
  const segment = decode({ offset, bytes })
  const expected = Entry.guards.Action(entry) ? entry.commandId : undefined
  const found = segment?.entries.find((candidate) =>
    expected === undefined ? true : Entry.guards.Action(candidate) && candidate.commandId === expected,
  )
  if (found === undefined) return `I2: shard ${shard} offset ${offset} does not hold the published entry ${expected ?? ""}`
  if (Entry.guards.Action(found) && Entry.guards.Action(entry) && effectsText(found.effects) !== effectsText(entry.effects))
    return `I2: shard ${shard} offset ${offset} published ${expected ?? ""} with effects other than the log's`
  return undefined
}

/** The invariant checks the simulator runs after every step. */
export const Invariants = { once, replays, published }
