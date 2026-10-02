import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { Actor } from "../../index.ts"
import type { AnyBlob } from "../../members/blob.ts"
import { MAX_ENTRY_BYTES } from "../../runtime/turn/blobs.ts"
import type { BlobWrite } from "../../state/blob.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"

/** Blob names shared by two actor types, so only the scope keeps their entries apart. */
export const files = Actor.blob("files")

const undeclared = Actor.blob("undeclared")

export interface BlobsFixture {
  escaped: Effect.Effect<unknown>
}

export const blobsFixture = (): BlobsFixture => ({ escaped: Effect.void })

class DrawerRejected extends Schema.TaggedError<DrawerRejected>()("DrawerRejected", {}) {}

const Entry = Schema.Struct({ name: Schema.String, text: Schema.String })

const Misuse = Schema.Literals([
  "undeclared",
  "emptyName",
  "loneSurrogate",
  "nul",
  "longName",
  "oversized",
  "notBytes",
])

const Store = Actor.command("Store", { payload: Entry })

/** Appends a chunk and returns the entry as the turn itself reads it. */
const Append = Actor.command("Append", { payload: Entry, success: Schema.String })

/** Appends, compacts, and returns the entry as the turn reads it after compaction. */
const AppendCompact = Actor.command("AppendCompact", { payload: Entry, success: Schema.String })

const WriteThenReject = Actor.command("WriteThenReject", {
  payload: Schema.String,
  error: DrawerRejected,
})

const WriteThenMisuse = Actor.command("WriteThenMisuse", { payload: Misuse })

/** Sets, appends, and sets again in one turn; the last set wins. */
const Rewrite = Actor.command("Rewrite", { payload: Entry, success: Schema.String })

const WriteForked = Actor.command("WriteForked")

/** A timeout runs its effect on a child fiber, so it is a forked use too. */
const WriteTimed = Actor.command("WriteTimed")

/** Races a write against a sleep, so the guard's defect would be swallowed by the race. */
const WriteRaced = Actor.command("WriteRaced")

/** Appends `size` bytes to one growing entry. */
const Grow = Actor.command("Grow", { payload: Schema.Int })

const Large = Actor.command("Large", { payload: Schema.Int })

const Capture = Actor.command("Capture")

const Replay = Actor.command("Replay")

const Get = Actor.query("Get", { payload: Schema.String, success: Schema.Option(Schema.String) })

const Size = Actor.query("Size", { payload: Schema.String, success: Schema.Int })

const QueryWrite = Actor.query("QueryWrite")

const CaptureRead = Actor.query("CaptureRead")

const Drawer = Actor.make("Drawer", {
  key: Schema.String,
  state: Actor.state({
    notes: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  blobs: [files],
  api: {
    Store,
    Append,
    AppendCompact,
    WriteThenReject,
    WriteThenMisuse,
    Rewrite,
    WriteForked,
    WriteTimed,
    WriteRaced,
    Grow,
    Large,
    Capture,
    Replay,
    Get,
    Size,
    QueryWrite,
    CaptureRead,
  },
  policy: { maxStateBytes: 1_024 },
})

const Put = Actor.command("Put", { payload: Entry })

const Peek = Actor.query("Peek", { payload: Schema.String, success: Schema.Option(Schema.String) })

/** A second actor type declaring an equally named blob. */
const Cabinet = Actor.make("Cabinet", { key: Schema.String, blobs: [files], api: { Put, Peek } })

const encoder = new TextEncoder()

const decoder = new TextDecoder()

const bytes = (text: string) => encoder.encode(text)

const text = (found: Option.Option<Uint8Array>) =>
  Option.map(found, (value) => decoder.decode(value))

const misuse = (loose: (blob: AnyBlob) => BlobWrite, kind: typeof Misuse.Type) => {
  switch (kind) {
    case "undeclared":
      return loose(undeclared).set("x", bytes("x"))
    case "emptyName":
      return loose(files).set("", bytes("x"))
    case "loneSurrogate":
      return loose(files).set("\uD800", bytes("x"))
    case "nul":
      return loose(files).set("a\u0000b", bytes("x"))
    case "longName":
      return loose(files).set("界".repeat(171), bytes("x"))
    case "oversized":
      return loose(files).set("x", new Uint8Array(MAX_ENTRY_BYTES + 1))
    case "notBytes":
      return loose(files).set("x", "not bytes" as never)
  }
}

const DrawerLive = (fixture: BlobsFixture) =>
  Drawer.toLayer(
    Effect.succeed({
      Store: Effect.fnUntraced(function* ({ name, text }) {
        yield* (yield* Drawer.Turn).blob(files).set(name, bytes(text))
      }),
      Append: Effect.fnUntraced(function* ({ name, text: chunk }) {
        const blob = (yield* Drawer.Turn).blob(files)
        yield* blob.append(name, bytes(chunk))

        return Option.getOrThrow(text(yield* blob.get(name)))
      }),
      AppendCompact: Effect.fnUntraced(function* ({ name, text: chunk }) {
        const blob = (yield* Drawer.Turn).blob(files)
        yield* blob.append(name, bytes(chunk))
        yield* blob.compact(name)

        return Option.getOrThrow(text(yield* blob.get(name)))
      }),
      WriteThenReject: Effect.fnUntraced(function* (name) {
        const turn = yield* Drawer.Turn
        const blob = turn.blob(files)
        yield* blob.set("kept", bytes("overwritten"))
        yield* blob.append("kept", bytes("-appended"))
        yield* blob.compact("kept")
        yield* blob.delete("kept")
        yield* blob.set(name, bytes(name))
        yield* blob.append(name, bytes(name))
        yield* turn.state.set({ notes: turn.state.notes + 1 })

        return yield* DrawerRejected.make({})
      }),
      WriteThenMisuse: Effect.fnUntraced(function* (kind) {
        const turn = yield* Drawer.Turn
        yield* turn.blob(files).set("before-misuse", bytes("before-misuse"))

        yield* misuse(turn.blob as (blob: AnyBlob) => BlobWrite, kind)
      }),
      Rewrite: Effect.fnUntraced(function* ({ name, text: last }) {
        const blob = (yield* Drawer.Turn).blob(files)
        yield* blob.set(name, bytes("first"))
        yield* blob.append(name, bytes("-appended"))
        yield* blob.set(name, bytes(last))

        return Option.getOrThrow(text(yield* blob.get(name)))
      }),
      WriteForked: Effect.fnUntraced(function* () {
        const blob = (yield* Drawer.Turn).blob(files)
        yield* blob.set("owned", bytes("owned"))
        yield* Effect.forkChild(blob.set("forked", bytes("forked"))).pipe(
          Effect.flatMap(Fiber.join),
        )
      }),
      WriteTimed: Effect.fnUntraced(function* () {
        yield* (yield* Drawer.Turn)
          .blob(files)
          .set("timed", bytes("timed"))
          .pipe(Effect.timeout("5 seconds"), Effect.orDie)
      }),
      WriteRaced: Effect.fnUntraced(function* () {
        const blob = (yield* Drawer.Turn).blob(files)
        yield* Effect.race(blob.set("raced", bytes("raced")), Effect.sleep("200 millis"))
      }),
      Grow: Effect.fnUntraced(function* (size) {
        yield* (yield* Drawer.Turn).blob(files).append("grow", new Uint8Array(size).fill(1))
      }),
      Large: Effect.fnUntraced(function* (size) {
        yield* (yield* Drawer.Turn).blob(files).set("large", new Uint8Array(size).fill(7))
      }),
      Capture: Effect.fnUntraced(function* () {
        const blob = (yield* Drawer.Turn).blob(files)
        fixture.escaped = blob.set("escaped", bytes("escaped"))
        yield* blob.set("captured", bytes("captured"))
      }),
      Replay: () => Effect.suspend(() => fixture.escaped).pipe(Effect.asVoid),
    }),
  )

const DrawerReads = (fixture: BlobsFixture) =>
  Drawer.toQueryLayer(
    Effect.succeed({
      Get: Effect.fnUntraced(function* (name) {
        return text(yield* (yield* Drawer.Read).blob(files).get(name))
      }),
      Size: Effect.fnUntraced(function* (name) {
        const found = yield* (yield* Drawer.Read).blob(files).get(name)

        return Option.match(found, { onNone: () => -1, onSome: (value) => value.byteLength })
      }),
      QueryWrite: Effect.fnUntraced(function* () {
        const blob = (yield* Drawer.Read).blob(files) as BlobWrite

        yield* blob.set("from-query", bytes("from-query"))
      }),
      CaptureRead: Effect.fnUntraced(function* () {
        fixture.escaped = (yield* Drawer.Read).blob(files).get("captured")
      }),
    }),
  )

const CabinetLive = Cabinet.toLayer(
  Effect.succeed({
    Put: Effect.fnUntraced(function* ({ name, text }) {
      yield* (yield* Cabinet.Turn).blob(files).set(name, bytes(text))
    }),
  }),
)

const CabinetReads = Cabinet.toQueryLayer(
  Effect.succeed({
    Peek: Effect.fnUntraced(function* (name) {
      return text(yield* (yield* Cabinet.Read).blob(files).get(name))
    }),
  }),
)

/** Handlers for the blob actors; `fixture` records handler runs so cases can tell a rerun from a replay. */
export const blobsLayer = (fixture: BlobsFixture) =>
  Layer.mergeAll(DrawerLive(fixture), DrawerReads(fixture), CabinetLive, CabinetReads)

const defect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"

const blobsOf = (count: number) => ({ blobs: { files: count } })

/** Actor blob cases: tenant and actor scoping, append/compact/set round trips, and rollback with a declared failure. */
export const blobsConformance: ReadonlyArray<ConformanceCase<BlobsFixture>> = [
  {
    name: "scopes blob entries by tenant, actor type, and actor for equal names",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const home = yield* Drawer.get("shared-id")
          const neighbor = yield* Drawer.get("neighbor")
          const abroad = yield* Drawer.get("shared-id").pipe(Actor.tenant(`${test.tenant}-b`))
          const cabinet = yield* Cabinet.get("shared-id")
          const drawers = [home, neighbor, abroad]

          for (const [index, drawer] of drawers.entries())
            yield* drawer.Store({ name: "a", text: `a${index}` })
          yield* cabinet.Put({ name: "a", text: "cabinet" })

          for (const [index, drawer] of drawers.entries())
            expect(yield* drawer.Append({ name: "a", text: `+${index}` })).toBe(
              `a${index}+${index}`,
            )
          yield* neighbor.Store({ name: "b", text: "b" })

          expect(yield* home.Get("a")).toEqual(Option.some("a0+0"))
          expect(yield* neighbor.Get("a")).toEqual(Option.some("a1+1"))
          expect(yield* abroad.Get("a")).toEqual(Option.some("a2+2"))
          expect(yield* cabinet.Peek("a")).toEqual(Option.some("cabinet"))
          expect(yield* home.Get("b")).toEqual(Option.none())
          expect(yield* test.inspect(home.ref)).toMatchObject(blobsOf(1))
          expect(yield* test.inspect(neighbor.ref)).toMatchObject(blobsOf(2))
          expect(yield* test.inspect(abroad.ref)).toMatchObject(blobsOf(1))
          expect(yield* test.inspect(cabinet.ref)).toMatchObject(blobsOf(1))
        }),
      ),
  },
  {
    name: "round-trips appended chunks through compact and replaces them with set",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const drawer = yield* Drawer.get("chunks")

          for (const chunk of ["one", "-two", "-three"])
            yield* drawer.Append({ name: "log", text: chunk })
          expect(yield* drawer.Get("log")).toEqual(Option.some("one-two-three"))
          expect(yield* drawer.AppendCompact({ name: "log", text: "-four" })).toBe(
            "one-two-three-four",
          )
          expect(yield* drawer.Get("log")).toEqual(Option.some("one-two-three-four"))
          expect(yield* drawer.Append({ name: "log", text: "-five" })).toBe(
            "one-two-three-four-five",
          )
          yield* drawer.Store({ name: "log", text: "reset" })
          expect(yield* drawer.Get("log")).toEqual(Option.some("reset"))
          expect(yield* drawer.Append({ name: "log", text: "!" })).toBe("reset!")
          yield* drawer.Store({ name: "empty", text: "" })
          expect(yield* drawer.Get("empty")).toEqual(Option.some(""))
          expect(yield* drawer.Rewrite({ name: "twice", text: "second" })).toBe("second")
          expect(yield* drawer.Get("twice")).toEqual(Option.some("second"))
          expect(yield* test.inspect(drawer.ref)).toMatchObject({ ...blobsOf(3), receipts: 9 })
        }),
      ),
  },
  {
    name: "rolls back every blob write with a declared failure and keeps its receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const drawer = yield* Drawer.get("rejected")
          yield* drawer.Store({ name: "kept", text: "kept" })
          const rejected = drawer.WriteThenReject("dropped")
          expect(yield* rejected.pipe(Effect.flip)).toEqual(DrawerRejected.make({}))
          expect(yield* rejected.pipe(Effect.flip)).toEqual(DrawerRejected.make({}))
          expect(yield* drawer.Get("kept")).toEqual(Option.some("kept"))
          expect(yield* drawer.Get("dropped")).toEqual(Option.none())
          expect(yield* test.inspect(drawer.ref)).toMatchObject({
            ...blobsOf(1),
            state: {},
            receipts: 2,
          })
        }),
      ),
  },
  {
    name: "discards blob writes of a declared failure across a crash before and after its commit",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest

          for (const point of ["beforeCommit", "afterCommit"] as const) {
            const drawer = yield* Drawer.get(`rejected-${point}`)
            yield* drawer.Store({ name: "kept", text: "kept" })
            yield* test.crashNext(point)
            const rejected = drawer.WriteThenReject("dropped")
            expect(yield* rejected.pipe(Effect.flip)).toEqual(DrawerRejected.make({}))
            expect(yield* rejected.pipe(Effect.flip)).toEqual(DrawerRejected.make({}))
            expect(yield* drawer.Get("kept")).toEqual(Option.some("kept"))
            expect(yield* drawer.Get("dropped")).toEqual(Option.none())
            expect(yield* test.inspect(drawer.ref)).toMatchObject({
              ...blobsOf(1),
              state: {},
              receipts: 2,
            })
          }
        }),
      ),
  },
  {
    name: "retries a blob append that crashes before commit to exactly one chunk",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const drawer = yield* Drawer.get("crash-before")
          yield* drawer.Store({ name: "log", text: "head" })
          yield* test.crashNext("beforeCommit")
          expect(yield* drawer.Append({ name: "log", text: "+once" })).toBe("head+once")
          expect(yield* drawer.Get("log")).toEqual(Option.some("head+once"))
          expect(yield* test.inspect(drawer.ref)).toMatchObject({ ...blobsOf(1), receipts: 2 })
        }),
      ),
  },
  {
    name: "replays a blob append committed before a crash without appending again",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const drawer = yield* Drawer.get("crash-after")
          yield* drawer.Store({ name: "log", text: "head" })
          yield* test.crashNext("afterCommit")
          expect(yield* drawer.Append({ name: "log", text: "+once" })).toBe("head+once")
          expect(yield* drawer.Get("log")).toEqual(Option.some("head+once"))
          expect(yield* test.inspect(drawer.ref)).toMatchObject({ ...blobsOf(1), receipts: 2 })
        }),
      ),
  },
  {
    name: "exempts blob bytes from maxStateBytes",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const drawer = yield* Drawer.get("large")
          yield* drawer.Large(256 * 1_024)
          expect(yield* drawer.Size("large")).toBe(256 * 1_024)
          expect(yield* test.inspect(drawer.ref)).toMatchObject({ ...blobsOf(1), receipts: 1 })
        }),
      ),
  },
  {
    name: "caps an entry at MAX_ENTRY_BYTES across appends as a defect without a receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const drawer = yield* Drawer.get("capped")
          const half = MAX_ENTRY_BYTES / 2
          yield* drawer.Grow(half)
          yield* drawer.Grow(half)
          expect(defect(yield* drawer.Grow(1).pipe(Effect.exit))).toContain(
            `A blob entry holds at most ${MAX_ENTRY_BYTES} bytes`,
          )
          expect(yield* drawer.Size("grow")).toBe(MAX_ENTRY_BYTES)
          expect(yield* test.inspect(drawer.ref)).toMatchObject({ ...blobsOf(1), receipts: 2 })
        }),
      ),
  },
  {
    name: "rejects undeclared blobs and malformed entries as defects without a receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const drawer = yield* Drawer.get("misuse")

          for (const [kind, message] of [
            ["undeclared", "undeclared is not a declared blob of Drawer"],
            ["emptyName", "Blob entry names"],
            ["loneSurrogate", "Blob entry names"],
            ["nul", "Blob entry names"],
            ["longName", "Blob entry names"],
            ["oversized", `A blob entry holds at most ${MAX_ENTRY_BYTES} bytes`],
            ["notBytes", "Blob bytes are a Uint8Array"],
          ] as const)
            expect(defect(yield* drawer.WriteThenMisuse(kind).pipe(Effect.exit))).toContain(message)

          expect(yield* test.inspect(drawer.ref)).toMatchObject({ ...blobsOf(0), receipts: 0 })
        }),
      ),
  },
  {
    name: "gives queries read-only blobs and rejects escaped blob capabilities",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const drawer = yield* Drawer.get("escape")
          expect(defect(yield* drawer.QueryWrite().pipe(Effect.exit))).toContain("set")
          yield* drawer.Capture()
          expect(defect(yield* fixture.escaped.pipe(Effect.exit))).toContain(
            "Blob capability escaped its turn",
          )
          expect(defect(yield* drawer.Replay().pipe(Effect.exit))).toContain(
            "Blob capability escaped its turn",
          )
          expect(yield* drawer.Get("captured")).toEqual(Option.some("captured"))
          expect(yield* drawer.Get("escaped")).toEqual(Option.none())
          expect(yield* drawer.Get("from-query")).toEqual(Option.none())
          yield* drawer.CaptureRead()
          expect(defect(yield* fixture.escaped.pipe(Effect.exit))).toContain(
            "Blob capability escaped its query",
          )

          for (const forked of [drawer.WriteForked(), drawer.WriteTimed(), drawer.WriteRaced()])
            expect(defect(yield* forked.pipe(Effect.exit))).toContain(
              "Blob capability used from a fiber other than its turn's",
            )
          expect(yield* drawer.Get("owned")).toEqual(Option.none())
          expect(yield* drawer.Get("forked")).toEqual(Option.none())
          expect(yield* drawer.Get("timed")).toEqual(Option.none())
          expect(yield* drawer.Get("raced")).toEqual(Option.none())
          expect(yield* test.inspect(drawer.ref)).toMatchObject({ ...blobsOf(1), receipts: 1 })
        }),
      ),
  },
  {
    name: "keeps uncommitted blob writes invisible to a query",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const drawer = yield* Drawer.get("invisible")
          yield* drawer.Store({ name: "log", text: "head" })
          const pause = yield* test.pauseNext("beforeCommit")
          const writer = yield* drawer.Append({ name: "log", text: "+tail" }).pipe(Effect.forkChild)
          yield* pause.reached
          expect(yield* drawer.Get("log")).toEqual(Option.some("head"))
          yield* pause.release
          expect(yield* Fiber.join(writer)).toBe("head+tail")
          expect(yield* drawer.Get("log")).toEqual(Option.some("head+tail"))
        }),
      ),
  },
]

/** The actor blob actors. */
export const blobsSuite: ConformanceSuite<BlobsFixture> = {
  fixture: blobsFixture,
  layer: blobsLayer,
}
