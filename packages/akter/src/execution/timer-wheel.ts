import { Clock, Duration, Effect, Latch } from "effect"
import type { Scope } from "effect"

/** Pending wakeups, not durable authority; the owner rebuilds them from its shard image. */
export interface TimerWheel {
  /** Replaces a pending id at an absolute Unix time in milliseconds. Closed wheels ignore calls. */
  readonly schedule: (id: string, at: number, effect: Effect.Effect<void>) => Effect.Effect<void>
  /** Removes a pending wakeup; an effect that has already started is not interrupted. */
  readonly cancel: (id: string) => Effect.Effect<void>
}

interface Timer {
  readonly id: string
  readonly at: number
  readonly effect: Effect.Effect<void>
  index: number
}

const precedes = (left: Timer, right: Timer) =>
  left.at < right.at || (left.at === right.at && left.id < right.id)

/**
 * A scope owns one indexed priority queue and one next-due sleep, bounded by the host timer's
 * maximum delay. Due effects run independently in that scope, so a slow action cannot block
 * other wakeups. Closing it interrupts the sleeper and running effects and discards pending ids.
 */
const make: Effect.Effect<TimerWheel, never, Scope.Scope> = Effect.gen(function* () {
  const scope = yield* Effect.scope
  const wake = Latch.makeUnsafe()
  const heap: Array<Timer> = []
  const timers = new Map<string, Timer>()
  let closed = false

  const swap = (left: number, right: number): void => {
    const a = heap[left]!
    const b = heap[right]!
    heap[left] = b
    heap[right] = a
    a.index = right
    b.index = left
  }

  const reorder = (start: number): void => {
    let index = start
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!precedes(heap[index]!, heap[parent]!)) break
      swap(index, parent)
      index = parent
    }
    for (;;) {
      const left = 2 * index + 1
      if (left >= heap.length) break
      const right = left + 1
      const child = right < heap.length && precedes(heap[right]!, heap[left]!) ? right : left
      if (!precedes(heap[child]!, heap[index]!)) break
      swap(index, child)
      index = child
    }
  }

  const remove = (id: string): void => {
    const timer = timers.get(id)
    if (timer === undefined) return
    timers.delete(id)
    const last = heap.pop()!
    if (timer.index === heap.length) return
    heap[timer.index] = last
    last.index = timer.index
    reorder(last.index)
  }

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true
      timers.clear()
      heap.length = 0
    }),
  )

  yield* Effect.forkIn(
    Effect.gen(function* () {
      for (;;) {
        wake.closeUnsafe()
        const timer = heap[0]
        if (timer === undefined) {
          yield* wake.await
          continue
        }
        const now = yield* Clock.currentTimeMillis
        if (wake.isOpen()) continue
        if (timer.at > now) {
          yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(Math.min(timer.at - now, 2_147_483_647))),
            wake.await,
          )
          continue
        }
        remove(timer.id)
        yield* Effect.forkIn(timer.effect, scope)
      }
    }),
    scope,
  )

  return {
    schedule: (id, at, effect) =>
      Effect.sync(() => {
        if (closed) return
        if (!Number.isFinite(at)) throw new Error("A timer needs a finite due time")
        remove(id)
        const timer = { id, at, effect, index: heap.length }
        timers.set(id, timer)
        heap.push(timer)
        reorder(timer.index)
        wake.openUnsafe()
      }),
    cancel: (id) =>
      Effect.sync(() => {
        if (closed) return
        remove(id)
        wake.openUnsafe()
      }),
  }
})

/** Scoped wakeups shared by timers, cron ticks and durable job sleeps. */
export const TimerWheels = { make }
