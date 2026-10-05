import * as Planetscale from "alchemy/Planetscale"
import { Stack } from "alchemy/Stack"
import { Stage } from "alchemy/Stage"
import { Context, Data, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Neki } from "./resources.ts"
import { NekiRoleProvider } from "./role.ts"
import type { NekiRoleAttributes, NekiRoleProps } from "./role.ts"

const PASSWORD = "p@ss/w:rd#1 &?"
const ROTATED_PASSWORD = "second+secret"

const REGION = {
  id: "region",
  provider: "AWS",
  enabled: true,
  public_ip_addresses: [],
  display_name: "US East",
  location: "N. Virginia",
  slug: "us-east",
  current_default: true,
  mysql_supported: true,
  postgresql_supported: true,
  neki_supported: true,
}

const branch = (kind: string) => ({
  id: "branch-id",
  name: "main",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  restore_checklist_completed_at: null,
  schema_last_updated_at: null,
  kind,
  state: "ready",
  cluster_name: "PS_10",
  cluster_iops: null,
  ready: true,
  metal: false,
  production: true,
  safe_migrations: false,
  stale_schema: false,
  actor: null,
  restored_from_branch: null,
  private_edge_connectivity: false,
  has_replicas: false,
  has_read_only_replicas: false,
  html_url: "https://example.test/branch",
  url: "https://example.test/branch",
  region: REGION,
  parent_branch: null,
})

type Json =
  | null
  | string
  | number
  | boolean
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json | undefined }

type RoleBody = {
  readonly name?: string
  readonly inherited_roles?: ReadonlyArray<string>
  readonly ttl?: number
  readonly with_replication?: boolean
}

type FakeRole = {
  id: string
  name: string
  inherited: ReadonlyArray<string>
  deleted?: boolean
}

type FakeState = {
  branchKind: string
  roles: FakeRole[]
  nextId: number
  getStatus: number
  deleteStatus: number
  calls: string[]
  bodies: RoleBody[]
  listQueries: string[]
}

const fresh = (): FakeState => ({
  branchKind: "neki",
  roles: [],
  nextId: 1,
  getStatus: 200,
  deleteStatus: 200,
  calls: [],
  bodies: [],
  listQueries: [],
})

const roleJson = (role: FakeRole, password: string | null) => ({
  id: role.id,
  name: role.name,
  access_host_url: "aws.connect.example.test",
  private_access_host_url: "private.example.test",
  private_connection_service_name: "service",
  username: `login.${role.id}`,
  base_username: "login",
  password,
  database_name: "postgres",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: role.deleted === true ? "2026-01-02T00:00:00Z" : null,
  expires_at: null,
  dropped_at: null,
  disabled_at: null,
  drop_failed: null,
  ready: true,
  expired: false,
  default: false,
  ttl: null,
  inherited_roles: role.inherited,
  with_replication: false,
  branch: {
    id: "branch-id",
    name: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
  },
  actor: { id: "actor", display_name: "actor", avatar_url: "https://example.test/a.png" },
  query_safety_settings: { require_where_on_delete: "off", require_where_on_update: "off" },
})

const json = (body: Json, status = 200) => Response.json(body, { status })

const BRANCH = "/v1/organizations/test-org/databases/cells/branches/main"

const handle = (state: FakeState, request: Request) =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`
    if (route === `GET ${BRANCH}`) return json(branch(state.branchKind))
    if (route === `POST ${BRANCH}/roles`) {
      const body: RoleBody = yield* Effect.promise(() => request.json())
      state.calls.push("createRole")
      state.bodies.push(body)
      const created = {
        id: `role${state.nextId}`,
        name: body.name ?? "",
        inherited: body.inherited_roles ?? [],
      }
      state.nextId += 1
      state.roles.push(created)
      return json(roleJson(created, state.nextId === 2 ? PASSWORD : ROTATED_PASSWORD))
    }
    if (route === `GET ${BRANCH}/roles`) {
      const query = url.searchParams.get("q") ?? ""
      const page = Number(url.searchParams.get("page") ?? "1")
      state.listQueries.push(query)
      const matching = state.roles.filter((entry) => entry.name.includes(query))
      const more = page < matching.length
      return json({
        type: "list",
        current_page: page,
        per_page: 1,
        next_page: more ? page + 1 : null,
        next_page_url: null,
        prev_page: page > 1 ? page - 1 : null,
        prev_page_url: null,
        total_count: matching.length,
        total_pages: matching.length,
        data: matching.slice(page - 1, page).map((entry) => roleJson(entry, null)),
      })
    }
    const reset = url.pathname.match(/\/roles\/([^/]+)\/reset$/)
    if (reset !== null && request.method === "POST") {
      state.calls.push("resetRole")
      const found = state.roles.find((entry) => entry.id === reset[1])
      return found === undefined
        ? json({ code: "not_found", message: "no" }, 404)
        : json(roleJson(found, ROTATED_PASSWORD))
    }
    const named = url.pathname.match(/\/roles\/([^/]+)$/)
    const role = state.roles.find((entry) => entry.id === named?.[1])
    if (named !== null && request.method === "GET") {
      if (state.getStatus !== 200) return json({ code: "denied", message: "no" }, state.getStatus)
      return role === undefined
        ? json({ code: "not_found", message: "no" }, 404)
        : json(roleJson(role, null))
    }
    if (named !== null && request.method === "DELETE") {
      state.calls.push("deleteRole")
      if (state.deleteStatus !== 200)
        return json(
          { code: "unprocessable", message: "Role is still referenced and cannot be dropped." },
          state.deleteStatus,
        )
      state.roles = state.roles.filter((entry) => entry.id !== named[1])
      return json({})
    }
    return json({ code: "unhandled", message: route }, 500)
  })

class RoleFailure extends Data.TaggedError("RoleFailure")<{ readonly message: string }> {}

type ProviderService = Effect.Success<typeof Neki.Role.Provider>

type ProviderOperations = {
  readonly reconcile: (
    input: Parameters<ProviderService["reconcile"]>[0],
  ) => Effect.Effect<NekiRoleAttributes, Error>
  readonly read?: (
    input: Parameters<NonNullable<ProviderService["read"]>>[0],
  ) => Effect.Effect<NekiRoleAttributes | undefined, Error>
  readonly delete: (input: Parameters<ProviderService["delete"]>[0]) => Effect.Effect<void, Error>
}

const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
}

const STACK = {
  name: "test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
  output: {},
  services: Context.empty(),
}

const environment = (port: number) =>
  NekiRoleProvider.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Planetscale.fromToken({
          tokenId: "id",
          token: "token",
          organization: "test-org",
          apiBaseUrl: `http://127.0.0.1:${port}/v1`,
        }),
        FetchHttpClient.layer,
        Layer.succeed(Stage, "test"),
        Layer.succeed(Stack, STACK),
      ),
    ),
  )

type Env = Layer.Success<ReturnType<typeof environment>>

describe("NekiRole provider against a recorded PlanetScale API", () => {
  let server: ReturnType<typeof Bun.serve>
  let runtime: ManagedRuntime.ManagedRuntime<Env, never>
  let state = fresh()

  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: (request) => Effect.runPromise(handle(state, request)) })
    runtime = ManagedRuntime.make(environment(server.port ?? 0))
  })
  afterAll(() => runtime.dispose().then(() => server.stop(true)))
  beforeEach(() => {
    state = fresh()
  })

  const props = (overrides: Partial<NekiRoleProps> = {}): NekiRoleProps => ({
    name: "app",
    database: "cells",
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
    ...overrides,
  })

  const lift = <A, R>(effect: Effect.Effect<A, Error, R>) =>
    Effect.mapError(effect, (error) => new RoleFailure({ message: String(error) }))

  const provider = Effect.map(Neki.Role.Provider, (service): ProviderOperations => service)

  const reconcile = (news: NekiRoleProps, output?: NekiRoleAttributes) =>
    Effect.gen(function* () {
      const service = yield* provider
      return yield* lift(
        service.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "instance",
          news,
          olds: undefined,
          output,
          session,
          bindings: [],
        }),
      )
    })

  const read = (output: NekiRoleAttributes) =>
    Effect.gen(function* () {
      const service = yield* provider
      return yield* lift(
        service.read?.({ id: "App", fqn: "App", instanceId: "instance", olds: props(), output }) ??
          Effect.undefined,
      )
    })

  const remove = (output: NekiRoleAttributes) =>
    Effect.gen(function* () {
      const service = yield* provider
      return yield* lift(
        service.delete({
          id: "App",
          fqn: "App",
          instanceId: "instance",
          olds: props(),
          output,
          session,
          bindings: [],
        }),
      )
    })

  const failure = <A>(effect: Effect.Effect<A, RoleFailure, Env>) =>
    Effect.match(effect, { onFailure: (error) => error.message, onSuccess: () => "succeeded" })

  const test = (name: string, program: () => Effect.Effect<void, RoleFailure, Env>) =>
    it(name, () => runtime.runPromise(Effect.suspend(program)))

  test("builds a router-group URL with the credentials percent-encoded", () =>
    Effect.gen(function* () {
      const attributes = yield* reconcile(props({ routerGroup: "edge" }))
      expect(Redacted.value(attributes.connectionUrl)).toBe(
        `postgresql://login.role1%7Cedge:${encodeURIComponent(PASSWORD)}@aws.connect.example.test:5432/postgres?sslmode=verify-full`,
      )
      expect(Redacted.value(attributes.connectionUrl)).not.toContain(PASSWORD)
      expect(attributes.username).toBe("login.role1")
      expect(state.bodies[0]).toMatchObject({
        name: "app",
        inherited_roles: ["pg_read_all_data", "pg_write_all_data"],
      })
    }))

  test("targets the default router group with the bare login", () =>
    Effect.gen(function* () {
      const attributes = yield* reconcile(props())
      expect(Redacted.value(attributes.connectionUrl)).toContain("//login.role1:")
      expect(Redacted.value(attributes.connectionUrl)).not.toContain("%7C")
    }))

  test("keeps the password from state when the role is read back and reconciled again", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      state.calls = []
      const readBack = yield* read(output)
      expect(readBack === undefined ? undefined : Redacted.value(readBack.password)).toBe(PASSWORD)
      const again = yield* reconcile(props(), output)
      expect(Redacted.value(again.password)).toBe(PASSWORD)
      expect(again.id).toBe(output.id)
      expect(state.calls).toEqual([])
    }))

  test("issues a new role with a new password when the recorded role is gone", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      state.roles = []
      expect(yield* read(output)).toBeUndefined()
      const rotated = yield* reconcile(props(), output)
      expect(state.calls).toEqual(["createRole", "createRole"])
      expect(rotated.id).toBe("role2")
      expect(Redacted.value(rotated.password)).toBe(ROTATED_PASSWORD)
      expect(Redacted.value(rotated.connectionUrl)).toContain(encodeURIComponent(ROTATED_PASSWORD))
    }))

  test("adopts the role a run created before its state was lost, under a new password", () =>
    Effect.gen(function* () {
      state.roles.push(
        { id: "decoy", name: "app-old", inherited: ["pg_read_all_data"] },
        { id: "gone", name: "app", inherited: ["postgres"], deleted: true },
      )
      const lost = yield* reconcile(props())
      expect(lost.id).toBe("role1")
      expect(state.calls).toEqual(["createRole"])
      const recovered = yield* reconcile(props())
      expect(state.calls).toEqual(["createRole", "resetRole"])
      expect(state.roles.filter((entry) => entry.name === "app" && entry.deleted !== true)).toEqual(
        [{ id: "role1", name: "app", inherited: ["pg_read_all_data", "pg_write_all_data"] }],
      )
      expect(recovered.id).toBe("role1")
      expect(Redacted.value(recovered.password)).toBe(ROTATED_PASSWORD)
      expect(Redacted.value(recovered.connectionUrl)).toContain(
        encodeURIComponent(ROTATED_PASSWORD),
      )
      expect(state.listQueries.every((query) => query === "app")).toBe(true)
      const again = yield* reconcile(props(), recovered)
      expect(again.id).toBe("role1")
      expect(Redacted.value(again.password)).toBe(ROTATED_PASSWORD)
      expect(state.calls).toEqual(["createRole", "resetRole"])
    }))

  test("refuses to adopt a role of the same name with other privileges", () =>
    Effect.gen(function* () {
      state.roles.push({ id: "foreign", name: "app", inherited: ["postgres"] })
      expect(yield* failure(reconcile(props()))).toContain("other privileges")
      expect(state.calls).toEqual([])
    }))

  test("does not treat a denied read as a missing role", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      state.getStatus = 403
      state.calls = []
      expect(yield* failure(read(output))).not.toBe("succeeded")
      expect(yield* failure(reconcile(props(), output))).not.toBe("succeeded")
      expect(state.calls).toEqual([])
    }))

  test("refuses a branch that is not a Neki branch", () =>
    Effect.gen(function* () {
      state.branchKind = "postgresql"
      expect(yield* failure(reconcile(props()))).toContain("postgresql")
      expect(state.calls).toEqual([])
    }))

  describe("delete", () => {
    test("deletes the role and treats one that is already gone as deleted", () =>
      Effect.gen(function* () {
        const output = yield* reconcile(props())
        yield* remove(output)
        expect(state.roles).toEqual([])
        yield* remove(output)
        expect(state.calls.filter((call) => call === "deleteRole")).toHaveLength(2)
      }))

    test("fails when the role is still referenced instead of reporting it deleted", () =>
      Effect.gen(function* () {
        const output = yield* reconcile(props())
        state.deleteStatus = 422
        expect(yield* failure(remove(output))).toContain("still referenced")
        expect(state.roles).toHaveLength(1)
      }))

    test("fails on a denied delete", () =>
      Effect.gen(function* () {
        const output = yield* reconcile(props())
        state.deleteStatus = 403
        expect(yield* failure(remove(output))).not.toBe("succeeded")
        expect(state.roles).toHaveLength(1)
      }))
  })
})
