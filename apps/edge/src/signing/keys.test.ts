import { migrate } from "@durable-actors/postgres/migrate"
import { edgeKey } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Config,
  Context,
  Crypto,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import type { EdgeOptions } from "../config.ts"
import { keyRing } from "./keys.ts"

const runtime = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => runtime.dispose())

/** A migrated control-plane database, dropped with the scope. */
const controlPlane = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `edge_keys_${(yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`
  yield* Effect.promise(() => migrate(base.href))

  return base.href
})

const optionsFor = Effect.fnUntraced(function* (url: string, kid: string) {
  const key = yield* edgeKey(kid)
  const jwk = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", key.privateKey))

  return {
    issuer: "https://edge.durable.test",
    controlPlaneUrl: Redacted.make(url),
    signingKeys: [{ kid, x: jwk.x ?? "", d: jwk.d ?? "" }],
    hostname: "127.0.0.1",
    port: 0,
    assertionLifetime: Duration.seconds(10),
    apiKeySession: Duration.minutes(5),
    pollEvery: Duration.seconds(5),
    publicationLead: Duration.zero,
    requestBytes: 1024 * 1024,
    socketMessageBytes: 64 * 1024,
    socketBufferBytes: 1024 * 1024,
    coldStartTimeout: Duration.seconds(30),
  } satisfies EdgeOptions
})

describe("the edge key ring", () => {
  it("publishes a new kid, starts again with the same key, and refuses a different key under a published kid", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* controlPlane

          const database = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 2 }),
          ).pipe(Effect.orDie)

          const start = (options: EdgeOptions) =>
            Effect.scoped(keyRing(options)).pipe(
              Effect.provideContext(database),
              Effect.orDie,
              Effect.exit,
            )

          const first = yield* optionsFor(url, "edge-1")

          expect(Exit.isSuccess(yield* start(first))).toBe(true)
          expect(Exit.isSuccess(yield* start(first))).toBe(true)

          const replaced = yield* optionsFor(url, "edge-1")
          const refused = yield* start(replaced)

          expect(Exit.isFailure(refused) && Exit.hasDies(refused)).toBe(true)

          const sql = Context.get(database, SqlClient.SqlClient)

          const rows = yield* sql<{
            readonly x: string
          }>`SELECT x FROM edge_key WHERE kid = 'edge-1'`.pipe(Effect.orDie)

          expect(rows.map(({ x }) => x)).toEqual([first.signingKeys[0]!.x])
        }),
      ),
    ))
})
