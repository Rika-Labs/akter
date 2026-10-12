import { Socket } from "node:net"
import { Effect, Fiber } from "effect"
import { expect, it } from "vitest"
import { ClockReadings } from "./clock.ts"
import { resumeEpoch } from "./database/resume.ts"

it("withdraws readiness before teardown and waits for the newest close barrier across repeated suspension", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let wall = 0
        const epoch = yield* resumeEpoch.pipe(
          Effect.provideService(ClockReadings, () => ({ at: 0, wall })),
        )
        epoch.requireReacquisition()
        const closes: Array<() => void> = []
        class ClosingSocket extends Socket {
          closing = false
          override destroy(error?: Error) {
            if (this.closing) return this
            this.closing = true
            expect(epoch.ready()).toBe(false)
            closes.push(() => {
              super.destroy(error)
            })
            return this
          }
        }
        const factory = epoch.track({
          stream: () => new ClosingSocket(),
        }).stream!
        factory()
        for (let index = 0; index < 20; index++) expect(epoch.check()).toBe(0)
        wall += 300_000
        expect(epoch.check()).toBe(1)
        const waiting = yield* epoch.settled.pipe(Effect.forkChild)
        yield* Effect.yieldNow
        factory()
        wall += 300_000
        expect(epoch.check()).toBe(2)
        closes[0]!()
        yield* Effect.sleep("25 millis")
        expect(waiting.pollUnsafe()).toBeUndefined()
        closes[1]!()
        yield* Fiber.join(waiting).pipe(Effect.timeout("1 second"))
        expect(epoch.ready()).toBe(false)
        expect(epoch.check()).toBe(2)
      }),
    ),
  ))

it("detects an idle runtime's corrected wall clock on its clock-only background tick", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let wall = 0
        let destroyed = false
        const epoch = yield* resumeEpoch.pipe(
          Effect.provideService(ClockReadings, () => ({ at: 0, wall })),
        )
        epoch.requireReacquisition()
        const socket = epoch.track({ stream: () => new Socket() }).stream!()
        socket.once("close", () => {
          destroyed = true
        })
        yield* epoch.recover(Effect.succeed(true))
        wall += 300_000
        yield* Effect.sleep("1.2 seconds")
        expect(destroyed).toBe(true)
        expect(socket.destroyed).toBe(true)
        expect(epoch.check()).toBe(1)
        expect(epoch.ready()).toBe(true)
      }),
    ),
  ))
