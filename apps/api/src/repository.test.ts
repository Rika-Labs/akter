import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Cause,
  Config,
  Context,
  Crypto,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Result,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import {
  type Audited,
  EnvironmentInUse,
  EnvironmentNameTaken,
  EnvironmentNotFound,
  InvalidCursor,
  ProjectInUse,
  ProjectNotFound,
  ProjectSlugTaken,
  Repository,
  RepositoryLive,
} from "./repository.ts"

/** A fresh database on the server at TEST_DATABASE_URL, dropped with the scope. */
const database = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `api_repository_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

const client = (url: Redacted.Redacted<string>, maxConnections: number) =>
  PgClient.layer({ url, maxConnections })

class DatabaseUrl extends Context.Service<DatabaseUrl, Redacted.Redacted<string>>()(
  "@akter/api/repository.test/DatabaseUrl",
) {}

const live = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* database

    return RepositoryLive.pipe(
      Layer.provideMerge(client(url, 20)),
      Layer.merge(Layer.succeed(DatabaseUrl, url)),
    )
  }),
).pipe(Layer.provideMerge(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

type Environment = Repository | SqlClient.SqlClient | DatabaseUrl | Crypto.Crypto

const run = <A, E>(effect: Effect.Effect<A, E, Environment>) => runtime.runPromise(effect)

const defect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(Effect.map((exit) => Exit.isFailure(exit) && Cause.hasDies(exit.cause)))

const count = (
  table: "cloud_project" | "cloud_environment" | "cloud_audit",
  organizationId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly n: string }>`
      SELECT count(*)::text AS n FROM ${sql(table)} WHERE organization_id = ${organizationId}
    `

    return Number(rows[0]!.n)
  }).pipe(Effect.orDie)

const unique = Effect.gen(function* () {
  return `org_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`
})

const by = (organizationId: string, userId = "user_1"): Audited => ({
  organizationId,
  actor: { kind: "user", id: userId, name: "Ada" },
  ip: "203.0.113.7",
})

const create = (organizationId: string, slug: string) =>
  Effect.gen(function* () {
    const repository = yield* Effect.service(Repository)

    return yield* repository.createProject({
      ...by(organizationId),
      name: `Project ${slug}`,
      slug,
      homeRegion: "us-east-1",
    })
  })

describe("migrations", () => {
  it("run safely from several processes at once and leave existing rows alone", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const url = yield* Effect.service(DatabaseUrl)
        const seeded = yield* create(organizationId, "seeded")

        yield* Effect.all(
          Array.from({ length: 4 }, () =>
            Effect.scoped(Layer.build(RepositoryLive.pipe(Layer.provide(client(url, 2))))),
          ),
          { concurrency: "unbounded", discard: true },
        )

        const again = yield* repository.getProject({ organizationId, projectId: seeded.id })
        expect(again.slug).toBe("seeded")
      }),
    ))
})

describe("projects", () => {
  it("are visible only to their organization, and a slug is unique per organization", () =>
    run(
      Effect.gen(function* () {
        const [a, b] = [yield* unique, yield* unique]
        const repository = yield* Effect.service(Repository)
        const created = yield* create(a, "shop")
        expect(created).toMatchObject({ organizationId: a, slug: "shop", status: "empty" })

        expect(yield* repository.listProjects({ organizationId: b })).toEqual([])
        expect(
          yield* Effect.flip(repository.getProject({ organizationId: b, projectId: created.id })),
        ).toEqual(ProjectNotFound.make({ projectId: created.id }))

        const sameSlugElsewhere = yield* create(b, "shop")
        expect(sameSlugElsewhere.id).not.toBe(created.id)

        expect(yield* Effect.flip(create(a, "shop"))).toEqual(
          ProjectSlugTaken.make({ slug: "shop" }),
        )
        expect((yield* repository.listProjects({ organizationId: a })).map(({ id }) => id)).toEqual(
          [created.id],
        )
        expect(yield* count("cloud_audit", a)).toBe(1)
      }),
    ))

  it("write exactly one audit entry naming the actor and the new project", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const created = yield* create(organizationId, "audited")
        const page = yield* repository.listAudit({ organizationId })

        expect(page.items).toHaveLength(1)
        expect(page.items[0]).toMatchObject({
          actor: { kind: "user", id: "user_1", name: "Ada" },
          action: "project.create",
          target: { type: "project", id: created.id, name: "Project audited" },
          ipAddress: "203.0.113.7",
        })
      }),
    ))

  it("racing to the same slug create exactly one project and one audit entry", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const results = yield* Effect.all(
          Array.from({ length: 8 }, () => Effect.result(create(organizationId, "race"))),
          { concurrency: "unbounded" },
        )

        expect(results.filter(Result.isSuccess)).toHaveLength(1)
        for (const result of results.filter(Result.isFailure)) {
          expect(result.failure).toEqual(ProjectSlugTaken.make({ slug: "race" }))
        }
        expect(yield* count("cloud_project", organizationId)).toBe(1)
        expect(yield* count("cloud_audit", organizationId)).toBe(1)
      }),
    ))
})

const environmentsOf = (organizationId: string, projectId: string) =>
  Effect.flatMap(Effect.service(Repository), (repository) =>
    repository.listEnvironments({ organizationId, projectId }),
  )

/** Runs `effect` while every insert into the audit log fails, as a full disk or a revoked grant would. */
const whileAuditRefused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`
      CREATE OR REPLACE FUNCTION cloud_audit_refuse() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit write refused'; END $$ LANGUAGE plpgsql
    `)
    yield* sql.unsafe(`
      CREATE TRIGGER cloud_audit_refuse BEFORE INSERT ON cloud_audit
      FOR EACH ROW EXECUTE FUNCTION cloud_audit_refuse()
    `)

    return yield* effect.pipe(
      Effect.ensuring(
        Effect.orDie(
          sql
            .unsafe(`DROP TRIGGER cloud_audit_refuse ON cloud_audit`)
            .pipe(Effect.andThen(sql.unsafe(`DROP FUNCTION cloud_audit_refuse()`))),
        ),
      ),
    )
  })

const deploy = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      UPDATE cloud_environment SET current_deployment_id = 'dep_1'
      WHERE project_id = ${projectId} AND name = ${name}
    `
  }).pipe(Effect.orDie)

const auditActions = (organizationId: string) =>
  Effect.gen(function* () {
    const repository = yield* Effect.service(Repository)

    return (yield* repository.listAudit({ organizationId })).items.map(({ action }) => action)
  })

describe("environments", () => {
  it("are provisioned with the project, in order, under one audit entry", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const owned = yield* create(organizationId, "app")

        expect(yield* environmentsOf(organizationId, owned.id)).toEqual(
          ["production", "staging", "dev"].map((name) => ({
            name,
            projectId: owned.id,
            currentDeploymentId: null,
          })),
        )
        expect(yield* auditActions(organizationId)).toEqual(["project.create"])
      }),
    ))

  it("belong to a project of the same organization and a name is unique per project", () =>
    run(
      Effect.gen(function* () {
        const [a, b] = [yield* unique, yield* unique]
        const repository = yield* Effect.service(Repository)
        const owned = yield* create(a, "app")

        expect(
          yield* Effect.flip(
            repository.createEnvironment({ ...by(a), projectId: owned.id, name: "production" }),
          ),
        ).toEqual(EnvironmentNameTaken.make({ name: "production" }))
        expect(
          yield* Effect.flip(
            repository.createEnvironment({ ...by(b), projectId: owned.id, name: "dev" }),
          ),
        ).toEqual(ProjectNotFound.make({ projectId: owned.id }))
        expect(
          yield* Effect.flip(
            repository.deleteEnvironment({ ...by(b), projectId: owned.id, name: "dev" }),
          ),
        ).toEqual(EnvironmentNotFound.make({ projectId: owned.id, name: "dev" }))

        expect(yield* count("cloud_environment", a)).toBe(3)
        expect(yield* count("cloud_environment", b)).toBe(0)
        expect(yield* count("cloud_audit", b)).toBe(0)
        expect(yield* auditActions(a)).toEqual(["project.create"])

        expect(
          yield* Effect.flip(
            repository.listEnvironments({ organizationId: b, projectId: owned.id }),
          ),
        ).toEqual(ProjectNotFound.make({ projectId: owned.id }))
        expect(
          yield* Effect.flip(
            repository.getEnvironment({
              organizationId: b,
              projectId: owned.id,
              name: "production",
            }),
          ),
        ).toEqual(EnvironmentNotFound.make({ projectId: owned.id, name: "production" }))
      }),
    ))

  it("can be deleted and created again, unless a deployment is current", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const owned = yield* create(organizationId, "app")
        const target = { ...by(organizationId), projectId: owned.id }

        yield* deploy(owned.id, "production")
        expect(
          yield* Effect.flip(repository.deleteEnvironment({ ...target, name: "production" })),
        ).toEqual(EnvironmentInUse.make({ projectId: owned.id, name: "production" }))

        yield* repository.deleteEnvironment({ ...target, name: "staging" })
        expect((yield* environmentsOf(organizationId, owned.id)).map(({ name }) => name)).toEqual([
          "production",
          "dev",
        ])

        yield* repository.createEnvironment({ ...target, name: "staging" })
        expect((yield* environmentsOf(organizationId, owned.id)).map(({ name }) => name)).toEqual([
          "production",
          "staging",
          "dev",
        ])
        expect(yield* auditActions(organizationId)).toEqual([
          "environment.create",
          "environment.delete",
          "project.create",
        ])
      }),
    ))

  it("cannot be attached to another organization's project even by direct SQL", () =>
    run(
      Effect.gen(function* () {
        const [a, b] = [yield* unique, yield* unique]
        const sql = yield* SqlClient.SqlClient
        const owned = yield* create(a, "guarded")

        const exit = yield* Effect.exit(sql`
          INSERT INTO cloud_environment (organization_id, project_id, name)
          VALUES (${b}, ${owned.id}, 'dev')
        `)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* count("cloud_environment", b)).toBe(0)
      }),
    ))
})

describe("updating and deleting projects", () => {
  it("update the name and slug with one audit entry, refusing a taken slug and another organization", () =>
    run(
      Effect.gen(function* () {
        const [a, b] = [yield* unique, yield* unique]
        const repository = yield* Effect.service(Repository)
        const first = yield* create(a, "first")
        yield* create(a, "second")

        const renamed = yield* repository.updateProject({
          ...by(a),
          projectId: first.id,
          name: "Renamed",
          slug: "renamed",
        })
        expect(renamed).toMatchObject({ id: first.id, name: "Renamed", slug: "renamed" })
        expect(yield* auditActions(a)).toEqual([
          "project.update",
          "project.create",
          "project.create",
        ])

        expect(
          yield* Effect.flip(
            repository.updateProject({ ...by(a), projectId: first.id, slug: "second" }),
          ),
        ).toEqual(ProjectSlugTaken.make({ slug: "second" }))
        expect(
          yield* Effect.flip(
            repository.updateProject({ ...by(b), projectId: first.id, name: "Taken over" }),
          ),
        ).toEqual(ProjectNotFound.make({ projectId: first.id }))
        expect(yield* repository.getProject({ organizationId: a, projectId: first.id })).toEqual(
          renamed,
        )
        expect(yield* count("cloud_audit", a)).toBe(3)
        expect(yield* count("cloud_audit", b)).toBe(0)

        expect(yield* repository.updateProject({ ...by(a), projectId: first.id })).toEqual(renamed)
        expect(yield* count("cloud_audit", a)).toBe(3)
      }),
    ))

  it("delete the project, its environments and every user's pins to it, and nothing of another project", () =>
    run(
      Effect.gen(function* () {
        const [a, b] = [yield* unique, yield* unique]
        const repository = yield* Effect.service(Repository)
        const doomed = yield* create(a, "doomed")
        const kept = yield* create(a, "kept")
        const [u1, u2] = [yield* unique, yield* unique]
        const pin = (userId: string, projectId: string, address: string) =>
          repository.pinActor({
            organizationId: a,
            userId,
            projectId,
            environment: "production",
            address,
          })
        yield* pin(u1, doomed.id, "Counter/1")
        yield* pin(u1, kept.id, "Counter/2")
        yield* pin(u2, doomed.id, "Counter/3")

        expect(
          yield* Effect.flip(repository.deleteProject({ ...by(b), projectId: doomed.id })),
        ).toEqual(ProjectNotFound.make({ projectId: doomed.id }))
        expect(yield* count("cloud_project", a)).toBe(2)

        yield* repository.deleteProject({ ...by(a), projectId: doomed.id })

        expect(
          yield* Effect.flip(repository.getProject({ organizationId: a, projectId: doomed.id })),
        ).toEqual(ProjectNotFound.make({ projectId: doomed.id }))
        expect(yield* count("cloud_environment", a)).toBe(3)
        expect((yield* repository.listPinnedActors({ userId: u1 })).map((p) => p.address)).toEqual([
          "Counter/2",
        ])
        expect(yield* repository.listPinnedActors({ userId: u2 })).toEqual([])
        expect(yield* auditActions(a)).toEqual([
          "project.delete",
          "project.create",
          "project.create",
        ])
        expect(yield* count("cloud_audit", b)).toBe(0)
      }),
    ))

  it("refuse to delete a project with a current deployment, changing nothing", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const live = yield* create(organizationId, "live")
        yield* deploy(live.id, "staging")

        expect(
          yield* Effect.flip(
            repository.deleteProject({ ...by(organizationId), projectId: live.id }),
          ),
        ).toEqual(ProjectInUse.make({ projectId: live.id }))
        expect(yield* environmentsOf(organizationId, live.id)).toHaveLength(3)
        expect(yield* auditActions(organizationId)).toEqual(["project.create"])
      }),
    ))
})

describe("a mutation and its audit entry", () => {
  it("roll back together when the audit write fails", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const kept = yield* create(organizationId, "kept")
        const target = { ...by(organizationId), projectId: kept.id }
        const userId = yield* unique
        yield* repository.pinActor({
          organizationId,
          userId,
          projectId: kept.id,
          environment: "dev",
          address: "Counter/1",
        })

        const refused = yield* whileAuditRefused(
          Effect.all([
            defect(create(organizationId, "lost")),
            defect(repository.updateProject({ ...target, name: "Changed", slug: "changed" })),
            defect(repository.deleteEnvironment({ ...target, name: "dev" })),
            defect(repository.deleteProject(target)),
          ]),
        )
        expect(refused).toEqual([true, true, true, true])

        expect(
          (yield* repository.listProjects({ organizationId })).map(({ slug }) => slug),
        ).toEqual(["kept"])
        expect(yield* repository.getProject({ organizationId, projectId: kept.id })).toEqual(kept)
        expect(yield* environmentsOf(organizationId, kept.id)).toHaveLength(3)
        expect((yield* repository.listPinnedActors({ userId })).map((p) => p.address)).toEqual([
          "Counter/1",
        ])
        expect(yield* count("cloud_environment", organizationId)).toBe(3)
        expect(yield* count("cloud_audit", organizationId)).toBe(1)

        yield* create(organizationId, "lost")
        expect(yield* count("cloud_audit", organizationId)).toBe(2)
      }),
    ))
})

describe("audit log", () => {
  it("pages newest first, scoped to the organization", () =>
    run(
      Effect.gen(function* () {
        const [a, b] = [yield* unique, yield* unique]
        const repository = yield* Effect.service(Repository)
        for (const action of ["one", "two", "three", "four", "five"]) {
          yield* repository.recordAudit({
            ...by(a),
            action,
            target: { type: "api-key", id: action },
          })
        }
        yield* repository.recordAudit({ ...by(b), action: "other", target: { type: "org" } })

        const first = yield* repository.listAudit({ organizationId: a, limit: 2 })
        expect(first.items.map(({ action }) => action)).toEqual(["five", "four"])
        expect(first.nextCursor).toBe(first.items[1]!.id)

        const second = yield* repository.listAudit({
          organizationId: a,
          limit: 2,
          cursor: first.nextCursor!,
        })
        expect(second.items.map(({ action }) => action)).toEqual(["three", "two"])

        const last = yield* repository.listAudit({
          organizationId: a,
          limit: 2,
          cursor: second.nextCursor!,
        })
        expect(last.nextCursor).toBe(null)
        expect(last.items.map(({ action }) => action)).toEqual(["one"])

        expect(
          (yield* repository.listAudit({ organizationId: b })).items.map(({ action }) => action),
        ).toEqual(["other"])
        yield* repository.recordAudit({
          organizationId: a,
          actor: { kind: "api-key", id: "key_9" },
          action: "one",
          target: { type: "api-key" },
        })
        expect(
          (yield* repository.listAudit({ organizationId: a, action: "one" })).items.map(
            ({ actor }) => actor.id,
          ),
        ).toEqual(["key_9", "user_1"])
        expect(
          (yield* repository.listAudit({ organizationId: a, actorId: "key_9" })).items.map(
            ({ action }) => action,
          ),
        ).toEqual(["one"])
        expect(
          yield* Effect.flip(repository.listAudit({ organizationId: a, cursor: "1; DROP" })),
        ).toEqual(InvalidCursor.make({ cursor: "1; DROP" }))
      }),
    ))

  it("orders by the numeric id when ids gain a digit", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`ALTER TABLE cloud_audit ALTER COLUMN id RESTART WITH 99999998`)

        for (const action of ["a", "b", "c", "d"]) {
          yield* repository.recordAudit({ ...by(organizationId), action, target: { type: "t" } })
        }

        const page = yield* repository.listAudit({ organizationId, limit: 3 })
        expect(page.items.map(({ action }) => action)).toEqual(["d", "c", "b"])
        expect(page.items.map(({ id }) => id)).toEqual(["100000001", "100000000", "99999999"])
        expect(
          (yield* repository.listAudit({ organizationId, cursor: page.nextCursor! })).items.map(
            ({ action }) => action,
          ),
        ).toEqual(["a"])
      }),
    ))

  it("records an API key actor and a null address", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const entry = yield* repository.recordAudit({
          organizationId,
          actor: { kind: "api-key", id: "key_1" },
          action: "api-key.create",
          target: { type: "api-key", id: "key_2", name: "ci" },
        })

        expect(entry).toMatchObject({
          actor: { kind: "api-key", id: "key_1", name: null },
          target: { type: "api-key", id: "key_2", name: "ci" },
          ipAddress: null,
        })
      }),
    ))
})

describe("preferences", () => {
  it("default until changed, change only the fields given and stay per user", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Effect.service(Repository)
        const [u1, u2] = [yield* unique, yield* unique]
        const defaults = yield* repository.getPreferences({ userId: u1 })
        expect(defaults).toEqual({
          defaultEnvironment: "production",
          openActorLinksInNewTab: false,
          timeZone: "UTC",
          pauseLiveTailOnScroll: true,
          showReplayedCommands: false,
          theme: "system",
        })

        const changed = yield* repository.updatePreferences({
          userId: u1,
          changes: { theme: "dark", openActorLinksInNewTab: true, pauseLiveTailOnScroll: false },
        })
        expect(changed).toEqual({
          ...defaults,
          theme: "dark",
          openActorLinksInNewTab: true,
          pauseLiveTailOnScroll: false,
        })

        const second = yield* repository.updatePreferences({
          userId: u1,
          changes: { timeZone: "Europe/Paris", defaultEnvironment: "dev" },
        })
        expect(second).toEqual({ ...changed, timeZone: "Europe/Paris", defaultEnvironment: "dev" })

        expect(yield* repository.getPreferences({ userId: u1 })).toEqual(second)
        expect(yield* repository.getPreferences({ userId: u2 })).toEqual(defaults)
      }),
    ))

  it("keep notifications per event, defaulting to email only", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Effect.service(Repository)
        const [u1, u2] = [yield* unique, yield* unique]
        const defaults = [
          { event: "deploy_failed", email: true, slack: false },
          { event: "dead_letter", email: true, slack: false },
          { event: "spend_threshold", email: true, slack: false },
        ]
        expect(yield* repository.getNotifications({ userId: u1 })).toEqual(defaults)

        const updated = yield* repository.updateNotifications({
          userId: u1,
          changes: [{ event: "dead_letter", email: false, slack: true }],
        })
        expect(updated).toEqual([
          defaults[0],
          { event: "dead_letter", email: false, slack: true },
          defaults[2],
        ])
        expect(yield* repository.getNotifications({ userId: u1 })).toEqual(updated)
        expect(yield* repository.getNotifications({ userId: u2 })).toEqual(defaults)
      }),
    ))

  it("pin actors in order, once, only in environments of the organization the caller names", () =>
    run(
      Effect.gen(function* () {
        const [a, b] = [yield* unique, yield* unique]
        const [u1, u2] = [yield* unique, yield* unique]
        const repository = yield* Effect.service(Repository)
        const owned = yield* create(a, "pins")
        yield* repository.deleteEnvironment({ ...by(a), projectId: owned.id, name: "dev" })

        const counter = {
          projectId: owned.id,
          environment: "production",
          address: "Counter/a",
        } as const
        const order = { projectId: owned.id, environment: "staging", address: "Order/1" } as const

        yield* repository.pinActor({ organizationId: a, userId: u1, ...counter })
        yield* repository.pinActor({ organizationId: a, userId: u1, ...order })
        expect(yield* repository.pinActor({ organizationId: a, userId: u1, ...counter })).toEqual([
          counter,
          order,
        ])

        expect(yield* repository.listPinnedActors({ userId: u2 })).toEqual([])
        expect(
          yield* repository.listPinnedActors({
            userId: u1,
            projectId: owned.id,
            environment: "staging",
          }),
        ).toEqual([order])

        expect(
          yield* Effect.flip(repository.pinActor({ organizationId: b, userId: u2, ...counter })),
        ).toEqual(EnvironmentNotFound.make({ projectId: owned.id, name: "production" }))
        expect(
          yield* Effect.flip(
            repository.pinActor({
              organizationId: a,
              userId: u2,
              projectId: owned.id,
              environment: "dev",
              address: "X/1",
            }),
          ),
        ).toEqual(EnvironmentNotFound.make({ projectId: owned.id, name: "dev" }))
        expect(yield* repository.listPinnedActors({ userId: u2 })).toEqual([])

        expect(yield* repository.unpinActor({ userId: u1, ...counter })).toEqual([order])
        expect(yield* repository.unpinActor({ userId: u1, ...counter })).toEqual([order])
        expect(yield* repository.unpinActor({ userId: u2, ...order })).toEqual([])
        expect(yield* repository.listPinnedActors({ userId: u1 })).toEqual([order])
      }),
    ))

  it("keep every pin when the same user pins concurrently", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const userId = yield* unique
        const repository = yield* Effect.service(Repository)
        const owned = yield* create(organizationId, "busy")
        const addresses = Array.from({ length: 12 }, (_, index) => `Counter/${index}`)

        yield* Effect.forEach(
          addresses,
          (address) =>
            repository.pinActor({
              organizationId,
              userId,
              projectId: owned.id,
              environment: "dev",
              address,
            }),
          { concurrency: "unbounded", discard: true },
        )

        const pinned = yield* repository.listPinnedActors({ userId })
        expect(pinned.map(({ address }) => address).sort()).toEqual([...addresses].sort())
      }),
    ))
})
