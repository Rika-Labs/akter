import { describe, expect, it } from "@effect/vitest"
import { expectTypeOf } from "vitest"
import { Effect, Layer, Schedule, Schema } from "effect"
import { Actor, Job, JobFailure, isUser } from "../index.ts"
import type { ActorError, DefOf, Handle, Handlers } from "../index.ts"
import { Simulation } from "../testing/index.ts"
import type { SimulationService } from "../testing/index.ts"
import type { Implementation } from "../handlers/registry.ts"

class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}

class Note extends Schema.Class<Note>("Note")({
  id: Schema.String,
  at: Schema.Finite,
  tags: Schema.Array(Schema.String),
}) {}

const Doc = Actor.make("Doc", {
  state: Schema.Struct({
    title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    tags: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    bio: Schema.optional(Schema.String),
    notes: Actor.list(Note, { key: "id", by: "at" }),
  }),
  commands: {
    rename: Actor.command(Schema.String, { fails: Forbidden }),
    size: Actor.command({ success: Schema.Finite }),
    failedIndex: Actor.command(JobFailure, { internal: true }),
  },
  views: {
    plain: Actor.view(Schema.Finite),
    page: Actor.view(Schema.Array(Schema.Finite), { params: Schema.Finite }),
  },
  broadcasts: { saved: Actor.broadcast(Schema.String) },
  jobs: { index: Actor.job({ payload: Schema.String, onFailure: "failedIndex" }) },
})

const handlers = {
  rename: () => undefined,
  size: () => 1,
  failedIndex: () => undefined,
  plain: () => 1,
  page: () => [1],
  index: () => Effect.void,
}

const unit = Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0)))

describe("Actor.make", () => {
  it("refuses a state field without a decoding default, Schema.optional or Actor.list", () => {
    expect(() =>
      Actor.make("Counter", {
        // @ts-expect-error `label` needs a decoding default
        state: Schema.Struct({ count: unit, label: Schema.String }),
        commands: { increment: Actor.command() },
      }),
    ).toThrow(/needs a decoding default/)
  })

  it("refuses a member name used twice or reserved", () => {
    expect(() =>
      // @ts-expect-error `total` is both a command and a view
      Actor.make("Clash", {
        state: Schema.Struct({ n: unit }),
        commands: { total: Actor.command({ success: Schema.Finite }) },
        views: { total: Actor.view(Schema.Finite) },
      }),
    ).toThrow(/used twice or reserved/)
    expect(() =>
      // @ts-expect-error `state` is reserved for the client's state stream
      Actor.make("Reserved", {
        state: Schema.Struct({ n: unit }),
        commands: {},
        broadcasts: { state: Actor.broadcast(Schema.String) },
      }),
    ).toThrow(/used twice or reserved/)
  })

  it("refuses an onFailure that is missing, public or not a command of the actor", () => {
    const state = Schema.Struct({ sent: unit })
    expect(() =>
      Actor.make("Mailer", {
        state,
        commands: { failedSend: Actor.command(JobFailure) },
        // @ts-expect-error the onFailure target must be internal
        jobs: { send: Actor.job({ payload: Schema.String, onFailure: "failedSend" }) },
      }),
    ).toThrow(/needs onFailure naming an internal command/)
    expect(() =>
      Actor.make("Resender", {
        state,
        commands: {},
        // @ts-expect-error `failedResend` is not a command
        jobs: { resend: Actor.job({ payload: Schema.String, onFailure: "failedResend" }) },
      }),
    ).toThrow(/needs onFailure naming an internal command/)
    // @ts-expect-error every job declares onFailure
    expect(() => Actor.job({ payload: Schema.String })).toBeDefined()
  })

  it("refuses an onSuccess that is public or not a command of the actor, and types the job's success by it", () => {
    const state = Schema.Struct({ sent: unit })
    const commands = {
      failedSend: Actor.command(JobFailure, { internal: true }),
      succeededPublish: Actor.command(Schema.Int),
    }
    expect(() =>
      Actor.make("PublicSuccess", {
        state,
        commands,
        jobs: {
          // @ts-expect-error the onSuccess target must be internal
          send: Actor.job({ onSuccess: "succeededPublish", onFailure: "failedSend" }),
        },
      }),
    ).toThrow(/needs onSuccess naming an internal command/)
    expect(() =>
      Actor.make("MissingSuccess", {
        state,
        commands,
        jobs: {
          // @ts-expect-error `succeededSend` is not a command
          send: Actor.job({ onSuccess: "succeededSend", onFailure: "failedSend" }),
        },
      }),
    ).toThrow(/needs onSuccess naming an internal command/)
    const Sender = Actor.make("Sender", {
      state,
      commands: {
        ...commands,
        succeededSend: Actor.command(Schema.Int, { internal: true }),
        succeededPing: Actor.command({ internal: true }),
      },
      jobs: {
        send: Actor.job({ onSuccess: "succeededSend", onFailure: "failedSend" }),
        ping: Actor.job({ onSuccess: "succeededPing", onFailure: "failedSend" }),
        fire: Actor.job({ onFailure: "failedSend" }),
      },
    })
    type H = Handlers<"Sender", DefOf<typeof Sender>>
    expectTypeOf<ReturnType<H["send"]>>().toEqualTypeOf<Effect.Effect<number, unknown, any>>()
    expectTypeOf<ReturnType<H["ping"]>>().toEqualTypeOf<Effect.Effect<void, unknown, any>>()
    expectTypeOf<ReturnType<H["fire"]>>().toEqualTypeOf<Effect.Effect<unknown, unknown, any>>()
    expectTypeOf(Effect.succeed("sent")).not.toExtend<ReturnType<H["send"]>>()
  })

  it("attaches retry and timeout as policies that keep the declaration (rejects options that drop onSuccess or a negative retry count)", () => {
    const declared = Actor.job({
      payload: Schema.String,
      onSuccess: "succeededSync",
      onFailure: "failedSync",
    })
    const schedule = Schedule.exponential("2 seconds")
    const piped = declared.pipe(Job.retry({ times: 2, schedule }), Job.timeout("30 seconds"))
    expectTypeOf(piped).toEqualTypeOf(declared)
    expect([piped.retry, piped.timeout, piped.onSuccess, piped.onFailure]).toEqual([
      { times: 2, schedule },
      "30 seconds",
      "succeededSync",
      "failedSync",
    ])
    expect([declared.retry, declared.timeout]).toEqual([{ times: 0 }, undefined])
    expect(() => declared.pipe(Job.retry({ times: -1 }))).toThrow(/whole number of retries/)
    expect(() => declared.pipe(Job.retry({ times: 1.5 }))).toThrow(/whole number of retries/)
    // @ts-expect-error retry is a policy, not an option
    expect(Actor.job({ onFailure: "failedSync", retry: { times: 1 } }).retry).toEqual({ times: 0 })
  })

  it("refuses a cron command with a payload, and a schedule in a fixed offset or an unknown zone", () => {
    // @ts-expect-error a cron command takes no payload
    expect(() => Actor.command(Schema.String, { cron: "0 3 * * *" })).toThrow(/takes no payload/)
    expect(Actor.command({ cron: "0 3 * * *" }).internal).toBe(true)
    expect(Actor.command({ cron: "CRON_TZ=Europe/Paris 0 3 * * *" }).cron).toBe(
      "CRON_TZ=Europe/Paris 0 3 * * *",
    )
    expect(Actor.command({ cron: "@every 90 seconds" }).internal).toBe(true)
    expect(() => Actor.command({ cron: "CRON_TZ=+02:00 0 3 * * *" })).toThrow(
      /not a named IANA time zone/,
    )
    expect(() => Actor.command({ cron: "CRON_TZ=Mars/Olympus 0 3 * * *" })).toThrow(
      /not a named IANA time zone/,
    )
    expect(() => Actor.command({ cron: "@every 500 millis" })).toThrow(/at least one second/)
  })

  it("orders lists by a declared scalar field and keys them by one", () => {
    // @ts-expect-error `tags` is not a scalar field of Note
    expect(Actor.list(Note, { by: "tags" }).byField).toBe("tags")
    // @ts-expect-error `when` is not a field of Note
    expect(Actor.list(Note, { key: "id", by: "when" }).keyField).toBe("id")
  })
})

describe("X.toLayer", () => {
  it("needs a handler for every declared member and accepts nothing undeclared", () => {
    const { size: _, ...withoutSize } = handlers
    // @ts-expect-error `size` has no handler
    expect(() => Doc.toLayer(withoutSize)).toThrow(/no handler for 'size'/)
    // @ts-expect-error `renmae` is not declared
    expect(() => Doc.toLayer({ ...handlers, renmae: () => {} })).toThrow(/'renmae' is not declared/)
    // @ts-expect-error a non-presence actor takes no connect handler
    expect(() => Doc.toLayer({ ...handlers, connect: () => {} })).toThrow(
      /'connect' is not declared/,
    )
    const Lobby = Actor.make("Lobby", {
      state: Schema.Struct({ online: unit }),
      commands: { ping: Actor.command() },
      presence: Schema.Struct({ name: Schema.String }),
    })
    // @ts-expect-error presence needs both connect and disconnect
    expect(() => Lobby.toLayer({ ping: () => {}, connect: () => {} })).toThrow(
      /no handler for 'disconnect'/,
    )
  })

  it("types command handlers as synchronous functions of the draft, payload and context", () => {
    expect(
      Doc.toLayer({
        ...handlers,
        // @ts-expect-error a command cannot return an Effect
        rename: () => Effect.succeed(1),
        // @ts-expect-error `size` returns a number
        size: (doc) => doc.title,
      }),
    ).toBeDefined()
    expect(
      Doc.toLayer({
        ...handlers,
        rename: (doc, title, { send, schedule, start, broadcast }) => {
          // @ts-expect-error `rename` takes a string
          send(Doc, "other").rename(42)
          // @ts-expect-error `publish` is not a command of Doc
          send(Doc, "other").publish("x")
          // @ts-expect-error `size` takes no payload
          schedule("1 minute").size("unexpected")
          // @ts-expect-error a start key is a string
          start.index(title, { key: 7 })
          // @ts-expect-error `reindex` is not a job of Doc
          start.reindex(title)
          // @ts-expect-error `saved` carries a string
          broadcast.saved(1)
          // @ts-expect-error `missing` is not a state field
          doc.missing = 1
          // @ts-expect-error a list item needs every field
          doc.notes.put({ id: title })
          // @ts-expect-error `name` is not optional, so it cannot be deleted
          delete doc.title
          delete doc.bio
        },
      }),
    ).toBeDefined()
  })

  it("types the caller from access: a type guard narrows it, a plain boolean keeps Anonymous", () => {
    const state = Schema.Struct({
      admins: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    })
    const Guarded = Actor.make("Guarded", {
      state,
      commands: { claim: Actor.command() },
      access: isUser,
    })
    const Open = Actor.make("Open", {
      state,
      commands: { claim: Actor.command() },
      access: () => true,
    })
    expect(
      Guarded.toLayer({
        claim: (room, _, { caller }) => {
          room.admins.push(caller.subject)
        },
      }),
    ).toBeDefined()
    expect(
      Open.toLayer({
        claim: (room, _, { caller }) => {
          // @ts-expect-error an Anonymous caller has no subject
          room.admins.push(caller.subject)
        },
      }),
    ).toBeDefined()
  })

  it("records JSON step results without a schema and anything else with one; jobs never get Scope", () => {
    expect(
      Doc.toLayer({
        ...handlers,
        index: (text, { step }) =>
          // @ts-expect-error a class instance is not JSON; name its schema
          step("load", Effect.succeed(Note.make({ id: text, at: 0, tags: [] }))),
      }),
    ).toBeDefined()
    expect(
      Doc.toLayer({
        ...handlers,
        index: (text, { step }) =>
          step("load", Note, Effect.succeed(Note.make({ id: text, at: 0, tags: [] }))),
      }),
    ).toBeDefined()
    const scoped = Doc.toLayer({ ...handlers, index: () => Effect.addFinalizer(() => Effect.void) })
    // @ts-expect-error a job that needs Scope gets a compile error instead of a layer
    expect(Layer.isLayer(scoped satisfies Layer.Any)).toBe(true)
  })
})

describe("X.client and X.find", () => {
  it("types calls, lists, views and queries from the contract", () => {
    const misuse = (doc: Handle<"Doc", DefOf<typeof Doc>>) => {
      // @ts-expect-error `rename` succeeds with void
      const typed: Effect.Effect<number, Forbidden | ActorError> = doc.rename("t")
      return [
        typed,
        // @ts-expect-error `rename` takes a string
        doc.rename(1),
        // @ts-expect-error `size` takes no payload
        doc.size("x"),
        // @ts-expect-error `notes` is ordered by a number
        doc.notes.range({ from: "a" }),
        // @ts-expect-error `plain` takes no params
        doc.plain(1),
        // @ts-expect-error `page` needs its params
        doc.page(),
        // @ts-expect-error `failedIndex` is internal
        doc.failedIndex,
        // @ts-expect-error `tags` is not a scalar field
        Doc.find({ where: { tags: ["a"] } }),
        // @ts-expect-error lists cannot order a query
        Doc.find({ orderBy: { field: "notes" } }),
        // @ts-expect-error `title` compares with strings
        Doc.find({ where: { title: { gte: 3 } } }),
      ]
    }
    expect(misuse).toBeTypeOf("function")
  })

  it("needs every actor's implementation before a simulation runs", () => {
    const layer = Simulation.layer({ actors: [Doc], seed: 1 })
    expectTypeOf(layer).toExtend<Layer.Layer<SimulationService, never, Implementation<"Doc">>>()
    expectTypeOf(layer).not.toExtend<Layer.Layer<SimulationService, never, never>>()
  })
})
