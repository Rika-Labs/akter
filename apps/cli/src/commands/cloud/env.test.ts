import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import * as Cloud from "@akter/cloud-api"
import { Effect, FileSystem, Schema } from "effect"
import { configDirectory, runCliWith, scriptedFetch } from "../../testing.ts"

const credentials = {
  apiUrl: "https://cloud.test",
  token: "stored-session",
  email: "owner@example.test",
}

layer(BunServices.layer)("akter env commands", (it) => {
  it.effect(
    "uses the signed-in API and scoped paths, prints metadata only and reads writes from files",
    () =>
      Effect.gen(function* () {
        const directory = yield* configDirectory(credentials)
        const fs = yield* FileSystem.FileSystem
        const secretPath = `${directory}/value`
        const importPath = `${directory}/variables.env`
        yield* fs.writeFileString(secretPath, "unequal-secret-value")
        yield* fs.writeFileString(importPath, "TOKEN=another-secret\nEXTRA=third-secret")
        const received: Array<{
          method: string
          path: string
          authorization: string | null
          body: string
        }> = []
        const server = scriptedFetch((request) => {
          received.push({
            method: request.method,
            path: new URL(request.url).pathname,
            authorization: request.authorization,
            body: request.body,
          })
          if (request.method === "DELETE") return new Response(null, { status: 204 })
          if (request.url.endsWith("/import"))
            return Response.json({ created: ["EXTRA"], updated: ["TOKEN"] })
          const row = {
            name: "TOKEN",
            usedBy: ["platform"],
            updatedAt: "2026-10-06T12:01:02.000Z",
            updatedBy: null,
          }
          return Response.json(request.method === "GET" ? [row] : row)
        })
        const run = runCliWith({
          fetch: server.fetch,
          env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" },
        })
        const results = [
          yield* run(["env", "list", "--env", "staging"]),
          yield* run(["env", "set", "TOKEN", "--file", secretPath]),
          yield* run(["env", "unset", "TOKEN"]),
          yield* run(["env", "import", importPath]),
        ]
        expect(results.every((result) => result.exitCode === 0)).toBe(true)
        expect(results[0]?.stdout).toBe("TOKEN\t2026-10-06T12:01:02.000Z\n")
        expect(
          received.map(({ method, path, authorization }) => [method, path, authorization]),
        ).toEqual([
          [
            "GET",
            "/api/projects/project-a/environments/staging/variables",
            "Bearer stored-session",
          ],
          [
            "PUT",
            "/api/projects/project-a/environments/production/variables/TOKEN",
            "Bearer stored-session",
          ],
          [
            "DELETE",
            "/api/projects/project-a/environments/production/variables/TOKEN",
            "Bearer stored-session",
          ],
          [
            "POST",
            "/api/projects/project-a/environments/production/variables/import",
            "Bearer stored-session",
          ],
        ])
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(received[1]!.body),
        ).toEqual({ value: "unequal-secret-value" })
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(received[3]!.body),
        ).toEqual({
          content: "TOKEN=another-secret\nEXTRA=third-secret",
        })
        for (const value of ["unequal-secret-value", "another-secret", "third-secret"])
          expect(
            results.map(({ stdout, stderr }) => `${stdout}${stderr}`).join("\n"),
          ).not.toContain(value)
      }),
  )

  it.effect(
    "refuses oversized input before sending a write, and reports denied access without printing server payloads",
    () =>
      Effect.gen(function* () {
        const directory = yield* configDirectory(credentials)
        const fs = yield* FileSystem.FileSystem
        const path = `${directory}/oversized-value`
        yield* fs.writeFileString(path, "x".repeat(65537))
        const server = scriptedFetch(() =>
          Response.json(Cloud.Forbidden.make({ message: "Project access is denied" }), {
            status: 403,
          }),
        )
        const run = runCliWith({ fetch: server.fetch, env: { AKTER_CONFIG_DIR: directory } })
        const oversized = yield* run([
          "env",
          "set",
          "TOKEN",
          "--project",
          "project-a",
          "--file",
          path,
        ])
        expect(oversized).toMatchObject({ exitCode: 2, reason: "EnvironmentInputTooLarge" })
        expect(server.requests).toEqual([])
        const denied = yield* run(["env", "list", "--project", "project-a"])
        expect(denied).toMatchObject({ exitCode: 1, reason: "Forbidden" })
        expect(denied.stderr).toContain("Project access is denied")
      }),
  )
})
