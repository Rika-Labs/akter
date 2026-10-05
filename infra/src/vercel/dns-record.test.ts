import { Credentials } from "@distilled.cloud/vercel"
import { Data, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DnsRecordProvider } from "./dns-record.ts"
import type { DnsRecordAttributes, DnsRecordProps } from "./dns-record.ts"
import { Vercel } from "./resources.ts"

type Json =
  | null
  | string
  | number
  | boolean
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json | undefined }

type FakeRecord = {
  id: string
  name: string
  type: string
  value: string
  mxPriority?: number
  ttl?: number
  comment?: string
}

type CreateBody = {
  readonly name?: string
  readonly type?: string
  readonly value?: string
  readonly mxPriority?: number
  readonly ttl?: number
  readonly comment?: string
}

type FakeState = {
  records: FakeRecord[]
  nextId: number
  calls: string[]
  queries: string[]
  pageSize: number
  deleteStatus: number
  stuckCursor: number | undefined
}

const fresh = (): FakeState => ({
  records: [],
  nextId: 1,
  calls: [],
  queries: [],
  pageSize: 100,
  deleteStatus: 200,
  stuckCursor: undefined,
})

const json = (body: Json, status = 200) => Response.json(body, { status })

const listed = (record: FakeRecord) => ({
  ...record,
  slug: record.id,
  creator: "user",
  created: 1,
  updated: 1,
  createdAt: 1,
  updatedAt: 1,
})

const handle = (state: FakeState, request: Request) =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    state.queries.push(url.search)
    const collection = url.pathname.match(/^\/(v2|v5)\/domains\/([^/]+)\/records$/)
    if (collection !== null && request.method === "POST") {
      const body: CreateBody = yield* Effect.promise(() => request.json())
      state.calls.push("create")
      const record: FakeRecord = {
        id: `rec_${state.nextId}`,
        name: body.name ?? "",
        type: body.type ?? "",
        value: body.value ?? "",
        mxPriority: body.mxPriority,
        ttl: body.ttl,
        comment: body.comment,
      }
      state.nextId += 1
      state.records.push(record)
      return json({ uid: record.id, updated: 0 })
    }
    if (collection !== null && request.method === "GET") {
      state.calls.push("list")
      const until = Number(url.searchParams.get("until") ?? state.records.length)
      const page = state.records.slice(Math.max(0, until - state.pageSize), until)
      const next = until - state.pageSize
      return json({
        records: [...page].reverse().map(listed),
        pagination: {
          count: page.length,
          next: state.stuckCursor ?? (next > 0 ? next : null),
          prev: null,
        },
      })
    }
    const single = url.pathname.match(/\/records\/([^/]+)$/)
    const target = state.records.find((record) => record.id === single?.[1])
    if (single !== null && request.method === "PATCH") {
      const body: CreateBody = yield* Effect.promise(() => request.json())
      state.calls.push("update")
      if (target === undefined) return json({ error: { code: "not_found", message: "no" } }, 404)
      Object.assign(target, {
        name: body.name ?? target.name,
        type: body.type ?? target.type,
        value: body.value ?? target.value,
        mxPriority: body.mxPriority ?? target.mxPriority,
        ttl: body.ttl ?? target.ttl,
      })
      return json({ uid: target.id })
    }
    if (single !== null && request.method === "DELETE") {
      state.calls.push("delete")
      if (state.deleteStatus !== 200)
        return json({ error: { code: "forbidden", message: "no" } }, state.deleteStatus)
      if (target === undefined) return json({ error: { code: "not_found", message: "no" } }, 404)
      state.records = state.records.filter((record) => record !== target)
      return json({})
    }
    return json({ error: { code: "unhandled", message: url.pathname } }, 500)
  })

class RecordFailure extends Data.TaggedError("RecordFailure")<{ readonly message: string }> {}

type ProviderService = Effect.Success<typeof Vercel.DnsRecord.Provider>

type DiffResult = { readonly action: string; readonly deleteFirst?: boolean } | void

type ProviderOperations = {
  readonly reconcile: (
    input: Parameters<ProviderService["reconcile"]>[0],
  ) => Effect.Effect<DnsRecordAttributes, Error>
  readonly read?: (
    input: Parameters<NonNullable<ProviderService["read"]>>[0],
  ) => Effect.Effect<DnsRecordAttributes | undefined, Error>
  readonly delete: (input: Parameters<ProviderService["delete"]>[0]) => Effect.Effect<void, Error>
  readonly diff?: (
    input: Parameters<NonNullable<ProviderService["diff"]>>[0],
  ) => Effect.Effect<DiffResult, Error>
}

const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
}

const environment = (port: number) =>
  DnsRecordProvider.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          Credentials,
          Effect.succeed({
            token: Redacted.make("test-token"),
            apiBaseUrl: `http://127.0.0.1:${port}`,
          }),
        ),
        FetchHttpClient.layer,
      ),
    ),
  )

type Env = Layer.Success<ReturnType<typeof environment>>

describe("DnsRecord provider against a recorded Vercel API", () => {
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

  const props = (overrides: Partial<DnsRecordProps> = {}): DnsRecordProps => ({
    domain: "akter.dev",
    name: "api",
    type: "CNAME",
    value: "akter-prod-api.fly.dev",
    ...overrides,
  })

  const lift = <A, R>(effect: Effect.Effect<A, Error, R>) =>
    Effect.mapError(effect, (error) => new RecordFailure({ message: String(error) }))

  const provider = Effect.map(Vercel.DnsRecord.Provider, (service): ProviderOperations => service)

  const base = { id: "Api", fqn: "api/Dns", instanceId: "instance" }

  const reconcile = (news: DnsRecordProps, output?: DnsRecordAttributes) =>
    Effect.gen(function* () {
      const service = yield* provider
      return yield* lift(
        service.reconcile({ ...base, news, olds: undefined, output, session, bindings: [] }),
      )
    })

  const read = (olds: DnsRecordProps, output?: DnsRecordAttributes) =>
    Effect.gen(function* () {
      const service = yield* provider
      return yield* lift(service.read?.({ ...base, olds, output }) ?? Effect.undefined)
    })

  const remove = (output: DnsRecordAttributes) =>
    Effect.gen(function* () {
      const service = yield* provider
      return yield* lift(
        service.delete({
          ...base,
          olds: props(),
          output,
          session,
          bindings: [],
        }),
      )
    })

  const diff = (news: DnsRecordProps, output: DnsRecordAttributes) =>
    Effect.gen(function* () {
      const service = yield* provider
      return yield* lift(
        service.diff?.({
          ...base,
          olds: props(),
          news,
          oldBindings: [],
          newBindings: [],
          output,
        }) ?? Effect.void,
      )
    })

  const failure = <A>(effect: Effect.Effect<A, RecordFailure, Env>) =>
    Effect.match(effect, { onFailure: (error) => error.message, onSuccess: () => "succeeded" })

  const test = (name: string, program: () => Effect.Effect<void, RecordFailure, Env>) =>
    it(name, () => runtime.runPromise(Effect.suspend(program)))

  test("creates a record with its name, type and value, and reports the fully qualified name", () =>
    Effect.gen(function* () {
      const attributes = yield* reconcile(props({ name: "api-pr-4.preview" }))
      expect(state.records).toEqual([
        {
          id: "rec_1",
          name: "api-pr-4.preview",
          type: "CNAME",
          value: "akter-prod-api.fly.dev",
          comment: "Managed by Alchemy",
        },
      ])
      expect(attributes).toMatchObject({
        id: "rec_1",
        fqdn: "api-pr-4.preview.akter.dev",
        value: "akter-prod-api.fly.dev",
      })
    }))

  test("sends an MX priority and the team the domain belongs to", () =>
    Effect.gen(function* () {
      yield* reconcile(
        props({
          name: "",
          type: "MX",
          value: "mx.example.test",
          mxPriority: 10,
          teamId: "team_abc",
        }),
      )
      expect(state.records[0]).toMatchObject({ type: "MX", mxPriority: 10, name: "" })
      expect(state.queries.every((query) => query.includes("teamId=team_abc"))).toBe(true)
    }))

  test("names the apex by its domain", () =>
    Effect.gen(function* () {
      const attributes = yield* reconcile(props({ name: "", type: "A", value: "1.2.3.4" }))
      expect(attributes.fqdn).toBe("akter.dev")
    }))

  test("does not create or change anything when the record is already right", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      state.calls = []
      const again = yield* reconcile(props(), output)
      expect(again.id).toBe(output.id)
      expect(state.calls).toEqual(["list"])
      expect(state.records).toHaveLength(1)
    }))

  test("updates the record in place when only its value changes", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      const changed = yield* reconcile(props({ value: "akter-prod-api-2.fly.dev" }), output)
      expect(changed.id).toBe(output.id)
      expect(state.calls.filter((call) => call !== "list")).toEqual(["create", "update"])
      expect(state.records[0]?.value).toBe("akter-prod-api-2.fly.dev")
    }))

  test("replaces the record, deleting first, when its name or type changes", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      expect(yield* diff(props({ name: "edge" }), output)).toEqual({
        action: "replace",
        deleteFirst: true,
      })
      expect(yield* diff(props({ type: "TXT" }), output)).toEqual({
        action: "replace",
        deleteFirst: true,
      })
      expect(yield* diff(props({ domain: "akter.run" }), output)).toEqual({
        action: "replace",
        deleteFirst: true,
      })
      expect(yield* diff(props({ value: "elsewhere.fly.dev" }), output)).toBeUndefined()
    }))

  test("takes back its own record after a lost state write instead of duplicating it", () =>
    Effect.gen(function* () {
      yield* reconcile(props())
      const recovered = yield* reconcile(props({ value: "akter-prod-api-2.fly.dev" }))
      expect(state.records).toHaveLength(1)
      expect(recovered.id).toBe("rec_1")
      expect(state.records[0]?.value).toBe("akter-prod-api-2.fly.dev")
    }))

  test("adopts a record made by hand only when it already holds the wanted value", () =>
    Effect.gen(function* () {
      state.records.push({
        id: "rec_hand",
        name: "api",
        type: "CNAME",
        value: "akter-prod-api.fly.dev",
      })
      const adopted = yield* reconcile(props())
      expect(adopted.id).toBe("rec_hand")
      expect(state.calls).not.toContain("create")
    }))

  test("leaves records it did not make alone, such as the domain's mail records", () =>
    Effect.gen(function* () {
      state.records.push(
        { id: "rec_spf", name: "", type: "TXT", value: "v=spf1 include:_spf.example.test ~all" },
        { id: "rec_mx", name: "", type: "MX", value: "mx.example.test", mxPriority: 1 },
        { id: "rec_dkim", name: "resend._domainkey", type: "TXT", value: "p=KEY" },
      )
      const before = structuredClone(state.records)
      const attributes = yield* reconcile(props({ name: "", type: "TXT", value: "other=1" }))
      expect(attributes.id).not.toBe("rec_spf")
      expect(state.records.slice(0, 3)).toEqual(before)
      expect(state.records).toHaveLength(4)
      yield* remove(attributes)
      expect(state.records).toEqual(before)
    }))

  test("finds its record past the first page of a large zone", () =>
    Effect.gen(function* () {
      state.pageSize = 2
      for (let index = 0; index < 5; index++)
        state.records.push({
          id: `rec_x${index}`,
          name: `host${index}`,
          type: "A",
          value: "1.1.1.1",
        })
      state.nextId = 10
      state.records.unshift({
        id: "rec_old",
        name: "api",
        type: "CNAME",
        value: "akter-prod-api.fly.dev",
        comment: "Managed by Alchemy",
      })
      const adopted = yield* reconcile(props())
      expect(adopted.id).toBe("rec_old")
      expect(state.calls).not.toContain("create")
    }))

  test("follows the cursor past fifty pages to find its record", () =>
    Effect.gen(function* () {
      state.pageSize = 1
      state.records.push({
        id: "rec_old",
        name: "api",
        type: "CNAME",
        value: "akter-prod-api.fly.dev",
        comment: "Managed by Alchemy",
      })
      for (let index = 0; index < 120; index++)
        state.records.push({
          id: `rec_x${index}`,
          name: `host${index}`,
          type: "A",
          value: "1.1.1.1",
        })
      state.nextId = 200
      const adopted = yield* reconcile(props())
      expect(adopted.id).toBe("rec_old")
      expect(state.calls).not.toContain("create")
      expect(state.calls.filter((call) => call === "list")).toHaveLength(121)
      expect((yield* read(props()))?.id).toBe("rec_old")
    }))

  test("fails rather than loop or stop early when Vercel repeats a cursor", () =>
    Effect.gen(function* () {
      state.pageSize = 1
      state.stuckCursor = 5
      for (let index = 0; index < 3; index++)
        state.records.push({
          id: `rec_x${index}`,
          name: `host${index}`,
          type: "A",
          value: "1.1.1.1",
        })
      expect((yield* Effect.exit(reconcile(props())))._tag).toBe("Failure")
      expect(state.calls).not.toContain("create")
      expect(state.calls.filter((call) => call === "list")).toHaveLength(2)
    }))

  test("reads a missing record as gone and a present one as itself", () =>
    Effect.gen(function* () {
      const output = yield* reconcile(props())
      expect((yield* read(props(), output))?.id).toBe(output.id)
      state.records = []
      expect(yield* read(props(), output)).toBeUndefined()
      expect(yield* read(props())).toBeUndefined()
    }))

  describe("delete", () => {
    test("removes the record and treats one that is already gone as removed", () =>
      Effect.gen(function* () {
        const output = yield* reconcile(props())
        yield* remove(output)
        expect(state.records).toEqual([])
        yield* remove(output)
        expect(state.calls.filter((call) => call === "delete")).toHaveLength(2)
      }))

    test("fails on a denied delete instead of reporting the record removed", () =>
      Effect.gen(function* () {
        const output = yield* reconcile(props())
        state.deleteStatus = 403
        expect(yield* failure(remove(output))).not.toBe("succeeded")
        expect(state.records).toHaveLength(1)
      }))
  })
})
