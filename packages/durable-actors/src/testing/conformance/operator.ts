import { Effect, Layer, Option, Schema, type Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors } from "../../index.ts"
import type { Capability } from "../../runtime/operators/grants.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"
import {
  type Answer,
  capability,
  encodeJson,
  type Harness,
  operatorHarness,
} from "./operator-harness.ts"

class Declined extends Schema.TaggedError<Declined>()("OpDeclined", { reason: Schema.String }) {}

class ProviderDown extends Schema.TaggedError<ProviderDown>()("OpProviderDown", {}) {}

// A typed failure: the provider did not apply the call.
class Charge extends Actor.effect<Charge>()("OpCharge", {
  input: { amount: Schema.Finite },
}) {}

// Dies: the provider may have applied the call.
class Ship extends Actor.effect<Ship>()("OpShip", { input: { parcel: Schema.String } }) {}

const Pay = Actor.command("Pay", { input: Schema.Finite, output: Schema.String })

const Refuse = Actor.command("Refuse", { input: Schema.String, errors: [Declined] })

const Send = Actor.command("Send", { input: Schema.String })

const Jam = Actor.command("Jam")

const Till = Actor.make("OpTill", {
  key: Schema.String,
  effects: [Charge, Ship],
  api: { Pay, Refuse, Send, Jam },
  policy: {
    effects: { OpCharge: { retry: { times: 0 } }, OpShip: { retry: { times: 0 } } },
  },
})

/** Counts handler runs and executor calls, and decides whether the provider is up. */
const fixture = {
  handlerRuns: 0,
  charges: [] as Array<string>,
  ships: [] as Array<string>,
  up: false,
}

const live = Layer.mergeAll(
  Till.toLayer(
    Effect.succeed({
      Pay: Effect.fnUntraced(function* (amount: number) {
        fixture.handlerRuns += 1
        yield* (yield* Till.Turn).perform(Charge.make({ amount }))

        return `paid ${amount}`
      }),
      Refuse: (reason: string) =>
        Effect.suspend(() => {
          fixture.handlerRuns += 1

          return Effect.fail(Declined.make({ reason }))
        }),
      Jam: () => Effect.die(new Error("till jammed")),
      Send: Effect.fnUntraced(function* (parcel: string) {
        fixture.handlerRuns += 1
        yield* (yield* Till.Turn).perform(Ship.make({ parcel }))
      }),
    }),
  ),
  Till.toEffectLayer(
    Effect.succeed({
      OpCharge: Effect.fnUntraced(function* () {
        const executor = yield* Till.Executor
        fixture.charges.push(executor.effectId)

        if (!fixture.up) return yield* ProviderDown.make({})
      }),
      OpShip: Effect.fnUntraced(function* () {
        const executor = yield* Till.Executor
        fixture.ships.push(executor.effectId)

        if (!fixture.up) return yield* Effect.die(new Error("carrier reply lost"))
      }),
    }),
  ),
)

const withOperators = <A, E>(
  environment: ConformanceEnvironment,
  tokens: Record<string, ReadonlyArray<Capability>>,
  body: (
    harness: Harness,
  ) => Effect.Effect<A, E, Actors | ActorTest | SqlClient.SqlClient | Scope.Scope>,
) =>
  operatorHarness({
    environment,
    live,
    reset: () => {
      Object.assign(fixture, { handlerRuns: 0, charges: [], ships: [], up: false })
    },
    tokens,
    body,
  })

const till = (tenant: string) => ({ tenant, actorType: "OpTill", actorId: "t1" })

const paths = (tenant: string) => ({
  inspect: `/operator/actors/OpTill/t1?tenant=${tenant}`,
  receipt: (commandId: string) => `/operator/receipts/OpTill/t1/${commandId}?tenant=${tenant}`,
  retry: (effectId: string) => `/operator/dead-letters/${effectId}/retry`,
  discard: (effectId: string) => `/operator/dead-letters/${effectId}/discard`,
  defects: `/operator/defects?tenant=${tenant}`,
  audit: `/operator/audit?tenant=${tenant}`,
})

/** One dead letter of `OpCharge` (not ambiguous) on `OpTill/t1`, left by a failed charge. */
const deadCharge = Effect.gen(function* () {
  yield* (yield* Till.get("t1")).Pay(5)
  yield* (yield* ActorTest).advance(0)
})

/** One dead letter of `OpShip`, ambiguous because the carrier's reply was lost. */
const deadShipment = Effect.gen(function* () {
  yield* (yield* Till.get("t1")).Send("box")
  yield* (yield* ActorTest).advance(0)
})

const reasonOf = (answer: Answer) =>
  Schema.decodeUnknownOption(
    Schema.Struct({ reason: Schema.Struct({ _tag: Schema.String, code: Schema.String }) }),
  )(answer.body)

export const operatorConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "refuses an application credential on every operator route and repairs nothing",
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        { "operator-token": [capability("dead-letters.retry", { tenant: "*" })] },
        ({ tenant, send, deadLetters, audit }) =>
          Effect.gen(function* () {
            yield* deadCharge
            const [letter] = yield* deadLetters
            const at = paths(tenant)
            const body = { ...till(tenant), reason: "customer asked" }

            // The application's own bearer token, and no token at all.
            for (const token of ["app-token", undefined])
              for (const [method, path, payload] of [
                ["GET", at.inspect, undefined],
                ["GET", at.receipt("v1.0.0.x"), undefined],
                ["GET", at.defects, undefined],
                ["GET", at.audit, undefined],
                ["POST", at.retry(letter!.effect_id), body],
                ["POST", at.discard(letter!.effect_id), body],
              ] as const) {
                const answer = yield* send(method, path, token, payload)

                expect(answer.status).toBe(401)
              }

            expect((yield* deadLetters).length).toBe(1)
            expect(fixture.charges.length).toBe(1)
            expect(yield* audit).toEqual([])
          }),
      ),
  },
  {
    name: "refuses a grant outside its action or resource scope, audits the denial, and changes nothing",
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        {
          // Retry on another actor, and inspection (not repair) on this one.
          "narrow-token": [
            capability("dead-letters.retry", { tenant: "*", actorType: "OpTill", actorId: "t2" }),
            capability("inspect", { tenant: "*", actorType: "OpTill", actorId: "t1" }),
          ],
        },
        ({ tenant, send, deadLetters, audit }) =>
          Effect.gen(function* () {
            yield* deadCharge
            const [letter] = yield* deadLetters
            const at = paths(tenant)

            const refused = yield* send("POST", at.retry(letter!.effect_id), "narrow-token", {
              ...till(tenant),
              reason: "try again",
            })

            expect(refused.status).toBe(403)
            expect(Option.getOrUndefined(reasonOf(refused))?.reason).toMatchObject({
              code: "access_denied",
            })
            expect((yield* send("GET", at.audit, "narrow-token")).status).toBe(403)
            expect((yield* deadLetters).length).toBe(1)
            expect(fixture.charges.length).toBe(1)

            expect(yield* audit).toMatchObject([
              {
                operator: "op-narrow-token",
                action: "dead-letters.retry",
                actor_id: "t1",
                target: letter!.effect_id,
                capability: null,
                outcome: '"denied"',
              },
              { operator: "op-narrow-token", action: "audit.read", outcome: '"denied"' },
            ])
          }),
      ),
  },
  {
    name: "inspects an actor with receipt tags only, and outcomes only under receipts.read",
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        {
          "look-token": [capability("inspect", { tenant: "*" })],
          "read-token": [
            capability("inspect", { tenant: "*" }),
            capability("receipts.read", { tenant: "*", actorType: "OpTill" }),
          ],
        },
        ({ tenant, send, audit }) =>
          Effect.gen(function* () {
            fixture.up = true
            yield* (yield* Till.get("t1")).Pay(7)
            const at = paths(tenant)

            const looked = yield* send("GET", at.inspect, "look-token")

            expect(looked.status).toBe(200)
            expect(looked.body).toMatchObject({
              actor: { actorType: "OpTill", actorId: "t1", generation: 1 },
              receipts: [{ command: "Pay", outcomeTag: "Success" }],
            })
            expect(
              (looked.body as { receipts: ReadonlyArray<object> }).receipts.every(
                (receipt) => !("outcome" in receipt),
              ),
            ).toBe(true)

            const read = yield* send("GET", at.inspect, "read-token")

            expect(read.body).toMatchObject({
              receipts: [{ command: "Pay", outcome: { json: { value: '{"value":"paid 7"}' } } }],
            })
            expect(
              (yield* send("GET", `/operator/actors/OpTill/missing?tenant=${tenant}`, "look-token"))
                .status,
            ).toBe(404)
            expect((yield* audit).map(({ action, outcome }) => [action, outcome])).toEqual([
              ["inspect", '{"outcomes":false}'],
              ["inspect", '{"outcomes":true}'],
              ["inspect", '{"outcomes":false}'],
            ])
          }),
      ),
  },
  {
    name: "reads a success and a declared-failure outcome under a receipt-scoped grant without running the handler",
    run: ({ expect, environment }) =>
      withOperators(environment, {}, ({ tenant, send, audit, grant }) =>
        Effect.gen(function* () {
          // The grant names each receipt, so it is given once the command ids exist.
          const actors = yield* Actors

          const ids = {
            paid: yield* actors.mintCommandId,
            refused: yield* actors.mintCommandId,
            other: yield* actors.mintCommandId,
          }

          const one = (commandId: string) =>
            capability("receipts.read", {
              tenant: "*",
              actorType: "OpTill",
              actorId: "t1",
              commandId,
            })

          yield* grant("receipt-token", [one(ids.paid), one(ids.refused)])
          fixture.up = true
          const till1 = yield* Till.get("t1")

          yield* till1.Pay(3).pipe(Actor.commandId(ids.paid))
          yield* till1.Refuse("closed").pipe(Actor.commandId(ids.refused), Effect.ignore)
          yield* till1.Pay(4).pipe(Actor.commandId(ids.other))

          const runs = fixture.handlerRuns
          const at = paths(tenant)

          expect(yield* send("GET", at.receipt(ids.paid), "receipt-token")).toMatchObject({
            status: 200,
            body: {
              commandId: ids.paid,
              command: "Pay",
              outcomeTag: "Success",
              outcome: { json: { value: '{"value":"paid 3"}' } },
            },
          })

          const failure = yield* send("GET", at.receipt(ids.refused), "receipt-token")

          expect(failure).toMatchObject({
            status: 200,
            body: { command: "Refuse", outcomeTag: "Failure" },
          })
          expect(yield* encodeJson(failure.body).pipe(Effect.orDie)).toContain("closed")

          // A receipt the grant does not name is refused.
          expect((yield* send("GET", at.receipt(ids.other), "receipt-token")).status).toBe(403)
          expect(fixture.handlerRuns).toBe(runs)
          expect(
            (yield* audit).map(({ action, target, outcome }) => [action, target, outcome]),
          ).toEqual([
            ["receipts.read", ids.paid, '"read"'],
            ["receipts.read", ids.refused, '"read"'],
            ["receipts.read", ids.other, '"denied"'],
          ])
        }),
      ),
  },
  {
    name: "retries a dead letter as a new effect and records operator, scope, reason, and the new effect id in the same transaction",
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        {
          "repair-token": [capability("dead-letters.retry", { tenant: "*", actorType: "OpTill" })],
        },
        ({ tenant, send, deadLetters, audit }) =>
          Effect.gen(function* () {
            yield* deadCharge
            const [letter] = yield* deadLetters
            fixture.up = true

            const retried = yield* send(
              "POST",
              paths(tenant).retry(letter!.effect_id),
              "repair-token",
              {
                ...till(tenant),
                reason: "provider back up",
              },
            )

            expect(retried.status).toBe(200)
            const { effectId } = retried.body as { effectId: string }
            expect(effectId).not.toBe(letter!.effect_id)

            yield* (yield* ActorTest).advance(0)

            expect(fixture.charges).toEqual([letter!.effect_id, effectId])
            expect(yield* deadLetters).toEqual([])

            const [row] = yield* audit

            expect(row).toMatchObject({
              operator: "op-repair-token",
              action: "dead-letters.retry",
              actor_id: "t1",
              target: letter!.effect_id,
              reason: "provider back up",
              capability: '{"action":"dead-letters.retry","tenant":"*","actorType":"OpTill"}',
            })
            expect(row!.outcome).toContain(`"effectId":"${effectId}"`)
            expect(row!.outcome).toContain('"providerChecked":false')

            // A dead letter is repaired once: the second request finds nothing.
            const again = yield* send(
              "POST",
              paths(tenant).retry(letter!.effect_id),
              "repair-token",
              {
                ...till(tenant),
                reason: "again",
              },
            )

            expect(again.status).toBe(404)
            expect(fixture.charges.length).toBe(2)
          }),
      ),
  },
  {
    name: "lets one of two concurrent repairs of a dead letter through",
    // Two requests race for the dead letter's row lock on independent connections.
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        { "repair-token": [capability("dead-letters.retry", { tenant: "*" })] },
        ({ tenant, send, deadLetters, audit }) =>
          Effect.gen(function* () {
            yield* deadCharge
            const [letter] = yield* deadLetters
            fixture.up = true
            const body = { ...till(tenant), reason: "race" }

            const answers = yield* Effect.forEach(
              [1, 2],
              () => send("POST", paths(tenant).retry(letter!.effect_id), "repair-token", body),
              { concurrency: "unbounded" },
            )

            expect(answers.map(({ status }) => status).toSorted((a, b) => a - b)).toEqual([
              200, 404,
            ])
            yield* (yield* ActorTest).advance(0)
            expect(fixture.charges.length).toBe(2)
            expect((yield* audit).length).toBe(1)
          }),
      ),
  },
  {
    name: "refuses to retry an ambiguous dead letter until the operator states the provider was checked",
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        { "repair-token": [capability("dead-letters.retry", { tenant: "*" })] },
        ({ tenant, send, deadLetters, audit }) =>
          Effect.gen(function* () {
            yield* deadShipment
            const [letter] = yield* deadLetters
            expect(letter!.ambiguous).toBe(true)
            const body = { ...till(tenant), reason: "carrier says it never arrived" }

            const refused = yield* send(
              "POST",
              paths(tenant).retry(letter!.effect_id),
              "repair-token",
              body,
            )

            expect(refused).toMatchObject({
              status: 409,
              body: { effectId: letter!.effect_id },
            })
            expect((yield* deadLetters).length).toBe(1)
            expect(yield* audit).toEqual([])

            fixture.up = true

            const checked = yield* send(
              "POST",
              paths(tenant).retry(letter!.effect_id),
              "repair-token",
              {
                ...body,
                providerChecked: true,
              },
            )

            expect(checked.status).toBe(200)
            yield* (yield* ActorTest).advance(0)
            expect(fixture.ships.length).toBe(2)
            expect((yield* audit)[0]!.outcome).toContain('"providerChecked":true')
          }),
      ),
  },
  {
    name: "discards a dead letter with its audit row and never records its payload",
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        { "repair-token": [capability("dead-letters.discard", { tenant: "*" })] },
        ({ tenant, send, deadLetters, audit }) =>
          Effect.gen(function* () {
            yield* deadCharge
            const [letter] = yield* deadLetters
            const body = { ...till(tenant), reason: "refunded by hand" }

            // Discard permission alone does not allow a retry.
            expect(
              (yield* send("POST", paths(tenant).retry(letter!.effect_id), "repair-token", body))
                .status,
            ).toBe(403)

            const discarded = yield* send(
              "POST",
              paths(tenant).discard(letter!.effect_id),
              "repair-token",
              body,
            )

            expect(discarded).toMatchObject({ status: 200, body: { discarded: letter!.effect_id } })
            expect(yield* deadLetters).toEqual([])
            expect(
              (yield* send("POST", paths(tenant).discard(letter!.effect_id), "repair-token", body))
                .status,
            ).toBe(404)

            const rows = yield* audit
            expect(
              rows.map(({ action, outcome }) => [action, outcome.includes("OpCharge")]),
            ).toEqual([
              ["dead-letters.retry", false],
              ["dead-letters.discard", true],
            ])
            expect(rows[1]!.outcome).not.toContain("amount")
            expect(rows[1]!.reason).toBe("refunded by hand")
            expect(fixture.charges.length).toBe(1)
          }),
      ),
  },
  {
    name: "rolls the repair back when its audit row cannot be written",
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        { "repair-token": [capability("dead-letters.retry", { tenant: "*" })] },
        ({ tenant, send, deadLetters }) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* deadCharge
            const [letter] = yield* deadLetters
            fixture.up = true

            yield* sql`CREATE FUNCTION op_audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`.pipe(Effect.orDie)
            yield* sql`CREATE TRIGGER op_audit_refuse BEFORE INSERT ON actor_operator_audit
                FOR EACH ROW EXECUTE FUNCTION op_audit_refuse()`.pipe(Effect.orDie)

            const failed = yield* send(
              "POST",
              paths(tenant).retry(letter!.effect_id),
              "repair-token",
              {
                ...till(tenant),
                reason: "try",
              },
            )

            expect(failed.status).toBe(500)
            expect((yield* deadLetters).map(({ effect_id }) => effect_id)).toEqual([
              letter!.effect_id,
            ])

            const [pending] = yield* sql<{ count: number }>`
              SELECT count(*)::int AS count FROM actor_outbox WHERE kind = 'effect'`.pipe(
              Effect.orDie,
            )

            expect(pending!.count).toBe(0)
            yield* (yield* ActorTest).advance(0)
            expect(fixture.charges.length).toBe(1)
          }),
      ),
  },
  {
    name: "lists defects only under defects.read, for the grant's tenants",
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        {
          "defects-token": [capability("defects.read", { tenant: "*" })],
          "look-token": [capability("inspect", { tenant: "*" })],
        },
        ({ tenant, send }) =>
          Effect.gen(function* () {
            yield* (yield* Till.get("t1")).Jam().pipe(Effect.exit)

            expect((yield* send("GET", paths(tenant).defects, "look-token")).status).toBe(403)

            const listed = yield* send("GET", paths(tenant).defects, "defects-token")

            expect(listed).toMatchObject({
              status: 200,
              body: [{ span: "durable-actors.OpTill/Jam", actorId: "t1", tenant }],
            })
            expect(
              (yield* send("GET", paths("another-tenant").defects, "defects-token")).body,
            ).toEqual([])
          }),
      ),
  },
]
