import { Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import {
  ActorError,
  ActorUnavailable,
  MailboxFull,
  NotCreated,
  RunnerAtCapacity,
  Timeout,
} from "../errors/actor.ts"
import { checkDeclaredErrors } from "../actor/served.ts"
import { actorErrorBody, statusOf } from "../protocol/wire.ts"
import { actorErrorResponse } from "./wire.ts"

const RetryBody = Schema.Struct({ retryAfter: Schema.Finite })

const respond = Effect.fnUntraced(function* (error: ActorError) {
  const web = HttpServerResponse.toWeb(yield* actorErrorResponse(error))

  return {
    status: web.status,
    headers: web.headers,
    body: yield* Effect.promise(() => web.json()),
  }
})

describe("served error envelopes", () => {
  it("maps back-pressure and delivery reasons to their statuses with the in-process retryAfter", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const [reason, status, low, high] of [
          [MailboxFull.make({}), 429, 50, 150],
          [RunnerAtCapacity.make({}), 503, 500, 1500],
          [ActorUnavailable.make({ cause: new Error("internal") }), 503, 125, 375],
        ] as const) {
          const error = ActorError.make({ reason })
          const reply = yield* respond(error)

          const { retryAfter } = yield* Schema.decodeUnknownEffect(RetryBody)(reply.body).pipe(
            Effect.orDie,
          )

          expect(reply.status).toBe(status)
          expect(retryAfter).toBe(Option.getOrElse(error.retryAfter, () => -1))
          expect(retryAfter >= low && retryAfter <= high).toBe(true)
          expect(reply.headers.get("retry-after")).toBe(String(Math.ceil(retryAfter / 1000)))
          expect(reply.body).toEqual(yield* actorErrorBody(error))
          expect(reply.body).toHaveProperty("reason._tag", reason._tag)
          expect(reply.body).toHaveProperty("isRetryable", true)
          expect(reply.body).not.toHaveProperty("reason.cause")
        }
      }),
    ))

  it("maps Timeout and NotCreated without retry metadata", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const timeout = yield* respond(
          ActorError.make({ reason: Timeout.make({ commandId: "v1.1.2.x" }) }),
        )

        expect(timeout.status).toBe(504)
        expect(timeout.headers.get("retry-after")).toBe(null)
        expect(statusOf(NotCreated.make({}))).toBe(404)
      }),
    ))

  it("rejects a declared error that claims a framework status or tag", () => {
    class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {}, { httpApiStatus: 409 }) {}

    class Defect extends Schema.TaggedError<Defect>()("Defect", {}) {}

    class Malformed extends Schema.TaggedError<Malformed>()(
      "Malformed",
      {},
      { httpApiStatus: 400 },
    ) {}

    class Missing extends Schema.TaggedError<Missing>()("Missing", {}, { httpApiStatus: 404 }) {}

    class Teapot extends Schema.TaggedError<Teapot>()("Teapot", {}, { httpApiStatus: 418 }) {}

    expect(() => checkDeclaredErrors({ tag: "M", error: Conflict })).toThrow(/409/)
    expect(() => checkDeclaredErrors({ tag: "M", error: Malformed })).toThrow(/400/)
    expect(() => checkDeclaredErrors({ tag: "M", error: Missing })).toThrow(/404/)
    expect(() => checkDeclaredErrors({ tag: "M", error: Defect })).toThrow(/reserved/)
    expect(() => checkDeclaredErrors({ tag: "M", error: Teapot })).not.toThrow()
  })
})
