import { eq, inArray, Param, SQL, sql as drizzleSql, StringChunk } from "drizzle-orm"
import { index, integer, pgTable, text } from "drizzle-orm/pg-core"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../index.ts"
import type { AnyOwnedTable, ScopedRows } from "../../tables/owned.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

/** An owned table with a column-level key, a per-actor unique column, and an index. */
export const notes = Actor.table(
  pgTable(
    "conformance_notes",
    {
      id: text("id").primaryKey(),
      body: text("body").notNull().unique(),
      rank: integer("rank").notNull().default(0),
    },
    (table) => [index("conformance_notes_rank").on(table.rank)],
  ),
)

/** A second actor type's table in the same tenant placement group. */
export const labels = Actor.table(
  pgTable("conformance_labels", {
    id: text("id").primaryKey(),
    noteId: text("note_id").notNull(),
    label: text("label").notNull(),
  }),
)

const unowned = pgTable("conformance_unowned", { id: text("id").primaryKey() })

// Wrapped but listed by no actor type, as a handler could do to reach framework tables.
const receipts = Actor.table(
  pgTable("actor_receipts", {
    command_id: text("command_id").primaryKey(),
    command: text("command"),
  }),
)

/** What drizzle-kit generates for the tables above; `owned.test.ts` checks it stays so. */
export const tablesDdl = [
  `CREATE TABLE "conformance_notes" (
	"routing_key" bigint,
	"tenant_id" text,
	"actor_id" text,
	"id" text,
	"body" text NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "conformance_notes_pkey" PRIMARY KEY("routing_key","tenant_id","actor_id","id"),
	CONSTRAINT "conformance_notes_routing_key_tenant_id_actor_id_body_unique" UNIQUE("routing_key","tenant_id","actor_id","body")
);
`,
  `CREATE TABLE "conformance_labels" (
	"routing_key" bigint,
	"tenant_id" text,
	"actor_id" text,
	"id" text,
	"note_id" text NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "conformance_labels_pkey" PRIMARY KEY("routing_key","tenant_id","actor_id","id")
);
`,
  `CREATE INDEX "conformance_notes_rank" ON "conformance_notes" ("routing_key","tenant_id","actor_id","rank");`,
]

export interface TablesFixture {
  escaped: Effect.Effect<unknown>
  hold: Effect.Effect<void>
}

export const tablesFixture = (): TablesFixture => ({ escaped: Effect.void, hold: Effect.void })

class NotebookRejected extends Schema.TaggedError<NotebookRejected>()("NotebookRejected", {}) {}

const Note = Schema.Struct({ id: Schema.String, body: Schema.String, rank: Schema.Int })

export const Misuse = Schema.Literals([
  "ownerInsert",
  "ownerFilter",
  "ownerSet",
  "ownerUpsert",
  "rawValue",
  "rawFilter",
  "unknownColumn",
  "undeclaredTable",
  "wrappedFilter",
  "wrappedValue",
])

const GroupMisuse = Schema.Literals([
  "raw",
  "rightJoin",
  "lock",
  "unowned",
  "subquery",
  "parentheses",
  "param",
  "wrapper",
  "ownership",
  "unlisted",
])

const Write = Actor.command("Write", {
  input: Schema.Struct({ id: Schema.String, body: Schema.String }),
  output: Schema.Int,
})

const Save = Actor.command("Save", { input: Note })

const Rename = Actor.command("Rename", {
  input: Schema.Struct({ id: Schema.String, body: Schema.String }),
})

const Promote = Actor.command("Promote", {
  input: Schema.Struct({ atLeast: Schema.Int, rank: Schema.Int }),
})

const Remove = Actor.command("Remove", { input: Schema.String })

const Clear = Actor.command("Clear")

const WriteThenReject = Actor.command("WriteThenReject", {
  input: Schema.String,
  errors: [NotebookRejected],
})

const WriteThenMisuse = Actor.command("WriteThenMisuse", { input: Misuse })

const WriteThenHold = Actor.command("WriteThenHold", { input: Schema.String })

const Capture = Actor.command("Capture")

const CaptureGroup = Actor.command("CaptureGroup")

const Replay = Actor.command("Replay")

const List = Actor.query("List", { output: Schema.Array(Note) })

const Get = Actor.query("Get", { input: Schema.String, output: Schema.Option(Note) })

const Ranked = Actor.query("Ranked", {
  input: Schema.Struct({ limit: Schema.Int, offset: Schema.Int }),
  output: Schema.Array(Schema.String),
})

const Count = Actor.query("Count", { output: Schema.Int })

const QueryWrite = Actor.query("QueryWrite")

const Joined = Schema.Struct({
  note: Schema.String,
  body: Schema.String,
  label: Schema.NullOr(Schema.String),
})

const Catalog = Actor.query("Catalog", { input: Schema.Boolean, output: Schema.Array(Joined) })

const Misgroup = Actor.query("Misgroup", { input: GroupMisuse })

/** Queries that try to smuggle SQL past validation; any rows they return must stay in scope. */
const Smuggle = Schema.Literals([
  "dateFilter",
  "dateGroup",
  "hiddenWhere",
  "hiddenSelection",
  "shiftingText",
  "shiftingParam",
  "shiftingChunks",
])

const Smuggled = Actor.query("Smuggled", {
  input: Smuggle,
  output: Schema.Array(Schema.String),
})

const Everything = Actor.query("Everything", { output: Schema.Array(Schema.String) })

/** @internal */
export const Notebook = Actor.make("Notebook", {
  key: Schema.String,
  tables: [notes],
  api: {
    Write,
    Save,
    Rename,
    Promote,
    Remove,
    Clear,
    WriteThenReject,
    WriteThenMisuse,
    WriteThenHold,
    Capture,
    CaptureGroup,
    Replay,
    List,
    Get,
    Ranked,
    Count,
    QueryWrite,
    Catalog,
    Misgroup,
    Everything,
    Smuggled,
  },
})

const Label = Actor.command("Label", {
  input: Schema.Struct({ id: Schema.String, noteId: Schema.String, label: Schema.String }),
})

const Shelf = Actor.make("Shelf", { key: Schema.String, tables: [labels], api: { Label } })

// A plain object Drizzle would render as SQL; it would close the scope's parentheses.
const sqlLookalike = { getSQL: () => drizzleSql.raw("'zzz')) or ((true") } as never

const escape = "'zzz')) or ((true"

// A date that also looks like SQL to Drizzle.
const sqlDate = (text: string) =>
  Object.assign(DateTime.toDateUtc(DateTime.makeUnsafe(0)), {
    getSQL: () => drizzleSql.raw(text),
  }) as never

// SQL hidden from Object.keys, so a copy would drop it but the original would render.
const hiddenSql = (text: string) =>
  Object.defineProperty({}, "getSQL", { value: () => drizzleSql.raw(text) }) as never

// Safe on the first reads, then raw SQL: only a value read once can be trusted.
const shifting = <T>(safe: T, evil: T, safeReads: number) => {
  let reads = 0

  return () => {
    reads += 1

    return reads <= safeReads ? safe : evil
  }
}

// Rows seen through the loosest static type, as code bypassing the declared table types would.
const misuse = (loose: ScopedRows<AnyOwnedTable>, kind: typeof Misuse.Type) => {
  switch (kind) {
    case "ownerInsert":
      return loose.insert({ id: "forged", body: "forged", actor_id: "victim" })
    case "ownerFilter":
      return loose.delete().where({ actor_id: { eq: "victim" } })
    case "ownerSet":
      return loose.update({ tenant_id: "elsewhere" }).where({})
    case "ownerUpsert":
      return loose.upsert({ id: "forged", body: "forged", routing_key: 0n })
    case "rawValue":
      return loose.insert({ id: "raw", body: drizzleSql`(SELECT body FROM conformance_notes)` })
    case "rawFilter":
      return loose.delete().where({ RAW: { eq: drizzleSql`true` } })
    case "unknownColumn":
      return loose.insert({ id: "unknown", body: "unknown", secret: 1 })
    case "wrappedFilter":
      return loose.delete().where({ id: { eq: sqlLookalike } })
    case "wrappedValue":
      return loose.insert({ id: "wrapped", body: sqlLookalike })
    case "undeclaredTable":
      return loose.all()
  }
}

const NotebookLive = (fixture: TablesFixture) =>
  Notebook.toLayer(
    Effect.succeed({
      Write: Effect.fnUntraced(function* ({ id, body }) {
        const turn = yield* Notebook.Turn
        yield* turn.rows(notes).insert({ id, body })

        return yield* turn.rows(notes).count()
      }),
      Save: Effect.fnUntraced(function* (note) {
        yield* (yield* Notebook.Turn).rows(notes).upsert(note)
      }),
      Rename: Effect.fnUntraced(function* ({ id, body }) {
        yield* (yield* Notebook.Turn).rows(notes).update({ body }).where({ id })
      }),
      Promote: Effect.fnUntraced(function* ({ atLeast, rank }) {
        yield* (yield* Notebook.Turn)
          .rows(notes)
          .update({ rank })
          .where({ rank: { gte: atLeast } })
      }),
      Remove: Effect.fnUntraced(function* (id) {
        yield* (yield* Notebook.Turn).rows(notes).delete().where({ id })
      }),
      Clear: Effect.fnUntraced(function* () {
        yield* (yield* Notebook.Turn).rows(notes).delete().where({})
      }),
      WriteThenReject: Effect.fnUntraced(function* (id) {
        const rows = (yield* Notebook.Turn).rows(notes)
        yield* rows.insert({ id, body: id })
        yield* rows.update({ rank: 3 }).where({})
        yield* rows.upsert({ id: "kept", body: "upserted", rank: 9 })
        yield* rows.delete().where({ id })

        return yield* NotebookRejected.make({})
      }),
      WriteThenMisuse: Effect.fnUntraced(function* (kind) {
        const turn = yield* Notebook.Turn
        yield* turn.rows(notes).insert({ id: "before-misuse", body: "before-misuse" })

        const loose = turn.rows as (table: AnyOwnedTable) => ScopedRows<AnyOwnedTable>

        yield* misuse(loose(kind === "undeclaredTable" ? labels : notes), kind)
      }),
      WriteThenHold: Effect.fnUntraced(function* (id) {
        const rows = (yield* Notebook.Turn).rows(notes)
        fixture.escaped = rows.insert({ id: `${id}-stolen`, body: `${id}-stolen` })
        yield* rows.insert({ id, body: id })
        yield* fixture.hold
      }),
      Capture: Effect.fnUntraced(function* () {
        const rows = (yield* Notebook.Turn).rows(notes)
        fixture.escaped = rows.insert({ id: "escaped", body: "escaped" })
        yield* rows.insert({ id: "captured", body: "captured" })
      }),
      CaptureGroup: Effect.fnUntraced(function* () {
        fixture.escaped = (yield* Notebook.Turn).group((db) =>
          db.select({ id: notes.id }).from(notes),
        )
      }),
      Replay: () => Effect.suspend(() => fixture.escaped).pipe(Effect.asVoid),
    }),
  )

const NotebookReads = Notebook.toQueryLayer(
  Effect.succeed({
    List: Effect.fnUntraced(function* () {
      return yield* (yield* Notebook.Read).rows(notes).all({ orderBy: { id: "asc" } })
    }),
    Get: Effect.fnUntraced(function* (id) {
      return yield* (yield* Notebook.Read).rows(notes).one({ where: { id } })
    }),
    Ranked: Effect.fnUntraced(function* ({ limit, offset }) {
      const found = yield* (yield* Notebook.Read)
        .rows(notes)
        .all({ orderBy: { rank: "desc", id: "asc" }, limit, offset })

      return found.map((note) => note.id)
    }),
    Count: Effect.fnUntraced(function* () {
      return yield* (yield* Notebook.Read).rows(notes).count()
    }),
    QueryWrite: Effect.fnUntraced(function* () {
      const rows = (yield* Notebook.Read).rows(notes) as ScopedRows<typeof notes>

      yield* rows.insert({ id: "from-query", body: "from-query" })
    }),
    Catalog: Effect.fnUntraced(function* (left) {
      return yield* (yield* Notebook.Read).group((db) => {
        const query = db
          .select({ note: notes.id, body: notes.body, label: labels.label })
          .from(notes)
          .$dynamic()

        return (
          left
            ? query.leftJoin(labels, eq(labels.noteId, notes.id))
            : query.innerJoin(labels, eq(labels.noteId, notes.id))
        )
          .where(inArray(notes.id, ["a", "b", "c"]))
          .orderBy(notes.id, labels.label)
      })
    }),
    Everything: Effect.fnUntraced(function* () {
      const found = yield* (yield* Notebook.Read).group((db) =>
        db
          .select({ body: notes.body })
          .from(notes)
          .where(drizzleSql`true or true`),
      )

      return found.map((note) => note.body)
    }),
    Smuggled: Effect.fnUntraced(function* (kind) {
      const read = yield* Notebook.Read

      if (kind === "dateFilter") {
        const found = yield* read.rows(notes).all({ where: { id: { eq: sqlDate(escape) } } })

        return found.map((note) => note.body)
      }

      const found = yield* read.group((db) => {
        const base = db.select({ body: notes.body }).from(notes)

        switch (kind) {
          case "dateGroup":
            return base.where(drizzleSql`${sqlDate("true)) or ((true")}`)
          case "hiddenWhere":
            return base.where(drizzleSql`${hiddenSql("true)) or ((true")}`)
          case "hiddenSelection":
            return db
              .select({
                body: drizzleSql<string>`${hiddenSql("(select string_agg(body, ',') from conformance_notes)")}`.as(
                  "body",
                ),
              })
              .from(notes)
          case "shiftingText": {
            const chunk = new StringChunk("true")
            const value = shifting("true", "true)) or ((true", 2)
            Object.defineProperty(chunk, "value", { get: value })

            return base.where(new SQL([chunk]))
          }

          case "shiftingParam": {
            const param = new Param(true)
            const value = shifting<unknown>(true, drizzleSql.raw("true)) or ((true"), 1)
            Object.defineProperty(param, "value", { get: value })

            return base.where(drizzleSql`${param}`)
          }

          case "shiftingChunks": {
            const expression = new SQL([new StringChunk("true")])

            const chunks = shifting(
              [new StringChunk("true")],
              [new StringChunk("true)) or ((true")],
              1,
            )

            Object.defineProperty(expression, "queryChunks", { get: chunks })

            return base.where(expression)
          }
        }
      })

      return found.map((note) => note.body)
    }),
    Misgroup: Effect.fnUntraced(function* (kind) {
      yield* (yield* Notebook.Read).group((db) => {
        switch (kind) {
          case "raw":
            return db
              .select({ id: notes.id })
              .from(notes)
              .where(drizzleSql`exists (select 1 from conformance_labels)`)
          case "subquery":
            return db
              .select({ id: notes.id })
              .from(notes)
              .where(drizzleSql`${notes.id} in ${db.select({ id: labels.noteId }).from(labels)}`)
          case "rightJoin":
            return db
              .select({ id: notes.id })
              .from(notes)
              .rightJoin(labels, eq(labels.noteId, notes.id))
          case "lock":
            return db.select({ id: notes.id }).from(notes).for("update")
          case "unowned":
            return db.select({ id: unowned.id }).from(unowned)
          case "parentheses":
            return db
              .select({ id: notes.id })
              .from(notes)
              .where(drizzleSql`true)) or ((true`)
          case "param":
            return db
              .select({ id: notes.id })
              .from(notes)
              .where(drizzleSql`${new Param(drizzleSql.raw("true"))}`)
          case "wrapper":
            return db
              .select({ id: notes.id })
              .from(notes)
              .where(drizzleSql`${sqlLookalike}`)
          case "unlisted":
            return db.select({ id: receipts.command }).from(receipts)
          case "ownership":
            return db.select({ id: notes.tenant_id }).from(notes)
        }
      })
    }),
  }),
)

const ShelfLive = Shelf.toLayer(
  Effect.succeed({
    Label: Effect.fnUntraced(function* (label) {
      yield* (yield* Shelf.Turn).rows(labels).insert(label)
    }),
  }),
)

/** Applies the drizzle-kit DDL once, then registers the table-owning actors. */
export const tablesLayer = (fixture: TablesFixture) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const existing = yield* sql<{ relname: string }>`
        SELECT relname FROM pg_class WHERE relname = 'conformance_notes'`

      if (existing.length === 0) for (const statement of tablesDdl) yield* sql.unsafe(statement)

      return Layer.mergeAll(NotebookLive(fixture), NotebookReads, ShelfLive)
    }).pipe(Effect.orDie),
  )

const defect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"

const rowsOf = (count: number) => ({ rows: { conformance_notes: count } })

export const tablesConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "scopes owned rows by tenant and actor for every supported operation",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const home = yield* Notebook.get("shared-id")
          const neighbor = yield* Notebook.get("neighbor")
          const abroad = yield* Notebook.get("shared-id").pipe(Actor.tenant(`${test.tenant}-b`))
          const all = [home, neighbor, abroad]

          // Interleaved: each step runs the same business-only call on every actor.
          for (const notebook of all)
            expect(yield* notebook.Write({ id: "n1", body: "one" })).toBe(1)

          for (const notebook of all)
            expect(yield* notebook.Write({ id: "n2", body: "two" })).toBe(2)
          yield* home.Save({ id: "n1", body: "uno", rank: 5 })
          yield* neighbor.Save({ id: "n3", body: "three", rank: 1 })
          yield* abroad.Rename({ id: "n2", body: "dos" })
          yield* neighbor.Promote({ atLeast: 0, rank: 7 })
          yield* abroad.Remove("n1")

          expect(yield* home.List()).toEqual([
            { id: "n1", body: "uno", rank: 5 },
            { id: "n2", body: "two", rank: 0 },
          ])
          expect(yield* neighbor.List()).toEqual([
            { id: "n1", body: "one", rank: 7 },
            { id: "n2", body: "two", rank: 7 },
            { id: "n3", body: "three", rank: 7 },
          ])
          expect(yield* abroad.List()).toEqual([{ id: "n2", body: "dos", rank: 0 }])
          expect(yield* home.Get("n1")).toEqual(Option.some({ id: "n1", body: "uno", rank: 5 }))
          expect(yield* abroad.Get("n1")).toEqual(Option.none())
          expect(yield* neighbor.Ranked({ limit: 2, offset: 1 })).toEqual(["n2", "n3"])
          expect(yield* home.Count()).toBe(2)

          yield* home.Clear()
          expect(yield* test.inspect(home.ref)).toMatchObject(rowsOf(0))
          expect(yield* test.inspect(neighbor.ref)).toMatchObject(rowsOf(3))
          expect(yield* test.inspect(abroad.ref)).toMatchObject(rowsOf(1))
        }),
      ),
  },
  {
    name: "keeps unique constraints per actor and rejects a duplicate key as a defect without a receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const first = yield* Notebook.get("unique-a")
          const second = yield* Notebook.get("unique-b")
          expect(yield* first.Write({ id: "k", body: "same" })).toBe(1)
          expect(yield* second.Write({ id: "k", body: "same" })).toBe(1)
          const duplicate = yield* first.Write({ id: "k2", body: "same" }).pipe(Effect.exit)
          expect(defect(duplicate)).toContain("conformance_notes")
          expect(yield* test.inspect(first.ref)).toMatchObject({ ...rowsOf(1), receipts: 1 })
          expect(yield* test.inspect(second.ref)).toMatchObject({ ...rowsOf(1), receipts: 1 })
        }),
      ),
  },
  {
    name: "cannot write another actor's rows, even with an explicit actor_id",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const victim = yield* Notebook.get("victim")
          const attacker = yield* Notebook.get("attacker")
          expect(yield* victim.Write({ id: "v", body: "victim" })).toBe(1)

          const rejections: ReadonlyArray<readonly [typeof Misuse.Type, string]> = [
            ["ownerInsert", "Ownership column actor_id"],
            ["ownerFilter", "Ownership column actor_id"],
            ["ownerSet", "Ownership column tenant_id"],
            ["ownerUpsert", "Ownership column routing_key"],
            ["rawValue", "plain data"],
            ["rawFilter", "RAW filters"],
            ["unknownColumn", "Unknown column secret"],
            ["undeclaredTable", "is not an owned table of Notebook"],
            ["wrappedFilter", "plain data"],
            ["wrappedValue", "plain data"],
          ]

          for (const [kind, message] of rejections)
            expect(defect(yield* attacker.WriteThenMisuse(kind).pipe(Effect.exit))).toContain(
              message,
            )

          // Nothing partial survives: not the attacker's first insert, not a receipt.
          expect(yield* test.inspect(attacker.ref)).toMatchObject({ ...rowsOf(0), receipts: 0 })
          expect(yield* victim.List()).toEqual([{ id: "v", body: "victim", rank: 0 }])
        }),
      ),
  },
  {
    name: "rolls back every owned-row write with a declared failure and keeps its receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const notebook = yield* Notebook.get("rejected")
          expect(yield* notebook.Write({ id: "kept", body: "kept" })).toBe(1)
          const rejected = notebook.WriteThenReject("dropped")
          expect(yield* rejected.pipe(Effect.flip)).toEqual(NotebookRejected.make({}))
          expect(yield* rejected.pipe(Effect.flip)).toEqual(NotebookRejected.make({}))
          expect(yield* notebook.List()).toEqual([{ id: "kept", body: "kept", rank: 0 }])
          expect(yield* test.inspect(notebook.ref)).toMatchObject({ ...rowsOf(1), receipts: 2 })
        }),
      ),
  },
  {
    name: "retries a crash before commit to exactly one owned row",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const notebook = yield* Notebook.get("crash")
          yield* test.crashNext("beforeCommit")
          expect(yield* notebook.Write({ id: "once", body: "once" })).toBe(1)
          expect(yield* test.inspect(notebook.ref)).toMatchObject({ ...rowsOf(1), receipts: 1 })
        }),
      ),
  },
  {
    name: "gives queries read-only rows and rejects escaped row capabilities",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const notebook = yield* Notebook.get("escape")
          expect(defect(yield* notebook.QueryWrite().pipe(Effect.exit))).toContain("insert")
          yield* notebook.Capture()
          expect(defect(yield* fixture.tables.escaped.pipe(Effect.exit))).toContain(
            "Table capability escaped its turn",
          )
          expect(defect(yield* notebook.Replay().pipe(Effect.exit))).toContain(
            "Table capability escaped its turn",
          )
          yield* notebook.CaptureGroup()
          expect(defect(yield* fixture.tables.escaped.pipe(Effect.exit))).toContain(
            "Table capability escaped its turn",
          )
          expect(yield* notebook.List()).toEqual([{ id: "captured", body: "captured", rank: 0 }])
          expect(yield* test.inspect(notebook.ref)).toMatchObject({ ...rowsOf(1), receipts: 2 })
        }),
      ),
  },
  {
    name: "joins owned tables across the placement group and never beyond it",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const other = `${test.tenant}-group`

          for (const tenant of [test.tenant, other]) {
            const scoped = Actor.tenant(tenant)
            yield* (yield* Notebook.get("g1").pipe(scoped)).Write({ id: "a", body: `a-${tenant}` })
            yield* (yield* Notebook.get("g2").pipe(scoped)).Write({ id: "b", body: `b-${tenant}` })
            yield* (yield* Notebook.get("g2").pipe(scoped)).Write({ id: "c", body: `c-${tenant}` })
            const shelf = yield* Shelf.get("s").pipe(scoped)
            yield* shelf.Label({ id: "l1", noteId: "a", label: `x-${tenant}` })
            yield* shelf.Label({ id: "l2", noteId: "b", label: `y-${tenant}` })
          }

          const reader = yield* Notebook.get("g1")
          const t = test.tenant

          expect(yield* reader.Catalog(false)).toEqual([
            { note: "a", body: `a-${t}`, label: `x-${t}` },
            { note: "b", body: `b-${t}`, label: `y-${t}` },
          ])
          const leaks: Record<string, ReadonlyArray<string>> = {}

          for (const kind of Smuggle.literals) {
            const exit = yield* reader.Smuggled(kind).pipe(Effect.exit)

            leaks[kind] = Exit.isSuccess(exit)
              ? exit.value.filter((body) => body.includes(other))
              : []
          }

          expect(leaks).toEqual(Object.fromEntries(Smuggle.literals.map((kind) => [kind, []])))

          // A balanced "or true" stays inside the framework's parenthesized scope.
          const everything = yield* reader.Everything()
          expect(everything).toContain(`a-${t}`)
          expect(everything.filter((body) => body.includes(other))).toEqual([])
          expect(yield* reader.Catalog(true)).toEqual([
            { note: "a", body: `a-${t}`, label: `x-${t}` },
            { note: "b", body: `b-${t}`, label: `y-${t}` },
            { note: "c", body: `c-${t}`, label: null },
          ])

          for (const [kind, message] of [
            ["raw", "not raw SQL"],
            ["subquery", "cannot reference tables, subqueries"],
            ["rightJoin", "inner and left joins"],
            ["lock", "read-only"],
            ["unowned", "registered by an actor type"],
            ["unlisted", "registered by an actor type"],
            ["parentheses", "balance their parentheses"],
            ["param", "plain data"],
            ["wrapper", "plain data"],
            ["ownership", "ownership columns"],
          ] as const)
            expect(defect(yield* reader.Misgroup(kind).pipe(Effect.exit))).toContain(message)
        }),
      ),
  },
  {
    name: "keeps uncommitted owned rows invisible to a second connection",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const notebook = yield* Notebook.get("invisible")
          const pause = yield* test.pauseNext("beforeCommit")

          const writer = yield* notebook
            .Write({ id: "pending", body: "pending" })
            .pipe(Effect.forkChild)

          yield* pause.reached
          expect(yield* notebook.Count()).toBe(0)
          expect(yield* test.inspect(notebook.ref)).toMatchObject({ ...rowsOf(0), receipts: 0 })
          yield* pause.release
          expect(yield* Fiber.join(writer)).toBe(1)
          expect(yield* notebook.Count()).toBe(1)
        }),
      ),
  },
  {
    name: "commits equal business keys of two actors concurrently without blocking",
    requiresIndependentConnections: true,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const first = yield* Notebook.get("contended-a")
          const second = yield* Notebook.get("contended-b")
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          fixture.tables.hold = Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )
          const holder = yield* first.WriteThenHold("same").pipe(Effect.forkChild)
          yield* Deferred.await(reached)
          fixture.tables.hold = Effect.void

          // The held turn keeps its row uncommitted; an equal key of another actor must not wait on it.
          expect(
            yield* second.Write({ id: "same", body: "same" }).pipe(Effect.timeout("5 seconds")),
          ).toBe(1)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(holder)
          expect(yield* test.inspect(first.ref)).toMatchObject({ ...rowsOf(1), receipts: 1 })
          expect(yield* test.inspect(second.ref)).toMatchObject({ ...rowsOf(1), receipts: 1 })
        }),
      ),
  },
  {
    name: "rejects an owned-row capability used from another still-active turn",
    requiresIndependentConnections: true,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const owner = yield* Notebook.get("row-owner")
          const thief = yield* Notebook.get("row-thief")
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          fixture.tables.hold = Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )
          const holder = yield* owner.WriteThenHold("held").pipe(Effect.forkChild)
          yield* Deferred.await(reached)
          fixture.tables.hold = Effect.void

          const stolen = yield* thief
            .Replay()
            .pipe(Effect.exit, Effect.ensuring(Deferred.succeed(release, undefined)))

          expect(defect(stolen)).toContain("Table capability escaped its turn")
          yield* Fiber.join(holder)
          expect(yield* owner.List()).toEqual([{ id: "held", body: "held", rank: 0 }])
          expect(yield* test.inspect(thief.ref)).toMatchObject({ ...rowsOf(0), receipts: 0 })
        }),
      ),
  },
  {
    name: "retries an owned-row write that times out on a real lock",
    requiresIndependentConnections: true,
    timeoutMs: 15_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const notebook = yield* Notebook.get("row-lock")
          const connect = environment.connect

          if (connect === undefined)
            return yield* Effect.die(new Error("backend lacks independent connections"))

          const lock = yield* connect
          yield* lock.query("BEGIN")
          yield* lock.query("LOCK TABLE conformance_notes IN EXCLUSIVE MODE")

          const writer = yield* notebook
            .Write({ id: "locked", body: "locked" })
            .pipe(Effect.forkChild)

          // Longer than the default 2 s lockWait, so at least one attempt times out.
          yield* Effect.sleep("3 seconds")
          yield* lock.query("ROLLBACK")
          expect(yield* Fiber.join(writer)).toBe(1)
          expect(yield* test.inspect(notebook.ref)).toMatchObject({ ...rowsOf(1), receipts: 1 })
        }),
      ),
  },
]
