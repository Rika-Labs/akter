import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import {
  ActorError,
  ActorUnavailable,
  MailboxFull,
  QuotaExceeded,
  RunnerAtCapacity,
  Unauthorized,
} from "../contract/errors.ts"
import { refusalResponse } from "./wire.ts"

const respond = (error: ActorError) =>
  Effect.gen(function* () {
    const web = HttpServerResponse.toWeb(yield* refusalResponse(error))
    return {
      status: web.status,
      headers: web.headers,
      body: yield* Effect.promise(() => web.json()),
    }
  })

describe("refusals before the RPC handler", () => {
  it("answer credential failures 401 with a Bearer challenge and refused access 403 without one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const code of ["missing_credentials", "invalid_credentials", "expired"] as const) {
          const reply = yield* respond(ActorError.make({ reason: Unauthorized.make({ code }) }))
          expect(reply.status).toBe(401)
          expect(reply.headers.get("www-authenticate")).toBe("Bearer")
          expect(Object.keys(reply.body).toSorted()).toEqual(["_tag", "isRetryable", "reason"])
          expect(reply.body).toHaveProperty("_tag", "ActorError")
          expect(reply.body).toHaveProperty(["reason", "_tag"], "Unauthorized")
          expect(reply.body).toHaveProperty(["reason", "code"], code)
          expect(reply.body).toHaveProperty("isRetryable", false)
        }
        const denied = yield* respond(
          ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) }),
        )
        expect(denied.status).toBe(403)
        expect(denied.headers.get("www-authenticate")).toBe(null)
      }),
    ))

  it("answer back-pressure with its status, the envelope's retry metadata and retry-after in whole seconds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const [reason, status, retryAfter, header] of [
          [ActorUnavailable.make({}), 503, 250, "1"],
          [RunnerAtCapacity.make({}), 503, 1_000, "1"],
          [MailboxFull.make({}), 429, 100, "1"],
        ] as const) {
          const reply = yield* respond(ActorError.make({ reason }))
          expect(reply.status).toBe(status)
          expect(reply.headers.get("retry-after")).toBe(header)
          expect(reply.body).toHaveProperty(["reason", "_tag"], reason._tag)
          expect(reply.body).toHaveProperty("isRetryable", true)
          expect(reply.body).toHaveProperty("retryAfter", retryAfter)
        }
        const quota = yield* respond(
          ActorError.make({ reason: QuotaExceeded.make({ limit: "storage", retryAfter: 2_500 }) }),
        )
        expect(quota.status).toBe(429)
        expect(quota.headers.get("retry-after")).toBe("3")
        expect(quota.body).toHaveProperty("isRetryable", true)
      }),
    ))
})
