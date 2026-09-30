import { Duration, Effect, Option, Queue, Random, Schema, Stream } from "effect"
import { ActorError, Unauthorized } from "../../errors/actor.ts"
import { aborted, decodeFailure, type Failure, undecodableFailure } from "../transport.ts"
import { readEvents } from "./feed.ts"

/** Options of one watch. */
export interface WatchOptions {
  /** Ends the iteration; the watch stops at once. */
  readonly signal?: AbortSignal
}

/** No bytes for this long, keepalive comments included, means the stream is dead. */
const IDLE_MS = 45_000

const MAX_BACKOFF_MS = 5_000

const VERSION = /^(0|[1-9]\d*)$/

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const isExpired = (failure: Failure) =>
  Schema.is(ActorError)(failure) &&
  Schema.is(Unauthorized)(failure.reason) &&
  failure.reason.code === "expired"

/** Whether a watch that ended with `failure` may reopen. */
const reopens = (failure: Failure, authRetried: boolean) =>
  Schema.is(ActorError)(failure) && (failure.isRetryable || (!authRetried && isExpired(failure)))

/** The greater of the version held and a result's `id`, when that is a version. */
const later = (current: string | undefined, seen: string | undefined) =>
  seen !== undefined &&
  VERSION.test(seen) &&
  (current === undefined || BigInt(seen) > BigInt(current))
    ? seen
    : current

interface WatchSource<A> {
  /** Decodes one result's JSON: the watched query's output, or a fleet page. */
  readonly decode: (json: Schema.Json) => Effect.Effect<A, Failure>
  /**
   * Posts the watch with its encoded input and fresh headers. `version` is the
   * least commit version its first result must reflect, sent as
   * `durable-min-version`.
   */
  readonly open: (
    version: string | undefined,
    signal: AbortSignal,
  ) => Effect.Effect<Response, Failure>
  /** Decodes the query's declared errors from a served body. */
  readonly declared: (body: Schema.Json) => Option.Option<Failure>
  /** The consistency token the client holds when the watch starts. */
  readonly token: () => string | undefined
  readonly options: WatchOptions
}

/**
 * One watch of served state, a query declared `watch: true` or a fleet view:
 * its current result, then the newest result after each change. A watch is
 * state, not history, so a dropped connection is reopened after a jittered,
 * growing delay, or the server's `retryAfter`, with the greatest version any
 * result carried as `durable-min-version`; its first result is the current
 * state, never older than one already delivered. It fails with the query's
 * declared error or the `ActorError` that ended it when a retry cannot help,
 * and an expired credential is retried once.
 */
export const watchStream = <A>({
  decode,
  open,
  declared,
  token,
  options,
}: WatchSource<A>): Stream.Stream<A, Failure> =>
  Stream.callback<A, Failure>((out) =>
    Effect.gen(function* () {
      const failureOf = (text: string, status: number, headers = new Headers()) =>
        decodeFailure(declared)({ status, headers, text, sentAt: 0 })

      let last = token()
      let failures = 0
      let authRetried = false

      const once = Effect.gen(function* () {
        const { next } = yield* readEvents({
          response: yield* open(last, yield* Effect.abortSignal),
          refused: failureOf,
          idleMs: IDLE_MS,
        })

        while (true) {
          const messages = yield* next

          if (messages === undefined) return

          for (const message of messages) {
            if (message.event === "end") return yield* failureOf(message.data, 0)

            const json = yield* decodeJson(message.data).pipe(Effect.mapError(undecodableFailure))
            const value = yield* decode(json)
            last = later(last, message.id)
            failures = 0
            authRetried = false
            yield* Queue.offer(out, value)
          }
        }
      }).pipe(Effect.scoped)

      while (true) {
        const ended = yield* once.pipe(Effect.flip, Effect.option)
        let hinted: number | undefined = undefined

        if (Option.isSome(ended)) {
          if (!reopens(ended.value, authRetried)) return yield* ended.value

          if (isExpired(ended.value)) authRetried = true

          if (Schema.is(ActorError)(ended.value))
            hinted = Option.getOrUndefined(ended.value.retryAfter)
        }

        const backoff = Math.min(MAX_BACKOFF_MS, 100 * 2 ** failures)
        failures += 1
        const jitter = yield* Random.nextBetween(0.5, 1.5)

        yield* Effect.sleep(Duration.millis(hinted ?? Math.round(backoff * jitter)))
      }
    }).pipe(
      Effect.catch((failure) => Queue.fail(out, failure)),
      Effect.andThen(Queue.end(out)),
    ),
  ).pipe(Stream.interruptWhen(aborted(options.signal)))
