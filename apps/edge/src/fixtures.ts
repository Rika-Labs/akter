import { type PricingConfig, PricingLive } from "@akter/billing"
import { publishedKeys } from "@akter/deployments"
import { migrate } from "@akter/postgres/migrate"
import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { type EdgeKey, edgeKey, type HostedEdge } from "@rikalabs/akter/testing"
import { Config, Context, Crypto, Duration, Effect, Layer, Redacted, Schema, Scope } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import type { EdgeOptions } from "./config.ts"
import * as Server from "./server.ts"

/** A new database on the test server, dropped with the scope. */
export const createDatabase = Effect.fnUntraced(function* (prefix: string) {
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

/** A control-plane database with one deployment, which any number of edges can serve. */
export interface Provisioned {
  readonly url: string
  readonly control: Context.Context<SqlClient.SqlClient | HttpClient.HttpClient | Crypto.Crypto>
  readonly deployment: string
  readonly organizationId: string
}

/** A new control-plane database and a deployment served on `127.0.0.1`. */
export const provision = Effect.fnUntraced(function* (options: {
  readonly primaryRegion: string
  readonly scaleToZero?: boolean
}): Effect.fn.Return<Provisioned, never, Scope.Scope | Crypto.Crypto> {
  const url = yield* createDatabase("edge").pipe(Effect.orDie)

  yield* Effect.promise(() => migrate(url))

  const control = yield* Layer.build(
    Layer.mergeAll(
      PgClient.layer({ url: Redacted.make(url), maxConnections: 8 }),
      FetchHttpClient.layer,
      BunCrypto.layer,
    ),
  ).pipe(Effect.orDie)

  const sql = Context.get(control, SqlClient.SqlClient)
  const random = yield* Crypto.Crypto
  const deployment = `dep-${(yield* random.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)}`

  yield* sql`INSERT INTO deployment (id, primary_region, scale_to_zero) VALUES (${deployment}, ${options.primaryRegion}, ${options.scaleToZero ?? false})`.pipe(
    Effect.orDie,
  )
  yield* sql`INSERT INTO deployment_host (host, deployment_id) VALUES ('127.0.0.1', ${deployment})`.pipe(
    Effect.orDie,
  )

  return { url, control, deployment, organizationId: `org-${deployment}` }
})

/** A running edge, with the database it reads and the organization its deployment bills. */
export interface FixtureEdge extends HostedEdge {
  readonly sql: SqlClient.SqlClient
  readonly organizationId: string
  readonly provisioned: Provisioned
}

/** The options a fixture edge takes beyond the conformance harness's own. */
export interface FixtureOptions {
  readonly primaryRegion: string
  readonly assertionSeconds?: number
  readonly apiKeySessionSeconds?: number
  readonly helloTimeoutMillis?: number
  readonly signingKeys?: ReadonlyArray<EdgeKey>
  readonly scaleToZero?: boolean
  readonly coldStartSeconds?: number
  readonly provisioned?: Provisioned
  /** The plan the deployment's organization is on; `enterprise` by default. */
  readonly plan?: string
  readonly spendLimitCents?: number | null
  readonly pricing?: PricingConfig
  /** Leaves the deployment unbound, so every metered request must fail closed. */
  readonly unbound?: boolean
  readonly leaseTtlMillis?: number
  readonly leaseHeartbeatMillis?: number
  readonly trustedProxies?: EdgeOptions["trustedProxies"]
}

/**
 * A real edge for a deployment, with its own control-plane database unless it
 * shares `provisioned`. Unless `unbound`, the deployment's wildcard tenant
 * binding and its organization's billing account are persisted before the
 * edge answers anything.
 */
export const startEdge = Effect.fnUntraced(function* (
  options: FixtureOptions,
): Effect.fn.Return<FixtureEdge, never, Scope.Scope | Crypto.Crypto> {
  const provisioned = options.provisioned ?? (yield* provision(options))
  const { url, control, deployment } = provisioned
  const sql = Context.get(control, SqlClient.SqlClient)
  const random = yield* Crypto.Crypto

  const keys = options.signingKeys ?? [
    yield* edgeKey(
      options.provisioned === undefined
        ? "edge-test-1"
        : `edge-test-${yield* random.randomUUIDv4.pipe(Effect.orDie)}`,
    ),
  ]

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
    helloTimeout: Duration.millis(options.helloTimeoutMillis ?? 30_000),
    pollEvery: Duration.millis(200),
    publicationLead: Duration.zero,
    requestBytes: 1024 * 1024,
    socketMessageBytes: 64 * 1024,
    socketBufferBytes: 1024 * 1024,
    coldStartTimeout: Duration.seconds(options.coldStartSeconds ?? 30),
    leaseTtl: Duration.millis(options.leaseTtlMillis ?? 30_000),
    leaseHeartbeat: Duration.millis(options.leaseHeartbeatMillis ?? 10_000),
    trustedProxies: options.trustedProxies ?? { nlbOnly: false, cloudflare: [] },
  }

  const pricing = yield* Layer.build(PricingLive(options.pricing))

  const edge = yield* Server.makeEdge(edgeOptions).pipe(
    Effect.provideContext(Context.merge(control, pricing)),
  )

  if (options.unbound !== true) {
    const organizationId = provisioned.organizationId

    yield* sql`
      INSERT INTO cloud_billing_account (organization_id, plan, subscribed_plan, spend_limit_cents)
      VALUES (${organizationId}, ${options.plan ?? "enterprise"}, ${options.plan ?? "enterprise"}, ${options.spendLimitCents ?? null})
      ON CONFLICT (organization_id) DO UPDATE
      SET plan = excluded.plan, subscribed_plan = excluded.subscribed_plan, spend_limit_cents = excluded.spend_limit_cents
    `.pipe(Effect.orDie)

    yield* sql`
      INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id)
      VALUES (${deployment}, '*', ${organizationId}, ${`proj-${deployment}`})
      ON CONFLICT (deployment_id, tenant) DO NOTHING
    `.pipe(Effect.orDie)
  }

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
    sql,
    provisioned,
    organizationId: provisioned.organizationId,
    url: edge.url,
    issuer: edgeOptions.issuer,
    deployment,
    keys: new URL(`http://127.0.0.1:${keySet.port}/keys`),
    addRunner: (runner) =>
      run(
        sql`INSERT INTO deployment_runner (deployment_id, region, url, base_path) VALUES (${deployment}, ${runner.region}, ${runner.url}, ${runner.basePath ?? ""})`,
      ),
    removeRunner: (url) =>
      run(sql`DELETE FROM deployment_runner WHERE deployment_id = ${deployment} AND url = ${url}`),
    takeWakes: sql<{
      readonly region: string
    }>`DELETE FROM runner_wake WHERE deployment_id = ${deployment} RETURNING region`.pipe(
      Effect.map((rows) => rows.map(({ region }) => region)),
      Effect.provideContext(control),
      Effect.orDie,
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
