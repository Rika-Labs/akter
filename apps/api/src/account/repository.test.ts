import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime } from "effect"
import { PgClient } from "@effect/sql-pg"
import { databaseLayer } from "@durable-actors/postgres"
import {
  billingFor,
  insertProject,
  membersFor,
  organizationFor,
  projectsFor,
} from "./repository.ts"
import { makeTestDatabase, type TestDatabase } from "../testing/database.ts"

describe("account repository", () => {
  let database: TestDatabase
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>
  const run = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) => runtime.runPromise(effect)

  beforeAll(
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          database = yield* makeTestDatabase("api_account_repository")
          runtime = ManagedRuntime.make(databaseLayer(database.url))
          yield* Effect.promise(() =>
            database.pool.query(`
      insert into "user" (id,name,email,email_verified) values
        ('user-1','Owner','owner@example.com',true),
        ('user-2','Member','member@example.com',true);
      insert into organization (id,name,slug) values
        ('org-1','Alpha','alpha'), ('org-2','Beta','beta');
      insert into member (id,organization_id,user_id,role,created_at) values
        ('member-1','org-1','user-1','owner','2026-01-01'),
        ('member-2','org-1','user-2','member','2026-01-02'),
        ('member-3','org-2','user-1','owner','2026-01-03');
      insert into organization_billing
        (organization_id,subscription_id,customer_id,plan,status,renewal_date,event_at)
        values ('org-1','sub-1','customer-1','pro','active','2026-12-01','2026-01-01');
      insert into project (id,organization_id,name,created_at) values
        ('project-2','org-1','Second','2026-01-02'),
        ('project-1','org-1','First','2026-01-01');
    `),
          )
        }),
      ),
    30_000,
  )

  afterAll(() => run(database.dispose).finally(() => runtime.dispose()))

  it("enforces membership when resolving active and display-only organizations", () => {
    const effect = Effect.all({
      active: organizationFor("user-1", "org-1"),
      forbidden: organizationFor("user-2", "org-2"),
      noActive: organizationFor("user-1", null),
      display: organizationFor("user-1", null, true),
    })

    return run(effect).then((result) => {
      expect(result.active).toMatchObject({ id: "org-1", role: "owner" })
      expect(result.forbidden).toBeNull()
      expect(result.noActive).toBeNull()
      expect(result.display).toMatchObject({ id: "org-1" })
    })
  })

  it("returns ordered tenant-scoped members, projects, and normalized billing", () =>
    run(
      Effect.all({
        members: membersFor("org-1"),
        projects: projectsFor("org-1"),
        billing: billingFor("org-1"),
        absent: billingFor("org-2"),
      }),
    ).then((result) => {
      expect(result.members.map((member) => member.email)).toEqual([
        "owner@example.com",
        "member@example.com",
      ])
      expect(result.projects.map((project) => project.id)).toEqual(["project-1", "project-2"])
      expect(result.billing).toEqual({
        plan: "pro",
        status: "active",
        renewalDate: "2026-12-01T00:00:00.000Z",
      })
      expect(result.absent).toBeUndefined()
    }))

  it("rejects a cross-tenant project and creates a project for a member", () =>
    run(
      Effect.gen(function* () {
        expect(yield* insertProject("project-3", "org-2", "user-2", "Cross tenant")).toBeUndefined()
        expect(yield* insertProject("project-3", "org-1", "user-1", "Allowed")).toEqual({
          id: "project-3",
          name: "Allowed",
          status: "active",
        })
      }),
    ))
})
