import { Clock, Context, Effect, Fiber, Option, Queue } from "effect"
import type { ActorRef } from "../../identity/caller.ts"

/** An encoded frame is at most this many bytes. */
export const MAX_PROGRESS_BYTES = 4096

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

/** One attempt's progress slot: latest wins, sent at most once per `everyMs`. */
export interface ProgressSlot {
  readonly offer: (frame: Uint8Array) => Effect.Effect<void>
  /** Sends the pending frame if the runner has a token free, and ignores every later offer. */
  readonly close: Effect.Effect<void>
}

const closedSlot: ProgressSlot = { offer: () => Effect.void, close: Effect.void }

/**
 * A runner's progress pool. It holds one slot per running attempt and a
 * runner-wide token bucket; a frame that finds no token stays in its slot,
 * where newer frames replace it, until one is free.
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
    let sentAt: number | undefined

    const send = (frame: { readonly seq: number; readonly frame: Uint8Array }) =>
      sink.send({
        ref: attempt.ref,
        effectId: attempt.effectId,
        effect: attempt.effect,
        attempt: attempt.attempt,
        seq: frame.seq,
        leaseUntil: attempt.leaseUntil(),
        frame: frame.frame,
      })

    const sender = yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(signal)

        if (sentAt !== undefined) {
          const wait = sentAt + everyMs - (yield* Clock.currentTimeMillis)

          if (wait > 0) yield* Effect.sleep(wait)
        }

        yield* token
        const next = pending
        pending = undefined

        if (next === undefined) continue
        sentAt = yield* Clock.currentTimeMillis
        yield* send(next)
      }
    }).pipe(Effect.forkIn(scope))

    return {
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
              const last = pending
              pending = undefined

              if (last === undefined) return Effect.void

              return Effect.flatMap(tryToken, (free) => (free ? send(last) : Effect.void))
            }),
          ),
        )
      }),
    } satisfies ProgressSlot
  })

  const closed = (message: ProgressClosed) =>
    sink === undefined ? Effect.void : sink.closed(message)

  return { open, closed }
})

export type ProgressPool = Effect.Success<ReturnType<typeof progressPool>>
