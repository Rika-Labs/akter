import { Duration, Effect, Option, Queue, Random, Schema, Stream } from "effect"
import type { ServedMember } from "../../actor/served.ts"
import { ActorError, Unauthorized } from "../../errors/actor.ts"
import type { ValueSchema } from "../../members/command.ts"
import { decodeFailure, type Failure, networkFailure, undecodableFailure } from "../transport.ts"
import { parse } from "./feed.ts"

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

const reopens = (failure: Failure, authRetried: boolean) =>
  Schema.is(ActorError)(failure) && (failure.isRetryable || (!authRetried && isExpired(failure)))

const later = (current: string | undefined, seen: string | undefined) =>
  seen !== undefined &&
  VERSION.test(seen) &&
  (current === undefined || BigInt(seen) > BigInt(current))
    ? seen
    : current

export interface WatchSource {
  readonly member: ServedMember
  /**
   * Posts the watch with its encoded input and fresh headers. `version` is the
   * least commit version its first result must reflect, sent as
   * `durable-min-version`.
   */
  readonly open: (
    version: string | undefined,
    signal: AbortSignal,
  ) => Effect.Effect<Response, ActorError>
  readonly declared: (body: Schema.Json) => Option.Option<Failure>
  /** The consistency token the client holds when the watch starts. */
  readonly token: () => string | undefined
  readonly options: WatchOptions
}

/**
 * One watch on a query declared `watch: true`: its current result, then the
 * newest result after each commit that changed what the query read. A watch is
 * state, not history, so a dropped connection is reopened with the greatest
 * version any result carried as `durable-min-version`, and its first result
 * is the current state, never older than one already delivered. It fails with
 * the query's declared error or the `ActorError` that ended it when a retry
 * cannot help.
 */
export const watchStream = ({
  member,
  open,
  declared,
  token,
  options,
}: WatchSource): Stream.Stream<ValueSchema["Type"], Failure> =>
  Stream.callback<ValueSchema["Type"], Failure>((out) =>
    Effect.gen(function* () {
      const decodeOutput = Schema.decodeUnknownEffect(Schema.toCodecJson(member.output))

      const failureOf = (text: string, status: number, headers = new Headers()) =>
        decodeFailure(declared)({ status, headers, text, sentAt: 0 })

      let last = token()
      let failures = 0
      let authRetried = false

      const once = Effect.gen(function* () {
        const response = yield* open(last, yield* Effect.abortSignal)

        if (response.status !== 200) {
          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: networkFailure,
          })

          return yield* failureOf(text, response.status, response.headers)
        }

        if (response.body === null) return yield* undecodableFailure()

        const reader = response.body.getReader()

        yield* Effect.addFinalizer(() =>
          Effect.promise(() => reader.cancel().catch(() => undefined)),
        )

        const text = new TextDecoder()
        let buffer = ""

        while (true) {
          const chunk = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: networkFailure,
          }).pipe(Effect.timeoutOption(IDLE_MS))

          if (Option.isNone(chunk) || chunk.value.done) return

          buffer += text.decode(chunk.value.value, { stream: true })
          const parsed = parse(buffer)
          buffer = parsed.rest

          for (const message of parsed.messages) {
            if (message.event === "end") return yield* failureOf(message.data, 0)

            const json = yield* decodeJson(message.data).pipe(Effect.mapError(undecodableFailure))
            const value = yield* decodeOutput(json).pipe(Effect.mapError(undecodableFailure))
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
  ).pipe(
    Stream.interruptWhen(
      Effect.callback<void>((resume) => {
        const signal = options.signal

        if (signal === undefined) return

        if (signal.aborted) return resume(Effect.void)

        const onAbort = () => resume(Effect.void)
        signal.addEventListener("abort", onAbort, { once: true })

        return Effect.sync(() => signal.removeEventListener("abort", onAbort))
      }),
    ),
  )
