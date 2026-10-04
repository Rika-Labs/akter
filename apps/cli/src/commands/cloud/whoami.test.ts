import * as Cloud from "@akter/cloud-api"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { DateTime, Effect, FileSystem, type PlatformError, Schema } from "effect"
import { configDirectory, runCliWith, scriptedFetch } from "../../testing.ts"

const credentials = { apiUrl: "http://cloud.test", token: "stored-token", email: "ada@example.dev" }

/** The answers `/api/me` gives, encoded as the API encodes them. */
const answers = Effect.all({
  unauthorized: Schema.encodeEffect(Schema.toCodecJson(Cloud.Unauthorized))(
    Cloud.Unauthorized.make({
      code: "missing_credentials",
      message: "A verified session is required",
    }),
  ),
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
    organizations: [
      {
        organization: {
          id: Cloud.OrganizationId.make("org_acme"),
          name: "Acme",
          slug: Cloud.Slug.make("acme"),
          plan: Cloud.UnboundPlan.make({}),
          createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
        },
        role: "owner",
      },
    ],
  }),
}).pipe(Effect.orDie)

/** Runs `durable whoami` against `fetch`, with the session stored unless `stored` is false; `prepare` runs on the configuration directory first. */
const whoami = (
  fetch: typeof globalThis.fetch,
  options: {
    readonly stored?: boolean
    readonly prepare?: (
      directory: string,
    ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>
  } = {},
) =>
  Effect.gen(function* () {
    const directory = yield* configDirectory(options.stored === false ? undefined : credentials)

    if (options.prepare !== undefined) yield* options.prepare(directory)

    return yield* runCliWith({ fetch, env: { AKTER_CONFIG_DIR: directory } })(["whoami"])
  })

layer(BunServices.layer)("durable whoami", (it) => {
  it.effect(
    "names the signed-in person, the control plane, and their organizations, sending the stored token",
    () =>
      Effect.gen(function* () {
        const { me } = yield* answers
        const server = scriptedFetch(() => Response.json(me))
        const run = yield* whoami(server.fetch)

        expect(run).toMatchObject({ exitCode: 0, reason: "" })
        expect(run.stdout).toBe("ada@example.dev at http://cloud.test\n  acme  owner  org_acme\n")
        expect(server.requests.map((request) => [request.url, request.authorization])).toEqual([
          ["http://cloud.test/api/me", "Bearer stored-token"],
        ])
      }),
  )

  it.effect("tells an expired or revoked session to log in again, with exit 1", () =>
    Effect.gen(function* () {
      const { unauthorized } = yield* answers
      const run = yield* whoami(
        scriptedFetch(() => Response.json(unauthorized, { status: 401 })).fetch,
      )

      expect(run).toMatchObject({ exitCode: 1, reason: "Unauthorized" })
      expect(run.stderr).toContain("expired or was revoked. Run `durable login`")
    }),
  )

  it.effect("asks for a login before sending anything when no session is stored", () =>
    Effect.gen(function* () {
      const server = scriptedFetch(() => new Response(null, { status: 401 }))
      const run = yield* whoami(server.fetch, { stored: false })

      expect(run).toMatchObject({ exitCode: 2, reason: "NotLoggedIn" })
      expect(server.requests).toEqual([])
    }),
  )

  it.effect.skipIf(process.platform === "win32")(
    "refuses stored credentials other users can read, without sending them",
    () =>
      Effect.gen(function* () {
        const { me } = yield* answers
        const server = scriptedFetch(() => Response.json(me))
        const run = yield* whoami(server.fetch, {
          prepare: (directory) =>
            Effect.flatMap(FileSystem.FileSystem, (fs) =>
              fs.chmod(`${directory}/credentials.json`, 0o644),
            ),
        })

        expect(run).toMatchObject({ exitCode: 2, reason: "CredentialsExposed" })
        expect(run.stderr).toContain("(mode 644)")
        expect(server.requests).toEqual([])
      }),
  )
})
