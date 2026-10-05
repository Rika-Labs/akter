import * as Planetscale from "alchemy/Planetscale"
import { Stack } from "alchemy/Stack"
import { Stage } from "alchemy/Stage"
import { Context, Data, Effect, Exit, Layer, ManagedRuntime } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { NekiDatabaseProvider } from "./database.ts"
import type { NekiDatabaseAttributes, NekiDatabaseProps } from "./database.ts"
import { Neki } from "./resources.ts"
import { dataTopology, keyRanges, type DataTopology, type LiveTopology } from "./topology.ts"

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

type FakeShard = {
  id: string
  name: string
  display_name: null
  configuration_profile: string
  created_at: string
  ready: boolean
  authoritative: boolean
}

type FakeRouter = { name: string; router_size: string; replicas_per_cell: number }

type RequestBody = {
  readonly name?: string
  readonly cluster_size?: string
  readonly replicas?: number
  readonly count?: number
  readonly router_size?: string
  readonly replicas_per_cell?: number
  readonly region?: string
  readonly kind?: string
  readonly data_topology?: DataTopology
  readonly deletion_protected?: boolean
}

type FakeState = {
  exists: boolean
  kind: string
  protected: boolean
  profileSize: string
  profileReplicas: number
  shards: FakeShard[]
  routers: FakeRouter[]
  topology: DataTopology | LiveTopology | undefined
  calls: string[]
  bodies: Record<string, RequestBody[]>
}

const NEW_SHARD_NAMES = ["zeta", "yankee", "xray", "whiskey", "victor"]

/**
 * The topology PlanetScale reports for a Neki database created in the dashboard and never
 * configured: one shard group over the authoritative shard and no table placements.
 */
const unplacedTopology: LiveTopology = {
  shard_groups: [{ uid: "meta", key_ranges: [{ shard_uid: "meta" }] }],
  default_shard_group: "meta",
  authoritative_shard_group: "meta",
}

const fresh = (): FakeState => ({
  exists: false,
  kind: "neki",
  protected: false,
  profileSize: "PS_10",
  profileReplicas: 0,
  shards: [],
  routers: [],
  topology: undefined,
  calls: [],
  bodies: {},
})

const shard = (name: string, order: number, authoritative: boolean): FakeShard => ({
  id: `id-${name}`,
  name,
  display_name: null,
  configuration_profile: "default",
  created_at: `2026-01-01T00:00:0${order}Z`,
  ready: true,
  authoritative,
})

const profile = (state: FakeState) => ({
  id: "profile-id",
  name: "default",
  architecture: "aarch64",
  cluster_size: state.profileSize,
  cluster_display_name: state.profileSize,
  default: true,
  metal: false,
  replicas: state.profileReplicas,
  postgres_image_version: "18",
  latest_postgres_image_version: "18",
  postgres_major_version: 18,
  postgres_minor_version: 1,
  latest_postgres_minor_version: 1,
  shards: state.shards.length,
  storage: {
    minimum_storage_bytes: null,
    maximum_storage_bytes: null,
    storage_autoscaling: null,
    storage_iops: null,
    storage_throughput_mibs: null,
  },
  state: "ready",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
})

const router = (entry: FakeRouter) => ({
  id: `router-${entry.name}`,
  name: entry.name,
  default: entry.name === "default",
  sku: {
    name: entry.router_size,
    display_name: entry.router_size,
    cpu: "1",
    ram: 1,
    sort_order: 1,
    rate: null,
    enabled: true,
  },
  router_size: entry.router_size,
  replicas_per_cell: entry.replicas_per_cell,
  autoscaling: false,
  max_replicas_per_cell: null,
  target_cpu_utilization: null,
  state: "ready",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
})

const branch = {
  id: "branch-id",
  name: "main",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  restore_checklist_completed_at: null,
  schema_last_updated_at: null,
  kind: "neki",
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
}

const database = (state: FakeState) => ({
  id: "database-id",
  url: "https://example.test/database",
  branches_url: "https://example.test/branches",
  ready: true,
  region: REGION,
  html_url: "https://example.test/database",
  name: "cells",
  state: "ready",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  kind: state.kind,
  deletion_protected: state.protected,
  default_branch: "main",
})

type Json =
  | null
  | string
  | number
  | boolean
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json | undefined }

const json = (body: Json, status = 200) => Response.json(body, { status })

const notFound = () => json({ code: "not_found", message: "not found" }, 404)

const BASE = "/v1/organizations/test-org/databases/cells"
const BRANCH = `${BASE}/branches/main`

const record = (state: FakeState, label: string, body: RequestBody) => {
  state.calls.push(label)
  state.bodies[label] = [...(state.bodies[label] ?? []), body]
}

const handle = (state: FakeState, request: Request) =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`
    const body: RequestBody =
      request.method === "GET" || request.method === "DELETE"
        ? {}
        : yield* Effect.promise(() => request.json())
    if (route === "POST /v1/organizations/test-org/databases") {
      record(state, "createDatabase", body)
      state.exists = true
      state.shards = [shard("meta", 0, true)]
      state.routers = [{ name: "default", router_size: "NKR_1", replicas_per_cell: 1 }]
      state.profileSize = body.cluster_size ?? state.profileSize
      state.profileReplicas = body.replicas ?? 0
      return json(database(state))
    }
    if (route === `GET ${BASE}`) return state.exists ? json(database(state)) : notFound()
    if (route === `DELETE ${BASE}`) {
      record(state, "deleteDatabase", body)
      if (!state.exists) return notFound()
      state.exists = false
      return json({})
    }
    if (!state.exists) return notFound()
    if (route === `PATCH ${BASE}`) {
      record(state, "updateSettings", body)
      state.protected = body.deletion_protected ?? state.protected
      return json(database(state))
    }
    if (route === `GET ${BRANCH}`) return json(branch)
    if (route === `GET ${BRANCH}/configuration-profiles`) return json([profile(state)])
    if (route === `GET ${BRANCH}/configuration-profiles/default`) return json(profile(state))
    if (route === `PATCH ${BRANCH}/configuration-profiles/default`) {
      record(state, "updateProfile", body)
      state.profileSize = body.cluster_size ?? state.profileSize
      state.profileReplicas = body.replicas ?? state.profileReplicas
      return json(profile(state))
    }
    if (route === `GET ${BRANCH}/shards`)
      return json({
        type: "list",
        current_page: 1,
        per_page: 100,
        next_page: null,
        next_page_url: null,
        prev_page: null,
        prev_page_url: null,
        data: [...state.shards].reverse(),
      })
    if (route === `POST ${BRANCH}/configuration-profiles/default/shards/bulk`) {
      record(state, "createShards", body)
      const created = Array.from({ length: body.count ?? 0 }, (_, index) =>
        shard(
          NEW_SHARD_NAMES[state.shards.length - 1 + index] ?? `extra${index}`,
          state.shards.length + index,
          false,
        ),
      )
      state.shards.push(...created)
      return json({ created: created.length, shard_ids: created.map((item) => item.id) })
    }
    if (route === `GET ${BRANCH}/data-topology`)
      return json({ data_topology: state.topology ?? {}, synced_at: null })
    if (route === `PUT ${BRANCH}/data-topology`) {
      record(state, "updateTopology", body)
      state.topology = body.data_topology
      return json({ data_topology: body.data_topology ?? {}, synced_at: null })
    }
    if (route === `GET ${BRANCH}/routers`) return json(state.routers.map(router))
    if (route === `POST ${BRANCH}/routers`) {
      record(state, "createRouter", body)
      const created = {
        name: body.name ?? "",
        router_size: body.router_size ?? "NKR_1",
        replicas_per_cell: body.replicas_per_cell ?? 1,
      }
      state.routers.push(created)
      return json(router(created))
    }
    const named = url.pathname.match(/\/routers\/([^/]+)$/)
    const target = state.routers.find((entry) => entry.name === named?.[1])
    if (named !== null && request.method === "PATCH") {
      record(state, "updateRouter", body)
      if (target === undefined) return notFound()
      target.router_size = body.router_size ?? target.router_size
      target.replicas_per_cell = body.replicas_per_cell ?? target.replicas_per_cell
      return json(router(target))
    }
    if (named !== null && request.method === "DELETE") {
      record(state, "deleteRouter", { name: named[1] })
      state.routers = state.routers.filter((entry) => entry.name !== named[1])
      return json({})
    }
    return json({ code: "unhandled", message: route }, 500)
  })

class ProviderFailure extends Data.TaggedError("ProviderFailure")<{ readonly message: string }> {}

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
  NekiDatabaseProvider.pipe(
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

type ProviderService = Effect.Success<typeof Neki.Database.Provider>

type ProviderOperations = {
  readonly reconcile: (
    input: Parameters<ProviderService["reconcile"]>[0],
  ) => Effect.Effect<NekiDatabaseAttributes, Error>
  readonly delete: (input: Parameters<ProviderService["delete"]>[0]) => Effect.Effect<void, Error>
  readonly diff?: (
    input: Parameters<NonNullable<ProviderService["diff"]>>[0],
  ) => Effect.Effect<{ readonly action: string } | void, Error>
}

type Env = Layer.Success<ReturnType<typeof environment>>

describe("NekiDatabase provider against a recorded PlanetScale API", () => {
  let server: ReturnType<typeof Bun.serve>
  let runtime: ManagedRuntime.ManagedRuntime<Env, never>
  let state = fresh()

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (request) => Effect.runPromise(handle(state, request)),
    })
    runtime = ManagedRuntime.make(environment(server.port ?? 0))
  })
  afterAll(() => runtime.dispose().then(() => server.stop(true)))
  beforeEach(() => {
    state = fresh()
  })

  const routed = { routedTables: ["actor_outbox"] }

  const props = (overrides: Partial<NekiDatabaseProps> = {}): NekiDatabaseProps => ({
    name: "cells",
    clusterSize: "PS_10",
    ...overrides,
  })

  const lift = <A, R>(effect: Effect.Effect<A, Error, R>) =>
    Effect.mapError(effect, (error) => new ProviderFailure({ message: String(error) }))

  const provider = Effect.map(Neki.Database.Provider, (service): ProviderOperations => service)

  const reconcile = (
    news: NekiDatabaseProps,
    previous?: { output: NekiDatabaseAttributes; olds: NekiDatabaseProps },
  ) =>
    Effect.gen(function* () {
      const service = yield* provider
      return yield* lift(
        service.reconcile({
          id: "Cells",
          fqn: "Cells",
          instanceId: "instance",
          news,
          olds: previous?.olds,
          output: previous?.output,
          session,
          bindings: [],
        }),
      )
    })

  const remove = (output: NekiDatabaseAttributes) =>
    Effect.gen(function* () {
      const service = yield* provider
      return yield* lift(
        service.delete({
          id: "Cells",
          fqn: "Cells",
          instanceId: "instance",
          olds: props(),
          output,
          session,
          bindings: [],
        }),
      )
    })

  const refusal = (effect: Effect.Effect<NekiDatabaseAttributes, ProviderFailure, Env>) =>
    Effect.match(effect, { onFailure: (error) => error.message, onSuccess: () => "succeeded" })

  const test = (name: string, program: () => Effect.Effect<void, ProviderFailure, Env>) =>
    it(name, () => runtime.runPromise(Effect.suspend(program)))

  const topologyOf = (dataShards: ReadonlyArray<string>, routedTables: ReadonlyArray<string>) =>
    dataTopology({
      authoritativeShard: "meta",
      dataShards,
      database: "postgres",
      schema: "public",
      routedTables,
    })

  test("creates a four-shard cluster, splits the key space over the new shards in creation order and sizes the routers", () =>
    Effect.gen(function* () {
      const attributes = yield* reconcile(
        props({
          shardCount: 4,
          region: "us-east",
          replicas: 2,
          routers: [
            { name: "default", size: "NKR_2", replicasPerCell: 2 },
            { name: "edge", size: "NKR_1" },
          ],
          routedTables: ["actor_outbox"],
        }),
      )
      expect(state.calls).toEqual([
        "createDatabase",
        "createShards",
        "updateTopology",
        "updateRouter",
        "createRouter",
      ])
      expect(state.bodies.createDatabase?.[0]).toMatchObject({
        kind: "neki",
        name: "cells",
        region: "us-east",
        cluster_size: "PS_10",
        replicas: 2,
      })
      expect(state.bodies.createShards?.[0]).toMatchObject({ count: 4 })
      const created = ["zeta", "yankee", "xray", "whiskey"]
      expect(attributes.authoritativeShard).toBe("meta")
      expect(attributes.dataShards).toEqual(created)
      expect(attributes.routerGroups).toEqual(["edge"])
      expect(state.bodies.updateTopology?.[0]?.data_topology).toEqual(
        topologyOf(created, ["actor_outbox"]),
      )
      expect(keyRanges(created).map((range) => range.start)).toEqual([undefined, "40", "80", "c0"])
      expect(state.bodies.updateRouter?.[0]).toMatchObject({
        router_size: "NKR_2",
        replicas_per_cell: 2,
      })
    }))

  test("keeps the data on the authoritative shard for the unsharded start and creates no shard", () =>
    Effect.gen(function* () {
      const attributes = yield* reconcile(props())
      expect(state.calls).toEqual(["createDatabase", "updateTopology"])
      expect(attributes.dataShards).toEqual(["meta"])
      expect(state.shards).toHaveLength(1)
    }))

  test("is idempotent: a second reconcile of the same props writes nothing", () =>
    Effect.gen(function* () {
      const olds = props({ ...routed, shardCount: 2 })
      const output = yield* reconcile(olds)
      state.calls = []
      yield* reconcile(olds, { output, olds })
      expect(state.calls).toEqual([])
    }))

  test("refuses to overwrite a live topology that places data differently and writes nothing", () =>
    Effect.gen(function* () {
      const olds = props({ ...routed, shardCount: 2 })
      const output = yield* reconcile(olds)
      state.calls = []
      const message = yield* refusal(
        reconcile(props({ ...routed, shardCount: 3 }), { output, olds }),
      )
      expect(message).toContain("resharding workflows")
      expect(state.calls).toEqual([])
      expect(state.shards.filter((item) => !item.authoritative)).toHaveLength(2)
    }))

  test("places an adopted single-shard database that was never given a topology, and nothing else", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      state.topology = unplacedTopology
      state.calls = []
      yield* reconcile(props(), { output, olds: props() })
      expect(state.calls).toContain("updateTopology")
      expect(state.topology?.databases).toBeDefined()
    }))

  test("accepts a single-shard database a stopped run placed before it saved its shards", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      state.calls = []
      yield* reconcile(props(), { output: { ...output, dataShards: [] }, olds: props() })
      expect(state.calls).not.toContain("createShard")
      expect(state.shards).toHaveLength(1)
    }))

  test("rewrites a single-shard database's routed tables, since one shard holds every group", () =>
    Effect.gen(function* () {
      const olds = props()
      const output = yield* reconcile(olds)
      const news = props({ routedTables: ["actor_outbox", "actor_state"] })
      state.calls = []
      yield* reconcile(news, { output, olds })
      expect(state.calls).toEqual(["updateTopology"])
      expect(state.topology?.databases?.["postgres"]?.schemas?.["public"]?.tables).toMatchObject({
        actor_state: { shard_group: "actor_data" },
      })
    }))

  test("refuses to place an unconfigured database that already has more than one shard", () =>
    Effect.gen(function* () {
      const olds = props({ ...routed, shardCount: 2 })
      const output = yield* reconcile(olds)
      state.topology = unplacedTopology
      state.calls = []
      expect(yield* refusal(reconcile(olds, { output, olds }))).toContain("resharding workflows")
      expect(state.calls).toEqual([])
    }))

  test("refuses when the live topology was resharded behind the props", () =>
    Effect.gen(function* () {
      const olds = props({ ...routed, shardCount: 2 })
      const output = yield* reconcile(olds)
      state.topology = topologyOf(["other-a", "other-b"], routed.routedTables)
      state.calls = []
      expect(yield* refusal(reconcile(olds, { output, olds }))).toContain("resharding workflows")
      expect(state.calls).toEqual([])
    }))

  test("refuses changed routing semantics before a requested profile resize writes anything", () =>
    Effect.gen(function* () {
      const olds = props({ ...routed, shardCount: 2 })
      const output = yield* reconcile(olds)
      const generated = topologyOf(output.dataShards, routed.routedTables)
      state.topology = {
        ...generated,
        shard_indexes: { routing_key_range: { type: "range", columns: ["wrong_key"] } },
      }
      state.calls = []
      expect(
        yield* refusal(
          reconcile(props({ ...routed, shardCount: 2, clusterSize: "PS_80" }), { output, olds }),
        ),
      ).toContain("resharding workflows")
      expect(state.calls).toEqual([])
      expect(state.profileSize).toBe("PS_10")
    }))

  test("resizes the configuration profile in place and does not touch the topology", () =>
    Effect.gen(function* () {
      const olds = props()
      const output = yield* reconcile(olds)
      state.calls = []
      const next = yield* reconcile(props({ clusterSize: "PS_80", replicas: 2 }), { output, olds })
      expect(next.clusterSize).toBe("PS_80")
      expect(next.replicas).toBe(2)
      expect(state.calls).toEqual(["updateProfile"])
      expect(state.bodies.updateProfile?.[0]).toMatchObject({
        cluster_size: "PS_80",
        replicas: 2,
      })
    }))

  test("turns deletion protection on and back off only when the prop differs", () =>
    Effect.gen(function* () {
      const olds = props({ deletionProtected: true })
      const output = yield* reconcile(olds)
      expect(state.protected).toBe(true)
      expect(state.calls.filter((call) => call === "updateSettings")).toHaveLength(1)
      state.calls = []
      yield* reconcile(olds, { output, olds })
      expect(state.calls).not.toContain("updateSettings")
      yield* reconcile(props({ deletionProtected: false }), { output, olds })
      expect(state.protected).toBe(false)
      expect(state.calls.filter((call) => call === "updateSettings")).toHaveLength(1)
    }))

  test("leaves deletion protection alone when the prop is unset", () =>
    Effect.gen(function* () {
      yield* reconcile(props())
      expect(state.calls).not.toContain("updateSettings")
    }))

  test("deletes the routers it created that the props no longer name", () =>
    Effect.gen(function* () {
      const olds = props({ routers: [{ name: "edge" }] })
      const output = yield* reconcile(olds)
      state.calls = []
      const next = yield* reconcile(props(), { output, olds })
      expect(state.calls).toEqual(["deleteRouter"])
      expect(next.routerGroups).toEqual([])
    }))

  test("recreates a database deleted behind the state and uses the new shards, not the recorded ones", () =>
    Effect.gen(function* () {
      const olds = props({ ...routed, shardCount: 2 })
      const output = yield* reconcile(olds)
      state = fresh()
      const next = yield* reconcile(olds, { output, olds })
      expect(state.calls).toEqual(["createDatabase", "createShards", "updateTopology"])
      expect(next.dataShards).toEqual(["zeta", "yankee"])
      expect(state.topology).toEqual(topologyOf(["zeta", "yankee"], routed.routedTables))
    }))

  test("refuses a database of another kind", () =>
    Effect.gen(function* () {
      state.exists = true
      state.kind = "postgresql"
      state.shards = [shard("meta", 0, true)]
      const message = yield* refusal(reconcile(props()))
      expect(message).toContain("postgresql")
      expect(state.calls).toEqual([])
    }))

  test("treats a database that is already gone as deleted", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      yield* remove(output)
      expect(state.exists).toBe(false)
      yield* remove(output)
      expect(state.calls.filter((call) => call === "deleteDatabase")).toHaveLength(2)
    }))

  describe("diff", () => {
    const diff = (
      news: NekiDatabaseProps,
      olds: NekiDatabaseProps,
      output: NekiDatabaseAttributes,
    ) =>
      Effect.gen(function* () {
        const service = yield* provider
        return yield* lift(
          service.diff?.({
            id: "Cells",
            fqn: "Cells",
            instanceId: "instance",
            olds,
            news,
            oldBindings: [],
            newBindings: [],
            output,
          }) ?? Effect.void,
        )
      })

    const outcome = (
      news: NekiDatabaseProps,
      olds: NekiDatabaseProps,
      output: NekiDatabaseAttributes,
    ) => Effect.map(diff(news, olds, output), (result) => result?.action ?? "noop")

    test("replaces on a name, region, organization or major version change and updates on the rest", () =>
      Effect.gen(function* () {
        const olds = props({ region: "us-east", majorVersion: "18" })
        const output = yield* reconcile(olds)
        expect(yield* outcome(olds, olds, output)).toBe("noop")
        expect(yield* outcome({ ...olds, name: "other" }, olds, output)).toBe("replace")
        expect(yield* outcome({ ...olds, region: "eu-west" }, olds, output)).toBe("replace")
        expect(yield* outcome({ ...olds, organization: "another" }, olds, output)).toBe("replace")
        expect(yield* outcome({ ...olds, majorVersion: "17" }, olds, output)).toBe("replace")
        expect(yield* outcome({ ...olds, clusterSize: "PS_80" }, olds, output)).toBe("update")
        expect(yield* outcome({ ...olds, ...routed, shardCount: 4 }, olds, output)).toBe("update")
      }))

    test("rejects data shards for a topology that routes no table before any provider call", () =>
      Effect.gen(function* () {
        const output = yield* reconcile(props())
        state.calls = []
        const exit = yield* Effect.exit(diff(props({ shardCount: 2 }), props(), output))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(String(exit)).toContain("routedTables")
        expect(state.calls).toEqual([])
        expect(
          Exit.isSuccess(
            yield* Effect.exit(diff(props({ ...routed, shardCount: 2 }), props(), output)),
          ),
        ).toBe(true)
      }))

    test("rejects routing a table that is not a framework per-actor table before any provider call", () =>
      Effect.gen(function* () {
        const output = yield* reconcile(props())
        state.calls = []
        for (const table of ["cloud_billing_state", "tenant_directory", "actor_placements"]) {
          const exit = yield* Effect.exit(
            diff(props({ routedTables: ["actor_outbox", table] }), props(), output),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          expect(String(exit)).toContain(table)
        }
        expect(state.calls).toEqual([])
      }))

    test("rejects a shard count that cannot align to buckets before any provider call", () =>
      Effect.gen(function* () {
        const output = yield* reconcile(props())
        state.calls = []
        const exit = yield* Effect.exit(
          diff(props({ ...routed, shardCount: 300 }), props(), output),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(state.calls).toEqual([])
      }))
  })
})
