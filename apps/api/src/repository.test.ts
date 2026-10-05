import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Cause,
  Clock,
  Config,
  Context,
  Crypto,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Result,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { nekiDatabase } from "@akter/postgres/neki"
import { Database } from "@rikalabs/akter/runtime"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import {
  type Audited,
  type CommandKey,
  commandPayloadHash,
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
            Effect.scoped(
              Layer.build(RepositoryLive.pipe(Layer.provide(client(url, 2)), Layer.fresh)),
            ),
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

describe("command assignments", () => {
  it("hashes canonical JSON semantics without losing escapes or array order", () => {
    const first = { b: { z: -0, a: "\u0000" }, a: [2, 1] }
    const reordered = { a: [2, 1], b: { a: "\u0000", z: 0 } }
    const expected = "f9a83063af44ea50d78207d8c6c3998df1c8fae7637eab1c4e31cfd835019f52"
    expect(commandPayloadHash(first)).toBe(expected)
    expect(commandPayloadHash(reordered)).toBe(expected)
    expect(commandPayloadHash({ ...reordered, a: [1, 2] })).not.toBe(expected)
    expect(commandPayloadHash({ ...reordered, b: { a: "", z: 0 } })).not.toBe(expected)
  })

  const expiresAt = Effect.runSync(Clock.currentTimeMillis) + 86_400_000
  const assignment = (commandId: string, payload: Schema.Json) => ({
    commandId,
    payloadHash: commandPayloadHash(payload),
    expiresAt,
    expired: false,
  })
  const assign = (
    repository: Repository["Service"],
    input: CommandKey & { payload: Schema.Json; mintedCommandId: string },
  ) => {
    const { payload, ...rest } = input
    return repository.assignCommand({
      ...rest,
      payloadHash: commandPayloadHash(payload),
      expiresAt,
    })
  }
  const key = (organizationId: string) => ({
    organizationId,
    projectId: "p1",
    environment: "production",
    address: "Order/o/1",
    command: "Cancel",
    commandId: "client-key",
  })

  it("let exactly one of several concurrent first sends win, and every racer gets the winner", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const minted = yield* Effect.all(Array.from({ length: 8 }, () => unique))

        const assigned = yield* Effect.forEach(
          minted,
          (mintedCommandId) =>
            assign(repository, {
              ...key(organizationId),
              payload: { reason: "late" },
              mintedCommandId,
            }),
          { concurrency: "unbounded" },
        )

        const winner = assigned[0]!
        expect(minted).toContain(winner.commandId)
        for (const row of assigned)
          expect(row).toEqual(assignment(winner.commandId!, { reason: "late" }))
        expect(yield* repository.findCommand(key(organizationId))).toEqual(winner)
      }),
    ))

  it("keep the first payload when a later assignment under the same key carries another", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const [first, second] = [yield* unique, yield* unique]

        expect(yield* repository.findCommand(key(organizationId))).toBeUndefined()

        const stored = yield* assign(repository, {
          ...key(organizationId),
          payload: { reason: "late", detail: { by: "ops" } },
          mintedCommandId: first,
        })
        const again = yield* assign(repository, {
          ...key(organizationId),
          payload: { reason: "early" },
          mintedCommandId: second,
        })

        expect(stored).toEqual(assignment(first, { reason: "late", detail: { by: "ops" } }))
        expect(again).toEqual(stored)
        expect(yield* repository.findCommand(key(organizationId))).toEqual(stored)
      }),
    ))

  it("survive a restart: a newly built repository on the same database reads the same assignment", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const url = yield* Effect.service(DatabaseUrl)
        const minted = yield* unique

        const stored = yield* assign(repository, {
          ...key(organizationId),
          payload: { reason: "late" },
          mintedCommandId: minted,
        })

        const restarted = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              RepositoryLive.pipe(Layer.provide(client(url, 2)), Layer.fresh),
            )
            const fresh = Context.get(context, Repository)

            return {
              found: yield* fresh.findCommand(key(organizationId)),
              assigned: yield* assign(fresh, {
                ...key(organizationId),
                payload: { reason: "late" },
                mintedCommandId: yield* unique,
              }),
            }
          }),
        )

        expect(restarted).toEqual({ found: stored, assigned: stored })
        expect(stored.commandId).toBe(minted)
      }),
    ))

  it("keep every scope field independent, so a key reused under another scope gets its own command", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const base = key(organizationId)
        const scopes = [
          base,
          { ...base, organizationId: yield* unique },
          { ...base, projectId: "p2" },
          { ...base, environment: "staging" },
          { ...base, address: "Order/o/2" },
          { ...base, command: "Ship" },
          { ...base, commandId: "client-other" },
        ]

        const assigned = []
        for (const scope of scopes) {
          const mintedCommandId = yield* unique
          const row = yield* assign(repository, {
            ...scope,
            payload: { scope: mintedCommandId },
            mintedCommandId,
          })

          expect(row).toEqual(assignment(mintedCommandId, { scope: mintedCommandId }))
          assigned.push(row)
        }

        for (const [index, scope] of scopes.entries())
          expect(yield* repository.findCommand(scope)).toEqual(assigned[index])
      }),
    ))

  it("compare payload hashes without retaining the request body", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const mintedCommandId = yield* unique
        const payload = { text: "before\u0000after", surrogate: "\ud800", values: ["\u0000"] }

        expect(
          yield* assign(repository, { ...key(organizationId), payload, mintedCommandId }),
        ).toEqual(assignment(mintedCommandId, payload))
        expect(yield* repository.findCommand(key(organizationId))).toEqual(
          assignment(mintedCommandId, payload),
        )
      }),
    ))

  it("turns an expired assignment into a tombstone and prunes it after 30 days", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const scope = key(organizationId)
        const assigned = yield* repository.assignCommand({
          ...scope,
          payloadHash: commandPayloadHash({ reason: "late" }),
          mintedCommandId: yield* unique,
          expiresAt: (yield* Clock.currentTimeMillis) + 86_400_000,
        })
        expect(assigned.commandId).not.toBeNull()
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE cloud_command_idempotency SET expires_at_ms = ${(yield* Clock.currentTimeMillis) - 1}
          WHERE organization_id = ${organizationId}`
        expect(yield* repository.sweepCommands).toMatchObject({ expired: 1 })
        expect(yield* repository.findCommand(scope)).toMatchObject({
          commandId: null,
          payloadHash: null,
          expired: true,
        })
        yield* sql`UPDATE cloud_command_idempotency SET expires_at_ms = ${(yield* Clock.currentTimeMillis) - 31 * 86_400_000}
          WHERE organization_id = ${organizationId}`
        expect(yield* repository.sweepCommands).toMatchObject({ pruned: 1 })
        expect(yield* repository.findCommand(scope)).toBeUndefined()
      }),
    ))

  it("races expiry sweep and reuse without reminting or duplicating the key", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const scope = key(organizationId)
        yield* repository.assignCommand({
          ...scope,
          payloadHash: commandPayloadHash({ reason: "late" }),
          mintedCommandId: yield* unique,
          expiresAt: (yield* Clock.currentTimeMillis) - 1,
        })
        const replacement = yield* unique
        const [swept, reused] = yield* Effect.all(
          [
            repository.sweepCommands,
            repository.assignCommand({
              ...scope,
              payloadHash: commandPayloadHash({ reason: "late" }),
              mintedCommandId: replacement,
              expiresAt: (yield* Clock.currentTimeMillis) + 86_400_000,
            }),
          ],
          { concurrency: "unbounded" },
        )
        expect(reused.commandId).toBeNull()
        expect(reused.expired).toBe(true)
        const next = yield* repository.sweepCommands
        expect(swept.expired + next.expired).toBe(1)
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly count: string }>`
          SELECT count(*)::text AS count FROM cloud_command_idempotency
          WHERE organization_id = ${scope.organizationId} AND project_id = ${scope.projectId}
            AND environment = ${scope.environment} AND address = ${scope.address}
            AND command = ${scope.command}
        `
        expect(Number(rows[0]?.count)).toBe(1)
      }),
    ))

  it("clears expired assignments and prunes old tombstones in batches of at most 1,000", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const sql = yield* SqlClient.SqlClient
        const repository = yield* Effect.service(Repository)
        const oldExpiry = (yield* Clock.currentTimeMillis) - 31 * 86_400_000
        yield* sql`
        INSERT INTO cloud_command_idempotency
          (organization_id, project_id, environment, address, command, key_hash, command_id, payload_hash, expires_at_ms)
        SELECT ${organizationId}, 'p1', 'production', 'Order/batched', 'Cancel',
          encode(sha256(convert_to(n::text, 'UTF8')), 'hex'),
          ${organizationId} || n::text, 'old-hash', ${(yield* Clock.currentTimeMillis) - 86_400_000}
        FROM generate_series(1, 1005) AS n
      `
        const first = yield* repository.sweepCommands
        expect(first).toEqual({ expired: 1000, pruned: 0 })
        const full = yield* sql<{ n: string }>`
        SELECT count(*)::text AS n FROM cloud_command_idempotency
        WHERE organization_id = ${organizationId} AND command_id IS NOT NULL
      `
        expect(Number(full[0]?.n)).toBe(5)
        expect(yield* repository.sweepCommands).toEqual({ expired: 5, pruned: 0 })
        yield* sql`UPDATE cloud_command_idempotency SET expires_at_ms = ${oldExpiry}
        WHERE organization_id = ${organizationId}`
        expect(yield* repository.sweepCommands).toEqual({ expired: 0, pruned: 1000 })
        const remaining = yield* sql<{
          n: string
        }>`SELECT count(*)::text AS n FROM cloud_command_idempotency WHERE organization_id = ${organizationId}`
        expect(Number(remaining[0]?.n)).toBe(5)
        expect(yield* repository.sweepCommands).toEqual({ expired: 0, pruned: 5 })
      }),
    ))

  it("migrates legacy JSON assignments to immutable hashes without retaining payloads or raw keys", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* database
          const db = yield* Layer.build(client(url, 2).pipe(Layer.fresh))
          const sql = Context.get(db, SqlClient.SqlClient)
          const mintedCommandId = `v1.1.${expiresAt}.00000000-0000-4000-8000-000000000001`
          const payload = { nested: { z: 2, a: "\u0000" }, list: [3, 1] }
          yield* sql`CREATE TABLE cloud_command_idempotency (
        organization_id text NOT NULL, project_id text NOT NULL, environment text NOT NULL,
        address text NOT NULL, command text NOT NULL, idempotency_key text NOT NULL,
        command_id text NOT NULL UNIQUE, payload json NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (organization_id, project_id, environment, address, command, idempotency_key)
      )`
          yield* sql`INSERT INTO cloud_command_idempotency VALUES (
        'legacy-org', 'p1', 'production', 'Order/o/1', 'Cancel', 'client-key',
        ${mintedCommandId}, ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(payload)}::json, now()
      )`
          const context = yield* Layer.build(
            RepositoryLive.pipe(Layer.provide(client(url, 2)), Layer.fresh),
          )
          const fresh = Context.get(context, Repository)
          expect(yield* fresh.findCommand(key("legacy-org"))).toEqual(
            assignment(mintedCommandId, payload),
          )
          const columns = yield* sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'cloud_command_idempotency'
      `
          expect(columns.map((row) => row.column_name)).not.toContain("payload")
          expect(columns.map((row) => row.column_name)).not.toContain("idempotency_key")
          expect(
            yield* assign(fresh, {
              ...key("legacy-org"),
              payload: { nested: { a: "\u0000", z: 2 }, list: [3, 1] },
              mintedCommandId: yield* unique,
            }),
          ).toEqual(assignment(mintedCommandId, payload))
        }),
      ),
    ))

  it("migrates legacy assignments on Neki, finishing what an earlier boot left part way", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* nekiDatabase("api_legacy")
          const neki = () =>
            client(url, 2).pipe(Layer.merge(Layer.succeed(Database.Neki, true)), Layer.fresh)
          const sql = Context.get(yield* Layer.build(neki()), SqlClient.SqlClient)
          const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
          const first = `v1.1.${expiresAt}.00000000-0000-4000-8000-000000000002`
          const second = `v1.1.${expiresAt + 1}.00000000-0000-4000-8000-000000000003`
          yield* sql`CREATE TABLE cloud_command_idempotency (
        organization_id text NOT NULL, project_id text NOT NULL, environment text NOT NULL,
        address text NOT NULL, command text NOT NULL, idempotency_key text NOT NULL,
        command_id text NOT NULL UNIQUE, payload json NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (organization_id, project_id, environment, address, command, idempotency_key)
      )`
          yield* sql`INSERT INTO cloud_command_idempotency VALUES
        ('neki-org', 'p1', 'production', 'Order/o/1', 'Cancel', 'client-key', ${first}, ${yield* encode({ n: 1 })}::json, now()),
        ('neki-org-2', 'p1', 'production', 'Order/o/1', 'Cancel', 'client-key', ${second}, ${yield* encode({ n: 2 })}::json, now())`
          yield* sql`ALTER TABLE cloud_command_idempotency
        ADD COLUMN key_hash text, ADD COLUMN payload_hash text, ADD COLUMN expires_at_ms bigint`
          const repository = Context.get(
            yield* Layer.build(RepositoryLive.pipe(Layer.provide(neki()), Layer.fresh)),
            Repository,
          )
          expect(yield* repository.findCommand(key("neki-org"))).toEqual(
            assignment(first, { n: 1 }),
          )
          expect(yield* repository.findCommand(key("neki-org-2"))).toEqual({
            ...assignment(second, { n: 2 }),
            expiresAt: expiresAt + 1,
          })
          const columns = yield* sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'cloud_command_idempotency'
      `
          expect(columns.map((row) => row.column_name)).not.toContain("payload")
          expect(columns.map((row) => row.column_name)).not.toContain("idempotency_key")
          yield* Layer.build(RepositoryLive.pipe(Layer.provide(neki()), Layer.fresh))
        }),
      ),
    ))

  it("rolls back both retention phases when a prune fails", () =>
    run(
      Effect.gen(function* () {
        const organizationId = yield* unique
        const repository = yield* Effect.service(Repository)
        const sql = yield* SqlClient.SqlClient
        const minted = yield* unique
        yield* repository.assignCommand({
          ...key(organizationId),
          address: "Order/fail-prune",
          payloadHash: commandPayloadHash("old"),
          mintedCommandId: minted,
          expiresAt: (yield* Clock.currentTimeMillis) - 31 * 86_400_000,
        })
        yield* sql.unsafe(`CREATE FUNCTION reject_command_prune() RETURNS trigger AS $$
        BEGIN IF OLD.address = 'Order/fail-prune' THEN RAISE EXCEPTION 'prune refused'; END IF;
        RETURN OLD; END $$ LANGUAGE plpgsql`)
        yield* sql`CREATE TRIGGER reject_command_prune BEFORE DELETE ON cloud_command_idempotency
        FOR EACH ROW EXECUTE FUNCTION reject_command_prune()`
        expect(yield* defect(repository.sweepCommands)).toBe(true)
        const rows = yield* sql<{ command_id: string; payload_hash: string }>`
        SELECT command_id, payload_hash FROM cloud_command_idempotency
        WHERE organization_id = ${organizationId} AND address = 'Order/fail-prune'
      `
        expect(rows).toEqual([{ command_id: minted, payload_hash: commandPayloadHash("old") }])
        yield* sql`DROP TRIGGER reject_command_prune ON cloud_command_idempotency`
        expect(yield* repository.sweepCommands).toEqual({ expired: 1, pruned: 1 })
        expect(
          yield* repository.findCommand({ ...key(organizationId), address: "Order/fail-prune" }),
        ).toBeUndefined()
      }),
    ))
})
