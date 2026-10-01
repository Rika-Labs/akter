import { describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { noRuntimeImportOutsideRuntimeRule } from "./no-runtime-import-outside-runtime.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const error = { messageId: "runtimeImport" }

tester.run("durable-actors/no-runtime-import-outside-runtime", noRuntimeImportOutsideRuntimeRule, {
  valid: [
    {
      code: 'import { SqlClient } from "effect/sql";',
      filename: "packages/durable-actors/src/runtime/database/client.ts",
    },
    {
      code: 'import { PgClient } from "@effect/sql-pg";',
      filename: "packages/durable-actors/src/testing/pglite/layer.ts",
    },
    {
      code: 'import { PgliteClient } from "@effect/sql-pglite";',
      filename: "packages/durable-actors/src/testing/pglite/layer.ts",
    },
    {
      code: 'export * from "effect/cluster";',
      filename: "packages/durable-actors/src/runtime/index.ts",
    },
    {
      code: 'import { PgClient } from "@effect/sql-pg";',
      filename: "packages/postgres/src/index.ts",
    },
    {
      code: 'import { SqlClient } from "effect/sql";',
      filename: "apps/api/src/app.ts",
    },
    {
      code: 'import { HttpApiBuilder } from "effect/http-api";',
      filename: "packages/durable-actors/src/serve/router.ts",
    },
    {
      code: 'import { Layer } from "effect";',
      filename: "packages/durable-actors/src/index.ts",
    },
    {
      code: 'import { SqlClient } from "effect/sql";',
      filename: "research/v4/framework/Actor.ts",
    },
  ],
  invalid: [
    {
      code: 'import { SqlClient } from "effect/sql";',
      filename: "packages/durable-actors/src/index.ts",
      errors: [error],
    },
    {
      code: 'import { PgClient } from "@effect/sql-pg";',
      filename: "packages/durable-actors/src/client/transport.ts",
      errors: [error],
    },
    {
      code: 'import { PgliteClient } from "@effect/sql-pglite";',
      filename: "packages/durable-actors/src/client/transport.ts",
      errors: [error],
    },
    {
      code: 'import { Sharding } from "effect/cluster";',
      filename: "packages/durable-actors/src/actor/actor.ts",
      errors: [error],
    },
    {
      code: 'export { SqlClient } from "effect/sql";',
      filename: "packages/durable-actors/src/tables/database.ts",
      errors: [error],
    },
    {
      code: 'const mod = await import("@effect/sql-pg");',
      filename: "packages/durable-actors/src/serve/openapi.ts",
      errors: [error],
    },
  ],
})
