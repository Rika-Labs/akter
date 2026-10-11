import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import * as Cloud from "@akter/cloud-api"
import { Clock, Effect, Fiber, Schedule, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { configDirectory, runCliWith, startCliWith } from "../../testing.ts"

const baseFetch = globalThis.fetch.bind(globalThis)

const line = (id: string, text: string) => ({
  id,
  deploymentId: "deployment-a",
  runnerId: "runner-west",
  at: "2026-10-07T01:02:03.000Z",
  stream: "stderr",
  text,
  clipped: false,
})

/** Real HTTP requests prove contract encoding, authentication, scope and interrupted response handling together. */
const serverWith = (
  respond: (request: Request, restart: () => Promise<void>) => Response | Promise<Response>,
) =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context())
    const serve = (port: number): Bun.Server<undefined> =>
      Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => respond(request, restart) })
    let server = serve(0)
    const restart = () =>
      run(
        Effect.gen(function* () {
          const port = server.port!
          yield* Effect.promise(() => server.stop(true))
          yield* Effect.sleep("100 millis")
          server = serve(port)
        }),
      )
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
    return server
  })

layer(BunServices.layer, { excludeTestServices: true })("akter logs over real HTTP", (it) => {
  it.effect(
    "uses bounded recent reads and both resource paths, refusing invalid flags before HTTP",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ url: string; authorization: string | null }> = []
        const server = yield* serverWith((request) => {
          requests.push({ url: request.url, authorization: request.headers.get("authorization") })
          return Response.json({
            lines: [line("first", "\u001b[31mrecent-marker\u001b[0m\u2028forged\u2029line")],
            cursor: "after-first",
            more: false,
          })
        })
        const directory = yield* configDirectory({
          apiUrl: `http://127.0.0.1:${server.port}`,
          token: "local-session",
          email: "owner@example.test",
        })
        const run = runCliWith({ env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" } })
        const recent = yield* run(["logs", "--env", "staging", "--since", "47", "--limit", "3"])
        expect(recent, `${recent.reason}: ${recent.stderr}`).toMatchObject({ exitCode: 0 })
        expect(recent.stdout).toBe(
          "2026-10-07T01:02:03.000Z\trunner-west\tstderr\trecent-marker�forged�line\n",
        )
        expect(requests[0]?.authorization).toBe("Bearer local-session")
        const url = new URL(requests[0]!.url)
        expect(url.pathname).toBe("/api/projects/project-a/environments/staging/logs")
        expect(url.searchParams.get("limit")).toBe("3")
        expect(url.searchParams.get("wait")).toBe("0")
        const age = (yield* Clock.currentTimeMillis) - Date.parse(url.searchParams.get("since")!)
        expect(age).toBeGreaterThanOrEqual(47000)
        expect(age).toBeLessThan(49000)
        const deployment = yield* run(["logs", "--deployment", "deployment-a"])
        expect(deployment.exitCode).toBe(0)
        expect(new URL(requests[1]!.url).pathname).toBe(
          "/api/projects/project-a/deployments/deployment-a/logs",
        )
        for (const args of [
          ["--limit", "201"],
          ["--since", "3601"],
          ["--since", "0"],
        ])
          expect((yield* run(["logs", ...args])).exitCode).toBe(2)
        expect(requests).toHaveLength(2)
      }),
  )

  it.effect(
    "drains every recent page exactly once and reports clipped text independently of more",
    () =>
      Effect.gen(function* () {
        const requests: string[] = []
        const server = yield* serverWith((request) => {
          requests.push(request.url)
          const cursor = new URL(request.url).searchParams.get("cursor")
          if (cursor === null)
            return Response.json({
              lines: [line("one", "old-marker")],
              cursor: "page-two",
              more: true,
            })
          if (cursor === "page-two")
            return Response.json({
              lines: [{ ...line("two", "clipped-marker"), clipped: true }],
              cursor: "page-three",
              more: true,
            })
          return Response.json({
            lines: [line("three", "new-marker")],
            cursor: "done",
            more: false,
          })
        })
        const directory = yield* configDirectory({
          apiUrl: `http://127.0.0.1:${server.port}`,
          token: "local-session",
          email: "owner@example.test",
        })
        const result = yield* runCliWith({
          env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" },
        })(["logs", "--since", "3600", "--limit", "1"])
        expect(result.exitCode).toBe(0)
        expect(requests).toHaveLength(3)
        const url = new URL(requests[0]!)
        expect(url.searchParams.get("cursor")).toBeNull()
        expect(requests.map((url) => new URL(url).searchParams.get("cursor"))).toEqual([
          null,
          "page-two",
          "page-three",
        ])
        expect(requests.map((url) => new URL(url).searchParams.get("wait"))).toEqual([
          "0",
          "0",
          "0",
        ])
        expect(result.stdout).toBe(
          "2026-10-07T01:02:03.000Z\trunner-west\tstderr\told-marker\n2026-10-07T01:02:03.000Z\trunner-west\tstderr\tclipped-marker …\n2026-10-07T01:02:03.000Z\trunner-west\tstderr\tnew-marker\n",
        )
        expect(result.stderr).toBe("")
      }),
  )

  it.effect(
    "retries one typed provider outage while following, without reprinting acknowledged output",
    () =>
      Effect.gen(function* () {
        const cursors: Array<string | null> = []
        let unavailable = true
        const server = yield* serverWith((request) => {
          const cursor = new URL(request.url).searchParams.get("cursor")
          cursors.push(cursor)
          if (cursor === null)
            return Response.json({
              lines: [line("before", "before-outage")],
              cursor: "before",
              more: false,
            })
          if (unavailable) {
            unavailable = false
            return Response.json(
              Cloud.Unavailable.make({ message: "Provider unavailable", retryAfterSeconds: 2 }),
              { status: 503 },
            )
          }
          if (cursor === "before")
            return Response.json({
              lines: [line("after", "after-outage")],
              cursor: "after",
              more: false,
            })
          return Response.json({ lines: [], cursor: "after", more: false })
        })
        const directory = yield* configDirectory({
          apiUrl: `http://127.0.0.1:${server.port}`,
          token: "local-session",
          email: "owner@example.test",
        })
        const { fiber, printed } = yield* startCliWith({
          env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" },
        })(["logs", "--follow"])
        yield* Effect.suspend(() =>
          printed.stdout.includes("after-outage")
            ? Effect.void
            : Effect.fail("Waiting after provider outage"),
        ).pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }))
        expect(cursors.slice(0, 3)).toEqual([null, "before", "before"])
        expect(printed.stdout.match(/before-outage/gu)).toHaveLength(1)
        expect(printed.stdout.match(/after-outage/gu)).toHaveLength(1)
        yield* Fiber.interrupt(fiber)
      }),
  )

  it.effect(
    "resumes the last cursor after a dropped response and cancels an outstanding follow poll",
    () =>
      Effect.gen(function* () {
        const cursors: Array<string | null> = []
        let dropped = false
        const outstanding = Promise.withResolvers<Response>()
        const requests: Array<{ signal: AbortSignal | null | undefined; settled: boolean }> = []
        const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          const request = { signal: init?.signal, settled: false }
          requests.push(request)
          return baseFetch(input, init).finally(() => {
            request.settled = true
          })
        }) as typeof globalThis.fetch
        const server = yield* serverWith((request, restart) => {
          const cursor = new URL(request.url).searchParams.get("cursor")
          cursors.push(cursor)
          if (cursor === null)
            return Response.json({
              lines: [line("one", "first-marker")],
              cursor: "resume-one",
              more: false,
            })
          if (!dropped) {
            dropped = true
            return restart().then(() =>
              Response.json({ lines: [], cursor: "unacknowledged", more: false }),
            )
          }
          if (cursor === "resume-one")
            return Response.json({
              lines: [line("two", "second-marker")],
              cursor: "resume-two",
              more: false,
            })
          return outstanding.promise
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            outstanding.resolve(Response.json({ lines: [], cursor: "resume-two", more: false })),
          ),
        )
        const directory = yield* configDirectory({
          apiUrl: `http://127.0.0.1:${server.port}`,
          token: "local-session",
          email: "owner@example.test",
        })
        const { fiber, printed } = yield* startCliWith({
          fetch,
          env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" },
        })(["logs", "--follow"])
        yield* Effect.suspend(() =>
          printed.stdout.includes("second-marker")
            ? Effect.void
            : Effect.fail(`Waiting for resumed line: ${printed.stderr}`),
        ).pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }))
        expect(cursors.slice(0, 3)).toEqual([null, "resume-one", "resume-one"])
        expect(printed.stdout.match(/first-marker/gu)).toHaveLength(1)
        expect(printed.stdout.match(/second-marker/gu)).toHaveLength(1)
        expect(printed.stderr).toContain("reconnecting from the last cursor")
        yield* Effect.suspend(() =>
          cursors.length === 4 ? Effect.void : Effect.fail("Waiting for outstanding follow poll"),
        ).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }))
        expect(cursors[3]).toBe("resume-two")
        expect(requests).toHaveLength(4)
        expect(requests[3]!.settled).toBe(false)
        yield* Fiber.interrupt(fiber)
        expect(requests[3]!.signal?.aborted).toBe(true)
        yield* Effect.suspend(() =>
          requests[3]!.settled ? Effect.void : Effect.fail("Waiting for cancelled fetch to settle"),
        ).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }))
        const count = cursors.length
        yield* Effect.sleep("1100 millis")
        expect(cursors).toHaveLength(count)
        expect(requests).toHaveLength(count)
      }),
  )

  it.effect("exits on SIGINT without leaving a follower issuing requests", () =>
    Effect.gen(function* () {
      let requests = 0
      const server = yield* serverWith(() => {
        requests += 1
        return Response.json({
          lines: [line(`signal-${requests}`, "signal-marker")],
          cursor: `signal-${requests}`,
          more: false,
        })
      })
      const directory = yield* configDirectory({
        apiUrl: `http://127.0.0.1:${server.port}`,
        token: "local-session",
        email: "owner@example.test",
      })
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "bun",
          [new URL("../../main.ts", import.meta.url).pathname, "logs", "--follow"],
          { env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" }, extendEnv: true },
        ),
      )
      const printed = { stdout: "", stderr: "" }
      const output = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText,
            Stream.runForEach((text) =>
              Effect.sync(() => {
                printed.stdout += text
              }),
            ),
          ),
          handle.stderr.pipe(
            Stream.decodeText,
            Stream.runForEach((text) =>
              Effect.sync(() => {
                printed.stderr += text
              }),
            ),
          ),
        ],
        { concurrency: 2 },
      ).pipe(Effect.forkScoped)
      yield* Effect.suspend(() =>
        printed.stdout.includes("signal-marker")
          ? Effect.void
          : Effect.fail("Waiting for first printed child line"),
      ).pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }))
      yield* handle.kill({ killSignal: "SIGINT" })
      expect(Number(yield* handle.exitCode)).toBe(130)
      yield* Fiber.join(output)
      expect(printed.stdout).toContain("signal-marker")
      expect(printed.stderr).not.toContain("ERROR")
      const count = requests
      yield* Effect.sleep("1100 millis")
      expect(requests).toBe(count)
    }),
  )

  it.effect(
    "does not reconnect after an authorization refusal or print its response body as logs",
    () =>
      Effect.gen(function* () {
        let requests = 0
        const server = yield* serverWith(() => {
          requests += 1
          return Response.json(Cloud.Forbidden.make({ message: "Project access is denied" }), {
            status: 403,
          })
        })
        const directory = yield* configDirectory({
          apiUrl: `http://127.0.0.1:${server.port}`,
          token: "local-session",
          email: "owner@example.test",
        })
        const denied = yield* runCliWith({
          env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" },
        })(["logs", "--follow"])
        expect(denied).toMatchObject({ exitCode: 1, reason: "Forbidden", stdout: "" })
        expect(requests).toBe(1)
        for (const [status, error, reason] of [
          [404, Cloud.NotFound.make({ resource: "cursor", id: "expired" }), "NotFound"],
          [501, Cloud.NotImplemented.make({ operation: "logs" }), "NotImplemented"],
        ] as const) {
          let refusedRequests = 0
          const refusedServer = yield* serverWith(() => {
            refusedRequests += 1
            return Response.json(error, { status })
          })
          const refusedDirectory = yield* configDirectory({
            apiUrl: `http://127.0.0.1:${refusedServer.port}`,
            token: "local-session",
            email: "owner@example.test",
          })
          const refused = yield* runCliWith({
            env: { AKTER_CONFIG_DIR: refusedDirectory, AKTER_PROJECT: "project-a" },
          })(["logs", "--follow"])
          expect(refused).toMatchObject({ exitCode: 1, reason, stdout: "" })
          expect(refusedRequests).toBe(1)
        }
      }),
  )
})
