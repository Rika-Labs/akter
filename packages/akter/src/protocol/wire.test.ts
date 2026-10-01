import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Unauthorized } from "../errors/actor.ts"
import corpus from "./exchanges.json" with { type: "json" }
import { actorErrorBody, actorErrorOf, isDefectBody, statusOf } from "./wire.ts"

const Answer = Schema.Struct({
  status: Schema.optional(Schema.Int),
  body: Schema.optional(Schema.Json),
})

const decodeCases = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String, responses: Schema.Array(Answer) })),
)

const isEnvelope = Schema.is(Schema.TaggedStruct("ActorError", {}))

const json = (text: string): Schema.Json => JSON.parse(text)

describe("exchange corpus", () => {
  it("holds only envelopes a server writes, with the status the server gives their reason", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const cases = yield* decodeCases(corpus.cases)
        let checked = 0

        for (const exchange of cases)
          for (const answer of exchange.responses) {
            if (answer.body === undefined || !isEnvelope(answer.body)) continue

            const error = actorErrorOf({ body: answer.body, headerRetryAfterMs: undefined })

            expect(Option.isSome(error), exchange.name).toBe(true)

            if (Option.isNone(error)) continue

            const written = yield* actorErrorBody(error.value)

            expect(answer.body, exchange.name).toMatchObject({
              _tag: written._tag,
              reason: written.reason,
              isRetryable: written.isRetryable,
            })
            expect(answer.status, exchange.name).toBe(statusOf(error.value.reason))
            checked += 1
          }

        expect(checked).toBeGreaterThanOrEqual(10)
      }),
    ))
})

describe("actorErrorOf", () => {
  it("keeps the server's retryAfter over the header's, and uses the header without one", () => {
    const sent = actorErrorOf({
      body: json(
        '{"_tag":"ActorError","reason":{"_tag":"MailboxFull"},"isRetryable":true,"retryAfter":120}',
      ),
      headerRetryAfterMs: 2_000,
    })

    const header = actorErrorOf({
      body: json('{"_tag":"ActorError","reason":{"_tag":"MailboxFull"},"isRetryable":true}'),
      headerRetryAfterMs: 2_000,
    })

    expect(Option.map(sent, (error) => Option.getOrUndefined(error.retryAfter))).toEqual(
      Option.some(120),
    )
    expect(Option.map(header, (error) => Option.getOrUndefined(error.retryAfter))).toEqual(
      Option.some(2_000),
    )
  })

  it("reads no ActorError from a reason this client doesn't know, a defect, or a declared error", () => {
    const read = (text: string) => actorErrorOf({ body: json(text), headerRetryAfterMs: undefined })

    expect(
      Option.isNone(read('{"_tag":"ActorError","reason":{"_tag":"Novel"},"isRetryable":false}')),
    ).toBe(true)
    expect(Option.isNone(read('{"_tag":"Defect","traceId":"t"}'))).toBe(true)
    expect(isDefectBody(json('{"_tag":"Defect","traceId":"t"}'))).toBe(true)
    expect(Option.isNone(read('{"_tag":"Closed"}'))).toBe(true)
  })
})

describe("credential classification", () => {
  it("serves exactly the auth provider's codes as 401 and every decision as 403", () => {
    const codes = Unauthorized.fields.code.literals

    expect(
      codes.filter((code) => statusOf(Unauthorized.make({ code })) === 401).toSorted(),
    ).toEqual(["expired", "invalid_credentials", "missing_credentials"])
    expect(codes.filter((code) => Unauthorized.make({ code }).isCredential).toSorted()).toEqual([
      "expired",
      "invalid_credentials",
      "missing_credentials",
    ])
  })
})
