import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Actor, JobFailure, isUser, user } from "../index.ts"
import { Story, StoryFailure } from "./index.ts"

class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", { limit: Schema.Finite }) {}

class Note extends Schema.Class<Note>("Note")({
  id: Schema.String,
  at: Schema.Finite,
  text: Schema.String,
}) {}

const Ledger = Actor.make("Ledger", {
  state: Schema.Struct({}),
  commands: {
    record: Actor.command(Schema.Struct({ from: Schema.String, total: Schema.Finite }), {
      internal: true,
    }),
  },
})

const Counter = Actor.make("Counter", {
  state: Schema.Struct({
    count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    reports: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    notes: Actor.list(Note, { key: "id", by: "at" }),
  }),
  commands: {
    add: Actor.command(Schema.Finite, { success: Schema.Finite, fails: TooLarge }),
    note: Actor.command(Schema.String, { success: Schema.String }),
    forget: Actor.command(Schema.String, { success: Schema.Boolean }),
    roll: Actor.command({ success: Schema.Finite }),
    explode: Actor.command(),
    whoami: Actor.command({ success: Schema.String }),
    expire: Actor.command(Schema.Finite, { internal: true }),
    succeededReport: Actor.command(Schema.Finite, { internal: true }),
    failedReport: Actor.command(JobFailure, { internal: true }),
  },
  views: {
    since: Actor.view(Schema.Array(Schema.String), { params: Schema.Finite }),
    total: Actor.view(Schema.Finite),
  },
  broadcasts: { changed: Actor.broadcast(Schema.Finite) },
  jobs: { report: Actor.job({ payload: Schema.Finite, onFailure: "failedReport" }) },
})

const CounterLive = Counter.toLayer({
  add: (counter, amount, { self, send, schedule, start, broadcast }) => {
    counter.count += amount
    start.report(counter.count)
    if (counter.count > 100) return TooLarge.make({ limit: 100 })
    send(Ledger, "main").record({ from: self, total: counter.count })
    schedule("1 minute").expire(counter.count)
    broadcast.changed(counter.count)
    return counter.count
  },
  note: (counter, text, { id, now }) => {
    const note = Note.make({ id: id(), at: now(), text })
    counter.notes.put(note)
    return note.id
  },
  forget: (counter, id) => counter.notes.delete(id),
  roll: (_, __, { random }) => Math.floor(random() * 6) + 1,
  explode: (counter) => {
    counter.count = 7
    throw new Error("boom")
  },
  whoami: (_, __, { caller }) => (isUser(caller) ? caller.subject : caller.source),
  expire: () => undefined,
  succeededReport: (counter, total, { caller }) => {
    counter.reports = [...counter.reports, `${caller.source}:${total}`]
  },
  failedReport: (counter, failure) => {
    counter.reports = [...counter.reports, `failed:${failure.job}`]
  },
  since: (counter, from) => counter.notes.range({ from }).map((note) => note.id),
  total: (counter) => counter.count,
  report: () => Effect.void,
})

const ids = (notes: ReadonlyArray<Note>) => notes.map((note) => note.id)

const failureOf = (story: () => void): StoryFailure => {
  try {
    story()
  } catch (thrown) {
    if (Schema.is(StoryFailure)(thrown)) return thrown
    throw thrown
  }
  throw new Error("the story passed")
}

describe("Story", () => {
  it("a declared failure keeps the state and drops the job start staged before it", () => {
    Story.run(
      Counter,
      CounterLive,
      Story.given({ count: 99 }),
      Story.command("add", 2),
      Story.expectFailure(TooLarge),
      Story.expectFailure(TooLarge.make({ limit: 100 })),
      Story.state((state) => expect(state.count).toBe(99)),
      Story.expectNothingStaged(),
    )
    const dropped = failureOf(() =>
      Story.run(
        Counter,
        CounterLive,
        Story.given({ count: 99 }),
        Story.command("add", 2),
        Story.expectFailure(TooLarge),
        Story.expectStarted("report", 101),
      ),
    )
    expect(dropped.message).toBe(
      'Story Counter, step 4 (expectStarted report): expected start report(101); nothing was staged: `add` ended in failure {"_tag":"TooLarge","limit":100}, which discards staged work',
    )
  })

  it("a success stages every send, timer, start and broadcast with its payload", () => {
    Story.run(
      Counter,
      CounterLive,
      Story.given({ count: 40 }),
      Story.command("add", 2, { now: 5_000 }),
      Story.expectReply(42),
      Story.expectStarted("report", 42),
      Story.expectSent(Ledger, "main", "record", { from: "story", total: 42 }),
      Story.expectScheduled("1 minute", "expire", 42),
      Story.expectBroadcast("changed", 42),
      Story.expectNothingStaged(),
      Story.state((state) => expect(state.count).toBe(42)),
    )
    Story.run(
      Counter,
      CounterLive,
      Story.given({ count: 40 }, { self: "c-7" }),
      Story.command("add", 2, { now: 5_000 }),
      Story.expectScheduled({ at: 65_000 }, "expire", 42),
      Story.expectSent(Ledger, "main", "record", { from: "c-7", total: 42 }),
    )
  })

  it("an expectation on staged work that differs fails and lists what was staged", () => {
    const wrong = failureOf(() =>
      Story.run(
        Counter,
        CounterLive,
        Story.given({ count: 40 }),
        Story.command("add", 2, { now: 5_000 }),
        Story.expectScheduled("1 minute", "expire", 41),
      ),
    )
    expect(wrong.message).toBe(
      'Story Counter, step 3 (expectScheduled expire): expected timer expire(41) at 65000; unmatched staged work: send Ledger("main").record({"from":"story","total":42}); timer expire(42) at 65000; start report(42); broadcast changed 42',
    )
    const late = failureOf(() =>
      Story.run(
        Counter,
        CounterLive,
        Story.command("add", 2, { now: 5_000 }),
        Story.expectScheduled("1 minute", "expire", 2),
        Story.expectScheduled("1 minute", "expire", 2),
      ),
    )
    expect(late.step).toBe(3)
  })

  it("expectNothingStaged fails while staged work is unmatched", () => {
    const staged = failureOf(() =>
      Story.run(
        Counter,
        CounterLive,
        Story.command("add", 2),
        Story.expectBroadcast("changed", 2),
        Story.expectNothingStaged(),
      ),
    )
    expect(staged.message).toBe(
      'Story Counter, step 3 (expectNothingStaged): expected `add` to stage nothing more; unmatched staged work: send Ledger("main").record({"from":"story","total":2}); timer expire(2) at 60000; start report(2)',
    )
  })

  it("each command runs on the state the previous one left", () => {
    Story.run(
      Counter,
      CounterLive,
      Story.given({ count: 40 }),
      Story.command("add", 2),
      Story.expectReply(42),
      Story.command("add", 3),
      Story.expectReply(45),
      Story.state((state) => expect(state.count).toBe(45)),
    )
  })

  it("lists are given as items, written by put and delete, and read in by order", () => {
    Story.run(
      Counter,
      CounterLive,
      Story.given({ notes: [Note.make({ id: "z", at: 5, text: "old" })] }),
      Story.given({
        notes: [
          Note.make({ id: "b", at: 20, text: "two" }),
          Note.make({ id: "a", at: 30, text: "three" }),
        ],
      }),
      Story.command("note", "one", { id: ["n1"], now: 10 }),
      Story.expectReply("n1"),
      Story.state((state) => {
        expect(ids(state.notes)).toEqual(["n1", "b", "a"])
        expect(state.notes[0]?.text).toBe("one")
      }),
      Story.command("forget", "b"),
      Story.expectReply(true),
      Story.command("forget", "z"),
      Story.expectReply(false),
      Story.state((state) => expect(ids(state.notes)).toEqual(["n1", "a"])),
    )
  })

  it("views read the state after the commands before them", () => {
    Story.run(
      Counter,
      CounterLive,
      Story.given({
        count: 3,
        notes: [Note.make({ id: "b", at: 20, text: "" }), Note.make({ id: "a", at: 30, text: "" })],
      }),
      Story.view("since", 25, (value) => expect(value).toEqual(["a"])),
      Story.command("note", "x", { id: ["c"], now: 26 }),
      Story.view("since", 25, (value) => expect(value).toEqual(["c", "a"])),
      Story.view("total", (value) => expect(value).toBe(3)),
    )
  })

  it("an internal command is callable and sees a System caller by default", () => {
    Story.run(
      Counter,
      CounterLive,
      Story.given({ reports: ["earlier"] }),
      Story.command("succeededReport", 7),
      Story.command(
        "failedReport",
        JobFailure.make({
          job: "report",
          declaration: "report",
          payload: 7,
          attempts: 1,
          cause: "Failed",
          ambiguous: false,
        }),
      ),
      Story.state((state) =>
        expect(state.reports).toEqual(["earlier", "process:7", "failed:report"]),
      ),
      Story.command("whoami"),
      Story.expectReply("process"),
      Story.command("whoami", { caller: user("ada") }),
      Story.expectReply("ada"),
    )
  })

  it("a thrown error is the defect the engine records, and the draft is discarded", () => {
    Story.run(
      Counter,
      CounterLive,
      Story.given({ count: 3 }),
      Story.command("explode"),
      Story.expectDefect({ kind: "Thrown", detail: "Error: boom" }),
      Story.state((state) => expect(state.count).toBe(3)),
    )
    const unexpected = failureOf(() =>
      Story.run(Counter, CounterLive, Story.command("explode"), Story.command("add", 1)),
    )
    expect(unexpected.message).toBe(
      "Story Counter, step 2 (command add): `explode` ended in defect Thrown: Error: boom; expect it with Story.expectDefect",
    )
    const atEnd = failureOf(() => Story.run(Counter, CounterLive, Story.command("add", 101)))
    expect(atEnd.label).toBe("end")
    expect(atEnd.detail).toContain("Story.expectFailure")
  })

  it("supplied ids and randoms are drawn in order and running out fails the story", () => {
    Story.run(
      Counter,
      CounterLive,
      Story.command("roll", { random: [0.5] }),
      Story.expectReply(4),
      Story.command("roll", { random: [0.99] }),
      Story.expectReply(6),
    )
    const short = failureOf(() =>
      Story.run(Counter, CounterLive, Story.command("note", "x", { id: [] })),
    )
    expect(short.message).toBe(
      "Story Counter, step 1 (command note): `note` drew more than the 0 ids the story supplied",
    )
    const drawn: Array<string> = []
    const twice = () =>
      Story.run(
        Counter,
        CounterLive,
        Story.command("note", "x"),
        Story.command("note", "y"),
        Story.state((state) => drawn.push(...ids(state.notes))),
      )
    twice()
    twice()
    expect(drawn.slice(0, 2)).toEqual(drawn.slice(2))
    expect(drawn[0]).not.toBe(drawn[1])
  })

  it("a reply that differs fails with the expected and actual outcome", () => {
    const wrong = failureOf(() =>
      Story.run(
        Counter,
        CounterLive,
        Story.given({ count: 40 }),
        Story.command("add", 2),
        Story.expectReply(43),
      ),
    )
    expect(wrong.message).toBe(
      "Story Counter, step 3 (expectReply): expected `add` to reply 43, but it ended in reply 42",
    )
  })

  it.effect("Story.effect fails with the StoryFailure", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Story.effect(Counter, CounterLive, Story.command("add", 2), Story.expectReply(3)),
      )
      expect(failure.step).toBe(2)
      yield* Story.effect(Counter, CounterLive, Story.command("add", 2), Story.expectReply(2))
    }),
  )

  it("the contract types every step and the runner refuses what bypasses them", () => {
    const unknown = failureOf(() =>
      Story.run(
        Counter,
        CounterLive,
        // @ts-expect-error: 'nope' is not a command of Counter
        Story.command("nope"),
      ),
    )
    expect(unknown.detail).toBe("'nope' is not a command of Counter")
    const payload = failureOf(() =>
      Story.run(
        Counter,
        CounterLive,
        // @ts-expect-error: add takes a number
        Story.command("add", "two"),
      ),
    )
    expect(payload.detail).toContain("the payload of 'add' does not match its schema")
    const failures = () =>
      Story.run(
        Counter,
        CounterLive,
        Story.command("add", 1),
        // @ts-expect-error: replies of Counter are numbers, strings or booleans
        Story.expectReply({ count: 1 }),
        // @ts-expect-error: Counter declares no failure but TooLarge
        Story.expectFailure(Note),
        // @ts-expect-error: internal commands are called by System callers only
        Story.command("succeededReport", 1, { caller: user("ada") }),
        // @ts-expect-error: report takes a number
        Story.expectStarted("report", "x"),
        // @ts-expect-error: changed carries a number
        Story.expectBroadcast("changed", "x"),
        // @ts-expect-error: record takes from and total
        Story.expectSent(Ledger, "main", "record", { from: "story" }),
        // @ts-expect-error: count is a number
        Story.given({ count: "x" }),
        // @ts-expect-error: a step of another actor
        Story.given<typeof Ledger>({}),
        Story.state((state) => {
          // @ts-expect-error: count is a number
          const count: string = state.count
          return count
        }),
      )
    expect(failures).toThrow(StoryFailure)
  })
})
