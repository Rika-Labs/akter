import { CommandFailed, Conflict, Forbidden, NotImplemented } from "@akter/cloud-api"
import { DateTime, Effect, Schema, Stream } from "effect"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadCommands, openTurns, sendCommand, streamTurns } from "./client.ts"
import { CommandAnswer, CommandRejected, CommandsPage, CommandSucceeded } from "./model.ts"

const fetch = vi.spyOn(globalThis, "fetch")

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
  fetch.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  fetch.mockReset()
})

afterAll(() => fetch.mockRestore())

describe("commands client in fixture mode", () => {
  it("carries the actor types and the opening tail, newest first", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { data: page, sample } = yield* loadCommands
        expect(sample).toBe(true)
        expect(Schema.is(CommandsPage)(page)).toBe(true)
        expect(page.recent).toHaveLength(14)
        expect(page.recent[0]?.sequence).toBe(13)
        expect(page.types).toContain("Order")
      }),
    ))
})

describe("commands client in fixture mode, writes and streams", () => {
  it("never sends a command or opens a stream for sample data", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sent = yield* sendCommand({
          address: "Order/ord_8f2c",
          command: "Charged",
          payload: "{}",
        }).pipe(Effect.flip)
        const opened = yield* openTurns.pipe(Effect.flip)
        const streamed = yield* Stream.runCollect(streamTurns).pipe(Effect.flip)
        for (const error of [sent, opened, streamed])
          expect(error).toMatchObject({ kind: "Sample", message: "Sample data is read-only." })
        expect(fetch).not.toHaveBeenCalled()
      }),
    ))
})

const json = (value: Schema.Json, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

const sse = (events: ReadonlyArray<Schema.Json>) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })

const me = {
  user: null,
  identityKind: "api-key",
  activeOrganizationId: "org_1",
  organizations: [
    {
      organization: {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        plan: "pro",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      role: "admin",
    },
  ],
}

const project = {
  id: "prj_1",
  organizationId: "org_1",
  name: "Storefront",
  slug: "storefront",
  status: "live",
  homeRegion: "us-east-1",
  createdAt: "2026-10-01T00:00:00.000Z",
}

const commandsPath = "/api/projects/prj_1/environments/production/runtime/commands"

/** Answers the identity lookups the project context needs, and the command route with `commands`. */
const route = (commands: () => Response) =>
  fetch.mockImplementation((input) => {
    const { pathname } = new URL(new Request(input).url)
    if (pathname === "/api/me") return Promise.resolve(json(me))
    if (pathname === "/api/organizations/org_1/projects") return Promise.resolve(json([project]))
    return Promise.resolve(commands())
  })

const callUrl = (call: (typeof fetch.mock.calls)[number]) => new URL(new Request(call[0]).url)

const commandRequests = () =>
  fetch.mock.calls.filter((call) => callUrl(call).pathname.startsWith(commandsPath))

const sentBody = (call: (typeof fetch.mock.calls)[number] | undefined) =>
  Effect.promise(() => new Response(call?.[1]?.body).text()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
  )

const encoded = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Schema.encodeEffect(Schema.toCodecJson(schema))(value)

const live = () => vi.stubEnv("VITE_CONSOLE_FIXTURES", "0")

const send = {
  address: "Order/ord_8f2c",
  command: "Charge",
  payload: '{"amount":12.5,"tags":[null]}',
}

describe("sendCommand over the derived API", () => {
  beforeEach(live)

  it("sends the parsed JSON payload and lets the server mint an omitted commandId", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        route(() => json({ commandId: "cmd_minted", result: { charged: true }, replayed: false }))
        const answer = yield* sendCommand(send)
        expect(answer).toEqual(
          CommandSucceeded.make({
            commandId: "cmd_minted",
            result: { charged: true },
            replayed: false,
          }),
        )
        expect(Schema.is(CommandAnswer)(answer)).toBe(true)
        const [call] = commandRequests()
        expect(call?.[1]?.method).toBe("POST")
        const body = yield* sentBody(call)
        expect(body).toStrictEqual({
          address: "Order/ord_8f2c",
          command: "Charge",
          payload: { amount: 12.5, tags: [null] },
        })
      }),
    ))

  it("sends a provided commandId unchanged and reports a replay", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        route(() => json({ commandId: "cmd_7", result: null, replayed: true }))
        const answer = yield* sendCommand({ ...send, commandId: "cmd_7" })
        expect(answer).toEqual(
          CommandSucceeded.make({ commandId: "cmd_7", result: null, replayed: true }),
        )
        const [call] = commandRequests()
        expect(yield* sentBody(call)).toMatchObject({ commandId: "cmd_7" })
      }),
    ))

  it("keeps the actor's own 422 refusal as an answer, not a ConsoleError", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* encoded(
          CommandFailed,
          CommandFailed.make({
            commandId: "cmd_9",
            errorTag: "AlreadyPlaced",
            error: { orderId: "ord_8f2c", attempts: 2 },
            replayed: true,
          }),
        )
        route(() => json(body, 422))
        const answer = yield* sendCommand(send)
        expect(answer).toEqual(
          CommandRejected.make({
            commandId: "cmd_9",
            errorTag: "AlreadyPlaced",
            error: { orderId: "ord_8f2c", attempts: 2 },
            replayed: true,
          }),
        )
        expect(Schema.is(CommandAnswer)(answer)).toBe(true)
      }),
    ))

  it("rejects invalid JSON and a malformed command before any request is made", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        route(() => json({ commandId: "x", result: null, replayed: false }))
        const notJson = yield* sendCommand({ ...send, payload: "{amount:" }).pipe(Effect.flip)
        const noAddress = yield* sendCommand({ ...send, address: "Order" }).pipe(Effect.flip)
        const noCommand = yield* sendCommand({ ...send, command: "" }).pipe(Effect.flip)
        expect(notJson).toMatchObject({ kind: "InvalidPayload" })
        expect(noAddress).toMatchObject({ kind: "InvalidCommand" })
        expect(noCommand).toMatchObject({ kind: "InvalidCommand" })
        expect(fetch).not.toHaveBeenCalled()
      }),
    ))

  it("fails NotImplemented as a ConsoleError and never fakes a result", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* encoded(
          NotImplemented,
          NotImplemented.make({ operation: "runtime.sendCommand" }),
        )
        route(() => json(body, 501))
        const error = yield* sendCommand(send).pipe(Effect.flip)
        expect(error).toMatchObject({ kind: "NotImplemented" })
        expect(commandRequests()).toHaveLength(1)
      }),
    ))

  it("maps denied, conflicting and unreachable sends to ConsoleError kinds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forbidden = yield* encoded(Forbidden, Forbidden.make({ message: "read-only key" }))
        const conflict = yield* encoded(Conflict, Conflict.make({ message: "Command id reused." }))
        route(() => json(forbidden, 403))
        expect(yield* sendCommand(send).pipe(Effect.flip)).toMatchObject({ kind: "Forbidden" })
        route(() => json(conflict, 409))
        expect(yield* sendCommand(send).pipe(Effect.flip)).toMatchObject({
          kind: "Conflict",
          message: "Command id reused.",
        })
        fetch.mockRejectedValue(new TypeError("Failed to fetch"))
        expect(yield* sendCommand(send).pipe(Effect.flip)).toMatchObject({ kind: "Unavailable" })
      }),
    ))
})

const turn = {
  at: "2026-10-03T14:02:16.998Z",
  durationMs: 4.1,
  address: "Order/ord_8f2c",
  command: "Charged",
  payloadPreview: "{}",
  outcome: "ok",
  errorTag: null,
}

describe("turn stream over the derived API", () => {
  beforeEach(live)

  it("decodes each event's ISO timestamp to a UTC instant, with no filter in the request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        route(() => sse([turn, { ...turn, at: "2026-10-03T14:02:17.500Z", outcome: "replayed" }]))
        const turns = yield* Stream.runCollect(streamTurns)
        expect(turns).toHaveLength(2)
        const [first, second] = turns
        expect(DateTime.isUtc(first?.at as DateTime.DateTime)).toBe(true)
        expect(DateTime.toEpochMillis(first?.at as DateTime.Utc)).toBe(
          Date.parse("2026-10-03T14:02:16.998Z"),
        )
        expect(second).toMatchObject({ outcome: "replayed", address: "Order/ord_8f2c" })
        const [call] = commandRequests()
        const url = callUrl(call as NonNullable<typeof call>)
        expect(url.pathname).toBe(`${commandsPath}/stream`)
        expect(url.search).toBe("")
      }),
    ))

  it("opens as soon as the headers arrive, before any event", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        route(
          () =>
            new Response(new ReadableStream({ start: () => undefined }), {
              headers: { "content-type": "text/event-stream" },
            }),
        )
        const stream = yield* openTurns
        expect(Stream.isStream(stream)).toBe(true)
      }),
    ))

  it("fails NotImplemented before the stream opens, without sample data", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* encoded(
          NotImplemented,
          NotImplemented.make({ operation: "runtime.streamCommands" }),
        )
        route(() => json(body, 501))
        expect(yield* openTurns.pipe(Effect.flip)).toMatchObject({ kind: "NotImplemented" })
        expect(yield* Stream.runCollect(streamTurns).pipe(Effect.flip)).toMatchObject({
          kind: "NotImplemented",
        })
      }),
    ))

  it("fails Unavailable when the connection cannot be made", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        route(() => {
          throw new TypeError("Failed to fetch")
        })
        expect(yield* openTurns.pipe(Effect.flip)).toMatchObject({ kind: "Unavailable" })
      }),
    ))

  it("fails Unavailable after the delivered events when the connection drops mid-stream", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let delivered = false
        route(
          () =>
            new Response(
              new ReadableStream({
                pull: (controller) => {
                  if (delivered) return controller.error(new TypeError("network error"))
                  delivered = true
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(turn)}\n\n`))
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        )
        const seen: Array<string> = []
        const error = yield* streamTurns.pipe(
          Stream.runForEach((entry) => Effect.sync(() => seen.push(entry.command))),
          Effect.flip,
        )
        expect(seen).toEqual(["Charged"])
        expect(error).toMatchObject({ kind: "Unavailable" })
      }),
    ))
})
