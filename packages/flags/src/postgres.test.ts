import { PgClient } from "@effect/sql-pg"
import {
  Config,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Result,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { expect, it } from "@effect/vitest"
import { flag, InvalidOverride } from "./evaluation.ts"
import { makeFlags } from "./layer.ts"
import { migrateFlags, postgresStore } from "./postgres.ts"
import { OverrideStore, StoreError } from "./store.ts"

const { Flags, layer } = makeFlags({ mode: flag(Schema.String)("default") })

it.effect(
  "persists targeting and rollout across runtime restarts, rejects failed updates and deletes, and rolls back interrupted writes",
  () =>
    Effect.gen(function* () {
      const url = yield* Config.String("TEST_DATABASE_URL")
      const database = PgClient.layer({ url: Redacted.make(url) })
      const live = Layer.mergeAll(layer.pipe(Layer.provide(postgresStore)), postgresStore).pipe(
        Layer.provideMerge(database),
      )
      const first = ManagedRuntime.make(live)
      try {
        yield* Effect.promise(() =>
          first.runPromise(
            Effect.gen(function* () {
              const flags = yield* Flags
              const sql = yield* SqlClient.SqlClient
              yield* Effect.all([migrateFlags, migrateFlags], { concurrency: "unbounded" })
              yield* flags.remove("mode")
              yield* flags.set("mode", {
                users: { special: "user" },
                organizations: { acme: "organization" },
                rollout: { percentage: 8, value: "rollout" },
                value: "global",
              })
              const invalid = yield* Effect.result(flags.set("mode", { value: false }))
              expect(Result.isFailure(invalid) && Schema.is(InvalidOverride)(invalid.failure)).toBe(
                true,
              )
              expect(
                yield* flags.evaluate("mode", { userId: "special", organizationId: "acme" }),
              ).toBe("user")
              expect(yield* flags.evaluate("mode", { userId: "alice" })).toBe("rollout")
              expect(yield* flags.evaluate("mode", { userId: "bob" })).toBe("global")
              const rollback = yield* Effect.result(
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* flags.set("mode", { value: "uncommitted" })
                    return yield* Effect.fail("abort")
                  }),
                ),
              )
              expect(Result.isFailure(rollback)).toBe(true)
              expect(yield* flags.evaluate("mode", {})).toBe("global")
              const written = yield* Deferred.make<void>()
              const interrupted = yield* Effect.forkChild(
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* flags.set("mode", { value: "interrupted" })
                    yield* Deferred.succeed(written, undefined)
                    return yield* Effect.never
                  }),
                ),
              )
              yield* Deferred.await(written)
              yield* Fiber.interrupt(interrupted)
              expect(yield* flags.evaluate("mode", {})).toBe("global")
            }),
          ),
        )
      } finally {
        yield* Effect.promise(() => first.dispose())
      }
      const second = ManagedRuntime.make(live)
      try {
        yield* Effect.promise(() =>
          second.runPromise(
            Effect.gen(function* () {
              const flags = yield* Flags
              const store = yield* OverrideStore
              const sql = yield* SqlClient.SqlClient
              expect(yield* flags.evaluate("mode", { userId: "alice" })).toBe("rollout")
              expect(yield* flags.evaluate("mode", { userId: "bob" })).toBe("global")
              expect(yield* flags.evaluate("mode", { organizationId: "acme" })).toBe("organization")
              expect(yield* flags.snapshot({ userId: "special" })).toEqual({
                mode: { value: "user" },
              })
              yield* sql`ALTER TABLE feature_flag_override ADD CONSTRAINT reject_change CHECK (rule->>'value' <> 'denied')`
              const failedSet = yield* Effect.result(flags.set("mode", { value: "denied" }))
              expect(Result.isFailure(failedSet) && Schema.is(StoreError)(failedSet.failure)).toBe(
                true,
              )
              expect(yield* flags.evaluate("mode", {})).toBe("global")
              yield* sql`ALTER TABLE feature_flag_override DROP CONSTRAINT reject_change`
              yield* sql`ALTER TABLE feature_flag_override RENAME TO unavailable_flags`
              for (const operation of [store.remove("mode"), flags.evaluate("mode", {})]) {
                const result = yield* Effect.result(operation)
                expect(Result.isFailure(result) && Schema.is(StoreError)(result.failure)).toBe(true)
              }
              yield* sql`ALTER TABLE unavailable_flags RENAME TO feature_flag_override`
              expect(yield* flags.evaluate("mode", {})).toBe("global")
              yield* flags.remove("mode")
              expect(yield* flags.evaluate("mode", {})).toBe("default")
            }),
          ),
        )
      } finally {
        yield* Effect.promise(() => second.dispose())
      }
    }),
)
