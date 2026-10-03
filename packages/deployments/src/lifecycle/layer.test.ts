import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { ActorTest } from "@rikalabs/akter/testing"
import {
  Config,
  Context,
  Crypto,
  Deferred,
  Fiber,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Result,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { ensureLifecycleTables } from "./bootstrap.ts"
import {
  DeploymentLifecycle,
  type Environment,
  lifecycleKey,
  RolloutInProgress,
  type RolloutRunner,
} from "./contract.ts"
import { DeploymentLifecycleLive } from "./layer.ts"
import {
  ActivationRefused,
  PlatformFailure,
  type Release,
  RolloutPlatform,
  RolloutRouting,
} from "./platform.ts"

interface Call {
  readonly step: "migrate" | "start" | "drain"
  readonly deploymentId: string
  readonly imageDigest: string
  readonly envSnapshot: string
  readonly jobId: string
  readonly other: string | null
}

/** A scripted provider: it records every call and fails or holds the steps a test names. */
const provider = {
  calls: [] as Array<Call>,
  failures: new Map<string, PlatformFailure>(),
  gates: new Map<string, Deferred.Deferred<void>>(),
  unmeasured: new Set<string>(),
}

const runner = (release: Release): RolloutRunner => ({
  id: `runner-${release.deploymentId}`,
  region: "us-east-1",
  actorCount: provider.unmeasured.has(release.deploymentId) ? null : 3,
  cpuPercent: provider.unmeasured.has(release.deploymentId) ? null : 12.5,
  health: "healthy",
})

const step = <A>(
  name: Call["step"],
  release: Pick<Release, "deploymentId" | "jobId">,
  extra: Partial<Call>,
  value: A,
) =>
  Effect.gen(function* () {
    provider.calls.push({
      step: name,
      deploymentId: release.deploymentId,
      imageDigest: "",
      envSnapshot: "",
      jobId: release.jobId,
      other: null,
      ...extra,
    })

    const gate = provider.gates.get(`${name}:${release.deploymentId}`)

    if (gate !== undefined) yield* Deferred.await(gate)

    const failure = provider.failures.get(`${name}:${release.deploymentId}`)

    if (failure !== undefined) return yield* failure

    return value
  })

const platform = Layer.succeed(
  RolloutPlatform,
  RolloutPlatform.of({
    migrate: (release) => step("migrate", release, release, undefined),
    start: (release) => step("start", release, release, [runner(release)]),
    drain: (input) =>
      step("drain", { ...input, jobId: input.jobId }, { other: input.replacedBy }, undefined),
  }),
)

/** Control-plane tables the routing writes in the actor's turn, as the real one writes `cloud_environment`. */
const routing = Layer.effect(
  RolloutRouting,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return RolloutRouting.of({
      register: (release) =>
        sql`
          INSERT INTO test_release (deployment_id, image_digest)
          VALUES (${release.deploymentId}, ${release.imageDigest})
          ON CONFLICT DO NOTHING
        `.pipe(Effect.orDie, Effect.asVoid),
      activate: (release) =>
        Effect.gen(function* () {
          const flipped = yield* sql`
            UPDATE test_environment SET current_deployment_id = ${release.deploymentId}
            WHERE project_id = ${release.projectId} AND environment = ${release.environment}
              AND current_deployment_id IS NOT DISTINCT FROM ${release.previousDeploymentId}
            RETURNING project_id
          `.pipe(Effect.orDie)

          if (flipped.length === 0)
            return yield* ActivationRefused.make({ reason: "the environment moved on" })
        }),
    })
  }),
)

const database = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `lifecycle_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  const url = Redacted.make(base.href)

  const client = yield* Layer.build(PgClient.layer({ url }))

  yield* ensureLifecycleTables.pipe(Effect.provideContext(client))
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`CREATE TABLE test_release (deployment_id text PRIMARY KEY, image_digest text NOT NULL)`
    yield* sql`CREATE TABLE test_environment (project_id text, environment text, current_deployment_id text, PRIMARY KEY (project_id, environment))`
  }).pipe(Effect.orDie, Effect.provideContext(client))

  return url
})

class Url extends Context.Service<Url, Redacted.Redacted<string>>()(
  "@akter/deployments/lifecycle/layer.test/Url",
) {}

const live = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* database

    const test = ActorTest.layer({ database: url })

    return DeploymentLifecycleLive.pipe(
      Layer.provide(Layer.merge(platform, routing.pipe(Layer.provide(test)))),
      Layer.provideMerge(test),
      Layer.provideMerge(Layer.succeed(Url, url)),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

const author = { name: "Ada", image: null }

const environment = (project: string, name: Environment = "production") =>
  Effect.gen(function* () {
    const test = yield* ActorTest
    const lifecycle = yield* DeploymentLifecycle.get(
      lifecycleKey({ projectId: project, environment: name }),
    )

    /** Starts a deployment, records its build, and lets its rollout finish. */
    const deploy = Effect.fnUntraced(function* (id: string, commitSha = "abcdef1") {
      yield* lifecycle.Create({
        deploymentId: id,
        commitSha,
        message: `deploy ${id}`,
        author,
        regions: [],
        envSnapshot: `env-${id}`,
      })
      yield* lifecycle.RecordBuild({
        deploymentId: id,
        imageDigest: `sha256:${id}`,
        commitSha: "abcdef1234567",
        log: [{ stream: "stdout", text: `built ${id}` }],
      })
      yield* settle
    })

    const settle = test.advance("1 minute")
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      INSERT INTO test_environment (project_id, environment, current_deployment_id)
      VALUES (${project}, ${name}, NULL) ON CONFLICT DO NOTHING
    `
    const pointer = Effect.map(
      sql<{ readonly current: string | null }>`
        SELECT current_deployment_id AS current FROM test_environment
        WHERE project_id = ${project} AND environment = ${name}
      `,
      ([row]) => row!.current,
    )

    const statuses = Effect.map(lifecycle.List({}), ({ items }) =>
      Object.fromEntries(items.map(({ id, status }) => [id, status])),
    )

    return { lifecycle, deploy, settle, statuses, pointer, test, sql }
  })

describe("DeploymentLifecycle", () => {
  it("rolls out build to live, drains the previous deployment only once the replacement is active, and serves the read model", () =>
    run(
      Effect.gen(function* () {
        const { lifecycle, statuses, settle, pointer, sql, test } = yield* environment("p-happy")
        const first = yield* lifecycle.Create({
          deploymentId: "d1",
          commitSha: "abcdef1",
          message: "first",
          author,
          regions: [],
          envSnapshot: "env-d1",
        })

        expect(first).toMatchObject({
          status: "in-progress",
          phase: "building",
          organizationId: expect.any(String),
          projectId: "p-happy",
          environment: "production",
          steps: [
            { name: "build", status: "running" },
            { name: "migrate", status: "pending" },
            { name: "start-runners", status: "pending" },
            { name: "drain-previous", status: "pending" },
          ],
        })
        expect((yield* lifecycle.GetBuildLog({ deploymentId: "d1" })).complete).toBe(false)

        yield* lifecycle.RecordBuild({
          deploymentId: "d1",
          imageDigest: "sha256:d1",
          commitSha: "abcdef1234567",
          log: [
            { stream: "stdout", text: "step 1" },
            { stream: "stderr", text: "warn" },
          ],
        })
        yield* settle

        const live = yield* lifecycle.Get({ deploymentId: "d1" })

        expect(live).toMatchObject({
          status: "live",
          phase: "live",
          commitSha: "abcdef1234567",
          imageDigest: "sha256:d1",
          runnerCount: 1,
          regions: ["us-east-1"],
          steps: [
            { name: "build", status: "succeeded" },
            { name: "migrate", status: "succeeded" },
            { name: "start-runners", status: "succeeded" },
            { name: "drain-previous", status: "skipped" },
          ],
          runners: [{ id: "runner-d1", region: "us-east-1", actorCount: 3, cpuPercent: 12.5 }],
        })
        expect(live.durationMs).toBeGreaterThanOrEqual(0)

        const log = yield* lifecycle.GetBuildLog({ deploymentId: "d1", after: 1 })

        expect(log.complete).toBe(true)
        expect(log.lines.map(({ index, stream, text }) => ({ index, stream, text }))).toEqual([
          { index: 1, stream: "stderr", text: "warn" },
        ])

        yield* lifecycle.Create({
          deploymentId: "d2",
          commitSha: "1234567",
          message: "second",
          author,
          regions: ["us-west-2"],
          envSnapshot: "env-d2",
        })
        yield* lifecycle.RecordBuild({
          deploymentId: "d2",
          imageDigest: "sha256:d2",
          commitSha: "1234567",
          log: [],
        })

        const gate = yield* Deferred.make<void>()

        provider.gates.set("start:d2", gate)

        const rolling = yield* Effect.forkChild(settle)

        while (!provider.calls.some((call) => call.step === "start" && call.deploymentId === "d2"))
          yield* Effect.sleep("20 millis")

        const migrations = () =>
          provider.calls.filter((call) => call.step === "migrate" && call.deploymentId === "d1")

        const waitingJobs = (yield* test.inspect(lifecycle.ref)).jobs
        const again = yield* lifecycle.RecordBuild({
          deploymentId: "d1",
          imageDigest: "sha256:d1",
          commitSha: "abcdef1234567",
          envSnapshot: "env-d1",
        })

        expect(again).toMatchObject({ id: "d1", status: "live" })
        expect((yield* test.inspect(lifecycle.ref)).jobs).toBe(waitingJobs)
        expect(migrations()).toHaveLength(1)
        expect(
          Result.isFailure(
            yield* Effect.result(
              lifecycle.RecordBuild({
                deploymentId: "d1",
                imageDigest: "sha256:d1",
                commitSha: "abcdef1234567",
                envSnapshot: "changed",
              }),
            ),
          ),
        ).toBe(true)
        expect(yield* statuses).toEqual({ d1: "live", d2: "in-progress" })
        expect(yield* pointer).toBe("d1")
        expect(provider.calls.some((call) => call.step === "drain")).toBe(false)

        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(rolling)

        expect(yield* statuses).toEqual({ d1: "drained", d2: "live" })
        expect(yield* pointer).toBe("d2")

        const versions = yield* sql<{
          readonly pointer: string
          readonly d1: string
          readonly d2: string
        }>`
          SELECT
            (SELECT xmin::text FROM test_environment WHERE project_id = 'p-happy') AS pointer,
            (SELECT xmin::text FROM deployment_rollout WHERE id = 'd1') AS d1,
            (SELECT xmin::text FROM deployment_rollout WHERE id = 'd2') AS d2
        `

        expect(versions[0]!.d1).toBe(versions[0]!.d2)
        expect(versions[0]!.pointer).toBe(versions[0]!.d2)
        expect(
          (yield* sql<{
            readonly deployment_id: string
          }>`SELECT deployment_id FROM test_release ORDER BY 1`).map((row) => row.deployment_id),
        ).toEqual(["d1", "d2"])

        const second = yield* lifecycle.Get({ deploymentId: "d2" })

        expect(second.regions).toEqual(["us-west-2"])
        expect(second.steps.map(({ name, status }) => `${name}:${status}`)).toEqual([
          "build:succeeded",
          "migrate:succeeded",
          "start-runners:succeeded",
          "drain-previous:succeeded",
        ])

        const d2Calls = provider.calls.filter(
          (call) => call.deploymentId === "d2" || call.other === "d2",
        )

        expect(
          d2Calls.map(({ step: name, deploymentId, other }) => [name, deploymentId, other]),
        ).toEqual([
          ["migrate", "d2", null],
          ["start", "d2", null],
          ["drain", "d1", "d2"],
        ])
        expect(d2Calls[0]).toMatchObject({ imageDigest: "sha256:d2", envSnapshot: "env-d2" })

        const page = yield* lifecycle.List({ limit: 1 })

        expect(page.items.map(({ id }) => id)).toEqual(["d2"])
        expect(page.nextCursor).not.toBeNull()
        expect(
          (yield* lifecycle.List({ limit: 1, cursor: page.nextCursor! })).items.map(({ id }) => id),
        ).toEqual(["d1"])
        expect((yield* lifecycle.List({ status: "drained" })).items.map(({ id }) => id)).toEqual([
          "d1",
        ])
        expect(Result.isFailure(yield* Effect.result(lifecycle.List({ cursor: "nope" })))).toBe(
          true,
        )
      }),
    ))

  it("lets exactly one of many concurrent rollouts start, per environment, and refuses repeated ids and results", () =>
    run(
      Effect.gen(function* () {
        const { lifecycle } = yield* environment("p-race")
        const staging = yield* environment("p-race", "staging")

        const create = (id: string) =>
          lifecycle.Create({
            deploymentId: id,
            commitSha: "abcdef1",
            message: id,
            author,
            regions: [],
            envSnapshot: "env",
          })

        const results = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => `r${index}`),
          (id) => Effect.map(Effect.result(create(id)), (result) => ({ id, result })),
          { concurrency: "unbounded" },
        )

        const winners = results.filter(({ result }) => Result.isSuccess(result))

        expect(winners).toHaveLength(1)

        for (const { result } of results.filter(({ result }) => Result.isFailure(result)))
          expect(Result.isFailure(result) ? result.failure : undefined).toEqual(
            RolloutInProgress.make({ deploymentId: winners[0]!.id }),
          )

        expect((yield* lifecycle.List({})).items.map(({ id }) => id)).toEqual([winners[0]!.id])

        const again = yield* Effect.result(create(winners[0]!.id))

        expect(Result.isFailure(again) ? again.failure._tag : undefined).toBe("DeploymentExists")

        yield* staging.lifecycle.Create({
          deploymentId: "s1",
          commitSha: "abcdef1",
          message: "staging",
          author,
          regions: [],
          envSnapshot: "env",
        })
        expect((yield* staging.lifecycle.List({})).items.map(({ id }) => id)).toEqual(["s1"])

        const record = {
          deploymentId: winners[0]!.id,
          imageDigest: "sha256:r",
          commitSha: "abcdef1",
          log: [],
        }

        yield* lifecycle.RecordBuild(record)

        const twice = yield* Effect.result(
          lifecycle.RecordBuild({ ...record, imageDigest: "sha256:other" }),
        )
        const unknown = yield* Effect.result(
          lifecycle.RecordBuild({ ...record, deploymentId: "nope" }),
        )

        expect(Result.isFailure(twice) ? twice.failure._tag : undefined).toBe("NotBuilding")
        expect(Result.isFailure(unknown) ? unknown.failure._tag : undefined).toBe(
          "DeploymentNotFound",
        )
      }),
    ))

  it("leaves the live deployment live whichever step fails, retries only retryable failures, and recovers", () =>
    run(
      Effect.gen(function* () {
        const { lifecycle, deploy, settle, statuses, pointer, sql } = yield* environment("p-fail")
        const failure = (reason: string, retryable = false) =>
          PlatformFailure.make({ reason, retryable })
        const calls = (step: Call["step"], id: string) =>
          provider.calls.filter((call) => call.step === step && call.deploymentId === id).length

        provider.unmeasured.add("f1")
        yield* deploy("f1")

        expect((yield* lifecycle.Get({ deploymentId: "f1" })).runners).toEqual([
          {
            id: "runner-f1",
            region: "us-east-1",
            actorCount: null,
            cpuPercent: null,
            health: "healthy",
          },
        ])

        provider.failures.set("migrate:f2", failure("migration 0007 failed"))
        yield* deploy("f2")

        const migrate = yield* lifecycle.Get({ deploymentId: "f2" })

        expect(migrate).toMatchObject({
          status: "failed",
          phase: "failed",
          failure: "migration 0007 failed",
        })
        expect(migrate.steps.map(({ name, status }) => `${name}:${status}`)).toEqual([
          "build:succeeded",
          "migrate:failed",
          "start-runners:skipped",
          "drain-previous:skipped",
        ])
        expect(migrate.steps[1]!.detail).toBe("migration 0007 failed")
        expect(calls("migrate", "f2")).toBe(1)
        expect(calls("start", "f2")).toBe(0)

        provider.failures.set("start:f3", failure("boom", true))
        yield* deploy("f3")

        for (let attempt = 0; attempt < 10; attempt++) {
          if ((yield* lifecycle.Get({ deploymentId: "f3" })).status !== "in-progress") break

          yield* settle
        }

        expect(calls("start", "f3")).toBe(4)
        expect(calls("drain", "f3")).toBe(1)

        provider.failures.set("start:f3b", failure("no capacity"))
        yield* deploy("f3b")

        expect(calls("start", "f3b")).toBe(1)
        expect(calls("drain", "f3b")).toBe(1)
        expect(yield* lifecycle.Get({ deploymentId: "f3" })).toMatchObject({
          status: "failed",
          failure: expect.stringContaining("boom"),
          runnerCount: 0,
          runners: [],
        })

        yield* sql`UPDATE test_environment SET current_deployment_id = 'elsewhere' WHERE project_id = 'p-fail'`
        yield* deploy("f4")

        expect(yield* lifecycle.Get({ deploymentId: "f4" })).toMatchObject({
          status: "failed",
          failure: "the environment moved on",
          runnerCount: 0,
          runners: [],
        })
        expect(yield* pointer).toBe("elsewhere")
        expect(calls("drain", "f1")).toBe(0)
        expect(calls("drain", "f4")).toBe(1)
        yield* sql`UPDATE test_environment SET current_deployment_id = 'f1' WHERE project_id = 'p-fail'`

        yield* lifecycle.Create({
          deploymentId: "f5",
          commitSha: "abcdef1",
          message: "f5",
          author,
          regions: [],
          envSnapshot: "env",
        })
        yield* lifecycle.FailBuild({ deploymentId: "f5", reason: "npm ERR" })

        const build = yield* lifecycle.GetBuildLog({ deploymentId: "f5" })

        expect(build.complete).toBe(true)
        expect(build.lines.map(({ stream, text }) => [stream, text])).toEqual([
          ["stderr", "npm ERR"],
        ])
        expect(yield* statuses).toEqual({
          f1: "live",
          f2: "failed",
          f3: "failed",
          f3b: "failed",
          f4: "failed",
          f5: "failed",
        })

        provider.failures.set("drain:f1", failure("runner stuck"))
        yield* deploy("f6")

        const drained = yield* lifecycle.Get({ deploymentId: "f6" })

        expect(drained.status).toBe("live")
        expect(drained.steps[3]).toMatchObject({
          name: "drain-previous",
          status: "failed",
          detail: "runner stuck",
        })
        expect((yield* statuses).f1).toBe("drained")

        yield* deploy("f7")
        expect(yield* statuses).toMatchObject({ f6: "drained", f7: "live" })
      }),
    ))

  it("rolls back to an earlier live deployment's image and environment without building or migrating", () =>
    run(
      Effect.gen(function* () {
        const { lifecycle, deploy, settle, statuses, pointer, sql } = yield* environment("p-rb")
        const rollback = (deploymentId: string, target: string) =>
          lifecycle.Rollback({ deploymentId, target, message: `back to ${target}`, author })
        const kind = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
          Result.isFailure(result) ? result.failure._tag : "ok"

        yield* deploy("a")
        yield* deploy("b")
        provider.failures.set(
          "migrate:x",
          PlatformFailure.make({ reason: "bad", retryable: false }),
        )
        yield* deploy("x")

        expect(yield* statuses).toEqual({ a: "drained", b: "live", x: "failed" })
        expect(kind(yield* Effect.result(rollback("c", "b")))).toBe("RollbackTargetInvalid")
        expect(kind(yield* Effect.result(rollback("c", "x")))).toBe("RollbackTargetInvalid")
        expect(kind(yield* Effect.result(rollback("c", "missing")))).toBe("DeploymentNotFound")
        expect(yield* statuses).toEqual({ a: "drained", b: "live", x: "failed" })

        const started = yield* rollback("c", "a")

        expect(started).toMatchObject({
          status: "in-progress",
          phase: "rolling-out",
          rolledBackFrom: "a",
          commitSha: "abcdef1234567",
          imageDigest: "sha256:a",
          steps: [
            { name: "build", status: "skipped" },
            { name: "migrate", status: "skipped" },
            { name: "start-runners", status: "running" },
            { name: "drain-previous", status: "pending" },
          ],
        })
        expect(
          kind(
            yield* Effect.result(
              lifecycle.Create({
                deploymentId: "n",
                commitSha: "abcdef1",
                message: "",
                author,
                regions: [],
                envSnapshot: "",
              }),
            ),
          ),
        ).toBe("RolloutInProgress")
        expect((yield* statuses).b).toBe("live")

        yield* settle

        expect(yield* statuses).toEqual({ a: "drained", b: "rolled-back", c: "live", x: "failed" })

        const own = provider.calls.filter((call) => call.deploymentId === "c" || call.other === "c")

        expect(own.map(({ step, deploymentId, other }) => [step, deploymentId, other])).toEqual([
          ["start", "c", null],
          ["drain", "b", "c"],
        ])
        expect(own[0]).toMatchObject({ imageDigest: "sha256:a", envSnapshot: "env-a" })
        expect(yield* pointer).toBe("c")
        expect(
          (yield* sql<{
            readonly image_digest: string
          }>`SELECT image_digest FROM test_release WHERE deployment_id = 'c'`)[0]!.image_digest,
        ).toBe("sha256:a")
        expect((yield* lifecycle.GetBuildLog({ deploymentId: "c" })).complete).toBe(true)

        provider.failures.set(
          "start:d",
          PlatformFailure.make({ reason: "no capacity", retryable: false }),
        )
        yield* rollback("d", "b")
        yield* settle

        expect(yield* statuses).toEqual({
          a: "drained",
          b: "rolled-back",
          c: "live",
          d: "failed",
          x: "failed",
        })
        expect((yield* lifecycle.Get({ deploymentId: "d" })).failure).toBe("no capacity")
      }),
    ))

  it("creates the lifecycle tables again, even concurrently, without touching their rows", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const count = Effect.map(
          sql<{ readonly total: number }>`SELECT count(*)::int AS total FROM deployment_rollout`,
          ([row]) => row!.total,
        )
        const before = yield* count

        expect(before).toBeGreaterThan(0)
        yield* Effect.all([ensureLifecycleTables, ensureLifecycleTables, ensureLifecycleTables], {
          concurrency: "unbounded",
        })
        expect(yield* count).toBe(before)
      }),
    ))
})
