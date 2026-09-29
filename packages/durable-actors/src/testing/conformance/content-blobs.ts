import {
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Content, ContentRef, InvalidContentRef, Tenant, Unauthorized } from "../../index.ts"
import { InternalActors } from "../../handles/actors.ts"
import { CHUNK_BYTES, MAX_CONTENT_BYTES } from "../../runtime/content/store.ts"
import type { ContentPoint } from "../../runtime/turn/hooks.ts"
import { ActorTest, TEST_CONTENT_KEY } from "../actor-test.ts"
import type {
  ConformanceCase,
  ConformanceEnvironment,
  ConformanceServices,
} from "../conformance.ts"
import { serveHttp } from "./http.ts"

const Attachments = Actor.content("attachments")

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Attaching = Schema.Struct({ name: Schema.String, ref: ContentRef })

const Attach = Actor.command("Attach", { input: Attaching, errors: [InvalidContentRef] })

const AttachThenRefuse = Actor.command("AttachThenRefuse", { input: Attaching, errors: [Refused] })

const AttachThenDie = Actor.command("AttachThenDie", { input: Attaching })

/** Attaches, then waits for the fixture's gate before the turn commits. */
const AttachHeld = Actor.command("AttachHeld", { input: Attaching, errors: [InvalidContentRef] })

const Detach = Actor.command("Detach", { input: Schema.String })

const DetachThenRefuse = Actor.command("DetachThenRefuse", {
  input: Schema.String,
  errors: [Refused],
})

const Entry = Schema.Struct({ name: Schema.String, hash: Schema.String, size: Schema.Int })

const Listed = Actor.query("Listed", { output: Schema.Array(Entry) })

const Text = Actor.query("Text", { input: Schema.String, output: Schema.Option(Schema.String) })

const Streamed = Actor.query("Streamed", {
  input: Schema.String,
  output: Schema.Option(Schema.String),
})

const Digest = Actor.query("Digest", {
  input: Schema.String,
  output: Schema.Option(Schema.Struct({ size: Schema.Int, sha: Schema.String })),
})

const Document = Actor.make("Document", {
  key: Schema.String,
  blobs: [Attachments],
  api: {
    Attach,
    AttachThenRefuse,
    AttachThenDie,
    AttachHeld,
    Detach,
    DetachThenRefuse,
    Listed,
    Text,
    Streamed,
    Digest,
  },
})

export interface ContentFixture {
  /** Called at every content hook point; cases replace it to pause one operation. */
  hook: (point: ContentPoint) => Effect.Effect<void>
  /** `AttachHeld` waits on this after attaching. */
  held: Effect.Effect<void>
}

export const contentFixture = (): ContentFixture => ({
  hook: () => Effect.void,
  held: Effect.void,
})

const decoder = new TextDecoder()

const encoder = new TextEncoder()

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0

  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }

  return bytes
}

const handlers = (fixture: ContentFixture) =>
  Effect.succeed({
    Attach: Effect.fnUntraced(function* ({ name, ref }: typeof Attaching.Type) {
      yield* (yield* Document.Turn).blob(Attachments).attach(name, ref)
    }),
    AttachThenRefuse: Effect.fnUntraced(function* ({ name, ref }: typeof Attaching.Type) {
      yield* (yield* Document.Turn).blob(Attachments).attach(name, ref).pipe(Effect.orDie)

      return yield* Refused.make({})
    }),
    AttachThenDie: Effect.fnUntraced(function* ({ name, ref }: typeof Attaching.Type) {
      yield* (yield* Document.Turn).blob(Attachments).attach(name, ref).pipe(Effect.orDie)

      return yield* Effect.die(new Error("after attach"))
    }),
    AttachHeld: Effect.fnUntraced(function* ({ name, ref }: typeof Attaching.Type) {
      yield* (yield* Document.Turn).blob(Attachments).attach(name, ref)
      yield* Effect.suspend(() => fixture.held)
    }),
    Detach: Effect.fnUntraced(function* (name: string) {
      yield* (yield* Document.Turn).blob(Attachments).detach(name)
    }),
    DetachThenRefuse: Effect.fnUntraced(function* (name: string) {
      yield* (yield* Document.Turn).blob(Attachments).detach(name)

      return yield* Refused.make({})
    }),
  })

const reads = Effect.succeed({
  Listed: Effect.fnUntraced(function* () {
    return yield* (yield* Document.Read).blob(Attachments).list
  }),
  Text: Effect.fnUntraced(function* (name: string) {
    const found = yield* (yield* Document.Read).blob(Attachments).get(name)

    return Option.map(found, (bytes) => decoder.decode(bytes))
  }),
  Streamed: Effect.fnUntraced(function* (name: string) {
    return yield* (yield* Document.Read)
      .blob(Attachments)
      .stream(name)
      .pipe(
        Stream.runCollect,
        Effect.map((parts) => Option.some(decoder.decode(concat(parts)))),
        Effect.catchTag("NoSuchElementError", () => Effect.succeed(Option.none<string>())),
      )
  }),
  Digest: Effect.fnUntraced(function* (name: string) {
    const found = yield* (yield* Document.Read).blob(Attachments).get(name)

    return Option.map(found, (bytes) => ({
      size: bytes.byteLength,
      sha: hex(new Bun.CryptoHasher("sha256").update(bytes).digest()),
    }))
  }),
})

export const contentLayer = (fixture: ContentFixture) =>
  Layer.mergeAll(Document.toLayer(handlers(fixture)), Document.toQueryLayer(reads))

const unique = Effect.gen(function* () {
  return yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
})

/** Distinct bytes per case, so cases sharing a database never share content. */
const fresh = (label: string) => Effect.map(unique, (uuid) => encoder.encode(`${label}:${uuid}`))

const upload = (bytes: Uint8Array) => Content.upload(bytes).pipe(Effect.orDie)

const stored = Effect.fnUntraced(function* (hash: string) {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{ contents: number; chunks: number }>`
    SELECT (SELECT count(*)::int FROM tenant_contents WHERE hash = ${hash}) AS contents,
      (SELECT count(*)::int FROM tenant_content_chunks WHERE hash = ${hash}) AS chunks`

  return row!
}, Effect.orDie)

/** The grace, the default 30-second turn, and the skew margin past a grant's expiry. */
const COLLECTED_AFTER = "26 hours"

/**
 * Pauses the next `point` until the returned `release`; `reached` completes
 * when the operation arrives there.
 */
const pauseAt = Effect.fnUntraced(function* (fixture: ContentFixture, point: ContentPoint) {
  const reached = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let armed = true

  fixture.hook = (at) =>
    at === point && armed
      ? Effect.suspend(() => {
          armed = false

          return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
        })
      : Effect.void

  return {
    reached: Deferred.await(reached),
    release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
  }
})

const reset = (fixture: ContentFixture) =>
  Effect.sync(() => {
    fixture.hook = () => Effect.void
    fixture.held = Effect.void
  })

/** Runs `effect` on a runtime of its own over `database`, disposed after. */
const onRuntime = <A, E>(
  environment: ConformanceEnvironment,
  options: Parameters<ConformanceEnvironment["build"]>[0],
  effect: Effect.Effect<A, E, ConformanceServices | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => environment.build(options)),
      (built) => Effect.promise(() => built.dispose()),
    )

    return yield* Effect.promise(() => runtime.runPromise(Effect.scoped(effect)))
  }).pipe(Effect.scoped)

const SECOND_KEY = {
  id: "second",
  secret: Redacted.make("a second durable-actors content grant key for rotation"),
}

export const contentConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "refuses to attach by bare hash, by another tenant's grant, or by an expired grant, and reads nothing without a reference",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const doc = yield* Document.get("denied")
          const bytes = yield* fresh("denied")
          const ref = yield* upload(bytes)

          const refusal = (name: string, attached: ContentRef) =>
            doc.Attach({ name, ref: attached }).pipe(
              Effect.flip,
              Effect.map((error) =>
                Predicate.isTagged(error, "InvalidContentRef") ? error.reason : error._tag,
              ),
            )

          expect(yield* refusal("bare", { hash: ref.hash, size: ref.size, grant: "" })).toBe(
            "malformed",
          )
          expect(yield* refusal("forged", { ...ref, grant: `${ref.grant.slice(0, -2)}AA` })).toBe(
            "invalid",
          )
          expect(yield* refusal("resized", { ...ref, size: ref.size + 1 })).toBe("invalid")

          const foreign = yield* upload(bytes).pipe(
            Effect.provideService(Tenant, `other-${yield* unique}`),
          )

          expect(foreign.hash).toBe(ref.hash)
          expect(yield* refusal("foreign", foreign)).toBe("invalid")

          yield* test.advance("1 hour")
          expect(yield* refusal("expired", ref)).toBe("expired")
          expect(yield* doc.Listed()).toEqual([])
          expect(yield* doc.Text("bare")).toEqual(Option.none())

          const other = yield* Document.get("denied-reader")
          expect(yield* other.Text(ref.hash)).toEqual(Option.none())
        }),
      ),
  },
  {
    name: "stores identical uploads once per tenant and twice across tenants",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const bytes = yield* fresh("dedup")
          const first = yield* upload(bytes)
          const second = yield* upload(bytes)
          expect(second.hash).toBe(first.hash)
          expect(second.size).toBe(bytes.byteLength)
          expect(yield* stored(first.hash)).toEqual({ contents: 1, chunks: 1 })

          yield* upload(bytes).pipe(Effect.provideService(Tenant, `other-${yield* unique}`))
          expect(yield* stored(first.hash)).toEqual({ contents: 2, chunks: 2 })

          const a = yield* Document.get("dedup-a")
          const b = yield* Document.get("dedup-b")
          yield* a.Attach({ name: "logo", ref: first })
          yield* b.Attach({ name: "logo", ref: second })
          expect(yield* a.Text("logo")).toEqual(Option.some(decoder.decode(bytes)))
          expect(yield* b.Text("logo")).toEqual(Option.some(decoder.decode(bytes)))
        }),
      ),
  },
  {
    name: "stores content across chunks up to 64 MiB, reads it whole by get and stream, and refuses one byte more",
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const doc = yield* Document.get("chunked")
          const bytes = new Uint8Array(CHUNK_BYTES * 2 + 12_345)
          const seed = yield* fresh("chunked")

          for (let index = 0; index < bytes.byteLength; index += 1)
            bytes[index] = seed[index % seed.byteLength]! ^ (index & 0xff)

          const ref = yield* upload(bytes)
          expect(yield* stored(ref.hash)).toEqual({ contents: 1, chunks: 3 })
          yield* doc.Attach({ name: "big", ref })

          expect(yield* doc.Digest("big")).toEqual(
            Option.some({
              size: bytes.byteLength,
              sha: hex(new Bun.CryptoHasher("sha256").update(bytes).digest()),
            }),
          )

          const empty = yield* upload(new Uint8Array())
          yield* doc.Attach({ name: "empty", ref: empty })
          expect(yield* doc.Text("empty")).toEqual(Option.some(""))
          expect(yield* doc.Streamed("empty")).toEqual(Option.some(""))

          const largest = yield* upload(new Uint8Array(MAX_CONTENT_BYTES).fill(7))
          expect(largest.size).toBe(MAX_CONTENT_BYTES)

          const refused = yield* Content.upload(new Uint8Array(MAX_CONTENT_BYTES + 1)).pipe(
            Effect.flip,
          )

          expect(refused._tag).toBe("ContentTooLarge")
        }),
      ),
  },
  {
    name: "accepts a served upload above limits.requestBytes up to limits.contentBytes, and answers 413 too_large past it without writing any content",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient

          const server = yield* serveHttp({
            actors: [Document],
            limits: { requestBytes: 1024, contentBytes: 4096 },
            openapi: { path: "/openapi.json" },
          })

          const token = `${test.tenant}:alice`
          const label = yield* unique
          const body = encoder.encode(`{"label":"${label}","pad":"${"x".repeat(3000)}"}`)

          const accepted = yield* server.send("/content", { token, bytes: body })
          expect(accepted.status).toBe(200)

          const ref = yield* Schema.decodeUnknownEffect(ContentRef)(accepted.body).pipe(
            Effect.orDie,
          )

          expect(ref.size).toBe(body.byteLength)

          const count = Effect.map(
            sql<{ contents: number }>`SELECT count(*)::int AS contents FROM tenant_contents
              WHERE tenant_id = ${test.tenant}`,
            ([row]) => row!.contents,
          ).pipe(Effect.orDie)

          const before = yield* count

          const refused = yield* server.send("/content", {
            token,
            bytes: encoder.encode(`{"label":"${label}","pad":"${"y".repeat(5000)}"}`),
          })

          expect(refused.status).toBe(413)
          expect(refused.text.includes('"code":"too_large"')).toBe(true)
          expect(yield* count).toBe(before)

          const doc = yield* Document.get("served")
          yield* doc.Attach({ name: "notes", ref })

          const downloaded = yield* server.send(
            "/actors/Document/served/content/attachments/notes",
            {
              method: "GET",
              token,
            },
          )

          expect(downloaded.status).toBe(200)
          expect(downloaded.text).toBe(decoder.decode(body))

          const granted = yield* server.send(
            "/actors/Document/served/content/attachments/notes/grant",
            { token },
          )

          expect(granted.status).toBe(200)
          expect(granted.body).toMatchObject({ hash: ref.hash, size: ref.size })

          const missing = yield* server.send("/actors/Document/served/content/attachments/none", {
            method: "GET",
            token,
          })

          expect(missing.status).toBe(404)

          const spec = yield* server.send("/openapi.json", { method: "GET" })

          expect(
            [
              "/content",
              "/actors/Document/{id}/content/{blob}/{name}",
              "/actors/Document/{id}/content/{blob}/{name}/grant",
            ].map((path) => spec.text.includes(`"${path}"`)),
          ).toEqual([true, true, true])
        }),
      ),
  },
  {
    name: "rolls back an attach and a detach with a declared failure or defect",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const doc = yield* Document.get("rollback")
          const ref = yield* upload(yield* fresh("rollback"))

          expect(
            (yield* doc.AttachThenRefuse({ name: "refused", ref }).pipe(Effect.flip))._tag,
          ).toBe("Refused")
          expect(
            Exit.isFailure(yield* doc.AttachThenDie({ name: "died", ref }).pipe(Effect.exit)),
          ).toBe(true)
          expect(yield* doc.Listed()).toEqual([])

          yield* doc.Attach({ name: "kept", ref })
          expect((yield* doc.DetachThenRefuse("kept").pipe(Effect.flip))._tag).toBe("Refused")
          expect((yield* doc.Listed()).map((entry) => entry.name)).toEqual(["kept"])
          yield* doc.Detach("kept")
          expect(yield* doc.Listed()).toEqual([])
        }),
      ),
  },
  {
    name: "keeps content referenced by one actor after another detaches it",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const internal = yield* InternalActors
          const bytes = yield* fresh("shared")
          const ref = yield* upload(bytes)
          const a = yield* Document.get("shared-a")
          const b = yield* Document.get("shared-b")
          yield* a.Attach({ name: "file", ref })
          yield* b.Attach({ name: "file", ref })
          yield* a.Detach("file")

          yield* test.advance(COLLECTED_AFTER)
          yield* internal.sweepContent
          expect(yield* stored(ref.hash)).toEqual({ contents: 1, chunks: 1 })
          expect(yield* b.Text("file")).toEqual(Option.some(decoder.decode(bytes)))

          yield* b.Detach("file")
          yield* internal.sweepContent
          expect(yield* stored(ref.hash)).toEqual({ contents: 0, chunks: 0 })
        }),
      ),
  },
  {
    name: "collects unattached uploads after grant plus grace and never before",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const internal = yield* InternalActors
          const ref = yield* upload(yield* fresh("orphan"))

          yield* test.advance("1 hour")
          yield* test.advance("24 hours")
          yield* test.advance("88 seconds")
          yield* internal.sweepContent
          expect(yield* stored(ref.hash)).toEqual({ contents: 1, chunks: 1 })

          yield* test.advance("4 seconds")
          expect((yield* internal.sweepContent) >= 1).toBe(true)
          expect(yield* stored(ref.hash)).toEqual({ contents: 0, chunks: 0 })

          const again = yield* upload(yield* fresh("orphan-again"))
          yield* test.advance(COLLECTED_AFTER)
          expect((yield* test.cleanup).contents >= 1).toBe(true)
          expect(yield* stored(again.hash)).toEqual({ contents: 0, chunks: 0 })
        }),
      ),
  },
  {
    name: "never deletes content attached concurrently with a sweep",
    requiresIndependentConnections: true,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const internal = yield* InternalActors
          const bytes = yield* fresh("race-attach")
          const ref = yield* upload(bytes)
          yield* test.advance(COLLECTED_AFTER)

          const paused = yield* pauseAt(fixture.content, "afterReferenceScan")
          const sweep = yield* internal.sweepContent.pipe(Effect.forkScoped)
          yield* paused.reached

          const regranted = yield* upload(bytes)
          const doc = yield* Document.get("race-attach")
          yield* doc.Attach({ name: "file", ref: regranted })
          yield* paused.release
          yield* Fiber.join(sweep)
          yield* reset(fixture.content)

          expect(regranted.hash).toBe(ref.hash)
          expect(yield* stored(ref.hash)).toEqual({ contents: 1, chunks: 1 })
          expect(yield* doc.Text("file")).toEqual(Option.some(decoder.decode(bytes)))
        }).pipe(Effect.ensuring(reset(fixture.content))),
      ),
  },
  {
    name: "refuses an attach whose grant has less than the skew margin S left",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const doc = yield* Document.get("skew")
          const early = yield* upload(yield* fresh("skew-early"))
          const late = yield* upload(yield* fresh("skew-late"))

          yield* test.advance("58 minutes")
          yield* test.advance("55 seconds")
          yield* doc.Attach({ name: "early", ref: early })

          yield* test.advance("10 seconds")
          const refused = yield* doc.Attach({ name: "late", ref: late }).pipe(Effect.flip)
          expect(refused).toEqual(InvalidContentRef.make({ reason: "expired" }))
          expect((yield* doc.Listed()).map((entry) => entry.name)).toEqual(["early"])
        }),
      ),
  },
  {
    name: "never deletes content whose attach checked its grant just before expiry and commits up to commandTimeout later",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const gate = yield* Deferred.make<void>()

          yield* onRuntime(
            environment,
            { database, content: { keys: [TEST_CONTENT_KEY], grace: 0, skew: 0 } },
            Effect.gen(function* () {
              const test = yield* ActorTest
              const internal = yield* InternalActors
              const bytes = yield* fresh("held")
              const ref = yield* upload(bytes)
              const doc = yield* Document.get("held")

              yield* test.advance("59 minutes")
              yield* test.advance("59500 millis")
              fixture.content.held = Deferred.await(gate)
              const attach = yield* doc.AttachHeld({ name: "file", ref }).pipe(Effect.forkScoped)
              yield* Effect.sleep("300 millis")

              yield* test.advance("5 seconds")
              expect(yield* internal.sweepContent).toBe(0)
              yield* Deferred.succeed(gate, undefined)
              yield* Fiber.join(attach)

              yield* test.advance(COLLECTED_AFTER)
              expect(yield* internal.sweepContent).toBe(0)
              expect(yield* doc.Text("file")).toEqual(Option.some(decoder.decode(bytes)))
            }).pipe(Effect.orDie),
          )
        }).pipe(Effect.ensuring(reset(fixture.content))),
      ),
  },
  {
    name: "hands a fresh grant from one actor's reference to another actor's attach through Content.grant, and refuses a caller whose authorize denies <blob>.grant",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const bytes = yield* fresh("handoff")
          const source = yield* Document.get("handoff-source")
          const target = yield* Document.get("handoff-target")
          yield* source.Attach({ name: "file", ref: yield* upload(bytes) })

          yield* test.advance("2 hours")
          const granted = yield* Content.grant(Document, "handoff-source", Attachments, "file")
          expect(Option.isSome(granted)).toBe(true)
          yield* target.Attach({ name: "copy", ref: Option.getOrThrow(granted) })
          expect(yield* target.Text("copy")).toEqual(Option.some(decoder.decode(bytes)))

          expect(yield* Content.grant(Document, "handoff-source", Attachments, "none")).toEqual(
            Option.none(),
          )

          fixture.denied.add("attachments.grant")

          const denied = yield* Content.grant(Document, "handoff-source", Attachments, "file").pipe(
            Effect.flip,
            Effect.ensuring(Effect.sync(() => fixture.denied.delete("attachments.grant"))),
          )

          expect(denied.reason).toEqual(Unauthorized.make({ code: "access_denied" }))
        }),
      ),
  },
  {
    name: "fails a read as a missing name, never with partial bytes, when a detach and a sweep run between resolving the reference and reading the chunks",
    requiresIndependentConnections: true,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const internal = yield* InternalActors

          for (const read of ["Text", "Streamed"] as const) {
            const doc = yield* Document.get(`race-read-${read}`)
            const ref = yield* upload(yield* fresh(`race-read-${read}`))
            yield* doc.Attach({ name: "file", ref })
            yield* test.advance(COLLECTED_AFTER)

            const paused = yield* pauseAt(fixture.content, "afterResolve")
            const reading = yield* doc[read]("file").pipe(Effect.forkScoped)
            yield* paused.reached
            yield* doc.Detach("file")
            expect((yield* internal.sweepContent) >= 1).toBe(true)
            expect(yield* stored(ref.hash)).toEqual({ contents: 0, chunks: 0 })
            yield* paused.release

            expect(yield* Fiber.join(reading)).toEqual(Option.none())
          }
        }).pipe(Effect.ensuring(reset(fixture.content))),
      ),
  },
  {
    name: "never returns a grant for content a concurrent detach and sweep deleted",
    requiresIndependentConnections: true,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const internal = yield* InternalActors
          const doc = yield* Document.get("race-grant")
          const ref = yield* upload(yield* fresh("race-grant"))
          yield* doc.Attach({ name: "file", ref })
          yield* test.advance(COLLECTED_AFTER)

          const paused = yield* pauseAt(fixture.content, "beforeRaise")

          const granting = yield* Content.grant(Document, "race-grant", Attachments, "file").pipe(
            Effect.forkScoped,
          )

          yield* paused.reached
          yield* doc.Detach("file")
          expect((yield* internal.sweepContent) >= 1).toBe(true)
          yield* paused.release

          expect(yield* Fiber.join(granting)).toEqual(Option.none())
        }).pipe(Effect.ensuring(reset(fixture.content))),
      ),
  },
  {
    name: "verifies grants under the previous key for one grant lifetime after rotation",
    run: ({ expect, environment }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* environment.stop

          const signed = yield* onRuntime(
            environment,
            { content: { keys: [TEST_CONTENT_KEY] } },
            Effect.gen(function* () {
              return { ref: yield* upload(yield* fresh("rotation")), tenant: yield* Tenant }
            }),
          )

          const attachAs = (keys: ReadonlyArray<typeof TEST_CONTENT_KEY>, name: string) =>
            onRuntime(
              environment,
              { content: { keys } },
              Effect.gen(function* () {
                const doc = yield* Document.get("rotation")

                return yield* doc.Attach({ name, ref: signed.ref }).pipe(
                  Effect.as("attached"),
                  Effect.catchTag("InvalidContentRef", (error) => Effect.succeed(error.reason)),
                  Effect.orDie,
                )
              }).pipe(Effect.provideService(Tenant, signed.tenant)),
            )

          expect(yield* attachAs([SECOND_KEY, TEST_CONTENT_KEY], "rotated")).toBe("attached")
          expect(yield* attachAs([SECOND_KEY], "retired")).toBe("invalid")
        }).pipe(Effect.ensuring(environment.restart)),
      ),
  },
]
