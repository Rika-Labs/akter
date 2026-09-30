import { type Cause, Effect, Option, Schema } from "effect"
import { Headers, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { ActorError } from "../../errors/actor.ts"
import { isSameOrigin } from "../../serve/layer.ts"
import { actorErrorResponse, Defect, invalidInput } from "../../serve/wire.ts"

/** The body of a 404: the tenant has nothing of that name. */
const NotFound = Schema.TaggedStruct("NotFound", {})

/** A 404 with the `NotFound` body. */
export const notFoundResponse = () =>
  HttpServerResponse.jsonUnsafe(NotFound.make({}), { status: 404 })

/** Answers a found value as JSON and an absent one as a 404. */
export const foundOrNotFound = (found: Option.Option<unknown>) =>
  Option.match(found, {
    onNone: notFoundResponse,
    onSome: (value) => HttpServerResponse.jsonUnsafe(value),
  })

/**
 * Refuses a browser page on another origin before its credentials are read,
 * so an operator's cookie or token can't be spent by a page they visit.
 */
export const refuseCrossOrigin = (request: HttpServerRequest.HttpServerRequest) => {
  const origin = Headers.get(request.headers, "origin")

  return Option.isSome(origin) && !isSameOrigin({ request, origin: origin.value })
    ? invalidInput("origin_not_allowed")
    : Effect.void
}

const traceId = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "0".repeat(32)),
)

/**
 * Finishes an operator or inspector route: an `ActorError` is answered as the
 * wire error, a defect is logged under `failure` and answered with an opaque
 * 500 naming only its trace, and no answer is cached, since every answer is
 * bound to one authenticated principal.
 */
export const operatorResponse =
  (failure: string) =>
  <R>(response: Effect.Effect<HttpServerResponse.HttpServerResponse, ActorError, R>) =>
    response.pipe(
      Effect.catch(actorErrorResponse),
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          const trace = yield* traceId

          yield* Effect.logError(failure, cause)

          return HttpServerResponse.jsonUnsafe(Defect.make({ traceId: trace }), { status: 500 })
        }),
      ),
      Effect.map((answered) =>
        HttpServerResponse.setHeaders(answered, { "cache-control": "no-store" }),
      ),
    )
