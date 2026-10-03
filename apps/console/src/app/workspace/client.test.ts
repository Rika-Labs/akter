import { Me, PinnedActor, Project } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { workspaceFrom } from "./client.ts"

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
