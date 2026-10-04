import { ProjectId } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  apiResponder,
  forbidden,
  type MockedAnswer,
  notFound,
  notImplemented,
  signedIn,
} from "../overview/testing.ts"
import { loadActor, loadActorType, loadActors } from "./client.ts"
import { ActorPage, ActorsPage, ActorTypePage, MissingActorPage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("actors client in fixture mode", () => {
  it("serves types, one type with its instances and an inspector, and nothing for an unknown name", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const actors = yield* loadActors
        expect(actors.sample).toBe(true)
        expect(Schema.is(ActorsPage)(actors.data)).toBe(true)
        expect(actors.data.types).toHaveLength(8)
        const order = yield* loadActorType("Order")
        expect(order.sample).toBe(true)
        expect(Schema.is(ActorTypePage)(order.data)).toBe(true)
        expect(order.data?.instances.map((instance) => instance.key)).toContain("ord_9a01")
        expect(order.data?.activity?.perSecond).toHaveLength(96)
        const inspected = yield* loadActor({ actorType: "Order", key: "ord_9a01" })
        expect(inspected.sample).toBe(true)
        expect(Schema.is(ActorPage)(inspected.data)).toBe(true)
        expect(inspected.data).toMatchObject({ actorType: "Order", key: "ord_9a01" })
        expect((yield* loadActorType("Nope")).data).toBeUndefined()
        expect((yield* loadActor({ actorType: "Nope", key: "x" })).data).toBeUndefined()
      }),
    ))
})

const fetch = vi.spyOn(globalThis, "fetch")

const base = "/api/projects/prj_1/environments/production/runtime/actor-types/Order"

const summary = {
  name: "Order",
  commands: ["Place", "Refund"],
  instances: 3,
  awake: 1,
  commandsPerSecond: 0.5,
  p99Ms: 9,
  maxMailbox: 0,
}

const activity = {
  window: "1h",
  series: [
    { at: "2026-10-03T14:01:00.000Z", value: 2 },
    { at: "2026-10-03T14:00:00.000Z", value: 1 },
  ],
  commands: [{ command: "Place", count: 1800, perSecond: 0.5 }],
}

const live = (overrides: Readonly<Record<string, MockedAnswer>> = {}) =>
  apiResponder({
    ...signedIn({ status: "live" }),
    [base]: { body: summary },
    [`${base}/instances`]: {
      body: {
        items: [
          {
            key: "ord_1",
            status: "awake",
            lastCommand: "Place",
            lastActivityAt: "2026-10-03T14:00:00.000Z",
            generation: 2,
          },
        ],
        nextCursor: null,
      },
    },
    [`${base}/activity`]: { body: activity },
    ...overrides,
  })

const chooseWindow = (window: string) =>
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => (key === "console-series-window" ? window : null),
  })

afterAll(() => fetch.mockRestore())

const load = (responder: ReturnType<typeof apiResponder>) => {
  fetch.mockImplementation(responder.respond)
  return loadActorType("Order")
}

describe("actor type over the live API", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CONSOLE_FIXTURES", "0")
    chooseWindow("1h")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetch.mockReset()
  })

  it("asks for the selected window and draws the reported series and command volumes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const responder = live()
        const loaded = yield* load(responder)
        expect(loaded.sample).toBe(false)
        expect(responder.seen).toContain(`${base}/activity?window=1h`)
        expect(loaded.data?.activity).toEqual({
          window: "1h",
          hours: ["14:00", "14:01"],
          perSecond: [1, 2],
          commands: [{ name: "Place", count: 1800, perSecond: 0.5 }],
        })
        expect(loaded.data?.instances.map((instance) => instance.key)).toEqual(["ord_1"])
      }),
    ))

  it("keeps the live summary and instances and marks the page sample when only activity is not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const loaded = yield* load(
          live({ [`${base}/activity`]: notImplemented("runtime.activity") }),
        )
        expect(loaded.sample).toBe(true)
        expect(loaded.data?.summary).toMatchObject({ instances: 3, commandsPerSecond: 0.5 })
        expect(loaded.data?.instances.map((instance) => instance.key)).toEqual(["ord_1"])
        expect(loaded.data?.activity.window).toBe("1h")
        expect(loaded.data?.activity.perSecond).toHaveLength(60)
        expect(loaded.data?.activity.commands.map((command) => command.name)).toEqual([
          "Place",
          "Refund",
        ])
      }),
    ))

  it("answers an unknown type with nothing rather than sample data", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const loaded = yield* load(
          live({ [base]: notFound({ resource: "actor-type", id: "Order" }) }),
        )
        expect(loaded).toEqual({ data: undefined, sample: false })
      }),
    ))

  it("fails instead of sampling when activity is denied", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(load(live({ [`${base}/activity`]: forbidden })))
        expect(error).toMatchObject({ kind: "Forbidden" })
      }),
    ))

  it("never samples when the project context is not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const responder = live({
          "/api/organizations/org_1/projects": notImplemented("projects.list"),
        })
        const error = yield* Effect.flip(load(responder))
        expect(error).toMatchObject({ kind: "NotImplemented" })
        expect(responder.seen.some((path) => path.includes("/runtime/"))).toBe(false)
      }),
    ))

  it("serves sample activity for the selected window without a request in sample mode", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
        chooseWindow("7d")
        const loaded = yield* loadActorType("Order")
        expect(loaded.sample).toBe(true)
        expect(loaded.data?.activity.window).toBe("7d")
        expect(loaded.data?.activity.hours[0]).toMatch(/^\d\d-\d\d \d\d:\d\d$/)
        expect(fetch).not.toHaveBeenCalled()
      }),
    ))
})

const actor = "/api/projects/prj_1/environments/production/runtime/actors/Counter/hits"

const inspect = (answers: Readonly<Record<string, MockedAnswer>>) => {
  const responder = apiResponder({ ...signedIn({ status: "live" }), ...answers })
  fetch.mockImplementation(responder.respond)
  return { responder, loaded: loadActor({ actorType: "Counter", key: "hits" }) }
}

describe("actor inspector over the live API", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CONSOLE_FIXTURES", "0")
  })

  afterEach(() => {
    fetch.mockReset()
  })

  it("shows live jobs and keeps the real command scope when only inspection is not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { loaded } = inspect({
          [actor]: notImplemented("runtime.inspectActor"),
          [`${actor}/jobs`]: {
            body: [
              { name: "Notify", id: "job_live", attempts: 2, status: "retrying" },
              { name: "Settle", id: "job_dead", attempts: 5, status: "dead" },
            ],
          },
        })
        const page = yield* loaded
        expect(page.sample).toBe(true)
        expect(page.data).toMatchObject({
          actorType: "Counter",
          key: "hits",
          commandScope: { projectId: "prj_1", environment: "production" },
          jobs: [
            { id: "job_live", name: "Notify", attempts: 2, status: "retrying" },
            { id: "job_dead", name: "Settle", attempts: 5, status: "dead" },
          ],
        })
      }),
    ))

  it("falls back to the fixture without a command scope when jobs are not implemented either", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { loaded } = inspect({
          [actor]: notImplemented("runtime.inspectActor"),
          [`${actor}/jobs`]: notImplemented("runtime.listActorJobs"),
        })
        expect(yield* loaded).toEqual({ data: undefined, sample: true })
      }),
    ))

  it("answers an actor no command has reached with a live page that can send the first one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { loaded } = inspect({
          [actor]: notImplemented("runtime.inspectActor"),
          [`${actor}/jobs`]: notFound({ resource: "actor", id: "Counter/hits" }),
        })
        expect(yield* loaded).toEqual({
          data: MissingActorPage.make({
            actorType: "Counter",
            key: "hits",
            commandScope: { projectId: ProjectId.make("prj_1"), environment: "production" },
          }),
          sample: false,
        })
        const inspected = inspect({
          [actor]: notFound({ resource: "actor", id: "Counter/hits" }),
        })
        expect(Schema.is(MissingActorPage)((yield* inspected.loaded).data)).toBe(true)
      }),
    ))

  it("offers no first command when the environment itself is missing or the read is refused", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const undeployed = inspect({
          [actor]: notImplemented("runtime.inspectActor"),
          [`${actor}/jobs`]: notFound({ resource: "live deployment", id: "prj_1/production" }),
        })
        expect(yield* undeployed.loaded).toEqual({ data: undefined, sample: false })
        const refused = inspect({
          [actor]: notImplemented("runtime.inspectActor"),
          [`${actor}/jobs`]: forbidden,
        })
        expect(yield* refused.loaded.pipe(Effect.flip)).toMatchObject({ kind: "Forbidden" })
      }),
    ))

  it("reads a fully inspected actor as live without asking for jobs separately", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { loaded, responder } = inspect({
          [actor]: {
            body: {
              address: "Counter/hits",
              state: { count: 3 },
              turn: 4,
              tables: [],
              receipts: [],
              events: [],
              jobs: [],
              connections: { sockets: 0, feedCursor: null },
              properties: {
                status: "idle",
                type: "Counter",
                generation: 1,
                runner: null,
                region: "us-east-1",
                tenant: "default",
                mailboxDepth: 0,
              },
              timeline: [],
            },
          },
        })
        const page = yield* loaded
        expect(page.sample).toBe(false)
        expect(page.data).toMatchObject({ state: '{\n  "count": 3\n}', jobs: [] })
        expect(responder.seen.some((path) => path.endsWith("/jobs"))).toBe(false)
      }),
    ))
})
