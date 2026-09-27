import { Effect, Layer, ManagedRuntime, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import { ActorRef } from "../../identity/caller.ts"
import { type ProgressMessage, ProgressSink, progressPool } from "./progress.ts"

const ref = ActorRef.make({ tenant: "t", actor: "Encoder", id: "e" })

const frame = (n: number) => new Uint8Array([n])

const attempt = (effectId: string, everyMs: number | undefined) => ({
  ref,
  effectId,
  effect: "Transcode",
  attempt: 1,
  everyMs,
  leaseUntil: () => 60_000,
})

// Runs `body` on TestClock against a sink that records every send, or with no sink at all.
const record = (
  body: (sent: ReadonlyArray<ProgressMessage>) => Effect.Effect<void, never, Scope.Scope>,
  sink: "wants" | "rejects" | "none" = "wants",
) => {
  const sent: Array<ProgressMessage> = []

  const sinkLayer =
    sink === "none"
      ? Layer.empty
      : Layer.succeed(ProgressSink, {
          wants: () => sink === "wants",
          send: (message) =>
            Effect.sync(() => {
              sent.push(message)
            }),
          closed: () => Effect.void,
        })

  return Effect.acquireUseRelease(
    Effect.sync(() => ManagedRuntime.make(Layer.mergeAll(sinkLayer, TestClock.layer()))),
    (runtime) => Effect.promise(() => runtime.runPromise(Effect.scoped(body(sent)))),
    (runtime) => Effect.promise(() => runtime.dispose()),
  ).pipe(Effect.as(sent))
}

it("sends the latest frame at most once per progressEvery and flushes it on close", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sent = yield* record((sent) =>
        Effect.gen(function* () {
          const pool = yield* progressPool()
          const slot = yield* pool.open(attempt("a", 250))
          yield* slot.offer(frame(1))
          yield* TestClock.adjust(0)
          yield* slot.offer(frame(2))
          yield* slot.offer(frame(3))
          yield* TestClock.adjust(100)
          expect(sent.map((message) => message.seq)).toEqual([1])
          yield* TestClock.adjust(150)
          expect(sent.map((message) => message.seq)).toEqual([1, 3])
          yield* slot.offer(frame(4))
          yield* slot.close
          yield* slot.offer(frame(5))
          yield* slot.close
          yield* TestClock.adjust(1000)
        }),
      )

      expect(sent.map((message) => [message.seq, message.frame[0]])).toEqual([
        [1, 1],
        [3, 3],
        [4, 4],
      ])
      expect(sent[0]).toMatchObject({ effectId: "a", attempt: 1, leaseUntil: 60_000 })
    }),
  ))

it("sends nothing without a sink, a recipient, or a progress schema", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const offer = (everyMs: number | undefined) => () =>
        Effect.gen(function* () {
          const pool = yield* progressPool()
          const slot = yield* pool.open(attempt("x", everyMs))
          yield* slot.offer(frame(1))
          yield* slot.close
        })

      const sent = [
        yield* record(offer(250), "none"),
        yield* record(offer(250), "rejects"),
        yield* record(offer(undefined)),
      ]

      expect(sent).toEqual([[], [], []])
    }),
  ))

it("caps a runner's progress messages per second across attempts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sent = yield* record((sent) =>
        Effect.gen(function* () {
          const pool = yield* progressPool({ perSecond: 2 })

          const slots = yield* Effect.forEach(["a", "b", "c", "d"], (id) =>
            pool.open(attempt(id, 250)),
          )

          yield* Effect.forEach(slots, (slot) => slot.offer(frame(1)))
          yield* TestClock.adjust(0)
          expect(sent.length).toBe(2)
          yield* TestClock.adjust(1000)
          expect(sent.length).toBe(4)
          // The bucket is empty again, so closing drops the frames still pending.
          yield* Effect.forEach(slots, (slot) => slot.offer(frame(2)))
          yield* Effect.forEach(slots, (slot) => slot.close)
        }),
      )

      expect(sent.length).toBe(4)
    }),
  ))

it("closes a slot without waiting on or failing with its sink", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const closed: Array<string> = []

      const run = (send: (message: ProgressMessage) => Effect.Effect<void>) => {
        const runtime = ManagedRuntime.make(
          Layer.succeed(ProgressSink, {
            wants: () => true,
            send,
            closed: (message) =>
              Effect.sync(() => {
                closed.push(message.effectId)
              }),
          }),
        )

        return Effect.acquireUseRelease(
          Effect.succeed(runtime),
          () =>
            Effect.promise(() =>
              runtime.runPromise(
                Effect.scoped(
                  Effect.gen(function* () {
                    const pool = yield* progressPool()
                    const slot = yield* pool.open(attempt("a", 250))
                    yield* slot.offer(frame(1))
                    yield* Effect.yieldNow
                    yield* slot.offer(frame(2))
                    yield* slot.close
                    yield* pool.closed({ ...attempt("a", 250), attempt: 1 })
                    yield* pool.closed({ ...attempt("b", undefined), attempt: 1 })
                    yield* Effect.sleep(20)
                  }),
                ),
              ),
            ),
          () => Effect.promise(() => runtime.dispose()),
        )
      }

      yield* run(() => Effect.die(new Error("sink down")))
      expect(closed).toEqual(["a"])
      yield* run(() => Effect.never)
      expect(closed).toEqual(["a"])
    }),
  ))
