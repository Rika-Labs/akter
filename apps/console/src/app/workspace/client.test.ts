import { Me, NotImplemented, PinnedActor, Project } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { afterAll, afterEach, expect, it, vi } from "vitest"
import { loadWorkspace, workspaceFrom } from "./client.ts"

const fetch = vi.spyOn(globalThis, "fetch")
afterEach(() => {
  fetch.mockReset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
afterAll(() => fetch.mockRestore())

it("selects the active membership and preserves actor keys containing slashes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const me = yield* Schema.decodeEffect(Schema.toCodecJson(Me))({
        user: {
          id: "u_9",
          name: "Lee",
          email: "lee@example.com",
          image: null,
          emailVerified: true,
        },
        identityKind: "session",
        activeOrganizationId: "org_2",
        organizations: [
          {
            role: "owner",
            organization: {
              id: "org_1",
              name: "Other",
              slug: "other",
              plan: "free",
              createdAt: "2026-01-02T03:04:05Z",
            },
          },
          {
            role: "viewer",
            organization: {
              id: "org_2",
              name: "Active",
              slug: "active",
              plan: "pro",
              createdAt: "2026-02-03T04:05:06Z",
            },
          },
        ],
      })
      const project = yield* Schema.decodeEffect(Schema.toCodecJson(Project))({
        id: "p_7",
        organizationId: "org_2",
        name: "Inbox",
        slug: "inbox",
        status: "empty",
        homeRegion: "us-west-2",
        createdAt: "2026-02-03T04:05:06Z",
      })
      const pin = yield* Schema.decodeEffect(Schema.toCodecJson(PinnedActor))({
        projectId: "p_7",
        environment: "production",
        address: "Room/team/subroom",
        status: "unknown",
        lastActivityAt: null,
      })
      const result = workspaceFrom(me, [project], [pin], { actorTypes: 7, openDeadLetters: 3 })
      expect(result).toEqual({
        person: { name: "Lee", email: "lee@example.com", role: "viewer" },
        organization: "Active",
        plan: "pro",
        projects: [{ slug: "inbox", deployed: false, region: "us-west-2" }],
        pinned: [{ actorType: "Room", key: "team/subroom", awake: false, lastTurn: "Unknown" }],
        deadLetters: 3,
      })
    }),
  ))

it("keeps the real session user instead of loading fixture identity when me is unimplemented", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.stubGlobal("location", { origin: "http://localhost" })
      const missing = yield* Schema.encodeEffect(Schema.fromJsonString(NotImplemented))(
        NotImplemented.make({ operation: "account.me" }),
      )
      fetch.mockImplementation((input) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname
        return Promise.resolve(
          path === "/api/me"
            ? new Response(missing, {
                status: 501,
                headers: { "content-type": "application/json" },
              })
            : new Response(
                '{"user":{"id":"real_u","name":"Real Session User","email":"real@example.com","emailVerified":true}}',
                { headers: { "content-type": "application/json" } },
              ),
        )
      })
      const workspace = yield* loadWorkspace
      expect(workspace.person).toEqual({
        name: "Real Session User",
        email: "real@example.com",
        role: "",
      })
      expect(workspace.organization).toBe("")
      expect(workspace.projects).toEqual([])
      expect(workspace.error).toBe("This action isn’t available yet.")
    }),
  ))
