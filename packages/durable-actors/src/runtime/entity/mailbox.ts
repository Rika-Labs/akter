import type { Request } from "../../handles/actors.ts"

/**
 * The most commands one turn batch runs. It stays below the 64 open
 * subtransactions past which Postgres overflows its per-backend subtransaction
 * cache, since a batch of an actor whose handlers issue statements can hold a
 * savepoint per command.
 */
export const BATCH_CAP = 32

/**
 * The most calls of one commutative reducer that one merged turn combines.
 * Merging never waits for calls: it takes only those already waiting.
 */
export const MERGE_CAP = 1024

/** A waiting command, and whether its reducer merges with its neighbours. */
interface Mergeable {
  readonly request: Request
  readonly command: { readonly merge?: unknown }
}

/** True when `next` joins a merged turn of `previous`'s commutative reducer. */
export const merges = ({
  previous,
  next,
}: {
  readonly previous: Mergeable
  readonly next: Mergeable
}) => next.command.merge !== undefined && next.request.command === previous.request.command

/**
 * Removes the next batch from the front of `waiting`, in delivery order: the
 * first command, then each command behind it that is already waiting, up to
 * `BATCH_CAP` turns. Consecutive calls of one commutative reducer are one
 * merged turn of up to `MERGE_CAP` calls. Nothing waits for more to arrive. A
 * command joins a batch only once its own `queued` hook has finished, so the
 * batch stops at the first command that is still in it, and takes nothing when
 * that is the first.
 *
 * A batch stops before a command id it already holds, so a retry queued
 * behind its original resolves through the receipt the original commits. It
 * also stops before a command listed in `alone`, and such a command runs in a
 * batch of its own, once: these are the commands of a batch that failed, run
 * one per transaction until each has been processed.
 */
export const takeBatch = <
  W extends Mergeable & {
    /** Set once the request's `queued` hook has finished. */
    readonly queued: boolean
  },
>({
  waiting,
  alone,
}: {
  readonly waiting: Array<W>
  readonly alone: Set<string>
}): Array<W> => {
  if (waiting[0]?.queued !== true) return []

  const first = waiting.shift()!

  if (alone.delete(first.request.commandId)) return [first]

  const batch = [first]
  const ids = new Set([first.request.commandId])
  let turns = 1
  let merged = first.command.merge === undefined ? 0 : 1

  while (waiting.length > 0) {
    const next = waiting[0]!
    const { commandId } = next.request

    if (!next.queued || ids.has(commandId) || alone.has(commandId)) break

    const joins = merged > 0 && merged < MERGE_CAP && merges({ previous: batch.at(-1)!, next })

    if (!joins && turns === BATCH_CAP) break

    if (joins) merged += 1
    else {
      turns += 1
      merged = next.command.merge === undefined ? 0 : 1
    }

    ids.add(commandId)
    batch.push(waiting.shift()!)
  }

  return batch
}
