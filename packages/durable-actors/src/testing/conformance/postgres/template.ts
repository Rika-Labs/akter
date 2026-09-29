import { BunCrypto } from "@effect/platform-bun"
import { Config, Crypto, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { Pool } from "pg"
import type { TestProject } from "vitest/node"
import { migrate } from "../../../runtime/database/migrations.ts"
import { Database } from "../../../runtime/layer.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)

/**
 * Vitest global setup: migrates one database for the whole run so each worker
 * copies it instead of running every migration again. The copies are what
 * `describePostgres` opens; the template is dropped when the run ends.
 */
export default (project: TestProject) =>
  harness.runPromise(
    Effect.gen(function* () {
      const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
      const name = `actors_template_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`
      const admin = new Pool({ connectionString: base.href })
      yield* Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`))
      const database = new URL(base.href)
      database.pathname = `/${name}`

      yield* Effect.gen(function* () {
        const client = yield* Layer.build(Database.postgres({ url: Redacted.make(database.href) }))
        yield* Effect.provide(migrate, client)
      }).pipe(Effect.scoped)

      project.provide("conformanceTemplate", name)

      return () =>
        admin
          .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
          .then(() => admin.end())
          .then(() => harness.dispose())
    }),
  )
