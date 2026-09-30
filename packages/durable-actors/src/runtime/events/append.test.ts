import { BunCrypto } from "@effect/platform-bun"
import { Config, Crypto, Effect, Fiber, Layer, ManagedRuntime, Redacted, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Pool, type PoolClient } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { System } from "../../identity/caller.ts"
import { migrate } from "../database/migrations.ts"
import { Database } from "../layer.ts"
import type { RegisteredSubscription } from "../members.ts"
import { Request } from "../request.ts"
import { OutboxRuntime } from "../turn/outbox.ts"
import { eventsStatement } from "./append.ts"

const KEY = 42n

const SOURCE = { tenant: "t", actor: "Src", id: "s" }

const ROW = `routing_key = ${KEY} AND tenant_id = 't' AND source_type = 'Src' AND source_id = 's'`

/** A routed subscription of `Sub` that follows `A` and `B`, as the publishing runner registers it. */
const routed: RegisteredSubscription & { readonly subscriberType: string } = {
  subscriberType: "Sub",
  tag: "Routed",
  sourceType: "Src",
  handler: "OnSrc",
  events: ["A", "B"],
  retired: [],
  routed: "id",
  route: () => Effect.succeed("x"),
  upcast: (_tag, _version, value) => Effect.succeed(value),
}

/**
 * Runs `publish`, an event `B` from the source, while `other` holds an
 * uncommitted change to the routed row that commits only once the publish
 * waits on its lock. The publish's snapshot therefore predates the change.
 */
const interleave = (other: PoolClient, watcher: Pool, change: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.promise(() => other.query("BEGIN"))

    for (const statement of change) yield* Effect.promise(() => other.query(statement))

    const { statement } = yield* eventsStatement(
      Request.make({
        ref: SOURCE,
        caller: System.make({ source: "process" }),
        command: "Publish",
        commandId: "c1",
        payload: "{}",
      }),
      KEY,
      [{ tag: "B", value: "{}", version: 0 }],
    ).pipe(
      Effect.provideService(OutboxRuntime, {
        retryWindowMs: 86_400_000,
        wake: Effect.void,
        cancelled: Effect.void,
        routed: () => [routed],
      }),
    )

    const publish = yield* Effect.forkChild(statement)

    yield* Effect.promise(() =>
      watcher.query<{ waiting: number }>(`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`),
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        until: (result) => result.rows[0]!.waiting > 0,
      }),
      Effect.timeout("10 seconds"),
    )
    yield* Effect.promise(() => other.query("COMMIT"))
    yield* Fiber.join(publish)

    return {
      summary: yield* sql<{ event: string; rows: number }>`SELECT event, rows
        FROM actor_subscription_tags WHERE ${sql.literal(ROW)} ORDER BY event`,
      counted: yield* sql<{ event: string; rows: number }>`SELECT x.tag AS event,
          count(*)::int AS rows
        FROM actor_subscriptions, unnest(events) AS x(tag)
        WHERE ${sql.literal(ROW)} AND active GROUP BY x.tag ORDER BY x.tag`,
    }
  })

/** A fresh migrated database with the source and its routed row following `A`, counted once. */
const withSource = <A, E>(
  body: (
    other: PoolClient,
    watcher: Pool,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | Crypto.Crypto>,
) =>
  Effect.gen(function* () {
    const url = new URL(yield* Config.String("TEST_DATABASE_URL"))
    const name = `append_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: url.href })),
      (pool) => Effect.promise(() => pool.end()),
    )

    yield* Effect.acquireRelease(
      Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
      () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
    )
    url.pathname = `/${name}`

    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: url.href })),
      (db) => Effect.promise(() => db.end()),
    )

    const other = yield* Effect.acquireRelease(
      Effect.promise(() => pool.connect()),
      (client) => Effect.sync(() => client.release()),
    )

    const client = yield* Layer.build(Database.postgres({ url: Redacted.make(url.href) }))

    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate
      yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
        VALUES (${KEY}, 't', 'Src', 's')`
      yield* sql`INSERT INTO actor_subscriptions (routing_key, tenant_id, source_type, source_id,
          subscriber_type, subscription, subscriber_id, events, epoch, active, delivered, bucket)
        VALUES (${KEY}, 't', 'Src', 's', 'Sub', 'Routed', '', ARRAY['A'], 0, true, 0, 0)`
      yield* sql`INSERT INTO actor_subscription_tags (routing_key, tenant_id, source_type,
          source_id, event, rows) VALUES (${KEY}, 't', 'Src', 's', 'A', 1)`

      return yield* body(other, pool)
    }).pipe(Effect.provideContext(client))
  })

describe("routed subscription rows with Postgres", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  it("counts a tag once when a settle widens the routed row after the publishing statement's snapshot", () =>
    runtime.runPromise(
      Effect.scoped(
        withSource((other, watcher) =>
          interleave(other, watcher, [
            `UPDATE actor_subscriptions SET events = ARRAY['A', 'C']
                WHERE ${ROW} AND subscriber_id = ''`,
            `INSERT INTO actor_subscription_tags (routing_key, tenant_id, source_type, source_id,
                event, rows) VALUES (${KEY}, 't', 'Src', 's', 'C', 1)`,
          ]).pipe(
            Effect.map(({ summary, counted }) => {
              expect(counted).toEqual([
                { event: "A", rows: 1 },
                { event: "B", rows: 1 },
                { event: "C", rows: 1 },
              ])
              expect(summary).toEqual(counted)
            }),
          ),
        ),
      ),
    ))

  it("counts every tag of a routed row the publish recreates after a cleanup deleted it", () =>
    runtime.runPromise(
      Effect.scoped(
        withSource((other, watcher) =>
          interleave(other, watcher, [
            `DELETE FROM actor_subscriptions WHERE ${ROW} AND subscriber_id = ''`,
            `DELETE FROM actor_subscription_tags WHERE ${ROW} AND event = 'A'`,
          ]).pipe(
            Effect.map(({ summary, counted }) => {
              expect(counted).toEqual([
                { event: "A", rows: 1 },
                { event: "B", rows: 1 },
              ])
              expect(summary).toEqual(counted)
            }),
          ),
        ),
      ),
    ))
})
