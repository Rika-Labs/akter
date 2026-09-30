import { Crypto, Effect, Option, Predicate } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, InvalidExecutionId, System, Unauthorized, User } from "../../../index.ts"
import { ActorTest } from "../../actor-test.ts"
import { routingKey } from "../../../runtime/storage/codec.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Attributed, Quote, Ship, Shipper, type WorkflowsFixture } from "./actors.ts"
import { advance, eventually, killOwner, on, reset, suspendedRow, withCluster } from "./harness.ts"

/** Tenant separation, routing keys, and caller attribution of workflows. */
export const workflowAccessConformance: ReadonlyArray<ConformanceCase<WorkflowsFixture>> = [
  {
    name: "workflows: separates equal keys across tenants and owners",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const test = yield* ActorTest
          const other = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4).pipe(Effect.orDie)

          const start = (tenant: string, id: string, sku: string) =>
            Effect.flatMap(Shipper.get(id), (shipper) =>
              shipper.Ship({ orderId: "same", sku }),
            ).pipe(Actor.tenant(tenant))

          const runs = [
            yield* start(test.tenant, "iso-a", "sleep-a"),
            yield* start(other, "iso-a", "sleep-other"),
            yield* start(test.tenant, "iso-b", "sleep-b"),
          ]

          expect(new Set(runs.map((run) => run.executionId)).size).toBe(3)
          yield* Effect.forEach(runs, (run) => suspendedRow(run.executionId))
          yield* test.advance("11 seconds")

          const results = yield* Effect.forEach(
            [
              [runs[0]!, test.tenant],
              [runs[1]!, other],
              [runs[2]!, test.tenant],
            ] as const,
            ([run, tenant]) => run.result.pipe(Actor.tenant(tenant)),
          )

          expect(results).toEqual(["r-sleep-a:v2", "r-sleep-other:v2", "r-sleep-b:v2"])
          expect(fixture.runs.get("reserve:same")).toBe(3)
        }),
      ),
  },
  {
    name: "workflows: writes every workflow row under the owner's routing key",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const shipper = yield* Shipper.get("routed")
          const run = yield* shipper.Ship({ orderId: "routed", sku: "sleep-routed" })
          yield* suspendedRow(run.executionId)
          const expected = String(routingKey({ ref: shipper.ref, placement: "tenant" }))

          const rows = yield* sql<{ kind: string; routing_key: string }>`
            SELECT 'execution' AS kind, routing_key::text AS routing_key FROM actor_workflow_executions
              WHERE execution_id = ${run.executionId}
            UNION ALL SELECT 'step:' || step, routing_key::text FROM actor_workflow_step
              WHERE execution_id = ${run.executionId}
            UNION ALL SELECT 'timer', routing_key::text FROM actor_outbox
              WHERE timer_key = ${`wf:${run.executionId}`}
            ORDER BY 1`

          expect(rows).toEqual([
            { kind: "execution", routing_key: expected },
            { kind: "step:cool-off", routing_key: expected },
            { kind: "step:label", routing_key: expected },
            { kind: "step:reserve", routing_key: expected },
            { kind: "timer", routing_key: expected },
          ])

          const [strays] = yield* sql<{ count: number }>`
            SELECT count(*)::int AS count FROM actor_workflow_step
            WHERE tenant_id = ${shipper.ref.tenant} AND actor_id = 'routed'
              AND routing_key <> ${BigInt(expected)}`

          expect(strays!.count).toBe(0)
          yield* ActorTest.use((test) => test.advance("11 seconds"))
          expect(yield* run.result).toBe("r-sleep-routed:v2")
        }),
      ),
  },
  {
    name: "workflows: rejects an execution id from another tenant",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const run = yield* (yield* Shipper.get("foreign")).Ship({ orderId: "f1", sku: "a" })
          expect(yield* run.result).toBe("r-a:v2")
          const other = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4).pipe(Effect.orDie)

          const foreign = yield* Shipper.run(Ship, run.executionId).pipe(
            Actor.tenant(other),
            Effect.flip,
          )

          expect(foreign).toBeInstanceOf(InvalidExecutionId)
          expect(yield* Shipper.run(Quote, run.executionId).pipe(Effect.flip)).toBeInstanceOf(
            InvalidExecutionId,
          )
        }),
      ),
  },
  {
    name: "workflows: continues with recorded attribution after the starting caller loses access",
    run: ({ expect, environment, fixture, access }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("revoked")
          const run = yield* shipper.Attributed({ key: "h2" })
          yield* suspendedRow(run.executionId)
          access.revoked.add("alice")

          expect(yield* shipper.Pay({ orderId: "h2", amount: 1 }).pipe(Effect.flip)).toMatchObject({
            reason: Unauthorized.make({ code: "access_denied" }),
          })

          yield* test.advance("11 seconds")

          const result = yield* Shipper.run(Attributed, run.executionId).pipe(
            Effect.flatMap((reattached) => reattached.result),
            Actor.as(User.make({ subject: "bob" })),
          )

          expect(result).toBe("alice")
          expect(fixture.audits.get("h2")).toEqual({
            tenant: test.tenant,
            caller: System.make({
              source: "workflow",
              ref: shipper.ref,
              onBehalfOf: { subject: "alice" },
            }),
          })
        }).pipe(Effect.ensuring(Effect.sync(() => access.revoked.delete("alice")))),
      ),
  },
  {
    name: "workflows: denies poll to a revoked caller",
    run: ({ expect, environment, fixture, access }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const shipper = yield* Shipper.get("poll-revoked")
          const run = yield* shipper.Ship({ orderId: "pr1", sku: "sleep-pr" })
          yield* suspendedRow(run.executionId)
          access.revoked.add("alice")
          const denied = { reason: Unauthorized.make({ code: "access_denied" }) }
          expect(yield* run.poll.pipe(Effect.flip)).toMatchObject(denied)
          expect(yield* run.result.pipe(Effect.flip)).toMatchObject(denied)
          expect(yield* run.interrupt.pipe(Effect.flip)).toMatchObject(denied)

          const polled = yield* Shipper.run(Ship, run.executionId).pipe(
            Effect.flatMap((reattached) => reattached.poll),
            Actor.as(User.make({ subject: "bob" })),
          )

          expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended")
        }).pipe(Effect.ensuring(Effect.sync(() => access.revoked.delete("alice")))),
      ),
  },
  {
    name: "workflows: restores tenant and onBehalfOf on resume elsewhere",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture,
        Effect.gen(function* () {
          const { id, ref, tenant } = yield* on(
            0,
            Effect.gen(function* () {
              const shipper = yield* Shipper.get("attributed")
              const run = yield* shipper.Attributed({ key: "elsewhere" })

              return { id: run.executionId, ref: shipper.ref, tenant: (yield* ActorTest).tenant }
            }),
          )

          yield* on(
            0,
            eventually(
              Effect.gen(function* () {
                const polled = yield* (yield* Shipper.run(Attributed, id)).poll

                return Option.isSome(polled) && Predicate.isTagged(polled.value, "Suspended")
              }),
              "the sleep to suspend",
            ),
          )
          const survivor = yield* killOwner("attributed")
          yield* advance(survivor, "11 seconds")

          const result = yield* on(
            survivor,
            Effect.gen(function* () {
              return yield* (yield* Shipper.run(Attributed, id)).result
            }),
          )

          expect(result).toBe("alice")
          expect(fixture.audits.get("elsewhere")).toEqual({
            tenant,
            caller: System.make({ source: "workflow", ref, onBehalfOf: { subject: "alice" } }),
          })
        }),
      ),
  },
]
