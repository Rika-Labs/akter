import * as Cloud from "@akter/cloud-api"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { runCliWith, scriptedFetch } from "../../testing.ts"
import { CLIENT_ID } from "./login.ts"

const API = "https://cloud.test"

const json = (status: number, body: Schema.Json) => Response.json(body, { status })

const parse = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(Effect.orDie)

/** The answers `/api/me` gives, encoded as the API encodes them. */
const answers = Effect.all({
  me: Schema.encodeEffect(Schema.toCodecJson(Cloud.Me))({
    user: {
      id: Cloud.UserId.make("usr_ada"),
      name: "Ada",
      email: Cloud.Email.make("ada@example.dev"),
      emailVerified: true,
      image: null,
    },
    identityKind: "session",
    activeOrganizationId: null,
    organizations: [],
  }),
  unauthorized: Schema.encodeEffect(Schema.toCodecJson(Cloud.Unauthorized))(
    Cloud.Unauthorized.make({ code: "invalid_credentials", message: "no" }),
  ),
}).pipe(Effect.orDie)

/**
 * The control plane's device authorization grant: a code that expires after
 * `expiresIn` seconds and asks for polls every `interval` seconds, then one
 * token answer per poll from `polls` (pending once they run out), then
 * `/api/me` for the granted token unless `meFails`. Each request's arrival is
 * recorded in milliseconds.
 */
const controlPlane = (
  polls: ReadonlyArray<Response>,
  options: {
    readonly interval?: number
    readonly expiresIn?: number
    readonly meFails?: boolean
  } = {},
) =>
  Effect.map(answers, ({ me, unauthorized }) => {
    const remaining = [...polls]
    const arrivals: Array<{ readonly path: string; readonly at: number }> = []

    const server = scriptedFetch((request) => {
      const path = new URL(request.url).pathname

      arrivals.push({ path, at: performance.now() })

      if (path === "/auth/device/code")
        return json(200, {
          device_code: "device-code-1",
          user_code: "WDJBMJHT",
          verification_uri: `${API}/device`,
          verification_uri_complete: `${API}/device?user_code=WDJBMJHT`,
          expires_in: options.expiresIn ?? 600,
          interval: options.interval ?? 0,
        })
      if (path === "/auth/device/token")
        return remaining.shift() ?? json(400, { error: "authorization_pending" })
      if (path === "/auth/sign-out") return json(200, { success: true })
      if (
        path === "/api/me" &&
        request.authorization === "Bearer granted-token" &&
        options.meFails !== true
      )
        return json(200, me)

      return json(401, unauthorized)
    })

    return { ...server, arrivals }
  })

const pending = () => json(400, { error: "authorization_pending" })

const granted = () =>
  json(200, { access_token: "granted-token", token_type: "Bearer", expires_in: 604800 })

/** Runs `akter login` against `fetch` with a fresh configuration directory, answering the run and what it stored. */
const login = (fetch: typeof globalThis.fetch, apiUrl = `${API}/`) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = `${yield* fs.makeTempDirectoryScoped()}/akter`
    const run = yield* runCliWith({ fetch, env: { AKTER_CONFIG_DIR: directory } })([
      "login",
      "--api-url",
      apiUrl,
    ])
    const file = `${directory}/credentials.json`
    const saved = yield* fs.exists(file)

    return { run, saved, stored: saved ? yield* parse(yield* fs.readFileString(file)) : undefined }
  })

const paths = (server: { readonly requests: ReadonlyArray<{ readonly url: string }> }) =>
  server.requests.map((request) => new URL(request.url).pathname)

layer(BunServices.layer, { excludeTestServices: true })("akter login", (it) => {
  it.effect(
    "uses the hosted default, lets the environment override it, and gives an explicit flag precedence",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        for (const [env, args, expected] of [
          [{}, [], "https://api.akter.dev/auth/device/code"],
          [
            { AKTER_API_URL: "http://localhost:3001" },
            [],
            "http://localhost:3001/auth/device/code",
          ],
          [
            { AKTER_API_URL: "https://unused.example.dev" },
            ["--api-url", "http://127.0.0.1:9"],
            "http://127.0.0.1:9/auth/device/code",
          ],
        ] as const) {
          const server = scriptedFetch(() => json(503, { error: "unavailable" }))
          const result = yield* runCliWith({
            fetch: server.fetch,
            env: { AKTER_CONFIG_DIR: directory, ...env },
          })(["login", ...args])
          expect(result.exitCode).not.toBe(0)
          expect(server.requests.map((request) => request.url)).toEqual([expected])
        }
      }),
  )
  it.effect(
    "prints the verification page and the code as XXXX-XXXX, then stores the session for whoever approved it",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane([pending(), granted()])
        const { run, saved, stored } = yield* login(server.fetch)

        expect(run).toMatchObject({ exitCode: 0, reason: "" })
        expect(run.stdout).toContain(`open ${API}/device\nand enter the code WDJB-MJHT.`)
        expect(run.stdout).not.toContain("user_code=")
        expect(run.stdout).toContain(`Logged in to ${API} as ada@example.dev`)
        expect(run.stdout).not.toContain("granted-token")
        expect(saved).toBe(true)
        expect(stored).toEqual({ apiUrl: API, token: "granted-token", email: "ada@example.dev" })
        expect(paths(server)).toEqual([
          "/auth/device/code",
          "/auth/device/token",
          "/auth/device/token",
          "/api/me",
        ])
        expect(yield* parse(server.requests[0]!.body)).toEqual({ client_id: CLIENT_ID })
        expect(yield* parse(server.requests[1]!.body)).toEqual({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device-code-1",
          client_id: CLIENT_ID,
        })
        expect(server.requests.at(-1)!.authorization).toBe("Bearer granted-token")
      }),
  )

  it.effect(
    "polls at the interval the control plane names, and five seconds slower than that after slow_down",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane(
          [pending(), json(400, { error: "slow_down" }), granted()],
          {
            interval: 1,
          },
        )
        const { run } = yield* login(server.fetch)
        const polls = server.arrivals
          .filter((arrival) => arrival.path !== "/api/me")
          .map((arrival) => arrival.at)
        const gaps = polls.slice(1).map((at, index) => at - polls[index]!)

        expect(run.exitCode).toBe(0)
        expect(gaps).toHaveLength(3)
        expect(gaps[0]).toBeGreaterThanOrEqual(990)
        expect(gaps[1]).toBeLessThan(2_500)
        expect(
          gaps[2],
          "the interval after slow_down is the named one plus five seconds",
        ).toBeGreaterThanOrEqual(5_990)
      }),
    20_000,
  )

  it.effect(
    "gives up with exit 1 when its own deadline passes, even though the server never answers expired_token",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane([], { interval: 1, expiresIn: 2 })
        const { run, saved } = yield* login(server.fetch)
        const polls = paths(server).filter((path) => path === "/auth/device/token")

        expect(run).toMatchObject({ exitCode: 1, reason: "LoginExpired" })
        expect(run.stderr).toContain("expired before it was approved")
        expect(polls.length).toBeGreaterThanOrEqual(1)
        expect(polls.length).toBeLessThanOrEqual(2)
        expect(saved).toBe(false)
      }),
    10_000,
  )

  it.effect(
    "revokes the granted session and stores nothing when it cannot read who it belongs to",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane([granted()], { meFails: true })
        const { run, saved } = yield* login(server.fetch)

        expect(run).toMatchObject({ exitCode: 1, reason: "Unauthorized" })
        expect(saved).toBe(false)
        expect(paths(server).slice(-2)).toEqual(["/api/me", "/auth/sign-out"])
        expect(server.requests.at(-1)!.authorization).toBe("Bearer granted-token")
      }),
  )

  it.effect("ends with exit 1 and stores nothing when the approval is denied", () =>
    Effect.gen(function* () {
      const { run, saved } = yield* login(
        (yield* controlPlane([pending(), json(400, { error: "access_denied" })])).fetch,
      )

      expect(run).toMatchObject({ exitCode: 1, reason: "LoginDenied" })
      expect(run.stderr).toContain("denied in the browser")
      expect(saved).toBe(false)
    }),
  )

  it.effect("ends with exit 1 and stores nothing when the server says the code expired", () =>
    Effect.gen(function* () {
      const { run, saved } = yield* login(
        (yield* controlPlane([pending(), json(400, { error: "expired_token" })])).fetch,
      )

      expect(run).toMatchObject({ exitCode: 1, reason: "LoginExpired" })
      expect(saved).toBe(false)
    }),
  )

  it.effect("names the control plane's own refusal of the grant", () =>
    Effect.gen(function* () {
      const { run, saved } = yield* login(
        (yield* controlPlane([json(400, { error: "invalid_grant" })])).fetch,
      )

      expect(run).toMatchObject({ exitCode: 1, reason: "LoginRefused" })
      expect(run.stderr).toContain("invalid_grant (400)")
      expect(saved).toBe(false)
    }),
  )

  it.effect(
    "refuses a control plane reached over plain HTTP anywhere but this machine, before sending anything",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane([granted()])

        for (const apiUrl of [
          "http://cloud.test",
          "http://10.0.0.5:3001",
          "http://localhost.evil.test",
          "ftp://cloud.test",
          "https://user:pass@cloud.test",
        ]) {
          const { run, saved } = yield* login(server.fetch, apiUrl)

          expect(run, apiUrl).toMatchObject({ exitCode: 2, reason: "InvalidValue" })
          expect(run.stderr).toContain("an https URL, or http on a loopback host")
          expect(saved).toBe(false)
        }

        expect(server.requests).toEqual([])

        for (const apiUrl of [
          "http://localhost:3001",
          "http://127.0.0.1:4100/",
          "http://[::1]:3001",
        ]) {
          const accepted = yield* controlPlane([granted()])
          const { run } = yield* login(accepted.fetch, apiUrl)

          expect(run, apiUrl).toMatchObject({ exitCode: 0 })
          expect(accepted.requests[0]!.url).toBe(`${apiUrl.replace(/\/$/u, "")}/auth/device/code`)
        }
      }),
  )

  it.effect("reports an unreachable control plane as a usage error", () =>
    Effect.gen(function* () {
      const unreachable = scriptedFetch(() => {
        throw new TypeError("connection refused")
      })
      const { run, saved } = yield* login(unreachable.fetch)

      expect(run).toMatchObject({ exitCode: 2, reason: "Unreachable" })
      expect(saved).toBe(false)
    }),
  )
})
