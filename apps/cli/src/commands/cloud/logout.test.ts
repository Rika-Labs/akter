import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { configDirectory, runCliWith, scriptedFetch } from "../../testing.ts"

const credentials = { apiUrl: "http://cloud.test", token: "stored-token", email: "ada@example.dev" }

const logout = (fetch: typeof globalThis.fetch, stored = true) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* configDirectory(stored ? credentials : undefined)
    const run = yield* runCliWith({ fetch, env: { AKTER_CONFIG_DIR: directory } })(["logout"])

    return { run, left: yield* fs.exists(`${directory}/credentials.json`) }
  })

layer(BunServices.layer)("durable logout", (it) => {
  it.effect("revokes the session at its control plane with the stored token, then deletes it", () =>
    Effect.gen(function* () {
      const server = scriptedFetch(() => Response.json({ success: true }))
      const { run, left } = yield* logout(server.fetch)

      expect(run).toMatchObject({ exitCode: 0, stdout: "Logged out of http://cloud.test.\n" })
      expect(left).toBe(false)
      expect(
        server.requests.map((request) => [request.method, request.url, request.authorization]),
      ).toEqual([["POST", "http://cloud.test/auth/sign-out", "Bearer stored-token"]])
    }),
  )

  it.effect(
    "still deletes the stored session when the control plane cannot revoke it, and says so",
    () =>
      Effect.gen(function* () {
        const unreachable = scriptedFetch(() => {
          throw new TypeError("connection refused")
        })
        const { run, left } = yield* logout(unreachable.fetch)

        expect(run.exitCode).toBe(0)
        expect(run.stdout).toContain("could not revoke the session")
        expect(left).toBe(false)
      }),
  )

  it.effect("is a no-op without a stored session", () =>
    Effect.gen(function* () {
      const server = scriptedFetch(() => Response.json({ success: true }))
      const { run } = yield* logout(server.fetch, false)

      expect(run).toMatchObject({ exitCode: 0, stdout: "Not logged in.\n" })
      expect(server.requests).toEqual([])
    }),
  )
})
