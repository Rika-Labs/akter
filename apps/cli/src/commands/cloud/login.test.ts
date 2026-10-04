import * as Cloud from "@akter/cloud-api"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Clock, Effect, FileSystem, Schema } from "effect"
import { runCliWith, scriptedFetch } from "../../testing.ts"
import { CLIENT_ID } from "./login.ts"

const API = "http://cloud.test"

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
 * The control plane's device authorization grant: a code, then one token
 * answer per poll from `polls`, then `/api/me` for the granted token only.
 */
const controlPlane = (polls: ReadonlyArray<Response>) =>
  Effect.map(answers, ({ me, unauthorized }) => {
    const remaining = [...polls]

    return scriptedFetch((request) => {
      const path = new URL(request.url).pathname

      if (path === "/auth/device/code")
        return json(200, {
          device_code: "device-code-1",
          user_code: "WDJB-MJHT",
          verification_uri: `${API}/device`,
          verification_uri_complete: `${API}/device?user_code=WDJB-MJHT`,
          expires_in: 600,
          interval: 0,
        })
      if (path === "/auth/device/token")
        return remaining.shift() ?? json(400, { error: "invalid_grant" })
      if (path === "/api/me" && request.authorization === "Bearer granted-token")
        return json(200, me)

      return json(401, unauthorized)
    })
  })

const pending = () => json(400, { error: "authorization_pending" })

/** Runs `durable login` against `fetch` with a fresh configuration directory, answering the run and what it stored. */
const login = (fetch: typeof globalThis.fetch) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = `${yield* fs.makeTempDirectoryScoped()}/akter`
    const run = yield* runCliWith({ fetch, env: { AKTER_CONFIG_DIR: directory } })([
      "login",
      "--api-url",
      `${API}/`,
    ])
    const file = `${directory}/credentials.json`
    const saved = yield* fs.exists(file)

    return { run, saved, stored: saved ? yield* parse(yield* fs.readFileString(file)) : undefined }
  })

layer(BunServices.layer, { excludeTestServices: true })("durable login", (it) => {
  it.effect(
    "polls the device grant past pending and slow_down answers, then stores the session for whoever approved it",
    () =>
      Effect.gen(function* () {
        const server = yield* controlPlane([
          pending(),
          json(400, { error: "slow_down" }),
          pending(),
          json(200, { access_token: "granted-token", token_type: "Bearer", expires_in: 604800 }),
        ])
        const started = yield* Clock.currentTimeMillis
        const { run, saved, stored } = yield* login(server.fetch)

        expect(run.reason).toBe("")
        expect(run.exitCode).toBe(0)
        expect(run.stdout).toContain(`open ${API}/device?user_code=WDJB-MJHT`)
        expect(run.stdout).toContain("confirm the code WDJB-MJHT")
        expect(run.stdout).toContain(`Logged in to ${API} as ada@example.dev`)
        expect(run.stdout).not.toContain("granted-token")
        expect(saved).toBe(true)
        expect(stored).toEqual({ apiUrl: API, token: "granted-token", email: "ada@example.dev" })
        expect(
          (yield* Clock.currentTimeMillis) - started,
          "slow_down adds five seconds to every later poll",
        ).toBeGreaterThanOrEqual(10_000)
        expect(server.requests.map((request) => new URL(request.url).pathname)).toEqual([
          "/auth/device/code",
          "/auth/device/token",
          "/auth/device/token",
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
    20_000,
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

  it.effect(
    "ends with exit 1 and stores nothing when the code expires before anyone approves it",
    () =>
      Effect.gen(function* () {
        const { run, saved } = yield* login(
          (yield* controlPlane([pending(), json(400, { error: "expired_token" })])).fetch,
        )

        expect(run).toMatchObject({ exitCode: 1, reason: "LoginExpired" })
        expect(run.stderr).toContain("expired before it was approved")
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
