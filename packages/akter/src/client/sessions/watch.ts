import { Effect, type Option, Schema, Stream } from "effect"
import { decodeFailure, type Failure, undecodableFailure } from "../transport.ts"
import { IDLE_MS, readEvents, reconnecting, session } from "./sse.ts"

/** Options of one watch. */
export interface WatchOptions {
  /** Ends the iteration; the watch stops at once. */
  readonly signal?: AbortSignal
}

const VERSION = /^(0|[1-9]\d*)$/

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

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
  session({
    signal: options.signal,
    run: (emit) => {
      const failureOf = (text: string, status: number, headers = new Headers()) =>
        decodeFailure(declared)({ status, headers, text, sentAt: 0 })

      let last = token()

      return reconnecting((delivered) =>
        Effect.gen(function* () {
          const response = yield* open(last, yield* Effect.abortSignal)

          yield* readEvents({ response, refused: failureOf, idleMs: IDLE_MS }).pipe(
            Stream.runForEach((message) =>
              Effect.gen(function* () {
                if (message.event === "end") return yield* failureOf(message.data, 0)

                const json = yield* decodeJson(message.data).pipe(
                  Effect.mapError(undecodableFailure),
                )

                const value = yield* decode(json)
                last = later(last, message.id)
                yield* delivered
                yield* emit(value)
              }),
            ),
          )
        }),
      )
    },
  })
