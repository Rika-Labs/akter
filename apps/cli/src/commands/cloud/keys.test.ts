import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import * as Cloud from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { configDirectory, runCliWith, scriptedFetch } from "../../testing.ts"

const credentials = {
  apiUrl: "https://cloud.test",
  token: "stored-session",
  email: "owner@example.test",
}
const key = {
  id: "key_0123456789abcdef01234567",
  name: "storefront",
  tenant: "acme",
  createdAt: "2026-10-06T12:01:02.000Z",
  revokedAt: null,
}
const secret = "synthetic-one-time-secret"

layer(BunServices.layer)("akter keys", (it) => {
  it.effect(
    "keeps hostile metadata in five TSV columns and removes terminal and bidi controls",
    () =>
      Effect.gen(function* () {
        const directory = yield* configDirectory(credentials)
        const hostile = {
          ...key,
          id: "\u001b[2Jkey\tone",
          name: "store\tfront",
          tenant: "a\u202ecme\nother",
        }
        const server = scriptedFetch(({ method }) => {
          if (method === "DELETE") return new Response(null, { status: 204 })
          if (method === "POST") return Response.json({ key: hostile, secret })
          return Response.json([
            hostile,
            {
              ...key,
              id: "key\rsecond",
              name: "store\u001b[2Jfront",
              tenant: "acme\u2066\u0085\u2028\u2029",
            },
          ])
        })
        const run = runCliWith({
          fetch: server.fetch,
          env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" },
        })
        for (const name of ["store\tfront", "store\u001b[2Jfront"]) {
          const created = yield* run(["keys", "create", name])
          expect(created.exitCode).toBe(0)
          expect(created.stdout).toBe(`${secret}\n`)
          expect(created.stderr).toBe(
            "Created key�one in production for tenant a�cme�other. Save the secret printed on stdout now; it cannot be read again.\n",
          )
        }
        const payloads = yield* Effect.forEach(server.requests.slice(0, 2), ({ body }) =>
          Schema.decodeEffect(Schema.fromJsonString(Cloud.CreateEnvironmentApiKey))(body),
        )
        expect(payloads).toEqual([{ name: "store\tfront" }, { name: "store\u001b[2Jfront" }])
        const listed = yield* run(["keys", "list"])
        expect(listed.exitCode).toBe(0)
        expect(
          listed.stdout
            .trimEnd()
            .split("\n")
            .map((line) => line.split("\t")),
        ).toEqual([
          ["key�one", "store�front", "a�cme�other", "2026-10-06T12:01:02.000Z", "active"],
          ["key�second", "storefront", "acme����", "2026-10-06T12:01:02.000Z", "active"],
        ])
        const revoked = yield* run(["keys", "revoke", hostile.id])
        expect(revoked.exitCode).toBe(0)
        expect(revoked.stdout).toBe("Revoked key�one in production.\n")
        for (const control of ["\u001b", "\r", "\u202e", "\u2066", "\u0085", "\u2028", "\u2029"])
          expect(
            `${listed.stdout}${listed.stderr}${revoked.stdout}${revoked.stderr}`,
          ).not.toContain(control)
      }),
  )

  it.effect("uses authenticated scoped routes and prints the secret only from create", () =>
    Effect.gen(function* () {
      const directory = yield* configDirectory(credentials)
      const server = scriptedFetch(({ method }) => {
        if (method === "DELETE") return new Response(null, { status: 204 })
        if (method === "POST") return Response.json({ key, secret })
        return Response.json([
          { ...key, secret },
          { ...key, id: "key_revoked", revokedAt: "2026-10-07T01:02:03.000Z" },
        ])
      })
      const run = runCliWith({
        fetch: server.fetch,
        env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" },
      })
      const created = yield* run([
        "keys",
        "create",
        "storefront",
        "--tenant",
        "acme",
        "--env",
        "staging",
      ])
      const defaultTenant = yield* run(["keys", "create", "backend", "--project", "project-b"])
      const listed = yield* run(["keys", "list"])
      const revoked = yield* run(["keys", "revoke", key.id])
      expect([created, defaultTenant, listed, revoked].map(({ exitCode }) => exitCode)).toEqual([
        0, 0, 0, 0,
      ])
      expect(created.stdout).toBe(`${secret}\n`)
      expect(created.stderr).toContain(key.id)
      expect(created.stderr).toContain("cannot be read again")
      expect(created.stderr).not.toContain(secret)
      expect(listed.stdout).toBe(
        `${key.id}\tstorefront\tacme\t2026-10-06T12:01:02.000Z\tactive\n` +
          "key_revoked\tstorefront\tacme\t2026-10-06T12:01:02.000Z\t2026-10-07T01:02:03.000Z\n",
      )
      expect(`${listed.stdout}${listed.stderr}${revoked.stdout}${revoked.stderr}`).not.toContain(
        secret,
      )
      expect(revoked.stdout).toBe(`Revoked ${key.id} in production.\n`)
      expect(
        server.requests.map(({ method, url, authorization, body }) => ({
          method,
          path: new URL(url).pathname,
          authorization,
          body,
        })),
      ).toEqual([
        {
          method: "POST",
          path: "/api/projects/project-a/environments/staging/api-keys",
          authorization: "Bearer stored-session",
          body: '{"name":"storefront","tenant":"acme"}',
        },
        {
          method: "POST",
          path: "/api/projects/project-b/environments/production/api-keys",
          authorization: "Bearer stored-session",
          body: '{"name":"backend"}',
        },
        {
          method: "GET",
          path: "/api/projects/project-a/environments/production/api-keys",
          authorization: "Bearer stored-session",
          body: "",
        },
        {
          method: "DELETE",
          path: `/api/projects/project-a/environments/production/api-keys/${key.id}`,
          authorization: "Bearer stored-session",
          body: "",
        },
      ])
    }),
  )

  it.effect(
    "refuses missing credentials and invalid selection or tenant before any HTTP call",
    () =>
      Effect.gen(function* () {
        const directory = yield* configDirectory()
        const server = scriptedFetch(() => Response.json([]))
        const run = runCliWith({ fetch: server.fetch, env: { AKTER_CONFIG_DIR: directory } })
        expect(yield* run(["keys", "list", "--project", "project-a"])).toMatchObject({
          exitCode: 2,
          reason: "NotLoggedIn",
        })
        for (const args of [
          ["keys", "list"],
          ["keys", "list", "--project", "project-a", "--env", "unknown"],
          ["keys", "create", "backend", "--project", "project-a", "--tenant", "bad tenant"],
          ["keys", "create", "", "--project", "project-a"],
          ["keys", "revoke", "--project", "project-a"],
        ])
          expect((yield* run(args)).exitCode).toBe(2)
        expect(server.requests).toEqual([])
        for (const command of ["create", "list", "revoke"]) {
          const help = yield* run(["keys", command, "--help"])
          expect(help.exitCode).toBe(0)
          expect(help.stdout).toContain("--project")
          expect(help.stdout).toContain("--env")
        }
      }),
  )

  it.effect(
    "reports denied reads, undeployed creates and missing revocations without false success",
    () =>
      Effect.gen(function* () {
        const directory = yield* configDirectory(credentials)
        const server = scriptedFetch(({ method }) => {
          if (method === "GET")
            return Response.json(Cloud.Forbidden.make({ message: "Project access is denied" }), {
              status: 403,
            })
          if (method === "POST")
            return Response.json(
              Cloud.Conflict.make({
                message:
                  "The staging environment has no live deployment; deploy it before creating a key",
              }),
              { status: 409 },
            )
          return Response.json(Cloud.NotFound.make({ resource: "api-key", id: "key_missing" }), {
            status: 404,
          })
        })
        const run = runCliWith({
          fetch: server.fetch,
          env: { AKTER_CONFIG_DIR: directory, AKTER_PROJECT: "project-a" },
        })
        for (const [args, reason, message] of [
          [["keys", "list"], "Forbidden", "Project access is denied"],
          [["keys", "create", "backend", "--env", "staging"], "Conflict", "no live deployment"],
          [["keys", "revoke", "key_missing"], "NotFound", "No api-key key_missing"],
        ] as const) {
          const result = yield* run(args)
          expect(result).toMatchObject({ exitCode: 1, reason, stdout: "" })
          expect(result.stderr).toContain(message)
        }
        expect(server.requests).toHaveLength(3)
      }),
  )
})
