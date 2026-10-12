import { BunCrypto } from "@effect/platform-bun"
import { Config, Effect, Layer, ManagedRuntime, Option, Redacted, Schema, Stream } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { Actor, Caller, CurrentCaller, Tenant, User } from "../index.ts"
import { ActorTest } from "../testing/actor-test.ts"

const Open = Actor.command("Open")
const IdentityResult = Schema.Struct({
  caller: Caller,
  tenant: Schema.String,
  readCaller: Caller,
  readTenant: Schema.String,
})
const Identity = Actor.query("Identity", { success: IdentityResult })
const Watching = Actor.query("Watching", { success: IdentityResult, watch: true })
const Streaming = Actor.stream("Streaming", { success: IdentityResult })
const Reader = Actor.make("QueryIdentityReader", {
  key: Schema.String,
  api: { Open, Identity, Watching, Streaming },
  access: Actor.access.public,
})
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    Reader.toLayer({
      Open: () => Effect.void,
      Streaming: () =>
        Stream.fromEffect(
          Effect.gen(function* () {
            const read = yield* Reader.Read
            return {
              caller: yield* CurrentCaller,
              tenant: yield* Tenant,
              readCaller: read.caller,
              readTenant: read.ref.tenant,
            }
          }),
        ),
    }),
    Reader.toQueryLayer({
      Identity: Effect.fn(function* () {
        const read = yield* Reader.Read
        return {
          caller: yield* CurrentCaller,
          tenant: yield* Tenant,
          readCaller: read.caller,
          readTenant: read.ref.tenant,
        }
      }),
      Watching: Effect.fn(function* () {
        const read = yield* Reader.Read
        return {
          caller: yield* CurrentCaller,
          tenant: yield* Tenant,
          readCaller: read.caller,
          readTenant: read.ref.tenant,
        }
      }),
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const database = yield* Config.String("QUERY_CONTEXT_TEST_DATABASE_URL").pipe(
            Config.option,
          )
          return ActorTest.layer({
            as: User.make({ subject: "layer-builder" }),
            database: Option.getOrUndefined(Option.map(database, Redacted.make)),
          })
        }),
      ),
    ),
    Layer.provide(BunCrypto.layer),
  ),
)

afterAll(() => runtime.dispose())

describe("read request identity", () => {
  it("ordinary queries bind ambient caller and tenant to the handle rather than layer construction", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        for (const [tenant, subject] of [
          ["tenant-a", "alice"],
          ["tenant-b", "bob"],
        ] as const) {
          const caller = User.make({ subject })
          const handle = yield* Reader.get("shared-id").pipe(Actor.tenant(tenant), Actor.as(caller))
          expect(yield* handle.Identity()).toEqual({
            caller,
            tenant,
            readCaller: caller,
            readTenant: tenant,
          })
        }
      }),
    ))

  it("watch reruns retain the same request identity without restoring unrelated layer services", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const caller = User.make({ subject: "watcher" })
        const handle = yield* Reader.get("watched-id").pipe(
          Actor.tenant("tenant-watch"),
          Actor.as(caller),
        )
        yield* handle.Open()
        const result = yield* handle.Watching.watch().pipe(Stream.runHead)
        expect(Option.getOrThrow(result)).toEqual({
          caller,
          tenant: "tenant-watch",
          readCaller: caller,
          readTenant: "tenant-watch",
        })
      }),
    ))

  it("streams override identities captured by their handler layer with the subscriber's identity", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const caller = User.make({ subject: "subscriber" })
        const handle = yield* Reader.get("streamed-id").pipe(
          Actor.tenant("tenant-stream"),
          Actor.as(caller),
        )
        yield* handle.Open()
        const result = yield* handle.Streaming().pipe(Stream.runHead)
        expect(Option.getOrThrow(result)).toEqual({
          caller,
          tenant: "tenant-stream",
          readCaller: caller,
          readTenant: "tenant-stream",
        })
      }),
    ))
})
