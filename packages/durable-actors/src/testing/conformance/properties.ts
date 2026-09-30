import { isDeepStrictEqual } from "node:util"
import { Effect, Exit, Match, Predicate, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, CommandExpired, InvalidCommandId } from "../../index.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"
import { checkProperty } from "../property.ts"
import { payloadHash } from "./admission.ts"
import { bodies, cursors, Feed, prune, eventsSuite } from "./events.ts"
import { Outboxer, receivedBodies, outboxSuite } from "./outbox.ts"
import { Misuse, Notebook, tablesSuite } from "./tables.ts"

class Refused extends Schema.TaggedError<Refused>()("Refused", { amount: Schema.Int }) {}

const Add = Actor.command("Add", { input: Schema.Int, output: Schema.Int })

const Refuse = Actor.command("Refuse", { input: Schema.Int, errors: [Refused] })

const Echo = Actor.command("Echo", { input: Schema.String, output: Schema.String })

const Tally = Actor.make("PropertyTally", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Add, Refuse, Echo },
})

export const propertiesLayer = Tally.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Tally.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
    Refuse: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Tally.Turn
      yield* turn.state.set({ count: -1 })

      return yield* Refused.make({ amount })
    }),
    Echo: (text: string) => Effect.succeed(text),
  }),
)

const CRASH_RUNS = 8

const small = (maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum })))

let cases = 0

const nextCase = (prefix: string) => {
  cases += 1

  return `property-${prefix}-${cases}`
}

const CrashPoint = Schema.Literals(["beforeHandler", "beforeCommit", "afterCommit"])

const ReceiptOp = Schema.Struct({
  slot: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  kind: Schema.Literals(["Add", "Refuse"]),
  amount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
})

const receiptOps = Arbitrary.array(Arbitrary.schema(ReceiptOp), { minLength: 1, maxLength: 6 })

const StoredCount = Schema.Struct({ count: Schema.optionalKey(Schema.Int) })

const receiptModel = Effect.fnUntraced(function* (
  ops: ReadonlyArray<typeof ReceiptOp.Type>,
  crash: { readonly at: number; readonly point: typeof CrashPoint.Type } | undefined,
) {
  const test = yield* ActorTest
  const actors = yield* Actors
  const tally = yield* Tally.get(nextCase("receipts"))

  const ids = [
    yield* actors.mintCommandId,
    yield* actors.mintCommandId,
    yield* actors.mintCommandId,
  ]

  const stored = new Map<number, { kind: string; amount: number; reply: string }>()
  let count = 0

  const fresh = ops.flatMap((op, index) =>
    ops.findIndex(({ slot }) => slot === op.slot) === index ? [index] : [],
  )

  const crashAt =
    crash === undefined ? -1 : (fresh.find((index) => index >= crash.at) ?? fresh.at(-1)!)

  for (const [index, op] of ops.entries()) {
    const receipt = stored.get(op.slot)
    let expected: string

    if (receipt === undefined) {
      if (op.kind === "Add") count += op.amount
      expected = op.kind === "Add" ? `ok:${count}` : `refused:${op.amount}`
      stored.set(op.slot, { kind: op.kind, amount: op.amount, reply: expected })

      if (crash !== undefined && index === crashAt) yield* test.crashNext(crash.point)
    } else
      expected =
        receipt.kind === op.kind && receipt.amount === op.amount ? receipt.reply : "CommandConflict"

    const id = Actor.commandId(ids[op.slot]!)

    const reply =
      op.kind === "Add"
        ? yield* tally.Add(op.amount).pipe(
            id,
            Effect.map((value) => `ok:${value}`),
            Effect.catch((error) => Effect.succeed(error.reason._tag)),
          )
        : yield* tally.Refuse(op.amount).pipe(
            id,
            Effect.as("replied"),
            Effect.catchTag("Refused", (error) => Effect.succeed(`refused:${error.amount}`)),
            Effect.catch((error) => Effect.succeed(error.reason._tag)),
          )

    if (reply !== expected) return false
  }

  const inspection = yield* test.inspect(tally.ref)
  const state = yield* Schema.decodeUnknownEffect(StoredCount)(inspection.state).pipe(Effect.orDie)

  return inspection.receipts === stored.size && (state.count ?? 0) === count
})

const Json = Schema.Json

type Stored = { readonly tenant_id: string; readonly actor_id: string; readonly id: string }

type Replay = readonly [ReadonlyArray<string>, ReadonlyArray<string>] | string

const encodeJson = (value: typeof Json.Type) =>
  Schema.encodeEffect(Schema.fromJsonString(Json))(value).pipe(Effect.orDie)

const EventOp = Schema.Union([
  Schema.TaggedStruct("Post", { body: Schema.Literals(["a", "b", "c"]) }),
  Schema.TaggedStruct("Archive", {}),
  Schema.TaggedStruct("Prune", {
    by: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  }),
  Schema.TaggedStruct("Read", {
    after: Schema.Union([
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
      Schema.Literals(["x", "-1", "01", "1.0", " 1", "9223372036854775807", "9223372036854775808"]),
    ]),
    archived: Schema.Boolean,
  }),
])

const eventOps = Arbitrary.array(Arbitrary.schema(EventOp), { minLength: 1, maxLength: 8 })

const TableOp = Schema.Union([
  Schema.TaggedStruct("Save", {
    at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    id: Schema.Literals(["x", "y", "z"]),
    rank: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  }),
  Schema.TaggedStruct("Remove", {
    at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    id: Schema.Literals(["x", "y", "z"]),
  }),
  Schema.TaggedStruct("Promote", {
    at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    atLeast: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    rank: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  }),
  Schema.TaggedStruct("Clear", {
    at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  }),
  Schema.TaggedStruct("Misuse", {
    at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    kind: Misuse,
  }),
])

const tableOps = Arbitrary.array(Arbitrary.schema(TableOp), { minLength: 1, maxLength: 6 })

const TimerOp = Schema.Union([
  Schema.TaggedStruct("Schedule", { key: Schema.optionalKey(Schema.Literals(["a", "b", "c"])) }),
  Schema.TaggedStruct("Cancel", { key: Schema.Literals(["a", "b", "c"]) }),
  Schema.TaggedStruct("CancelThenRefuse", { key: Schema.Literals(["a", "b", "c"]) }),
])

const timerOps = Arbitrary.array(Arbitrary.schema(TimerOp), { minLength: 1, maxLength: 6 })

const isJsonObject = Schema.is(Schema.JsonObject)

/** Reorders every object's keys, which JSONB canonicalization must undo. */
const reversed = (value: typeof Json.Type): typeof Json.Type => {
  if (Array.isArray(value)) return value.map(reversed)

  if (isJsonObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reversed(entry)]),
    )

  return value
}

const storableText = (text: string) =>
  !text.includes("\u0000") && new TextDecoder().decode(new TextEncoder().encode(text)) === text

const storable = (value: typeof Json.Type): boolean => {
  if (Predicate.isString(value)) return storableText(value)

  if (Array.isArray(value)) return value.every(storable)

  if (isJsonObject(value))
    return Object.entries(value).every(([key, entry]) => storableText(key) && storable(entry))

  return true
}

/** Property cases: payload hashing and receipts checked against a model over generated inputs. */
export const propertiesConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "property: hashes a payload by its JSONB canonical text regardless of key order or spacing",
    timeoutMs: 120_000,
    run: ({ environment }) =>
      environment.run(
        checkProperty({
          name: "canonical payload hash",
          arbitrary: Arbitrary.filter(Arbitrary.schema(Json), storable).pipe(
            Arbitrary.map((value): typeof Json.Type => ({ value, escapes: ["\\^@", "\\u0000"] })),
          ),
          property: Effect.fnUntraced(function* (value) {
            const text = yield* encodeJson(value)
            const reorderedText = yield* encodeJson(reversed(value))
            const hash = yield* payloadHash(text)

            return (
              /^[0-9a-f]{64}$/.test(hash) &&
              hash === (yield* payloadHash(reorderedText)) &&
              hash === (yield* payloadHash(`\n\t ${reorderedText} \n`))
            )
          }),
        }).pipe(Effect.asVoid),
      ),
  },
  {
    name: "property: rejects malformed and expired identities as terminal for payloads Postgres cannot store",
    timeoutMs: 120_000,
    run: ({ environment }) =>
      environment.run(
        Effect.gen(function* () {
          const tally = yield* Tally.get(nextCase("unstorable"))

          return yield* checkProperty({
            name: "terminal identities with NUL payloads",
            arbitrary: Arbitrary.all([Arbitrary.schema(Schema.String), small(16)]),
            property: Effect.fnUntraced(function* ([text, at]) {
              const index = Math.min(at, text.length)
              const payload = `${text.slice(0, index)}\u0000${text.slice(index)}`
              const malformed = `v1.1000.6000.${payload}`
              const expired = "v1.1000.61000.17b3670b-3f17-4a9b-aade-037e1dd1bba8"

              const invalid = yield* tally
                .Echo(payload)
                .pipe(Actor.commandId(malformed), Effect.flip)

              const late = yield* tally.Echo(payload).pipe(Actor.commandId(expired), Effect.flip)

              return (
                Schema.is(InvalidCommandId)(invalid.reason) &&
                invalid.reason.commandId === malformed &&
                Schema.is(CommandExpired)(late.reason) &&
                late.reason.commandId === expired
              )
            }),
          }).pipe(Effect.asVoid)
        }),
      ),
  },
  {
    name: "property: receipts match a model under duplicate ids, conflicting payloads, and declared failures",
    timeoutMs: 600_000,
    run: ({ environment }) =>
      environment.run(
        checkProperty({
          name: "receipt model",
          arbitrary: receiptOps,
          property: (ops) => receiptModel(ops, undefined),
        }).pipe(Effect.asVoid),
      ),
  },
  {
    name: "property: receipts match the same model when one generated turn crashes and retries",
    timeoutMs: 600_000,
    run: ({ environment }) =>
      environment.run(
        checkProperty({
          name: "receipt model with crashes",
          arbitrary: Arbitrary.all([receiptOps, small(5), Arbitrary.schema(CrashPoint)]),
          property: ([ops, at, point]) => receiptModel(ops, { at, point }),
          runs: CRASH_RUNS,
        }).pipe(Effect.asVoid),
      ),
  },
  {
    name: "property: event cursors stay monotonic and replay exclusively under random pruning, against a model",
    timeoutMs: 600_000,
    run: ({ environment }) =>
      environment.run(
        checkProperty({
          name: "event cursor model",
          arbitrary: eventOps,
          property: Effect.fnUntraced(function* (ops) {
            const id = nextCase("events")
            const feed = yield* Feed.get(id)
            let retained: Array<{ sequence: number; tag: string; body: string }> = []
            let head = 0

            const read = (after: string, archived: boolean) =>
              feed.History({ after, archived }).pipe(
                Effect.map((entries): Replay => [cursors(entries), bodies(entries)]),
                Effect.catchTags({
                  UnknownCursor: ({ cursor }) => Effect.succeed(`UnknownCursor:${cursor}`),
                  RetentionGap: ({ cursor }) => Effect.succeed(`RetentionGap:${cursor}`),
                  ActorError: ({ reason }) => Effect.succeed(reason._tag),
                }),
                Effect.map((replay) => {
                  const canonical = /^(0|[1-9][0-9]{0,18})$/.test(after)
                  const position = canonical ? BigInt(after) : -1n
                  const oldest = retained[0]?.sequence
                  const tag = archived ? "Archived" : "Posted"

                  const matching = retained.filter(
                    (event) => BigInt(event.sequence) > position && event.tag === tag,
                  )

                  const expected: Replay =
                    !canonical || position > 2n ** 63n - 1n || position > BigInt(head)
                      ? `UnknownCursor:${after}`
                      : position < BigInt(head) &&
                          (oldest === undefined || BigInt(oldest) > position + 1n)
                        ? `RetentionGap:${after}`
                        : [
                            matching.map(({ sequence }) => String(sequence)),
                            matching.map(({ body }) => body),
                          ]

                  return isDeepStrictEqual(replay, expected)
                }),
              )

            const append = (tag: string, body: string) => {
              head += 1
              retained.push({ sequence: head, tag, body })

              return true
            }

            for (const op of ops) {
              const agrees = yield* Match.value(op).pipe(
                Match.tagsExhaustive({
                  Post: ({ body }) =>
                    feed.Post(body).pipe(Effect.map(() => append("Posted", body))),
                  Archive: () =>
                    feed.Archive().pipe(Effect.map(() => append("Archived", "Archived"))),
                  Prune: ({ by }) => {
                    const oldest = retained[0]?.sequence ?? head + 1
                    const through = Math.min(head, oldest - 1 + by)

                    return prune(id, through).pipe(
                      Effect.map(() => {
                        retained = retained.filter(({ sequence }) => sequence > through)

                        return true
                      }),
                    )
                  },
                  Read: ({ after, archived }) => read(String(after), archived),
                }),
              )

              if (!agrees) return false
            }

            const all = yield* feed.History({}).pipe(Effect.orElseSucceed(() => []))
            const sequences = all.map(({ cursor }) => Number(cursor))

            return sequences.every(
              (sequence, index) => index === 0 || sequence > sequences[index - 1]!,
            )
          }),
        }).pipe(Effect.asVoid),
      ),
  },
  {
    name: "property: owned rows never cross tenants or actors under random operations, filters, and exploits",
    timeoutMs: 600_000,
    run: ({ environment }) =>
      environment.run(
        checkProperty({
          name: "owned-table scoping model",
          arbitrary: tableOps,
          property: Effect.fnUntraced(function* (ops) {
            const test = yield* ActorTest
            const sql = yield* SqlClient.SqlClient
            const id = nextCase("tables")
            const tenants = [test.tenant, `${test.tenant}-property`]

            const scopes = [0, 1, 2, 3].map((at) => ({
              tenant: tenants[at % 2]!,
              actor: `${id}-${Math.floor(at / 2)}`,
            }))

            const handles = yield* Effect.forEach(scopes, ({ tenant, actor }) =>
              Notebook.get(actor).pipe(Actor.tenant(tenant)),
            )

            const model = scopes.map(() => new Map<string, number>())

            const exploited = sql<Stored>`
              SELECT tenant_id, actor_id, id FROM conformance_notes
              WHERE (actor_id = 'victim' OR tenant_id = 'elsewhere'
                OR id IN ('forged', 'raw', 'unknown', 'wrapped', 'before-misuse'))
                AND actor_id NOT LIKE ${`${id}-%`}
              ORDER BY tenant_id COLLATE "C", actor_id COLLATE "C", id COLLATE "C"`.pipe(
              Effect.orDie,
            )

            const before = yield* exploited

            for (const op of ops) {
              const notebook = handles[op.at]!
              const rows = model[op.at]!

              const agrees = yield* Match.value(op).pipe(
                Match.tagsExhaustive({
                  Save: ({ id: key, rank }) =>
                    notebook.Save({ id: key, body: key, rank }).pipe(
                      Effect.tap(() => Effect.sync(() => rows.set(key, rank))),
                      Effect.as(true),
                    ),
                  Remove: ({ id: key }) =>
                    notebook.Remove(key).pipe(
                      Effect.tap(() => Effect.sync(() => rows.delete(key))),
                      Effect.as(true),
                    ),
                  Promote: ({ atLeast, rank }) =>
                    notebook.Promote({ atLeast, rank }).pipe(
                      Effect.map(() => {
                        for (const [key, current] of rows)
                          if (current >= atLeast) rows.set(key, rank)

                        return true
                      }),
                    ),
                  Clear: () =>
                    notebook.Clear().pipe(
                      Effect.map(() => {
                        rows.clear()

                        return true
                      }),
                    ),
                  Misuse: ({ kind }) =>
                    Effect.exit(notebook.WriteThenMisuse(kind)).pipe(Effect.map(Exit.isFailure)),
                }),
              )

              if (!agrees) return false
            }

            for (const [at, notebook] of handles.entries()) {
              const listed = yield* notebook.List()

              const expected = [...model[at]!.entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([key, rank]) => ({ id: key, body: key, rank }))

              if (!isDeepStrictEqual(listed, expected)) return false
            }

            const stored = yield* sql<Stored>`
              SELECT tenant_id, actor_id, id FROM conformance_notes
              WHERE actor_id LIKE ${`${id}-%`}
              ORDER BY tenant_id COLLATE "C", actor_id COLLATE "C", id COLLATE "C"`.pipe(
              Effect.orDie,
            )

            const expected = scopes
              .flatMap(({ tenant, actor }, at) =>
                [...model[at]!.keys()].map((key) => ({
                  tenant_id: tenant,
                  actor_id: actor,
                  id: key,
                })),
              )
              .sort((a, b) => {
                const left = `${a.tenant_id}\u0000${a.actor_id}\u0000${a.id}`
                const right = `${b.tenant_id}\u0000${b.actor_id}\u0000${b.id}`

                return left < right ? -1 : left > right ? 1 : 0
              })

            return (
              isDeepStrictEqual(stored, expected) && isDeepStrictEqual(yield* exploited, before)
            )
          }),
        }).pipe(Effect.asVoid),
      ),
  },
  {
    name: "property: keyed timers replace and cancel exactly as a model predicts",
    timeoutMs: 600_000,
    run: ({ environment }) =>
      environment.run(
        checkProperty({
          name: "keyed timer model",
          arbitrary: timerOps,
          property: Effect.fnUntraced(function* (ops) {
            const test = yield* ActorTest
            const to = nextCase("timers")
            const outboxer = yield* Outboxer.get(to)
            const keyed = new Map<string, string>()
            const unkeyed: Array<string> = []

            for (const [index, op] of ops.entries())
              yield* Match.value(op).pipe(
                Match.tagsExhaustive({
                  Schedule: ({ key }) => {
                    const body = `${index}`

                    if (key === undefined) unkeyed.push(body)
                    else keyed.set(key, body)

                    return outboxer.Schedule({ to, body, afterMs: 60_000, ...op })
                  },
                  Cancel: ({ key }) => {
                    keyed.delete(key)

                    return outboxer.Cancel(key)
                  },
                  CancelThenRefuse: ({ key }) =>
                    outboxer.CancelThenRefuse(key).pipe(Effect.flip, Effect.asVoid),
                }),
              )

            const pending = (yield* test.inspect(outboxer.ref)).outbox
            yield* test.advance("61 seconds")
            const received = [...(yield* receivedBodies(to))].sort()
            const expected = [...unkeyed, ...keyed.values()].sort()

            return (
              pending === expected.length &&
              isDeepStrictEqual(received, expected) &&
              (yield* test.inspect(outboxer.ref)).outbox === 0
            )
          }),
        }).pipe(Effect.asVoid),
      ),
  },
]

/** Property actors, beside the feed, outbox and table actors the properties drive. */
export const propertiesSuite: ConformanceSuite = {
  layer: () => propertiesLayer,
  uses: [eventsSuite, outboxSuite, tablesSuite],
}
