import type { Request } from "../../handles/actors.ts"

/**
 * The most commands one turn batch runs. It stays below the 64 open
 * subtransactions past which Postgres overflows its per-backend subtransaction
 * cache, since a batch of an actor whose handlers issue statements can hold a
 * savepoint per command.
 */
export const BATCH_CAP = 32

/**
 * Removes the next batch from the front of `waiting`, in delivery order: the
 * first command, then each command behind it that is already waiting, up to
 * `BATCH_CAP`. Nothing waits for more to arrive.
 *
 * A batch stops before a command id it already holds, so a retry queued
 * behind its original resolves through the receipt the original commits. It
 * also stops before a command listed in `alone`, and such a command runs in a
 * batch of its own, once: these are the commands of a batch that failed, run
 * one per transaction until each has been processed.
 */
export const takeBatch = <W extends { readonly request: Request }>({
  waiting,
  alone,
}: {
  readonly waiting: Array<W>
  readonly alone: Set<string>
}): Array<W> => {
  const first = waiting.shift()

  if (first === undefined) return []

  if (alone.delete(first.request.commandId)) return [first]

  const batch = [first]
  const ids = new Set([first.request.commandId])

  while (batch.length < BATCH_CAP && waiting.length > 0) {
    const { commandId } = waiting[0]!.request

    if (ids.has(commandId) || alone.has(commandId)) break

    ids.add(commandId)
    batch.push(waiting.shift()!)
  }

  return batch
}
