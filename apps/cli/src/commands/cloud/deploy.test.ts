import * as Cloud from "@akter/cloud-api"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Predicate, Schema } from "effect"
import { configDirectory, runCliWith, scriptedFetch } from "../../testing.ts"

const API = "https://cloud.test"

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
  unavailable: Schema.encodeEffect(Schema.toCodecJson(Cloud.Unavailable))(
    Cloud.Unavailable.make({ message: "Session store unavailable", retryAfterSeconds: 1 }),
  ),
  deploymentGone: Schema.encodeEffect(Schema.toCodecJson(Cloud.NotFound))(
    Cloud.NotFound.make({ resource: "deployment", id: "dep_42" }),
  ),
}).pipe(Effect.orDie)

type Refusals = Effect.Success<typeof refusals>

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

/** A build log line as the control plane encodes it. */
const logLine = (index: number, text: string) => ({
  index,
  at: "2026-10-04T10:00:01.000Z",
  stream: "stderr",
  text,
})

/** The whole log of a build that has ended: 25 numbered lines. */
const endedLog = {
  lines: Array.from({ length: 25 }, (_, index) => logLine(index, `build line ${index}`)),
  complete: true,
}

const database: NonNullable<Cloud.Environment["database"]> = {
  source: "customer",
  state: "reachable",
  latency: 7.25,
  latencyWarning: true,
  runnerCap: 13,
}

/**
 * The control plane: stores the upload, creates `dep_42`, then answers each
 * poll with the next of `polls`, a deployment detail or, given a function, the
 * response it makes from the encoded refusals. A build log read is answered
 * with the lines of `log` at or after its `after` cursor, `log` being the next
 * of `logs` once the earlier ones are spent.
 */
const controlPlane = (
  polls: ReadonlyArray<ReturnType<typeof detail> | ((refused: Refusals) => Response)>,
  logs: ReadonlyArray<typeof endedLog> = [endedLog],
  probe?: Cloud.Environment["database"],
) =>
  Effect.map(refusals, (refused) => {
    const { unauthorized, notFound } = refused
    const answers = [...polls]
    const logAnswers = [...logs]

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
      if (path === "/api/projects/prj_1/deployments/dep_42/build-log") {
        const log = logAnswers.length > 1 ? logAnswers.shift()! : logAnswers[0]!
        const after = Number(new URL(request.url).searchParams.get("after") ?? "0")

        return Response.json({
          lines: log.lines.filter((line) => line.index >= after),
          complete: log.complete,
        })
      }
      if (path === "/api/projects/prj_1/deployments/dep_42") {
        const answer = answers.shift() ?? building()

        return Predicate.isFunction(answer) ? answer(refused) : Response.json(answer)
      }
      if (path === "/api/projects/prj_1/environments/staging")
        return Response.json({
          name: "staging",
          projectId: "prj_1",
          currentDeploymentId: "dep_42",
          database: probe,
        })

      return Response.json(notFound, { status: 404 })
    })
  })

type Server = Effect.Success<ReturnType<typeof controlPlane>>

/**
 * Runs `akter deploy` of a small app directory to `project` (default
 * `prj_1`), with `stored` as the stored session (default `credentials`, none
 * for null) and `entry` as the contents of `src/app.ts` (none for null).
 */
const deploy = (
  server: Server,
  options: {
    readonly args?: ReadonlyArray<string>
    readonly stored?: typeof credentials | null
    readonly project?: string
    readonly entry?: string | null
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* configDirectory(
      options.stored === null ? undefined : (options.stored ?? credentials),
    )
    const root = yield* fs.makeTempDirectoryScoped()

    yield* fs.makeDirectory(`${root}/src`)
    if (options.entry !== null)
      yield* fs.writeFileString(`${root}/src/app.ts`, options.entry ?? "export default app\n")
    yield* fs.writeFileString(`${root}/.akterignore`, "*.log\n")
    yield* fs.writeFileString(`${root}/src/debug.log`, "left out")

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

layer(BunServices.layer, { excludeTestServices: true })("akter deploy", (it) => {
  it.effect(
    "uploads the context, creates the deployment from its digest, and follows each step until it is live",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane(
          [
            detail("in-progress", ["succeeded", "running", "pending", "pending"]),
            detail("live", ["succeeded", "succeeded", "succeeded", "skipped"]),
          ],
          [endedLog],
          database,
        )
        const run = yield* deploy(server)

        expect(run).toMatchObject({ exitCode: 0, reason: "" })
        expect(routes(server)).toEqual([
          "POST /api/projects/prj_1/sources",
          "POST /api/projects/prj_1/deployments",
          "GET /api/projects/prj_1/deployments/dep_42/build-log",
          "GET /api/projects/prj_1/deployments/dep_42",
          "GET /api/projects/prj_1/deployments/dep_42",
          "GET /api/projects/prj_1/environments/staging",
        ])

        const [upload, create] = server.requests
        const uploaded = yield* Effect.promise(() => new Bun.Archive(upload!.bytes).files())

        expect([...uploaded.keys()].toSorted()).toEqual([".akterignore", "src/app.ts"])
        expect(yield* parse(create!.body)).toEqual({
          environment: "staging",
          commitSha: "abcdef1234",
          message: "Ship it",
          source: { digest: `sha256:${sha256(upload!.bytes)}` },
        })
        expect(run.stdout).toContain("Deployment dep_42 of abcdef1 to staging started")
        expect(run.stdout).toContain(
          `  build running\n${endedLog.lines.map((line) => `    ${line.text}\n`).join("")}  build succeeded in 1.3s\n  migrate running\n`,
        )
        expect(run.stdout).toContain(
          "  start-runners succeeded in 1.3s\n  drain-previous skipped\n",
        )
        expect(run.stderr).toContain("Warning: database p50 latency (7.25 ms) exceeds 5 ms")
        expect(run.stdout).toContain("Database runner cap: 13")
        expect(run.stdout).toContain("Deployment dep_42 is live in staging")
      }),
  )

  it.effect(
    "prints a zero runner cap without a latency warning and leaves unknown probes unprinted",
    () =>
      Effect.gen(function* () {
        for (const probe of [
          { ...database, latency: 5, latencyWarning: false, runnerCap: 0 },
          { ...database, latency: null, latencyWarning: false, runnerCap: null },
          undefined,
        ]) {
          const server = yield* controlPlane(
            [detail("live", ["succeeded", "succeeded", "succeeded", "skipped"])],
            [endedLog],
            probe,
          )
          const run = yield* deploy(server)
          expect(run.exitCode).toBe(0)
          expect(run.stderr).not.toContain("latency")
          if (probe?.runnerCap === 0) expect(run.stdout).toContain("Database runner cap: 0")
          else expect(run.stdout).not.toContain("Database runner cap:")
        }
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
    "fails with exit 1 at a failed rollout step after the build, without printing the build's last lines",
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
        expect(routes(server)).toEqual([
          "POST /api/projects/prj_1/sources",
          "POST /api/projects/prj_1/deployments",
          "GET /api/projects/prj_1/deployments/dep_42/build-log",
          "GET /api/projects/prj_1/deployments/dep_42",
        ])
        expect(new URL(server.requests[2]!.url).searchParams.get("after")).toBe("0")
        expect(run.stderr).not.toContain("build line")
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

  it.effect(
    "keeps following through a control-plane outage, retrying a typed Unavailable and a proxy's 502",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane([
          ({ unavailable }) => Response.json(unavailable, { status: 503 }),
          () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
          detail("live", ["succeeded", "succeeded", "succeeded", "skipped"]),
        ])
        const run = yield* deploy(server)

        expect(run).toMatchObject({ exitCode: 0, reason: "" })
        expect(run.stdout).toContain("Deployment dep_42 is live in staging")
        expect(run.stderr.match(/still following the deployment/gu)).toHaveLength(2)
        expect(
          routes(server).filter((route) => route === "GET /api/projects/prj_1/deployments/dep_42"),
        ).toHaveLength(3)
      }),
  )

  it.effect("stops following at a refusal during the rollout without retrying it", () =>
    Effect.gen(function* () {
      const server = yield* controlPlane([
        ({ deploymentGone }) => Response.json(deploymentGone, { status: 404 }),
      ])
      const run = yield* deploy(server)

      expect(run).toMatchObject({ exitCode: 1, reason: "NotFound" })
      expect(run.stderr).not.toContain("still following")
      expect(routes(server).at(-1)).toBe("GET /api/projects/prj_1/deployments/dep_42")
      expect(
        routes(server).filter((route) => route === "GET /api/projects/prj_1/deployments/dep_42"),
      ).toHaveLength(1)
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

  it.effect(
    "prints the build log while the build runs, asking only for lines after the last it printed, and the rest before the build's end",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane(
          [
            building(),
            detail("in-progress", ["succeeded", "running", "pending", "pending"]),
            detail("live", ["succeeded", "succeeded", "succeeded", "skipped"]),
          ],
          [
            { lines: [logLine(0, "resolve"), logLine(1, "install")], complete: false },
            { lines: [0, 1, 2].map((index) => logLine(index, `step ${index}`)), complete: false },
            {
              lines: [0, 1, 2, 3, 4].map((index) => logLine(index, `step ${index}`)),
              complete: true,
            },
          ],
        )
        const run = yield* deploy(server)
        const logReads = server.requests
          .map((request) => new URL(request.url))
          .filter((url) => url.pathname.endsWith("/build-log"))
          .map((url) => url.searchParams.get("after"))

        expect(run).toMatchObject({ exitCode: 0, reason: "" })
        expect(logReads).toEqual(["0", "2", "3"])
        expect(run.stdout).toContain(
          [
            "  build running",
            "    resolve",
            "    install",
            "    step 2",
            "    step 3",
            "    step 4",
            "  build succeeded in 1.3s",
            "  migrate running",
            "",
          ].join("\n"),
        )
        expect(run.stdout.match(/step 2/gu)).toHaveLength(1)
      }),
  )

  it.effect(
    "sends no Dockerfile, and refuses an app directory without src/app.ts before contacting anyone",
    () =>
      Effect.gen(function* () {
        const legacy = yield* controlPlane([])
        const flagged = yield* deploy(legacy, { args: ["--dockerfile", "Dockerfile"] })

        expect(flagged).toMatchObject({ exitCode: 2 })
        expect(legacy.requests).toEqual([])

        const missing = yield* controlPlane([])
        const run = yield* deploy(missing, { entry: null })

        expect(run).toMatchObject({ exitCode: 2, reason: "ContextInvalid" })
        expect(run.stderr).toContain(`No ${Cloud.SOURCE_ENTRY} in `)
        expect(missing.requests).toEqual([])
      }),
  )
})
