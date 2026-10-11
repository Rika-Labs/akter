import { Latch } from "effect"
import type { Request } from "../request.ts"

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

/**
 * The most command ids an activation keeps to run alone after a failed batch.
 * An id leaves the set when its retry is taken, and a caller that never
 * retries would otherwise leave it for the activation's lifetime. Past the
 * cap the oldest go first: an evicted id's late retry may join a batch again,
 * which a retryable failure makes safe.
 */
export const ALONE_CAP = BATCH_CAP * 32

/** Adds `ids` to `alone` as its newest entries, then drops the oldest past `ALONE_CAP`. */
export const markAlone = ({
  alone,
  ids,
}: {
  readonly alone: Set<string>
  readonly ids: Iterable<string>
}) => {
  for (const id of ids) {
    alone.delete(id)
    alone.add(id)
  }

  for (const oldest of alone) {
    if (alone.size <= ALONE_CAP) return

    alone.delete(oldest)
  }
}

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

/**
 * One activation handler's waiting commands in arrival order, and its
 * worker's wake-up. A command is offered as Cluster delivers it and becomes
 * takeable once its `queued` hook finished; the wake-up stays open while the
 * front command is takeable, so the worker never sleeps past ready work and a
 * command whose hook is still running holds back every command behind it.
 * `alone` outlives the handler: it holds the ids of a failed batch, each run
 * in a transaction of its own once. Methods are shared; the waiting commands,
 * wake-up and retry isolation belong to this handler alone.
 */
export const activationMailbox = <W extends Mergeable & { queued: boolean }>(alone: Set<string>) =>
  new ActivationMailbox<W>(alone)

class ActivationMailbox<W extends Mergeable & { queued: boolean }> {
  private readonly waiting: Array<W> = []
  private readonly ready = Latch.makeUnsafe(false)

  constructor(private readonly alone: Set<string>) {}

  offer(entry: W) {
    this.waiting.push(entry)
  }

  /** Marks `entry`'s `queued` hook finished, so a batch may take it. */
  queued(entry: W) {
    entry.queued = true
    this.ready.openUnsafe()
  }

  /** Waits until the front command may be takeable. */
  readonly await = this.ready.await

  /** The next batch, possibly empty; the wake-up closes once the front command is not takeable. */
  take() {
    const batch = takeBatch({ waiting: this.waiting, alone: this.alone })

    if (this.waiting[0]?.queued !== true) this.ready.closeUnsafe()

    return batch
  }

  /** Puts taken commands back in front of everything that arrived since. */
  requeue(entries: ReadonlyArray<W>) {
    if (entries.length === 0) return

    this.waiting.unshift(...entries)
    this.ready.openUnsafe()
  }

  /** Runs each of `ids` alone once, the next time it is taken. */
  isolate(ids: Iterable<string>) {
    markAlone({ alone: this.alone, ids })
  }

  size() {
    return this.waiting.length
  }
}
