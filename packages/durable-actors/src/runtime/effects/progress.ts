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
  readonly effectId: string
  readonly effect: string
  readonly attempt: number
  /** Per attempt, from 1; counts the attempt's accepted `progress` calls. */
  readonly seq: number
  /** The attempt's lease deadline on the database clock, as last claimed or renewed. */
  readonly leaseUntil: number
  readonly frame: Uint8Array
}

/** Sent after an effect's terminal settle commits; no attempt of it reports again. */
export interface ProgressClosed {
  readonly ref: ActorRef
  readonly effectId: string
  readonly attempt: number
}

/**
 * Where an executor pool sends progress. Sends are fire-and-forget: there is
 * no acknowledgment or resend, and a lost message is a lost frame. Without a
 * sink, or for an effect `wants` rejects, the pool sends nothing.
 */
export class ProgressSink extends Context.Service<
  ProgressSink,
  {
    readonly wants: (actor: string, effect: string) => boolean
    readonly send: (message: ProgressMessage) => Effect.Effect<void>
    readonly closed: (message: ProgressClosed) => Effect.Effect<void>
  }
>()("@durable-actors/core/runtime/effects/progress/ProgressSink") {}

/**
 * Sees every message a runner's pool sends before the runtime delivers it;
 * `false` drops it. Tests record and drop progress here, between the pool and
 * the owner.
 */
export const ProgressTap = Context.Reference<{
  readonly send: (message: ProgressMessage) => Effect.Effect<boolean>
  readonly closed: (message: ProgressClosed) => Effect.Effect<boolean>
}>("@durable-actors/core/runtime/effects/progress/ProgressTap", {
  defaultValue: () => ({ send: () => Effect.succeed(true), closed: () => Effect.succeed(true) }),
})

/** One attempt's progress slot: latest wins, sent at most once per `everyMs`. */
export interface ProgressSlot {
  /** False once nothing more will be sent, so a caller can skip encoding frames. */
  readonly active: () => boolean
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
 * frame borrows a token instead of waiting.
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

  // Takes a token if one is free, refilling at `perSecond` up to a burst of one second's worth.
  const tryToken = Effect.map(refill, () => {
    if (tokens < 1) return false
    tokens -= 1

    return true
  })

  // Runs `effect` off the caller's fiber, waiting for it only a bounded time.
  const detached = (effect: Effect.Effect<void>) =>
    effect.pipe(
      Effect.ignoreCause,
      Effect.forkIn(scope),
      Effect.tap((fiber) =>
        Fiber.await(fiber).pipe(Effect.timeoutOption(PROGRESS_CLOSE_WAIT_MS), Effect.asVoid),
      ),
    )

  // Each effect's last flush, so its close is sent after that attempt's final frame.
  const flushes = new Map<string, Fiber.Fiber<void>>()

  // An attempt's last frame is sent even when the bucket is empty; the debt
  // delays later sends, so the runner still averages `perSecond`.
  const borrow = Effect.map(refill, () => {
    tokens -= 1
  })

  const token: Effect.Effect<void> = Effect.gen(function* () {
    while (!(yield* tryToken)) yield* Effect.sleep(Math.ceil(((1 - tokens) * 1000) / perSecond))
  })

  const open = Effect.fnUntraced(function* (attempt: {
    readonly ref: ActorRef
    readonly effectId: string
    readonly effect: string
    readonly attempt: number
    readonly everyMs: number | undefined
    readonly leaseUntil: () => number
  }) {
    if (sink === undefined || attempt.everyMs === undefined) return closedSlot

    if (!sink.wants(attempt.ref.actor, attempt.effect)) return closedSlot
    const everyMs = attempt.everyMs
    const signal = yield* Queue.sliding<void>(1)
    let seq = 0
    let closed = false
    let pending: { readonly seq: number; readonly frame: Uint8Array } | undefined
    // The frame the sink is accepting, resent on close if that send is interrupted.
    let inflight: { readonly seq: number; readonly frame: Uint8Array } | undefined
    let sentAt: number | undefined

    const send = (frame: { readonly seq: number; readonly frame: Uint8Array }) =>
      sink
        .send({
          ref: attempt.ref,
          effectId: attempt.effectId,
          effect: attempt.effect,
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

        // A signal left by a frame already sent must not spend a token.
        if (pending === undefined) continue
        yield* token
        const next = pending
        pending = undefined

        if (next === undefined) continue
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

              return Effect.andThen(borrow, send(last))
            }),
          ),
          detached,
          Effect.map((flush) => {
            flushes.set(attempt.effectId, flush)
          }),
        )
      }),
    } satisfies ProgressSlot
  })

  // Only effects that could have opened a slot are closed.
  const closed = (
    message: ProgressClosed & { readonly effect: string; readonly everyMs: number | undefined },
  ) =>
    Effect.suspend(() => {
      const flush = flushes.get(message.effectId)
      flushes.delete(message.effectId)

      if (
        sink === undefined ||
        message.everyMs === undefined ||
        !sink.wants(message.ref.actor, message.effect)
      )
        return Effect.void

      // A final frame still sending after the bound is left to finish on its own.
      const last =
        flush === undefined
          ? Effect.void
          : Fiber.await(flush).pipe(Effect.timeoutOption(PROGRESS_CLOSE_WAIT_MS), Effect.asVoid)

      return last.pipe(
        Effect.andThen(
          sink.closed({ ref: message.ref, effectId: message.effectId, attempt: message.attempt }),
        ),
        detached,
        Effect.asVoid,
      )
    })

  // An attempt that ends without a terminal settle keeps no flush.
  const forget = (effectId: string) => Effect.sync(() => flushes.delete(effectId))

  return { open, closed, forget }
})

export type ProgressPool = Effect.Success<ReturnType<typeof progressPool>>
