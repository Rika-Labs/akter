import type { Fiber, Scheduler } from "effect"

/**
 * A fiber scheduler whose interleavings are a function of its seed: runnable tasks wait in one
 * queue and run in batches, one macrotask per batch so the event loop still turns, each pick drawn
 * with a seeded xorshift generator among the tasks of the lowest priority. Nothing a simulated run
 * does waits on a host promise, so no host timing reaches the queue. Whoever waits for idleness is
 * woken only once no fiber can run, never on a host timer, so when it runs is a function of the
 * seed too.
 */
export class SeededScheduler implements Scheduler.Scheduler {
  readonly executionMode = "async"
  readonly #queue: Array<readonly [number, () => void]> = []
  #batch: Array<readonly [number, () => void]> = []
  #pending = false
  #idlers: Array<() => void> = []
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
        this.#wake()
      },
      flush: () => this.#drain(),
    }
  }

  /** Calls `wake` once no fiber can run, after the event loop turns. */
  whenIdle(wake: () => void): void {
    this.#idlers.push(wake)
    this.#wake()
  }

  /** True when no fiber is runnable: everything left waits on the clock or a signal. */
  get idle(): boolean {
    return this.#queue.length === 0 && this.#batch.length === 0
  }

  #wake(): void {
    if (this.#pending || (this.#queue.length === 0 && this.#idlers.length === 0)) return
    this.#pending = true
    setImmediate(() => {
      this.#pending = false
      if (this.#queue.length > 0) this.#drain()
      else for (const wake of this.#idlers.splice(0)) wake()
      this.#wake()
    })
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
