import { Clock, Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ActorError } from "../errors/actor.ts"
import { Actor } from "../index.ts"
import corpus from "../protocol/exchanges.json" with { type: "json" }

const Answer = Schema.Struct({
  status: Schema.optional(Schema.Int),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optional(Schema.Json),
  text: Schema.optional(Schema.String),
  drop: Schema.optional(Schema.Boolean),
})

const Exchange = Schema.Struct({
  name: Schema.String,
  refresh: Schema.optional(Schema.Boolean),
  freshCredentials: Schema.optional(Schema.Boolean),
  responses: Schema.Array(Answer),
  outcome: Schema.Struct({
    result: Schema.optional(Schema.Json),
    actorError: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    declared: Schema.optional(Schema.String),
    defect: Schema.optional(Schema.Boolean),
  }),
  attempts: Schema.Int,
  minWaitMs: Schema.optional(Schema.Array(Schema.Finite)),
  maxWaitMs: Schema.optional(Schema.Array(Schema.Finite)),
})

const decodeExchange = Schema.decodeUnknownEffect(Exchange)

class RoomClosed extends Schema.TaggedError<RoomClosed>()("RoomClosed", {
  reason: Schema.String,
}) {}

const Call = Actor.command("Call", {
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Int,
  errors: [RoomClosed],
})

const Vectors = Actor.make("ExchangeVectors", { key: Schema.String, api: { Call } })

interface Attempt {
  readonly at: number
  readonly commandId: string | null
  readonly authorization: string | null
  readonly body: string
}

/** A fresh v1 id valid for a minute, as a caller that saved it before sending would pass. */
const freshId = Clock.currentTimeMillis.pipe(
  Effect.map((now) => `v1.${now - 1_000}.${now + 60_000}.00000000-0000-4000-8000-000000000001`),
)

/** Runs one exchange through the Promise client against its scripted answers. */
const exchange = (vector: typeof Exchange.Type) =>
  Effect.gen(function* () {
    const attempts: Array<Attempt> = []
    const commandId = yield* freshId
    let credential = 0

    const fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)

      attempts.push({
        at: performance.now(),
        commandId: headers.get("idempotency-key"),
        authorization: headers.get("authorization"),
        body: JSON.stringify(init?.body),
      })

      const answer = vector.responses[attempts.length - 1]

      if (answer === undefined) return Promise.reject(new Error("no answer scripted"))

      if (answer.drop === true) return Promise.reject(new TypeError("connection reset"))

      const text = answer.text ?? JSON.stringify(answer.body).replaceAll("$commandId", commandId)

      return Promise.resolve(
        new Response(text, {
          status: answer.status ?? 200,
          headers: answer.headers,
        }),
      )
    }

    const handle = Vectors.client({
      baseUrl: "http://vectors.test/api",
      fetch,
      headers: () => ({ authorization: `Bearer credential-${(credential += 1)}` }),
    }).get("room")

    const outcome = yield* Effect.promise(() =>
      handle.Call({ text: "hi" }, { commandId }).then(Result.succeed, Result.fail),
    )

    return { attempts, commandId, outcome }
  })

describe("served exchanges", () => {
  for (const [index, { name }] of corpus.cases.entries())
    it(name, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const vector = yield* decodeExchange(corpus.cases[index])
          const { attempts, commandId, outcome } = yield* exchange(vector)

          expect(attempts).toHaveLength(vector.attempts)
          expect(new Set(attempts.map((attempt) => attempt.commandId))).toEqual(
            new Set([commandId]),
          )
          expect(new Set(attempts.map((attempt) => attempt.body)).size).toBe(1)

          if (vector.freshCredentials === true)
            expect(new Set(attempts.map((attempt) => attempt.authorization)).size).toBe(
              attempts.length,
            )

          const waits = attempts.slice(1).map((attempt, index) => attempt.at - attempts[index]!.at)

          vector.minWaitMs?.forEach((min, index) =>
            expect(waits[index]).toBeGreaterThanOrEqual(min - 5),
          )
          vector.maxWaitMs?.forEach((max, index) => expect(waits[index]).toBeLessThanOrEqual(max))

          const expected = vector.outcome

          if (expected.result !== undefined) {
            expect(Result.isSuccess(outcome) ? outcome.success : undefined).toEqual(expected.result)

            return
          }

          const failure = Result.isFailure(outcome) ? outcome.failure : undefined

          expect(failure).toBeDefined()

          if (expected.declared !== undefined) {
            expect(Schema.is(RoomClosed)(failure)).toBe(true)

            return
          }

          expect(Schema.is(ActorError)(failure)).toBe(true)
          const reason = Schema.is(ActorError)(failure) ? failure.reason : undefined

          if (expected.defect === true) {
            expect(reason).toMatchObject({ code: "defect" })

            return
          }

          expect(reason?._tag).toBe(expected.actorError)

          if (expected.code !== undefined) expect(reason).toMatchObject({ code: expected.code })
        }),
      ),
    )
})
