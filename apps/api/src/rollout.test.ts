import { DeploymentDetail, NotFound, OrganizationMembership, Project } from "@akter/cloud-api"
import { ActivationRefused, RolloutRouting, type ReleaseRecord } from "@akter/deployments/lifecycle"
import { migrate } from "@akter/postgres/migrate"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Config,
  Context,
  Crypto,
  Effect,
  Exit,
  Inspectable,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
  Schema,
} from "effect"
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { runtimeEdge } from "./cloud.ts"
import { Repository, RepositoryLive } from "./repository.ts"
import { rolloutRouting, serviceCredential } from "./rollout.ts"
import { RuntimeEdge } from "./runtime.ts"
import { infrastructure, routes } from "./server.ts"
import type { ApiOptions } from "./config.ts"

const options = {
  secret: Redacted.make("rollout-test-secret-is-not-a-provider-credential"),
  databaseUrl: Redacted.make("unused"),
  origin: "http://localhost:3001",
  port: 0,
  production: false,
  emailMode: "local",
  emailFrom: "test@localhost",
  runnerEnvironment: { DATABASE_URL: "postgres://cell/original" },
} satisfies ApiOptions

const live = Layer.unwrap(
  Effect.gen(function* () {
    const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
    const name = `routing_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: base.href })),
      (pool) => Effect.promise(() => pool.end()),
    )
    yield* Effect.acquireRelease(
      Effect.promise(() => pool.query(`CREATE DATABASE "${name}"`)),
      () => Effect.promise(() => pool.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
    )
    base.pathname = `/${name}`
    yield* Effect.promise(() => migrate(base.href, { startAt: "0002_" }))
    return rolloutRouting(options).pipe(
      Layer.provideMerge(RepositoryLive),
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(base.href), maxConnections: 5 })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)
const runtime = ManagedRuntime.make(live)
afterAll(() => runtime.dispose(), 60000)
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

const apiLive = Layer.unwrap(
  Config.Redacted("TEST_DATABASE_URL").pipe(
    Effect.map((databaseUrl) => infrastructure({ ...options, databaseUrl })),
  ),
).pipe(Layer.provideMerge(FetchHttpClient.layer), Layer.provideMerge(BunCrypto.layer))
const api = ManagedRuntime.make(apiLive)
afterAll(() => api.dispose(), 60000)

/** Serves the public routes over Bun HTTP and signs one verified owner in, so assertions go through the API a client calls. */
const publicApi = Effect.gen(function* () {
  const context = yield* Effect.context<Layer.Success<typeof apiLive>>()
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        routes.pipe(
          Layer.provide(Layer.succeedContext(context)),
          Layer.provide(BunHttpServer.layerHttpServices),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  )
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => web.handler(request) }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )
  const client = yield* HttpClient.HttpClient
  const sql = yield* SqlClient.SqlClient
  const request = (path: string, body?: Schema.Json, cookie?: string) =>
    Effect.gen(function* () {
      const headers = new Headers({ "content-type": "application/json", origin: options.origin })
      if (cookie !== undefined) headers.set("cookie", cookie)
      const base = HttpClientRequest.make(body === undefined ? "GET" : "POST")(
        `http://127.0.0.1:${server.port}${path}`,
      ).pipe(HttpClientRequest.setHeaders(headers))
      return yield* client
        .execute(body === undefined ? base : yield* HttpClientRequest.bodyJson(body)(base))
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
    }).pipe(Effect.orDie)
  const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
  const email = `rollout-owner-${suffix}@example.com`
  const password = "correct-horse-battery-staple-42"
  const signup = yield* request("/auth/sign-up/email", { name: "Rollout owner", email, password })
  expect(signup.status).toBe(200)
  const [verification] = yield* sql<{
    body: string
  }>`SELECT body FROM cloud_email_outbox WHERE recipient = ${email} ORDER BY id DESC LIMIT 1`.pipe(
    Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (rows) => rows.length > 0 }),
    Effect.timeout("5 seconds"),
    Effect.orDie,
  )
  const link = new URL(verification?.body ?? "")
  expect((yield* request(link.pathname + link.search)).status).toBe(302)
  const login = yield* request("/auth/sign-in/email", { email, password })
  expect(login.status).toBe(200)
  const cookie = Cookies.toCookieHeader(login.cookies)
  return {
    sql,
    suffix,
    call: <A, I>(path: string, schema: Schema.Codec<A, I>, body?: Schema.Json) =>
      request(path, body, cookie).pipe(
        Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema))),
        Effect.orDie,
      ),
  }
})

const release = (projectId: string, deploymentId: string): ReleaseRecord => ({
  organizationId: "org-routing",
  projectId,
  environment: "production",
  deploymentId,
  imageDigest: `example@sha256:${"a".repeat(64)}`,
  envSnapshot: '{"APP_SETTING":"original"}',
  regions: ["us-east-1"],
})

describe("rollout routing authority", () => {
  it("binds a redacted service credential to the deployment and signing secret", () => {
    const secret = Redacted.make("review-local-hmac-test-key-not-a-secret")
    const first = serviceCredential(secret, "deployment-one")
    const second = serviceCredential(secret, "deployment-two")
    expect(Redacted.value(first)).toBe(
      "9c6ec99ca3922954b83c5c0f8e7cc3e930386f022a8704c576daeb3fb1461e47",
    )
    expect(Redacted.value(second)).toBe(
      "5102a78e1e0030d95d6e4fb9b08d8a7c73cb987a8739dc214d0f7dbcda6b50aa",
    )
    expect(
      Redacted.value(serviceCredential(Redacted.make("another-local-key"), "deployment-one")),
    ).not.toBe(Redacted.value(first))
    expect(Inspectable.toStringUnknown(first)).not.toContain(Redacted.value(first))
  })

  it("moves aliases and credentials atomically and restores the earlier effective snapshot on rollback", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository
        const sql = yield* SqlClient.SqlClient
        const routing = yield* RolloutRouting
        const project = yield* repository.createProject({
          organizationId: "org-routing",
          actor: { kind: "user", id: "user-routing" },
          name: "Routing",
          slug: "routing",
          homeRegion: "us-east-1",
        })
        const first = release(project.id, "release-one")
        yield* sql.withTransaction(routing.register(first)).pipe(Effect.orDie)
        yield* sql
          .withTransaction(
            routing.activate({
              ...first,
              previousDeploymentId: null,
              initiator: "user:user-routing",
            }),
          )
          .pipe(Effect.orDie)
        yield* sql`INSERT INTO deployment_host (host, deployment_id) VALUES ('custom.example', 'release-one')`.pipe(
          Effect.orDie,
        )
        yield* sql`INSERT INTO hosted_api_key (key_hash, deployment_id, tenant, subject) VALUES (${"b".repeat(64)}, 'release-one', 'acme', 'customer')`.pipe(
          Effect.orDie,
        )
        const second = release(project.id, "release-two")
        yield* sql.withTransaction(routing.register(second)).pipe(Effect.orDie)
        yield* sql
          .withTransaction(
            routing.activate({
              ...second,
              previousDeploymentId: "release-one",
              initiator: "api-key:key-routing",
            }),
          )
          .pipe(Effect.orDie)
        expect(
          yield* sql`SELECT deployment_id FROM deployment_host WHERE host = 'custom.example'`,
        ).toEqual([{ deployment_id: "release-two" }])
        expect(
          yield* sql`SELECT deployment_id, tenant FROM hosted_api_key WHERE subject = 'customer'`,
        ).toEqual([{ deployment_id: "release-two", tenant: "acme" }])
        expect(
          yield* sql`SELECT actor_kind, actor_id FROM cloud_audit WHERE action = 'deployment.live' ORDER BY id`,
        ).toEqual([
          { actor_kind: "user", actor_id: "user-routing" },
          { actor_kind: "api-key", actor_id: "key-routing" },
        ])
        const context = yield* Effect.context<SqlClient.SqlClient | Repository>()
        const changed = yield* Layer.build(
          rolloutRouting({
            ...options,
            runnerEnvironment: { DATABASE_URL: "postgres://cell/changed" },
          }).pipe(Layer.provide(Layer.succeedContext(context))),
        )
        const rollback = {
          ...release(project.id, "release-rollback"),
          rolledBackFrom: "release-one",
        }
        yield* sql
          .withTransaction(Context.get(changed, RolloutRouting).register(rollback))
          .pipe(Effect.orDie)
        expect(
          yield* sql`SELECT environment_snapshot ->> 'DATABASE_URL' AS database, environment_snapshot ->> 'APP_SETTING' AS setting, environment_snapshot ->> 'ASSERTION_AUDIENCE' AS audience FROM deployment WHERE id = 'release-rollback'`,
        ).toEqual([
          {
            database: "postgres://cell/original",
            setting: "original",
            audience: "release-rollback",
          },
        ])
      }).pipe(Effect.scoped),
    ))

  it("refuses a stale pointer without writing and rolls back pointer, project and host changes when audit fails", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository
        const sql = yield* SqlClient.SqlClient
        const routing = yield* RolloutRouting
        const project = yield* repository.createProject({
          organizationId: "org-routing",
          actor: { kind: "user", id: "user-routing" },
          name: "Failure",
          slug: "failure",
          homeRegion: "us-east-1",
        })
        const candidate = release(project.id, "release-failure")
        yield* sql.withTransaction(routing.register(candidate)).pipe(Effect.orDie)
        expect(
          yield* sql
            .withTransaction(
              routing.activate({
                ...candidate,
                previousDeploymentId: "stale",
                initiator: "user:user-routing",
              }),
            )
            .pipe(Effect.flip),
        ).toEqual(
          ActivationRefused.make({ reason: "The live environment changed before activation" }),
        )
        yield* sql
          .unsafe(
            "CREATE FUNCTION deny_live_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'deployment.live' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$",
          )
          .pipe(Effect.orDie)
        yield* sql
          .unsafe(
            "CREATE TRIGGER deny_live_audit BEFORE INSERT ON cloud_audit FOR EACH ROW EXECUTE FUNCTION deny_live_audit()",
          )
          .pipe(Effect.orDie)
        const failed = yield* sql
          .withTransaction(
            routing.activate({
              ...candidate,
              previousDeploymentId: null,
              initiator: "user:user-routing",
            }),
          )
          .pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(Exit.isFailure(failed) ? String(failed.cause) : "succeeded").toContain(
          "audit unavailable",
        )
        expect(
          yield* sql`SELECT current_deployment_id FROM cloud_environment WHERE project_id = ${project.id} AND name = 'production'`,
        ).toEqual([{ current_deployment_id: null }])
        expect(yield* sql`SELECT status FROM cloud_project WHERE id = ${project.id}`).toEqual([
          { status: "empty" },
        ])
        expect(
          yield* sql`SELECT host FROM deployment_host WHERE deployment_id = 'release-failure' AND host <> 'release-failure.localhost'`,
        ).toEqual([])
        expect(
          yield* sql`SELECT id FROM cloud_audit WHERE action = 'deployment.live' AND target_id = 'release-failure'`,
        ).toEqual([])
        yield* sql.unsafe("DROP TRIGGER deny_live_audit ON cloud_audit").pipe(Effect.orDie)
      }),
    ))

  it("resolves a live environment's edge target only for the organization that owns the project", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository
        const sql = yield* SqlClient.SqlClient
        const routing = yield* RolloutRouting
        const project = yield* repository.createProject({
          organizationId: "org-routing",
          actor: { kind: "user", id: "user-routing" },
          name: "Scoped",
          slug: "scoped",
          homeRegion: "us-east-1",
        })
        const scoped = release(project.id, "release-scoped")
        yield* sql.withTransaction(routing.register(scoped)).pipe(Effect.orDie)
        yield* sql
          .withTransaction(
            routing.activate({
              ...scoped,
              previousDeploymentId: null,
              initiator: "user:user-routing",
            }),
          )
          .pipe(Effect.orDie)
        const context = yield* Effect.context<SqlClient.SqlClient>()
        const edge = Context.get(
          yield* Layer.build(
            runtimeEdge(options).pipe(Layer.provide(Layer.succeedContext(context))),
          ),
          RuntimeEdge,
        )
        const target = { projectId: project.id, environment: "production" }
        expect((yield* edge.resolve({ ...target, organizationId: "org-routing" })).host).toBe(
          `${project.id.replaceAll("_", "-")}-production.localhost`,
        )
        expect(
          yield* edge.resolve({ ...target, organizationId: "org-other" }).pipe(Effect.flip),
        ).toEqual(NotFound.make({ resource: "live deployment", id: `${project.id}/production` }))
      }).pipe(Effect.scoped),
    ))

  it(
    "labels a rollback and a redeploy with the source deployment's short commit and message",
    () =>
      api.runPromise(
        Effect.gen(function* () {
          const { sql, suffix, call } = yield* publicApi
          const organization = yield* call("/api/organizations", OrganizationMembership, {
            name: "Rollout labels",
            slug: `rollout-labels-${suffix}`,
          })
          const project = yield* call(
            `/api/organizations/${organization.organization.id}/projects`,
            Project,
            { name: "Labels", slug: "labels", homeRegion: "us-east-1" },
          )
          const path = `/api/projects/${project.id}/deployments`
          const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
          const deploy = (commitSha: string, message: string) =>
            call(path, DeploymentDetail, { environment: "production", commitSha, message })
          const fail = (deploymentId: string) =>
            call(`${path}/${deploymentId}/build-failure`, DeploymentDetail, {
              reason: "Release the environment for the next rollout",
            })
          const first = yield* deploy(sha, "Ship the checkout flow")
          yield* fail(first.id)
          yield* fail(
            (yield* deploy("9f8e7d6c5b4a39281706f5e4d3c2b1a098765432", "Tune the cache")).id,
          )
          const redeployed = yield* call(`${path}/${first.id}/redeploy`, DeploymentDetail, {})
          expect(redeployed).toMatchObject({
            commitSha: sha,
            message: "Redeploy a1b2c3d: Ship the checkout flow",
            rolledBackFrom: null,
          })
          yield* fail(redeployed.id)
          const image = `example@sha256:${"c".repeat(64)}`
          yield* sql`UPDATE deployment_rollout SET status = 'drained', image_digest = ${image} WHERE id = ${first.id}`.pipe(
            Effect.orDie,
          )
          yield* sql`INSERT INTO deployment (id, primary_region, tier, image, environment_snapshot, serving) VALUES (${first.id}, 'us-east-1', 'free', ${image}, ${'{"APP_SETTING":"checkout","DATABASE_URL":"postgres://cell/original"}'}::jsonb, false)`.pipe(
            Effect.orDie,
          )
          const rolledBack = yield* call(`${path}/${first.id}/rollback`, DeploymentDetail, {})
          expect(rolledBack).toMatchObject({
            commitSha: sha,
            message: "Rollback to a1b2c3d: Ship the checkout flow",
            rolledBackFrom: first.id,
          })
        }).pipe(Effect.scoped),
      ),
    60000,
  )
})
