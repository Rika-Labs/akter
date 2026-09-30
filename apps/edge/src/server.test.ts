import { publishedKeys } from "@durable-actors/deployments"
import { migrate } from "@durable-actors/postgres/migrate"
import {
  type ConformanceBackend,
  type ConformanceEdge,
  describeConformance,
  edgeConformance,
  type EdgeKey,
  edgeKey,
  type HostedEdge,
} from "@durable-actors/core/testing"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
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
  Schedule,
  Schema,
  Scope,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { EdgeOptions } from "./config.ts"
import { makeEdge } from "./server.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => harness.dispose())

/** A new database on the test server, dropped with the scope. */
const createDatabase = Effect.fnUntraced(function* (prefix: string) {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `${prefix}_${(yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return base.href
})

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

const sha256 = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map(hex),
  )

const encodeKeySet = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

/** A real edge for a new deployment, with its own control-plane database. */
const startEdge = Effect.fnUntraced(function* (options: {
  readonly primaryRegion: string
  readonly assertionSeconds?: number
  readonly apiKeySessionSeconds?: number
  readonly signingKeys?: ReadonlyArray<EdgeKey>
}): Effect.fn.Return<HostedEdge, never, Scope.Scope | Crypto.Crypto> {
  const url = yield* createDatabase("edge").pipe(Effect.orDie)

  yield* Effect.promise(() => migrate(url))

  const control = yield* Layer.build(
    Layer.mergeAll(
      PgClient.layer({ url: Redacted.make(url), maxConnections: 5 }),
      FetchHttpClient.layer,
      BunCrypto.layer,
    ),
  ).pipe(Effect.orDie)

  const sql = Context.get(control, SqlClient.SqlClient)
  const random = yield* Crypto.Crypto
  const deployment = `dep-${(yield* random.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)}`

  yield* sql`INSERT INTO deployment (id, primary_region) VALUES (${deployment}, ${options.primaryRegion})`.pipe(
    Effect.orDie,
  )
  yield* sql`INSERT INTO deployment_host (host, deployment_id) VALUES ('127.0.0.1', ${deployment})`.pipe(
    Effect.orDie,
  )

  const keys = options.signingKeys ?? [yield* edgeKey("edge-test-1")]

  const signingKeys = yield* Effect.forEach(keys, (key) =>
    Effect.promise(() => crypto.subtle.exportKey("jwk", key.privateKey)).pipe(
      Effect.map((jwk) => ({ kid: key.kid, x: jwk.x ?? "", d: jwk.d ?? "" })),
    ),
  )

  const edgeOptions: EdgeOptions = {
    issuer: "https://edge.durable.test",
    controlPlaneUrl: Redacted.make(url),
    signingKeys,
    hostname: "127.0.0.1",
    port: 0,
    assertionLifetime: Duration.seconds(options.assertionSeconds ?? 10),
    apiKeySession: Duration.seconds(options.apiKeySessionSeconds ?? 300),
    pollEvery: Duration.millis(200),
    publicationLead: Duration.zero,
    requestBytes: 1024 * 1024,
    socketMessageBytes: 64 * 1024,
    socketBufferBytes: 1024 * 1024,
  }

  const edge = yield* makeEdge(edgeOptions).pipe(Effect.provideContext(control))

  const keySet = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Effect.runPromiseWith(control)(
        publishedKeys.pipe(
          Effect.flatMap(encodeKeySet),
          Effect.map(
            (body) => new Response(body, { headers: { "content-type": "application/json" } }),
          ),
          Effect.orDie,
        ),
      ),
  })

  yield* Effect.addFinalizer(() => Effect.promise(() => keySet.stop(true)))

  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideContext(control), Effect.orDie, Effect.asVoid)

  return {
    url: edge.url,
    issuer: edgeOptions.issuer,
    deployment,
    keys: new URL(`http://127.0.0.1:${keySet.port}/keys`),
    addRunner: (runner) =>
      run(
        sql`INSERT INTO deployment_runner (deployment_id, region, url, base_path) VALUES (${deployment}, ${runner.region}, ${runner.url}, ${runner.basePath ?? ""})`,
      ),
    issueApiKey: ({ tenant, subject }) =>
      Effect.gen(function* () {
        const key = `dak_${(yield* random.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`

        yield* run(
          sql`INSERT INTO hosted_api_key (key_hash, deployment_id, tenant, subject) VALUES (${yield* sha256(key)}, ${deployment}, ${tenant}, ${subject})`,
        )

        return key
      }),
    revokeApiKey: (key) =>
      Effect.flatMap(sha256(key), (hash) =>
        run(sql`UPDATE hosted_api_key SET revoked_at = now() WHERE key_hash = ${hash}`),
      ),
    revokeSigningKey: (kid) => run(sql`UPDATE edge_key SET revoked_at = now() WHERE kid = ${kid}`),
    home: ({ tenant, region }) =>
      run(sql`
        INSERT INTO tenant_directory (routing_key, tenant_id, actor_id, deployment_id, tenant, region, state)
        VALUES (0, 'default', ${`${deployment}/${tenant}`}, ${deployment}, ${tenant}, ${region}, 'active')
        ON CONFLICT (deployment_id, tenant) DO UPDATE SET region = excluded.region
      `),
    directoryRows: sql<{
      readonly n: number
    }>`SELECT count(*)::int AS n FROM tenant_directory`.pipe(
      Effect.map(([row]) => row?.n ?? 0),
      Effect.provideContext(control),
      Effect.orDie,
    ),
  }
})

const edge: ConformanceEdge = {
  start: (options) =>
    Effect.gen(function* () {
      const crypto = Context.get(yield* Layer.build(BunCrypto.layer), Crypto.Crypto)

      return yield* startEdge(options).pipe(Effect.provideService(Crypto.Crypto, crypto))
    }),
}

const backend: ConformanceBackend = {
  independentConnections: true,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  edge,
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const crypto = yield* Crypto.Crypto

        const provision = (prefix: string) =>
          createDatabase(prefix).pipe(
            Scope.provide(scope),
            Effect.orDie,
            Effect.map(Redacted.make),
            Effect.provideService(Crypto.Crypto, crypto),
          )

        return {
          database: yield* provision("runners"),
          freshDatabase: provision("isolated"),
          copy: (database) =>
            Effect.gen(function* () {
              if (!Redacted.isRedacted(database))
                return yield* Effect.die(
                  new Error("The edge backend copies only Postgres databases"),
                )
              const source = new URL(Redacted.value(database)).pathname.slice(1)
              const base = new URL(Redacted.value(database))
              const name = `restored_${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`

              const admin = yield* Effect.acquireRelease(
                Effect.sync(() => new Pool({ connectionString: base.href })),
                (pool) => Effect.promise(() => pool.end()),
              )

              yield* Effect.acquireRelease(
                Effect.tryPromise(() =>
                  admin.query(`CREATE DATABASE "${name}" TEMPLATE "${source}"`),
                ).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })),
                () =>
                  Effect.promise(() =>
                    admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
                  ),
              )
              base.pathname = `/${name}`

              return Redacted.make(base.href)
            }).pipe(Scope.provide(scope), Effect.orDie),
          close: Scope.close(scope, Exit.void),
        }
      }),
    ),
}

describeConformance({
  name: "Hosted edge",
  backend,
  cases: edgeConformance,
  registrar: { describe, it, beforeAll, afterAll, expect, skip: (name) => it.skip(name) },
})
