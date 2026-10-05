import { expect, it } from "@effect/vitest"
import { Context, Crypto, Effect, Layer } from "effect"
import { RunnerNotFound, RunnerPlatform, RunnerPlatformError, startToken } from "./contract.ts"
import { flyRunners, type FlyOptions } from "./fly.ts"
import { creates, flyClient, flyFake, FLY_TOKEN, type FlyScript } from "./fly-fake.ts"

const prefix = "akter-pr-12-run-"
const acme = "akter-pr-12-run-958512cc237ea2"
const globex = "akter-pr-12-run-04889e1207f479"

const options = {
  organization: "rika-labs-test",
  regions: {
    "us-east-1": { region: "iad", fallbackRegions: ["ord"] },
    "us-west-2": { region: "sjc" },
  },
  appPrefix: prefix,
  port: 8080,
  guest: { cpuKind: "shared", cpus: 1, memoryMb: 512 },
  basePath: "/api",
} as const satisfies FlyOptions

const digest = (letter: string) => `registry.fly.io/akter-images@sha256:${letter.repeat(64)}`

const request = {
  deploymentId: "acme",
  region: "us-east-1",
  image: digest("a"),
  environment: { DATABASE_URL: "postgres://u:p@db/x?a=b&c=d", PLAIN: "two words" },
  idempotencyKey: "01JABC.5.start",
}

const harness = (script: FlyScript = {}, overrides: Partial<FlyOptions> = {}) =>
  Effect.gen(function* () {
    const fake = yield* flyFake(script)
    const context = yield* Layer.build(
      flyRunners({ ...options, ...overrides }).pipe(Layer.provideMerge(flyClient(fake.url))),
    )

    return {
      ...fake,
      platform: Context.get(context, RunnerPlatform),
      token: (input: Parameters<typeof startToken>[0]) =>
        startToken(input).pipe(
          Effect.provideService(Crypto.Crypto, Context.get(context, Crypto.Crypto)),
        ),
    }
  })

const routes = (calls: ReadonlyArray<{ readonly method: string; readonly path: string }>) =>
  calls.map((call) => `${call.method} ${call.path}`)

it.effect(
  "starts a machine in the deployment's own app on a network of its own, with public addresses and the snapshot",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, apps, platform, token } = yield* harness()

        const started = yield* platform.start(request)

        const name = `run-${(yield* token(request)).slice(0, 32)}`

        expect(started).toEqual({
          id: `${acme}/${apps.get(acme)?.machines[0]?.id}`,
          state: "starting",
          url: `https://${acme}.fly.dev`,
          basePath: "/api",
        })
        expect(acme).toHaveLength(30)
        expect(routes(calls)).toEqual([
          `GET /v1/apps/${acme}`,
          "POST /v1/apps",
          `GET /v1/apps/${acme}`,
          `GET /v1/apps/${acme}/ip_assignments`,
          `POST /v1/apps/${acme}/ip_assignments`,
          `POST /v1/apps/${acme}/ip_assignments`,
          `GET /v1/apps/${acme}/machines`,
          `POST /v1/apps/${acme}/machines`,
        ])
        for (const call of calls) expect(call.authorization).toBe(`Bearer ${FLY_TOKEN}`)
        expect(calls[1]?.body).toEqual({
          name: acme,
          org_slug: "rika-labs-test",
          network: acme,
          idempotency_key: "958512cc237ea285b0b6ca2a57f53ea6",
        })
        expect(calls.slice(4, 6).map((call) => call.body)).toEqual([
          { type: "shared_v4" },
          { type: "v6" },
        ])
        expect(calls[7]?.body).toEqual({
          name,
          region: "iad",
          config: {
            image: request.image,
            env: request.environment,
            guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
            restart: { policy: "no" },
            stop_config: { signal: "SIGTERM", timeout: "30s" },
            metadata: { "akter.deployment": "acme", "akter.region": "us-east-1" },
            services: [
              {
                protocol: "tcp",
                internal_port: 8080,
                autostart: false,
                autostop: "off",
                concurrency: { type: "connections", soft_limit: 1000, hard_limit: 2000 },
                ports: [
                  { port: 443, handlers: ["tls", "http"] },
                  { port: 80, handlers: ["http"], force_https: true },
                ],
              },
            ],
          },
        })
      }),
    ),
)

it.effect(
  "keeps one app per deployment and one machine per start key, and gives another deployment its own app",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, apps, platform, token } = yield* harness()

        const first = yield* platform.start(request)
        const again = yield* platform.start(request)
        const replacement = yield* platform.start({ ...request, idempotencyKey: "01JABC.6.start" })
        const other = yield* platform.start({ ...request, deploymentId: "globex" })

        expect(again).toEqual(first)
        expect(replacement.id).not.toBe(first.id)
        expect(replacement.id.startsWith(`${acme}/`)).toBe(true)
        expect(other.id.startsWith(`${globex}/`)).toBe(true)
        expect([...apps.keys()]).toEqual([acme, globex])
        expect(apps.get(acme)?.machines.map((machine) => machine.name)).toEqual([
          `run-${(yield* token(request)).slice(0, 32)}`,
          `run-${(yield* token({ ...request, idempotencyKey: "01JABC.6.start" })).slice(0, 32)}`,
        ])
        expect(calls.filter((call) => call.path === "/v1/apps")).toHaveLength(2)
        expect(creates(calls)).toHaveLength(3)
        expect(apps.get(acme)?.addresses).toHaveLength(2)
      }),
    ),
)

it.effect("returns the machine a racing start created instead of creating a second one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { calls, seed, platform, token } = yield* harness({ staleList: true })
      const app = seed(acme)
      const name = `run-${(yield* token(request)).slice(0, 32)}`

      app.machines.push({
        id: "d8000000000099",
        name,
        region: "iad",
        state: "started",
        config: { metadata: { "akter.deployment": "acme" } },
        events: [],
        stopping: 0,
      })

      const started = yield* platform.start(request)

      expect(started).toEqual({
        id: `${acme}/d8000000000099`,
        state: "running",
        url: `https://${acme}.fly.dev`,
        basePath: "/api",
      })
      expect(app.machines).toHaveLength(1)
      expect(creates(calls)).toHaveLength(1)
    }),
  ),
)

it.effect(
  "refuses an app whose machines belong to another deployment or that lives in another organization",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, seed, platform } = yield* harness()
        const squatted = seed(acme, { organization: "someone-else" })

        const foreign = yield* Effect.flip(platform.start(request))

        expect(foreign).toMatchObject({ code: "refused" })
        expect(calls.some((call) => call.method === "POST")).toBe(false)

        const app = seed(acme)

        app.machines.push({
          id: "d8000000000001",
          name: "run-other",
          region: "iad",
          state: "started",
          config: { metadata: { "akter.deployment": "globex" } },
          events: [],
          stopping: 0,
        })

        const shared = yield* Effect.flip(platform.start(request))

        expect(shared).toMatchObject({ code: "refused" })
        expect(squatted.machines).toHaveLength(0)
        expect(app.machines).toHaveLength(1)
        expect(creates(calls)).toHaveLength(0)
      }),
    ),
)

it.effect(
  "reports a machine's state by what Fly observed: a stop request is not a stop, and only an observed exit is a termination",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { apps, platform } = yield* harness()
        const started = yield* platform.start(request)
        const machine = apps.get(acme)!.machines[0]!
        const origin = `https://${acme}.fly.dev`
        const base = { id: started.id, basePath: "/api" }

        const observe = (state: string) =>
          Effect.sync(() => {
            machine.state = state
          }).pipe(Effect.andThen(platform.describe(started.id)))

        expect(yield* observe("created")).toEqual({ ...base, state: "starting", url: origin })
        expect(yield* observe("starting")).toEqual({ ...base, state: "starting", url: origin })
        expect(yield* observe("started")).toEqual({ ...base, state: "running", url: origin })
        expect(yield* observe("replacing")).toEqual({ ...base, state: "starting", url: origin })
        for (const state of ["stopping", "suspending", "stopped", "suspended", "destroying"])
          expect(yield* observe(state)).toEqual({ ...base, state: "stopped", url: null })

        machine.events = [
          {
            type: "exit",
            timestamp: 5,
            request: { exit_event: { exit_code: 0, requested_stop: true } },
          },
        ]

        expect(yield* observe("started")).toEqual({ ...base, state: "running", url: origin })
        expect(yield* observe("stopping")).toEqual({
          ...base,
          state: "stopped",
          url: null,
          terminated: true,
        })
        expect(yield* observe("stopped")).toEqual({
          ...base,
          state: "stopped",
          url: null,
          terminated: true,
        })
        expect(yield* observe("started")).toEqual({ ...base, state: "running", url: origin })
      }),
    ),
)

it.live(
  "drains a started machine, returns only once Fly reports it stopped, and then destroys it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, apps, platform } = yield* harness()
        const started = yield* platform.start(request)
        const machine = apps.get(acme)!.machines[0]!
        const path = `/v1/apps/${acme}/machines/${machine.id}`

        machine.state = "started"
        calls.length = 0

        yield* platform.stop(started.id)

        const sequence = routes(calls)
        const stopAt = sequence.indexOf(`POST ${path}/stop`)
        const deleteAt = sequence.indexOf(`DELETE ${path}`)

        expect(calls[stopAt]?.body).toEqual({ signal: "SIGTERM", timeout: "30s" })
        expect(sequence.slice(stopAt + 1, deleteAt)).toEqual([`GET ${path}`, `GET ${path}`])
        expect(deleteAt).toBe(sequence.length - 1)
        expect(calls[deleteAt]?.query).toEqual({ force: "false" })
        expect(apps.get(acme)?.machines).toHaveLength(0)
        expect(yield* Effect.flip(platform.describe(started.id))).toEqual(
          RunnerNotFound.make({ id: started.id }),
        )
      }),
    ),
)

it.live(
  "destroys a machine that never started without draining it, and a stopped one without stopping it again",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, apps, platform } = yield* harness()
        const first = yield* platform.start(request)
        const second = yield* platform.start({ ...request, idempotencyKey: "01JABC.6.start" })
        const [booting, finished] = apps.get(acme)!.machines

        booting!.state = "starting"
        finished!.state = "stopped"
        calls.length = 0

        yield* platform.stop(first.id)
        yield* platform.stop(second.id)

        expect(routes(calls)).toEqual([
          `GET /v1/apps/${acme}/machines/${booting!.id}`,
          `DELETE /v1/apps/${acme}/machines/${booting!.id}`,
          `GET /v1/apps/${acme}/machines/${finished!.id}`,
          `GET /v1/apps/${acme}/machines/${finished!.id}`,
          `DELETE /v1/apps/${acme}/machines/${finished!.id}`,
        ])
        expect(calls[1]?.query).toEqual({ force: "true" })
        expect(calls[4]?.query).toEqual({ force: "false" })
        expect(apps.get(acme)?.machines).toHaveLength(0)
      }),
    ),
)

it.effect(
  "reports a missing machine, and refuses ids outside the configured apps and invalid starts without calling Fly",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, platform } = yield* harness()
        const missing = `${acme}/d8000000000042`

        expect(yield* Effect.flip(platform.describe(missing))).toEqual(
          RunnerNotFound.make({ id: missing }),
        )
        expect(yield* Effect.flip(platform.stop(missing))).toEqual(
          RunnerNotFound.make({ id: missing }),
        )

        const before = calls.length

        for (const id of [
          "someone-elses-app/d8000000000042",
          `${acme}/d8000000000042/extra`,
          `${acme}/../apps`,
          `${acme}/D8000000000042`,
          acme,
          "",
        ]) {
          expect(yield* Effect.flip(platform.describe(id))).toEqual(RunnerNotFound.make({ id }))
          expect(yield* Effect.flip(platform.stop(id))).toEqual(RunnerNotFound.make({ id }))
        }

        const refusals = [
          yield* Effect.flip(platform.start({ ...request, region: "eu-west-1" })),
          yield* Effect.flip(platform.start({ ...request, region: "constructor" })),
          yield* Effect.flip(platform.start({ ...request, environment: { "BAD NAME": "x" } })),
          yield* Effect.flip(platform.start({ ...request, image: "registry.fly.io/akter:latest" })),
          yield* Effect.flip(
            platform.start({ ...request, image: `ghcr.io/x/y@sha256:${"a".repeat(64)}` }),
          ),
          yield* Effect.flip(
            platform.start({ ...request, image: `docker.io/library/bun@sha256:${"a".repeat(64)}` }),
          ),
        ]

        expect(refusals.map((refusal) => refusal.code)).toEqual([
          "unknown-region",
          "unknown-region",
          "invalid-input",
          "invalid-input",
          "invalid-input",
          "invalid-input",
        ])
        expect(calls).toHaveLength(before)
      }),
    ),
)

it.effect(
  "names a failure by fixed code and Fly's error name, never by what Fly echoed or the token",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = request.environment.DATABASE_URL
        let reply = {
          status: 403,
          body: { error: `token ${FLY_TOKEN} may not create machines with env ${secret}` },
        }
        const { platform, apps } = yield* harness({
          override: (call) =>
            call.method === "POST" && call.path.endsWith("/machines") ? reply : undefined,
        })

        const forbidden = yield* Effect.flip(platform.start(request))
        reply = { status: 503, body: { error: `upstream said ${secret}` } }
        const unavailable = yield* Effect.flip(platform.start(request))
        reply = { status: 400, body: { error: `bad config ${secret}` } }
        const rejected = yield* Effect.flip(platform.start(request))

        expect(forbidden).toEqual(
          RunnerPlatformError.make({
            operation: "start",
            code: "refused",
            message: "the platform refused the request (Forbidden)",
          }),
        )
        expect(unavailable).toEqual(
          RunnerPlatformError.make({
            operation: "start",
            code: "unavailable",
            message: "the platform could not be reached (ServiceUnavailable)",
          }),
        )
        expect(rejected).toMatchObject({ code: "refused" })
        expect(apps.get(acme)?.machines).toHaveLength(0)

        for (const error of [forbidden, unavailable, rejected])
          expect(`${error._tag} ${error.message}`).not.toMatch(/postgres:|fly-test-token/u)
      }),
    ),
)

it.effect("places the machine in the next allowed region when Fly has no capacity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { calls, apps, platform } = yield* harness({ noCapacity: ["iad"] })

      const started = yield* platform.start(request)

      expect(creates(calls).map((create) => create.region)).toEqual(["iad", "ord"])
      expect(apps.get(acme)?.machines.map((machine) => machine.region)).toEqual(["ord"])
      expect(started.state).toBe("starting")
    }),
  ),
)

for (const status of [412, 422] as const)
  it.effect(
    `fails with the transient capacity code, leaving no machine, when no allowed region has room (${status})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { calls, apps, platform } = yield* harness({
            noCapacity: ["iad", "ord", "sjc"],
            capacityStatus: status,
          })

          const everywhere = yield* Effect.flip(platform.start(request))
          const single = yield* Effect.flip(platform.start({ ...request, region: "us-west-2" }))

          expect(everywhere).toEqual(
            RunnerPlatformError.make({
              operation: "start",
              code: "capacity",
              message: "the platform has no capacity for the runner in an allowed region",
            }),
          )
          expect(single).toMatchObject({ code: "capacity" })
          expect(creates(calls).map((create) => create.region)).toEqual(["iad", "ord", "sjc"])
          expect(apps.get(acme)?.machines).toHaveLength(0)
        }),
      ),
  )

it.effect("runs a one-shot machine with the command and no public service or addresses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { calls, apps, platform } = yield* harness({}, { command: ["bun", "run", "migrate"] })

      const started = yield* platform.start(request)

      const config = creates(calls)[0]?.config

      expect(started).toEqual({
        id: `${acme}/${apps.get(acme)?.machines[0]?.id}`,
        state: "starting",
        url: null,
        basePath: "/api",
      })
      expect(config?.init).toEqual({ cmd: ["bun", "run", "migrate"] })
      expect(config?.services).toBeUndefined()
      expect(config?.restart).toEqual({ policy: "no" })
      expect(calls.some((call) => call.path.endsWith("/ip_assignments"))).toBe(false)
    }),
  ),
)
