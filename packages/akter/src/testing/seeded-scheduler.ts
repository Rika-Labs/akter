import type { Fiber, Scheduler } from "effect"

/**
 * A fiber scheduler whose interleavings are a function of its seed: runnable tasks wait in one
 * queue and run in batches, one macrotask per batch so the event loop still turns, each pick drawn
 * with a seeded xorshift generator among the tasks of the lowest priority.
 */
export class SeededScheduler implements Scheduler.Scheduler {
  readonly executionMode = "async"
  readonly #queue: Array<readonly [number, () => void]> = []
  #batch: Array<readonly [number, () => void]> = []
  #pending = false
  #state: number
  picks = 0

  constructor(seed: number) {
    this.#state = seed >>> 0 || 1
  }

  #random(): number {
    let x = this.#state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.#state = x >>> 0
    return this.#state / 4294967296
  }

  shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    return fiber.currentOpCount >= 32
  }

  makeDispatcher(): Scheduler.SchedulerDispatcher {
    return {
      scheduleTask: (task, priority) => {
        this.#queue.push([priority, task])
        if (this.#pending) return
        this.#pending = true
        setImmediate(() => {
          this.#pending = false
          this.#drain()
        })
      },
      flush: () => this.#drain(),
    }
  }

  /** True when no fiber is runnable: everything left waits on the clock, a signal or the host. */
  get idle(): boolean {
    return this.#queue.length === 0 && this.#batch.length === 0
  }

  #drain(): void {
    const batch = this.#queue.splice(0, this.#queue.length)
    this.#batch = batch
    while (batch.length > 0) {
      let lowest = Number.POSITIVE_INFINITY
      for (const [priority] of batch) lowest = Math.min(lowest, priority)
      const candidates: Array<number> = []
      batch.forEach(([priority], index) => {
        if (priority === lowest) candidates.push(index)
      })
      const index = candidates[Math.floor(this.#random() * candidates.length)] ?? 0
      const [picked] = batch.splice(index, 1)
      this.picks++
      picked?.[1]()
    }
  }
}
