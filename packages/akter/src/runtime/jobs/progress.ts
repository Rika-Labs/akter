import { Clock, Context, Effect, Fiber, Option, Queue } from "effect"
import type { ActorRef } from "../../identity/caller.ts"

/** An encoded frame is at most this many bytes. */
export const MAX_PROGRESS_BYTES = 4096

/** How long closing an attempt's progress waits on the sink before settling without it. */
export const PROGRESS_CLOSE_WAIT_MS = 100

/** Progress messages one runner's executor pool sends per second at most. */
export const RUNNER_PROGRESS_PER_SECOND = 2000

/** One progress frame on its way from an executor attempt to the owner. */
export interface ProgressMessage {
  readonly ref: ActorRef
  readonly jobId: string
  readonly job: string
  /** The attempt number of the job, from 1. */
  readonly attempt: number
  /** Per attempt, from 1; counts the attempt's accepted `progress` calls. */
  readonly seq: number
  /** The attempt's lease deadline on the database clock, as last claimed or renewed. */
  readonly leaseUntil: number
  readonly frame: Uint8Array
}

/** Sent after a job's terminal settle commits; no attempt of it reports again. */
export interface ProgressClosed {
  readonly ref: ActorRef
  readonly jobId: string
  readonly attempt: number
}

/**
 * Where an executor pool sends progress. Sends are fire-and-forget: there is
 * no acknowledgment or resend, and a lost message is a lost frame. Without a
 * sink, or for a job `wants` rejects, the pool sends nothing.
 */
export class ProgressSink extends Context.Service<
  ProgressSink,
  {
    readonly wants: (actor: string, job: string) => boolean
    readonly send: (message: ProgressMessage) => Effect.Effect<void>
    readonly closed: (message: ProgressClosed) => Effect.Effect<void>
  }
>()("@rikalabs/akter/runtime/jobs/progress/ProgressSink") {}

/**
 * Sees every message a runner's pool sends before the runtime delivers it;
 * `false` drops it. Tests record and drop progress here, between the pool and
 * the owner.
 */
export const ProgressTap = Context.Reference<{
  readonly send: (message: ProgressMessage) => Effect.Effect<boolean>
  readonly closed: (message: ProgressClosed) => Effect.Effect<boolean>
}>("@rikalabs/akter/runtime/jobs/progress/ProgressTap", {
  defaultValue: () => ({ send: () => Effect.succeed(true), closed: () => Effect.succeed(true) }),
})

/** One attempt's progress slot: latest wins, sent at most once per `everyMs`. */
interface ProgressSlot {
  /** False once nothing more will be sent, so a caller can skip encoding frames. */
  readonly active: () => boolean
  /** Replaces the pending frame; ignored once closed. */
  readonly offer: (frame: Uint8Array) => Effect.Effect<void>
  /**
   * Ignores every later offer, then sends the pending frame, borrowing a
   * token when none is free. It never fails with the sink and waits on it
   * only briefly.
   */
  readonly close: Effect.Effect<void>
}

const closedSlot: ProgressSlot = {
  active: () => false,
  offer: () => Effect.void,
  close: Effect.void,
}

/**
 * A runner's progress pool. It holds one slot per running attempt and a
 * runner-wide token bucket; a frame that finds no token stays in its slot,
 * where newer frames replace it, until one is free. A closing slot's last
 * frame borrows a token instead of waiting, so the debt delays later sends and
 * the runner still averages `perSecond`. The bucket refills at `perSecond` up
 * to a burst of one second's worth. Closing waits on the sink at most
 * `PROGRESS_CLOSE_WAIT_MS`; a final frame still sending then finishes on its
 * own. Closing sends the last frame even if a send was interrupted, and the
 * closed message follows that attempt's last flush. Only jobs that could
 * have opened a slot are closed, and an attempt that ends without a terminal
 * settle keeps no flush (`forget`).
 */
export const progressPool = Effect.fnUntraced(function* (options?: {
  readonly perSecond?: number
}) {
  const sink = Option.getOrUndefined(yield* Effect.serviceOption(ProgressSink))
  const scope = yield* Effect.scope
  const perSecond = options?.perSecond ?? RUNNER_PROGRESS_PER_SECOND
  let tokens = perSecond
  let refilledAt = yield* Clock.currentTimeMillis

  const refill = Effect.map(Clock.currentTimeMillis, (now) => {
    tokens = Math.min(perSecond, tokens + ((now - refilledAt) * perSecond) / 1000)
    refilledAt = now
  })

  /** Takes a token if one is free, or always when `borrow` is set, going into debt. */
  const take = (borrow: boolean) =>
    Effect.map(refill, () => {
      if (tokens < 1 && !borrow) return false
      tokens -= 1

      return true
    })

  const awaitBriefly = (fiber: Fiber.Fiber<void>) =>
    Fiber.await(fiber).pipe(Effect.timeoutOption(PROGRESS_CLOSE_WAIT_MS), Effect.asVoid)

  const detached = (effect: Effect.Effect<void>) =>
    effect.pipe(Effect.ignoreCause, Effect.forkIn(scope), Effect.tap(awaitBriefly))

  const flushes = new Map<string, Fiber.Fiber<void>>()

  const token: Effect.Effect<void> = Effect.gen(function* () {
    while (!(yield* take(false))) yield* Effect.sleep(Math.ceil(((1 - tokens) * 1000) / perSecond))
  })

  const open = Effect.fnUntraced(function* (attempt: {
    readonly ref: ActorRef
    readonly jobId: string
    readonly job: string
    readonly attempt: number
    readonly everyMs: number | undefined
    readonly leaseUntil: () => number
  }) {
    if (
      sink === undefined ||
      attempt.everyMs === undefined ||
      !sink.wants(attempt.ref.actor, attempt.job)
    )
      return closedSlot
    const everyMs = attempt.everyMs
    const signal = yield* Queue.sliding<void>(1)
    let seq = 0
    let closed = false
    let pending: { readonly seq: number; readonly frame: Uint8Array } | undefined
    let inflight: { readonly seq: number; readonly frame: Uint8Array } | undefined
    let sentAt: number | undefined

    const send = (frame: { readonly seq: number; readonly frame: Uint8Array }) =>
      sink
        .send({
          ref: attempt.ref,
          jobId: attempt.jobId,
          job: attempt.job,
          attempt: attempt.attempt,
          seq: frame.seq,
          leaseUntil: attempt.leaseUntil(),
          frame: frame.frame,
        })
        .pipe(Effect.ignoreCause)

    const sender = yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(signal)

        if (sentAt !== undefined) {
          const wait = sentAt + everyMs - (yield* Clock.currentTimeMillis)

          if (wait > 0) yield* Effect.sleep(wait)
        }

        if (pending === undefined) continue
        yield* token
        const next = pending
        pending = undefined
        sentAt = yield* Clock.currentTimeMillis
        inflight = next
        yield* send(next)
        inflight = undefined
      }
    }).pipe(Effect.forkIn(scope))

    return {
      active: () => !closed,
      offer: (frame) =>
        Effect.suspend(() => {
          if (closed) return Effect.void
          seq += 1
          pending = { seq, frame }

          return Queue.offer(signal, undefined).pipe(Effect.asVoid)
        }),
      close: Effect.suspend(() => {
        if (closed) return Effect.void
        closed = true

        return Fiber.interrupt(sender).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const last = pending ?? inflight
              pending = undefined
              inflight = undefined

              if (last === undefined) return Effect.void

              return Effect.andThen(take(true), send(last))
            }),
          ),
          detached,
          Effect.map((flush) => {
            flushes.set(attempt.jobId, flush)
          }),
        )
      }),
    } satisfies ProgressSlot
  })

  const closed = (attempt: {
    readonly ref: ActorRef
    readonly jobId: string
    readonly job: string
    readonly attempt: number
    readonly everyMs: number | undefined
  }) =>
    Effect.suspend(() => {
      const flush = flushes.get(attempt.jobId)
      flushes.delete(attempt.jobId)

      if (
        sink === undefined ||
        attempt.everyMs === undefined ||
        !sink.wants(attempt.ref.actor, attempt.job)
      )
        return Effect.void

      return (flush === undefined ? Effect.void : awaitBriefly(flush)).pipe(
        Effect.andThen(
          sink.closed({ ref: attempt.ref, jobId: attempt.jobId, attempt: attempt.attempt }),
        ),
        detached,
        Effect.asVoid,
      )
    })

  const forget = (jobId: string) => Effect.sync(() => flushes.delete(jobId))

  return { open, closed, forget }
})
