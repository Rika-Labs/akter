import * as Cloud from "@akter/cloud-api"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { configDirectory, runCliWith, scriptedFetch } from "../../testing.ts"

const API = "http://cloud.test"

const credentials = { apiUrl: API, token: "stored-token", email: "ada@example.dev" }

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const parse = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(Effect.orDie)

/** The refusals the stand-in control plane answers with, encoded as the API encodes them. */
const refusals = Effect.all({
  unauthorized: Schema.encodeEffect(Schema.toCodecJson(Cloud.Unauthorized))(
    Cloud.Unauthorized.make({
      code: "invalid_credentials",
      message: "Session could not be verified",
    }),
  ),
  notFound: Schema.encodeEffect(Schema.toCodecJson(Cloud.NotFound))(
    Cloud.NotFound.make({ resource: "project", id: "prj_other" }),
  ),
}).pipe(Effect.orDie)

type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped"

/** A deployment detail as the control plane encodes it, with its four steps in `steps`' states. */
const detail = (
  status: "in-progress" | "live" | "failed",
  steps: readonly [StepStatus, StepStatus, StepStatus, StepStatus],
  failure: string | null = null,
) => ({
  id: "dep_42",
  projectId: "prj_1",
  environment: "staging",
  commitSha: "abcdef1234",
  message: "Ship it",
  author: { name: "Ada", image: null },
  regions: ["us-east-1"],
  runnerCount: status === "live" ? 1 : 0,
  durationMs: null,
  status,
  rolledBackFrom: null,
  createdAt: "2026-10-04T10:00:00.000Z",
  steps: (["build", "migrate", "start-runners", "drain-previous"] as const).map((name, index) => ({
    name,
    status: steps[index]!,
    durationMs: steps[index] === "succeeded" ? 1250 : null,
    detail: steps[index] === "failed" ? failure : null,
  })),
  runners: [],
})

const building = () => detail("in-progress", ["running", "pending", "pending", "pending"])

/** The control plane: stores the upload, creates `dep_42`, then answers each poll with the next of `polls`. */
const controlPlane = (polls: ReadonlyArray<ReturnType<typeof detail>>) =>
  Effect.map(refusals, ({ unauthorized, notFound }) => {
    const answers = [...polls]

    return scriptedFetch((request) => {
      const path = new URL(request.url).pathname

      if (request.authorization !== "Bearer stored-token")
        return Response.json(unauthorized, { status: 401 })
      if (path === "/api/projects/prj_1/sources")
        return Response.json({
          digest: `sha256:${sha256(request.bytes)}`,
          sizeBytes: request.bytes.byteLength,
        })
      if (path === "/api/projects/prj_1/deployments") return Response.json(building())
      if (path === "/api/projects/prj_1/deployments/dep_42/build-log")
        return Response.json({
          lines: Array.from({ length: 25 }, (_, index) => ({
            index,
            at: "2026-10-04T10:00:01.000Z",
            stream: "stderr",
            text: `build line ${index}`,
          })),
          complete: true,
        })
      if (path === "/api/projects/prj_1/deployments/dep_42")
        return Response.json(answers.shift() ?? building())

      return Response.json(notFound, { status: 404 })
    })
  })

type Server = Effect.Success<ReturnType<typeof controlPlane>>

/** Runs `durable deploy` of a small context to `project` (default `prj_1`), with `stored` as the stored session (default `credentials`, none for null). */
const deploy = (
  server: Server,
  options: {
    readonly args?: ReadonlyArray<string>
    readonly stored?: typeof credentials | null
    readonly project?: string
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* configDirectory(
      options.stored === null ? undefined : (options.stored ?? credentials),
    )
    const root = yield* fs.makeTempDirectoryScoped()

    yield* fs.writeFileString(`${root}/Dockerfile`, "FROM scratch\nCOPY app.ts /app.ts\n")
    yield* fs.writeFileString(`${root}/app.ts`, "export {}\n")
    yield* fs.writeFileString(`${root}/.dockerignore`, "*.log\n")
    yield* fs.writeFileString(`${root}/debug.log`, "left out")

    return yield* runCliWith({ fetch: server.fetch, env: { AKTER_CONFIG_DIR: directory } })([
      "deploy",
      "--project",
      options.project ?? "prj_1",
      "--env",
      "staging",
      "--context",
      root,
      "--commit",
      "abcdef1234",
      "--message",
      "Ship it",
      ...(options.args ?? []),
    ])
  })

const routes = (server: Server) =>
  server.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)

layer(BunServices.layer, { excludeTestServices: true })("durable deploy", (it) => {
  it.effect(
    "uploads the context, creates the deployment from its digest, and follows each step until it is live",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane([
          detail("in-progress", ["succeeded", "running", "pending", "pending"]),
          detail("live", ["succeeded", "succeeded", "succeeded", "skipped"]),
        ])
        const run = yield* deploy(server)

        expect(run).toMatchObject({ exitCode: 0, reason: "" })
        expect(routes(server)).toEqual([
          "POST /api/projects/prj_1/sources",
          "POST /api/projects/prj_1/deployments",
          "GET /api/projects/prj_1/deployments/dep_42",
          "GET /api/projects/prj_1/deployments/dep_42",
        ])

        const [upload, create] = server.requests
        const uploaded = yield* Effect.promise(() => new Bun.Archive(upload!.bytes).files())

        expect([...uploaded.keys()].toSorted()).toEqual([".dockerignore", "Dockerfile", "app.ts"])
        expect(yield* parse(create!.body)).toEqual({
          environment: "staging",
          commitSha: "abcdef1234",
          message: "Ship it",
          source: { digest: `sha256:${sha256(upload!.bytes)}`, dockerfile: "Dockerfile" },
        })
        expect(run.stdout).toContain("Deployment dep_42 of abcdef1 to staging started")
        expect(run.stdout).toContain(
          "  build running\n  build succeeded in 1.3s\n  migrate running\n",
        )
        expect(run.stdout).toContain(
          "  start-runners succeeded in 1.3s\n  drain-previous skipped\n",
        )
        expect(run.stdout).toContain("Deployment dep_42 is live in staging")
      }),
  )

  it.effect("fails with exit 1 at the failed build, printing the build's last lines and why", () =>
    Effect.gen(function* () {
      const server = yield* controlPlane([
        detail(
          "failed",
          ["failed", "skipped", "skipped", "skipped"],
          "docker build exited with 1: COPY failed",
        ),
      ])
      const run = yield* deploy(server)

      expect(run).toMatchObject({ exitCode: 1, reason: "DeploymentFailed" })
      expect(run.stderr).toContain(
        "Deployment dep_42 failed at build: docker build exited with 1: COPY failed",
      )
      expect(run.stderr).toContain("    build line 24\n")
      expect(run.stderr).toContain("    build line 5\n")
      expect(run.stderr).not.toContain("    build line 4\n")
      expect(routes(server).at(-1)).toBe("GET /api/projects/prj_1/deployments/dep_42/build-log")
    }),
  )

  it.effect(
    "fails with exit 1 at a failed rollout step after the build, without reading the build log",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane([
          detail(
            "failed",
            ["succeeded", "succeeded", "failed", "skipped"],
            "Runner never became ready",
          ),
        ])
        const run = yield* deploy(server)

        expect(run).toMatchObject({ exitCode: 1, reason: "DeploymentFailed" })
        expect(run.stderr).toContain(
          "Deployment dep_42 failed at start-runners: Runner never became ready. The previous deployment, if any, is still serving.",
        )
        expect(routes(server)).not.toContain("GET /api/projects/prj_1/deployments/dep_42/build-log")
      }),
  )

  it.effect(
    "stops following with exit 1 when the timeout passes, leaving the rollout running",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane([])
        const run = yield* deploy(server, { args: ["--timeout", "0"] })

        expect(run).toMatchObject({ exitCode: 1, reason: "DeploymentTimedOut" })
        expect(run.stderr).toContain("still rolling out after 0s")
      }),
  )

  it.effect("tells an expired session to log in again before anything is uploaded", () =>
    Effect.gen(function* () {
      const server = yield* controlPlane([])
      const run = yield* deploy(server, { stored: { ...credentials, token: "expired-token" } })

      expect(run).toMatchObject({ exitCode: 1, reason: "Unauthorized" })
      expect(run.stderr).toContain("expired or was revoked")
      expect(routes(server)).toEqual(["POST /api/projects/prj_1/sources"])
    }),
  )

  it.effect("names a project the session cannot see", () =>
    Effect.gen(function* () {
      const server = yield* controlPlane([])
      const run = yield* deploy(server, { project: "prj_other" })

      expect(run).toMatchObject({ exitCode: 1, reason: "NotFound" })
      expect(run.stderr).toContain("No project prj_other is visible to you.")
    }),
  )

  it.effect("asks for a login without contacting the control plane when no session is stored", () =>
    Effect.gen(function* () {
      const server = yield* controlPlane([])
      const run = yield* deploy(server, { stored: null })

      expect(run).toMatchObject({ exitCode: 2, reason: "NotLoggedIn" })
      expect(server.requests).toEqual([])
    }),
  )
})
