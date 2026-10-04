import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { configDirectory, runCliWith, scriptedFetch } from "../../testing.ts"

const credentials = {
  apiUrl: "https://cloud.test",
  token: "stored-token",
  email: "ada@example.dev",
}

const logout = (fetch: typeof globalThis.fetch, stored = true, mode = 0o600) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* configDirectory(stored ? credentials : undefined)

    if (stored) yield* fs.chmod(`${directory}/credentials.json`, mode)

    const run = yield* runCliWith({ fetch, env: { AKTER_CONFIG_DIR: directory } })(["logout"])

    return { run, left: yield* fs.exists(`${directory}/credentials.json`) }
  })

layer(BunServices.layer)("akter logout", (it) => {
  it.effect("revokes the session at its control plane with the stored token, then deletes it", () =>
    Effect.gen(function* () {
      const server = scriptedFetch(() => Response.json({ success: true }))
      const { run, left } = yield* logout(server.fetch)

      expect(run).toMatchObject({ exitCode: 0, stdout: "Logged out of https://cloud.test.\n" })
      expect(left).toBe(false)
      expect(
        server.requests.map((request) => [request.method, request.url, request.authorization]),
      ).toEqual([["POST", "https://cloud.test/auth/sign-out", "Bearer stored-token"]])
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

  it.effect.skipIf(process.platform === "win32")(
    "still revokes a session whose file other users could read, since its token may have leaked",
    () =>
      Effect.gen(function* () {
        const server = scriptedFetch(() => Response.json({ success: true }))
        const { run, left } = yield* logout(server.fetch, true, 0o644)

        expect(run).toMatchObject({ exitCode: 0, stdout: "Logged out of https://cloud.test.\n" })
        expect(left).toBe(false)
        expect(server.requests.map((request) => request.authorization)).toEqual([
          "Bearer stored-token",
        ])
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
