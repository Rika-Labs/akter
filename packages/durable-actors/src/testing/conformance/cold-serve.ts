import {
  Clock,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Schema,
  Scope,
} from "effect"
import { Actor, Intent } from "../../index.ts"
import { InternalActors } from "../../runtime/actors.ts"
import { RuntimeControl } from "../../runtime/drain.ts"
import type { ConformanceCase } from "../conformance.ts"
import {
  bearerHeaders,
  clientFor,
  delayingProxy,
  edgeOf,
  edgeRunner,
  REGION,
} from "./assertions.ts"
import { reasonOf, receipts, runs, serveHttp, tenantOf } from "./http.ts"

/**
 * Scale-to-zero serving: a deployment's last runner drains and exits, and the
 * next request starts a new one. The runtime cases stop the conformance
 * runtime between two served runners on the same database, as a platform that
 * scales to zero stops the process; the edge cases start runners only when
 * the edge asks its provider for one.
 */

const Deposit = Actor.command("Deposit", { input: Schema.Int, output: Schema.Int })

const Hold = Actor.command("Hold", { output: Schema.Int })

const Plan = Actor.command("Plan")

const Remind = Actor.command("Remind")

const Balance = Actor.query("Balance", {
  output: Schema.Struct({ balance: Schema.Int, holds: Schema.Int, reminded: Schema.Int }),
})

const zero = Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0)))

/** An account whose deposits, held turns, and reminders are each counted in state. */
const ColdLedger = Actor.make("ColdLedger", {
  key: Schema.String,
  state: Actor.state({ balance: zero, holds: zero, reminded: zero }),
  api: { Deposit, Hold, Plan, Balance },
  internal: { Remind },
})

/** Shared by the ledger's handlers and the cold-serve cases; each case resets it first. */
export interface ColdServeFixture {
  /** Deposit handler runs by command id, rolled-back runs included. */
  readonly deposits: Map<string, number>
  /** What a held turn waits for before it commits. */
  hold: Effect.Effect<void>
}

export const coldServeFixture = (): ColdServeFixture => ({
  deposits: new Map(),
  hold: Effect.void,
})

export const coldServeLayer = (fixture: ColdServeFixture) =>
  Layer.mergeAll(
    ColdLedger.toLayer(
      Effect.succeed({
        Deposit: Effect.fnUntraced(function* (amount: number) {
          const turn = yield* ColdLedger.Turn
          fixture.deposits.set(turn.commandId, (fixture.deposits.get(turn.commandId) ?? 0) + 1)
          yield* turn.state.set({ balance: turn.state.balance + amount })

          return turn.state.balance
        }),
        Hold: Effect.fnUntraced(function* () {
          const turn = yield* ColdLedger.Turn
          yield* Effect.suspend(() => fixture.hold)
          yield* turn.state.set({ holds: turn.state.holds + 1 })

          return turn.state.holds
        }),
        Plan: Effect.fnUntraced(function* () {
          const turn = yield* ColdLedger.Turn
          yield* (yield* ColdLedger.intents(turn.ref.id)).Remind().pipe(Intent.after("1 second"))
        }),
        Remind: Effect.fnUntraced(function* () {
          const turn = yield* ColdLedger.Turn
          yield* turn.state.set({ reminded: turn.state.reminded + 1 })
        }),
      }),
    ),
    ColdLedger.toQueryLayer(
      Effect.succeed({
        Balance: Effect.fnUntraced(function* () {
          const { state } = yield* ColdLedger.Read

          return { balance: state.balance, holds: state.holds, reminded: state.reminded }
        }),
      }),
    ),
  )

const reset = (fixture: ColdServeFixture) =>
  Effect.sync(() => {
    fixture.deposits.clear()
    fixture.hold = Effect.void
  })

const serveLedger = serveHttp({ actors: [ColdLedger] })

const path = (id: string, member: string) => `/actors/ColdLedger/${id}/${member}`

/** A v1 command id issued now, as a client would mint it from `/protocol`. */
const mint = Effect.gen(function* () {
  const actors = yield* InternalActors
  const now = yield* actors.databaseNow

  const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)

  return `v1.${now}.${now + actors.retryWindowMs}.${uuid}`
})

/** The bound a cold start of the conformance runtime must answer within. */
const COLD_START_BOUND_MS = 30_000

export const coldServeConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "recovers committed and due work after scaling to zero, and runs every retried command once",
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const cold = fixture.coldServe
          yield* reset(cold)
          yield* environment.restart

          const first = yield* Effect.promise(() =>
            environment.run(
              Effect.gen(function* () {
                const server = yield* serveLedger
                const token = `${yield* tenantOf}:alice`
                const deposited = yield* mint
                const held = yield* mint
                const refused = yield* mint

                const answer = yield* server.send(path("l1", "Deposit"), {
                  token,
                  key: deposited,
                  body: 5,
                })

                expect(answer).toMatchObject({ status: 200, body: 5 })
                expect(
                  yield* server.send(path("l1", "Plan"), { token, key: yield* mint }),
                ).toMatchObject({ status: 204 })

                const entered = yield* Deferred.make<void>()

                cold.hold = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))

                const holding = yield* server
                  .send(path("l1", "Hold"), { token, key: held })
                  .pipe(Effect.forkChild)

                yield* Deferred.await(entered)

                const report = yield* RuntimeControl.use((control) =>
                  control.drain({ deadline: "300 millis" }),
                )

                expect(report).toMatchObject({
                  outcome: "deadline-expired",
                  interruptedTurns: 1,
                })

                yield* Fiber.interrupt(holding)

                const late = yield* server.send(path("l1", "Deposit"), {
                  token,
                  key: refused,
                  body: 7,
                })

                expect(late.status).toBe(503)
                expect(yield* server.send("/ready", { method: "GET" })).toMatchObject({
                  status: 503,
                  body: { ready: false, reason: "drained" },
                })

                return { token, deposited, held, refused, answer: answer.body }
              }),
            ),
          )

          yield* environment.stop
          cold.hold = Effect.void
          yield* Effect.sleep("1500 millis")

          const stopped = yield* Clock.currentTimeMillis

          yield* environment.restart

          const coldMs = yield* Effect.promise(() =>
            environment.run(
              Effect.gen(function* () {
                const server = yield* serveLedger

                const again = yield* server.send(path("l1", "Deposit"), {
                  token: first.token,
                  key: first.deposited,
                  body: 5,
                })

                const answeredMs = (yield* Clock.currentTimeMillis) - stopped

                expect(again).toMatchObject({ status: 200, body: first.answer })
                expect(
                  yield* server.send(path("l1", "Hold"), { token: first.token, key: first.held }),
                ).toMatchObject({ status: 200, body: 1 })
                expect(
                  yield* server.send(path("l1", "Deposit"), {
                    token: first.token,
                    key: first.refused,
                    body: 7,
                  }),
                ).toMatchObject({ status: 200, body: 12 })

                const balance = server
                  .send(path("l1", "Balance"), { token: first.token })
                  .pipe(Effect.map((reply) => reply.body))

                const reminded = yield* balance.pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("100 millis"),
                    until: (body) =>
                      Schema.is(Schema.Struct({ reminded: Schema.Literal(1) }))(body),
                    times: 200,
                  }),
                )

                expect(reminded).toEqual({ balance: 12, holds: 1, reminded: 1 })
                yield* Effect.sleep("1 second")
                expect(yield* balance).toEqual({ balance: 12, holds: 1, reminded: 1 })

                return answeredMs
              }),
            ),
          )

          expect(cold.deposits.get(first.deposited)).toBe(1)
          expect(cold.deposits.get(first.refused)).toBe(1)
          expect(coldMs > 0 && coldMs < COLD_START_BOUND_MS).toBe(true)
        }).pipe(
          Effect.ensuring(reset(fixture.coldServe)),
          Effect.onError(() => environment.restart),
        ),
      ),
  },
]

/** Runs `provider` on every wake the edge records until the scope closes, checking every 20 ms. */
const provide = <R>(
  takeWakes: Effect.Effect<ReadonlyArray<string>>,
  provider: (region: string) => Effect.Effect<void, never, R>,
) =>
  takeWakes.pipe(
    Effect.flatMap((regions) => Effect.forEach(regions, provider, { discard: true })),
    Effect.repeat(Schedule.spaced("20 millis")),
    Effect.forkScoped,
  )

export const coldServeEdgeConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "cold-starts one runner for a burst of requests to a deployment with none, forwards once it answers ready, and again after it scales to zero",
    requiresEdge: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* (yield* edgeOf(environment.edge)).start({
            primaryRegion: REGION,
            scaleToZero: true,
          })

          const send = yield* clientFor(edge.url)
          const tenant = yield* tenantOf
          const key = yield* edge.issueApiKey({ tenant, subject: "alice" })
          const launched: Array<{ readonly url: string; readonly scope: Scope.Closeable }> = []
          const probes: Array<Effect.Effect<number>> = []

          yield* provide(edge.takeWakes, (region) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make()
              const runner = yield* edgeRunner(edge, region).pipe(Scope.provide(scope))
              const door = yield* delayingProxy(runner.url).pipe(Scope.provide(scope))

              yield* door.fail("/ready", 3)
              launched.push({ url: door.url, scope })
              probes.push(door.arrived)
              yield* edge.addRunner({ region, url: door.url })
            }),
          )

          const whoami = (id: string, commandId: string) =>
            send({
              method: "POST",
              path: `/actors/HttpRoom/${id}/Whoami`,
              key: commandId,
              body: "",
              headers: bearerHeaders(key),
            })

          const ids = yield* Effect.forEach(Array.from({ length: 8 }), () => mint)

          const burst = yield* Effect.forEach(ids, (id, index) => whoami(`cold-${index}`, id), {
            concurrency: "unbounded",
          })

          expect(burst.map((reply) => reply.status)).toEqual(ids.map(() => 200))
          expect(burst.map((reply) => reply.body)).toEqual(ids.map(() => `${tenant}/alice`))
          expect(launched.length).toBe(1)
          expect((yield* probes[0]!) >= 3 + ids.length).toBe(true)

          yield* edge.removeRunner(launched[0]!.url)
          yield* Scope.close(launched[0]!.scope, Exit.void)
          yield* Effect.sleep("500 millis")

          const before = runs.count
          const again = yield* whoami("cold-0", ids[0]!)

          expect(again).toMatchObject({ status: 200, body: `${tenant}/alice` })
          expect(launched.length).toBe(2)
          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "cold-0")).toBe(1)
        }),
      ),
  },
  {
    name: "refuses at once without a wake when scale-to-zero is off, and after the cold-start bound when no runner answers ready",
    requiresEdge: true,
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const start = (yield* edgeOf(environment.edge)).start
          const always = yield* start({ primaryRegion: REGION })

          const scaled = yield* start({
            primaryRegion: REGION,
            scaleToZero: true,
            coldStartSeconds: 1,
          })

          const call = (edge: typeof always) =>
            Effect.gen(function* () {
              const send = yield* clientFor(edge.url)
              const tenant = yield* tenantOf
              const key = yield* edge.issueApiKey({ tenant, subject: "alice" })

              return yield* send({
                method: "POST",
                path: "/actors/HttpRoom/nobody/Whoami",
                key: yield* mint,
                body: "",
                headers: bearerHeaders(key),
              })
            })

          const refused = yield* call(always)

          expect(refused.status).toBe(503)
          expect(yield* reasonOf(refused.body)).toEqual({ tag: "ActorUnavailable" })
          expect(yield* always.takeWakes).toEqual([])

          const asked = yield* Clock.currentTimeMillis
          const waited = yield* call(scaled)
          const waitedMs = (yield* Clock.currentTimeMillis) - asked

          expect(waited.status).toBe(503)
          expect(yield* reasonOf(waited.body)).toEqual({ tag: "ActorUnavailable" })
          expect(waitedMs >= 1000).toBe(true)
          expect(yield* scaled.takeWakes).toEqual([REGION])
        }),
      ),
  },
]
