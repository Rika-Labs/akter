import { Effect } from "effect"
import type { Scope } from "effect"

interface Waiter {
  granted: boolean
  readonly resume: () => void
}

/**
 * A first-come, first-served gate of `permits` slots. A slot freed while
 * fibers wait goes straight to the oldest waiter, never back into the free
 * count.
 *
 * Effect's `Pool` and `Semaphore` free a slot and then schedule the waiter
 * they wake. A fiber that asks in between, typically the one that just freed
 * the slot and loops for its next statement, takes the slot first, and the
 * woken waiter queues again at the back. Under steady load the same holders
 * keep the slots and a waiter waits for as long as the load lasts. Putting
 * this gate in front of a pool, with as many slots as the pool has
 * connections, means the pool never has a waiter to pass over.
 *
 * A waiter interrupted after it was handed a slot passes the slot on, so an
 * interrupt never leaks one.
 */
export const fairGate = (permits: number) => {
  let free = permits
  const waiters = new Set<Waiter>()

  const release = Effect.sync(() => {
    const next = waiters.values().next()

    if (next.done === true) {
      free += 1
      return
    }

    waiters.delete(next.value)
    next.value.granted = true
    next.value.resume()
  })

  const enter = (restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      if (free > 0) {
        free -= 1
        return Effect.void
      }

      let waiter: Waiter | undefined

      return restore(
        Effect.callback<void>((resume) => {
          const queued: Waiter = { granted: false, resume: () => resume(Effect.void) }
          waiter = queued
          waiters.add(queued)

          return Effect.sync(() => {
            waiters.delete(queued)
          })
        }),
      ).pipe(Effect.onInterrupt(() => (waiter?.granted === true ? release : Effect.void)))
    })

  return {
    /** Holds one slot until the enclosing scope closes, waiting behind every earlier caller. */
    take: Effect.uninterruptibleMask((restore) =>
      Effect.andThen(
        enter(restore),
        Effect.addFinalizer(() => release),
      ),
    ) satisfies Effect.Effect<void, never, Scope.Scope>,
    /** Holds one slot while `effect` runs, waiting behind every earlier caller. */
    use: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.andThen(enter(restore), restore(effect).pipe(Effect.ensuring(release))),
      ),
    /** Callers waiting for a slot now. */
    waiting: () => waiters.size,
  }
}
