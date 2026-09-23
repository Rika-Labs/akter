import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DateTime, Effect, ManagedRuntime } from "effect"
import { PgClient } from "@effect/sql-pg"
import { databaseLayer } from "@durable-actors/postgres"
import { applySubscription } from "./repository.ts"
import { makeTestDatabase, type TestDatabase } from "../testing/database.ts"

describe("billing repository", () => {
  let database: TestDatabase
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>
  beforeAll(
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          database = yield* makeTestDatabase("api_billing_repository")
          runtime = ManagedRuntime.make(databaseLayer(database.url))
          yield* Effect.promise(() =>
            database.pool.query(
              "insert into organization (id,name,slug) values ('org-1','Alpha','alpha')",
            ),
          )
        }),
      ),
    30_000,
  )
  afterAll(() => runtime.runPromise(database.dispose).finally(() => runtime.dispose()))

  const apply = (id: string, eventAt: string, status: string, organizationId = "org-1") =>
    runtime.runPromise(
      applySubscription({
        id,
        organizationId,
        subscriptionId: "sub-1",
        customerId: "customer-1",
        plan: status === "active" ? "pro" : "free",
        status,
        renewalDate: null,
        eventAt: DateTime.toDate(DateTime.makeUnsafe(eventAt)),
      }),
    )

  it("deduplicates event IDs and ignores stale ordering", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => apply("latest", "2026-09-20T00:00:00Z", "active"))
        yield* Effect.promise(() => apply("latest", "2026-09-21T00:00:00Z", "canceled"))
        yield* Effect.promise(() => apply("older", "2026-09-19T00:00:00Z", "canceled"))

        const billing = yield* Effect.promise(() =>
          database.pool.query(
            "select plan,status,event_at from organization_billing where organization_id='org-1'",
          ),
        )

        expect(billing.rows).toEqual([
          {
            plan: "pro",
            status: "active",
            event_at: DateTime.toDate(DateTime.makeUnsafe("2026-09-20T00:00:00Z")),
          },
        ])

        const events = yield* Effect.promise(() =>
          database.pool.query("select id from billing_webhook order by id"),
        )

        expect(events.rows).toEqual([{ id: "latest" }, { id: "older" }])
      }),
    ))

  it("records an unknown-tenant webhook without creating orphan billing", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          apply("unknown", "2026-09-22T00:00:00Z", "active", "missing-org"),
        )

        expect(
          (yield* Effect.promise(() =>
            database.pool.query("select count(*)::int as count from organization_billing"),
          )).rows[0],
        ).toEqual({ count: 1 })
        expect(
          (yield* Effect.promise(() =>
            database.pool.query("select count(*)::int as count from billing_webhook"),
          )).rows[0],
        ).toEqual({ count: 3 })
      }),
    ))
})
