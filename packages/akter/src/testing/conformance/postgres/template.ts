import { Config, Effect, Exit, Layer, ManagedRuntime, Redacted, Scope } from "effect"
import type { TestProject } from "vitest/node"
import { migrate } from "../../../runtime/database/migrations.ts"
import { Database } from "../../../runtime/layer.ts"
import { disposableDatabase, sweepStaleDatabases } from "../../database.ts"
import { cryptoLayer } from "../platform.ts"

const harness = ManagedRuntime.make(cryptoLayer)

/**
 * Vitest global setup: migrates one database for the whole run so each worker
 * copies it instead of running every migration again. The copies are what
 * `describePostgres` opens; the template is dropped when the run ends. It
 * first drops the test databases earlier runs left on the server.
 */
export default (project: TestProject) =>
  harness.runPromise(
    Effect.gen(function* () {
      const url = yield* Config.Redacted("TEST_DATABASE_URL")
      yield* sweepStaleDatabases(url)

      const scope = yield* Scope.make()

      const template = yield* disposableDatabase({ url, prefix: "actors_template" }).pipe(
        Scope.provide(scope),
      )

      yield* Effect.gen(function* () {
        const client = yield* Layer.build(Database.postgres({ url: template }))
        yield* Effect.provide(migrate, client)
      }).pipe(Effect.scoped)

      project.provide("conformanceTemplate", new URL(Redacted.value(template)).pathname.slice(1))

      return () => harness.runPromise(Scope.close(scope, Exit.void)).then(() => harness.dispose())
    }),
  )
