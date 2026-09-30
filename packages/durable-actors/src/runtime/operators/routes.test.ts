import { BunCrypto } from "@effect/platform-bun"
import {
  type Crypto,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Schema,
  type Scope,
} from "effect"
import { describe, expect, it } from "vitest"
import { Actor } from "../../index.ts"
import { ActorTest } from "../../testing/actor-test.ts"
import type { ConformanceEnvironment } from "../../testing/conformance.ts"
import { operatorHarness } from "../../testing/conformance/operator-harness.ts"
import type { Capability } from "./grants.ts"
import { ProviderOutcomeUnknown } from "./repair.ts"
import { SeedJson } from "./seed.ts"

const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

class ProviderDown extends Schema.TaggedError<ProviderDown>()("OpsProviderDown", {}) {}

const Charge = Actor.job("OpsCharge", { payload: { amount: Schema.Finite } })

const Ship = Actor.job("OpsShip", { payload: { parcel: Schema.String } })

const Pay = Actor.command("Pay", { payload: Schema.Finite })

const Send = Actor.command("Send", { payload: Schema.String })

const Later = Actor.command("Later", { payload: Schema.String })

const Till = Actor.make("OpsTill", {
  key: Schema.String,
  api: { Pay, Send, Later },
  jobs: {
    OpsCharge: { job: Charge, retry: { times: 0 } },
    OpsShip: { job: Ship, retry: { times: 0 } },
  },
})

/** The job ids each executor saw, and whether the provider is up. */
const fixture = {
  charges: [] as Array<string>,
  ships: [] as Array<string>,
  shippedFor: [] as Array<string>,
  up: false,
}

const live = Layer.mergeAll(
  Till.toLayer({
    Pay: Effect.fn(function* (amount) {
      yield* (yield* Till.Turn).enqueue(Charge.make({ amount }))
    }),
    Send: Effect.fn(function* (parcel) {
      yield* (yield* Till.Turn).enqueue(Ship.make({ parcel }))
    }),
    Later: Effect.fn(function* (parcel) {
      yield* (yield* Till.Turn).enqueue(Ship.make({ parcel }), { key: "later", after: "1 hour" })
    }),
  }),
  Till.toJobLayer({
    OpsCharge: Effect.fn(function* () {
      fixture.charges.push((yield* Till.Executor).jobId)

      if (!fixture.up) return yield* ProviderDown.make({})
    }),
    OpsShip: Effect.fn(function* () {
      const executor = yield* Till.Executor
      fixture.ships.push(executor.jobId)
      fixture.shippedFor.push(executor.ref.id)

      if (!fixture.up) return yield* Effect.die(new Error("carrier reply lost"))
    }),
  }),
)

const crypto = ManagedRuntime.make(BunCrypto.layer)

/** An in-process PGlite environment with only what the operator harness uses. */
const environment: ConformanceEnvironment = {
  run: <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
    crypto.runPromise(Effect.scoped(effect)),
  freshDatabase: Effect.succeed({}),
} as never

const withOperators = <A, E>(
  tokens: Record<string, ReadonlyArray<Capability>>,
  body: Parameters<typeof operatorHarness<A, E>>[0]["body"],
) =>
  operatorHarness({
    environment,
    live,
    reset: () => Object.assign(fixture, { charges: [], ships: [], shippedFor: [], up: false }),
    tokens,
    body,
  })

const till = (tenant: string) => ({ tenant, actorType: "OpsTill", actorId: "t1" })

const retryPath = (jobId: string) => `/operator/dead-letters/${jobId}/retry`

const discardPath = (jobId: string) => `/operator/dead-letters/${jobId}/discard`

/** One dead letter of a charge whose provider failed with a typed error: not ambiguous. */
const deadCharge = Effect.gen(function* () {
  yield* (yield* Till.get("t1")).Pay(5)
  yield* (yield* ActorTest).advance(0)
})

describe("operator repairs and exports of jobs", () => {
  it("retries a dead letter as a new job and audits the new job id", () =>
    withOperators(
      { "repair-token": [{ action: "dead-letters.retry", tenant: "*", actorType: "OpsTill" }] },
      ({ tenant, send, deadLetters, audit }) =>
        Effect.gen(function* () {
          yield* deadCharge
          const [letter] = yield* deadLetters
          expect(letter).toMatchObject({ job: "OpsCharge", ambiguous: false })
          fixture.up = true

          const retried = yield* send("POST", retryPath(letter!.job_id), "repair-token", {
            ...till(tenant),
            reason: "provider back up",
          })

          expect(retried.status).toBe(200)
          const { jobId } = retried.body as { readonly jobId: string }
          expect(jobId).not.toBe(letter!.job_id)
          yield* (yield* ActorTest).advance(0)
          expect(fixture.charges).toEqual([letter!.job_id, jobId])
          expect(yield* deadLetters).toEqual([])

          const [row] = yield* audit
          expect(row).toMatchObject({ action: "dead-letters.retry", target: letter!.job_id })
          expect(yield* parseJson(row!.outcome)).toMatchObject({
            retried: letter!.job_id,
            jobId,
            job: "OpsCharge",
            ambiguous: false,
            providerChecked: false,
          })
        }),
    ))

  it("refuses an ambiguous retry until the provider was checked, naming the job id", () =>
    withOperators(
      { "repair-token": [{ action: "dead-letters.retry", tenant: "*" }] },
      ({ tenant, send, deadLetters, audit }) =>
        Effect.gen(function* () {
          yield* (yield* Till.get("t1")).Send("box")
          yield* (yield* ActorTest).advance(0)
          const [letter] = yield* deadLetters
          expect(letter!.ambiguous).toBe(true)
          const body = { ...till(tenant), reason: "carrier says it never arrived" }

          const refused = yield* send("POST", retryPath(letter!.job_id), "repair-token", body)

          expect(refused.status).toBe(409)
          expect(yield* Schema.decodeUnknownEffect(ProviderOutcomeUnknown)(refused.body)).toEqual(
            ProviderOutcomeUnknown.make({ jobId: letter!.job_id }),
          )
          expect(yield* audit).toEqual([])

          fixture.up = true
          const checked = yield* send("POST", retryPath(letter!.job_id), "repair-token", {
            ...body,
            providerChecked: true,
          })

          expect(checked.status).toBe(200)
          yield* (yield* ActorTest).advance(0)
          expect(fixture.ships.length).toBe(2)
        }),
    ))

  it("discards a dead letter, answering its job id and auditing no payload", () =>
    withOperators(
      { "repair-token": [{ action: "dead-letters.discard", tenant: "*" }] },
      ({ tenant, send, deadLetters, audit }) =>
        Effect.gen(function* () {
          yield* deadCharge
          const [letter] = yield* deadLetters
          const body = { ...till(tenant), reason: "refunded by hand" }

          expect(yield* send("POST", discardPath(letter!.job_id), "repair-token", body)).toEqual({
            status: 200,
            body: { discarded: letter!.job_id },
          })
          expect(yield* deadLetters).toEqual([])

          const [row] = yield* audit
          expect(yield* parseJson(row!.outcome)).toMatchObject({
            discarded: letter!.job_id,
            job: "OpsCharge",
            ambiguous: false,
          })
          expect(row!.outcome).not.toContain("amount")
        }),
    ))

  it("exports pending jobs under jobs and starts another actor from the seed", () =>
    withOperators({ "export-token": [{ action: "export", tenant: "*" }] }, ({ tenant, send }) =>
      Effect.gen(function* () {
        yield* (yield* Till.get("t1")).Later("parcel")

        const exported = yield* send(
          "GET",
          `/operator/actors/OpsTill/t1/export?tenant=${tenant}`,
          "export-token",
        )

        expect(exported.status).toBe(200)
        expect(exported.body).toMatchObject({
          jobs: [
            {
              job: "OpsShip",
              payload: yield* Schema.encodeEffect(Ship)(Ship.make({ parcel: "parcel" })),
              key: "later",
            },
          ],
        })
        expect(exported.body).not.toHaveProperty("effects")

        const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          exported.body,
        )
        const { jobs, ...rest } = yield* Schema.decodeEffect(SeedJson)(text)

        const legacy = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          ...rest,
          effects: jobs.map(({ job, ...entry }) => ({ ...entry, effect: job })),
        })

        expect(Exit.isFailure(yield* Effect.exit(Schema.decodeEffect(SeedJson)(legacy)))).toBe(true)

        const test = yield* ActorTest
        const seeded = yield* test
          .actor(Till, "t2", { seed: "t2.seed" })
          .pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.makeNoop({ readFileString: () => Effect.succeed(text) }),
            ),
          )

        expect(fixture.ships).toEqual([])
        fixture.up = true
        yield* test.advance(Duration.hours(2))
        expect(fixture.shippedFor.toSorted()).toEqual(["t1", "t2"])
        expect(new Set(fixture.ships).size).toBe(2)
        expect(yield* seeded.inspect).toMatchObject({ outbox: 0 })
      }),
    ))
})
