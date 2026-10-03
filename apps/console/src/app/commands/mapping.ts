import type { CommandFailed, CommandLogEntry, CommandSent } from "@akter/cloud-api"
import { formatDuration } from "@akter/ui/geometry"
import { DateTime, Match } from "effect"
import { clockMillis, splitAddress } from "../overview/time.ts"
import { CommandRejected, CommandSucceeded, type Tail, type TailEntry } from "./model.ts"

/** The most turns the tail keeps. */
export const tailCapacity = 60

/** Seeds the command snapshot without changing the selected filter or fixture pause state. */
export const toOpeningTail =
  (tail: Tail) =>
  (recent: ReadonlyArray<TailEntry>): Tail => ({
    ...tail,
    entries: recent,
    next: (recent[0]?.sequence ?? -1) + 1,
  })

/**
 * One committed command as a tail row. `sequence` orders rows and keys them, and the caller owns
 * it. An error reads as its typed tag, a replay as `replayed`, and an empty payload leaves the
 * command name bare.
 */
export const toTailEntry =
  (sequence: number) =>
  (entry: CommandLogEntry): TailEntry => {
    const { actorType, key } = splitAddress(entry.address)
    return {
      sequence,
      time: clockMillis(entry.at),
      took: formatDuration(entry.durationMs),
      actorType,
      key,
      command:
        entry.payloadPreview === "" ? entry.command : `${entry.command} ${entry.payloadPreview}`,
      result: entry.outcome,
      detail: Match.value(entry.outcome).pipe(
        Match.when("error", () => entry.errorTag ?? "error"),
        Match.when("ok", () => "ok"),
        Match.when("replayed", () => "replayed"),
        Match.exhaustive,
      ),
    }
  }

/** A page of the command log, newest first, numbered so the newest has the highest sequence. */
export const toRecentTurns = (entries: ReadonlyArray<CommandLogEntry>): ReadonlyArray<TailEntry> =>
  [...entries]
    .sort((left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at))
    .map((entry, index) => toTailEntry(index)(entry))
    .reverse()

/** The actor's return value, flagged when it came from the stored receipt of an earlier send. */
export const toSucceeded = (sent: CommandSent): CommandSucceeded => CommandSucceeded.make(sent)

/** The actor's own typed error, kept as an answer rather than a transport failure. */
export const toRejected = (failed: CommandFailed): CommandRejected =>
  CommandRejected.make({
    commandId: failed.commandId,
    errorTag: failed.errorTag,
    error: failed.error,
    replayed: failed.replayed,
  })
