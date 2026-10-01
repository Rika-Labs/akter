import {
  Cause,
  Clock,
  Duration,
  Effect,
  Option,
  Queue,
  Random,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { Sse } from "effect/unstable/encoding"
import { ActorError, Unauthorized } from "../../errors/actor.ts"
import { aborted, type Failure, networkFailure, undecodableFailure } from "../transport.ts"

/**
 * One SSE message as a session reads it. `id` is set only when the message
 * introduced a new, non-empty last event id. A standard parser gives every
 * message the last id seen, so a message without its own `id` line, such as a
 * feed's terminal `end`, inherits the previous one; `id` hides that.
 */
export interface Message {
  readonly event: string
  readonly id: string | undefined
  readonly data: string
}

/**
 * The framework bounds no single served message except a feed's events, at
 * the 1 MiB a turn may emit; watch results and stream elements are as large as
 * the query or handler makes them. The parser therefore takes any size the
 * server sends instead of Effect's 10 MiB default.
 */
const DECODE = { maxEventSize: Number.POSITIVE_INFINITY }

/** No bytes for this long, keepalive comments included, means the stream is dead. */
export const IDLE_MS = 45_000

const MAX_BACKOFF_MS = 5_000

/**
 * The chunks of `body`, read in the consuming fiber so the first read is
 * issued as soon as the response arrives, ending when the body closes or,
 * with `idleMs`, once no chunk arrived for that long. The idle watchdog
 * cancels the body, which ends the pending read, instead of racing each read
 * against a timer: a raced or forked read can miss a chunk that arrives just
 * before the body fails. Closing the stream cancels the body.
 */
const chunks = (body: ReadableStream<Uint8Array>, idleMs: number | undefined) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const reader = body.getReader()
      const cancel = Effect.promise(() => reader.cancel().catch(() => undefined))
      let last = yield* Clock.currentTimeMillis

      yield* Effect.addFinalizer(() => cancel)

      if (idleMs !== undefined)
        yield* Effect.gen(function* () {
          while (true) {
            const wait = last + idleMs - (yield* Clock.currentTimeMillis)

            if (wait <= 0) return yield* cancel

            yield* Effect.sleep(Duration.millis(wait))
          }
        }).pipe(Effect.forkScoped)

      return Stream.fromEffectRepeat(
        Effect.tryPromise({ try: () => reader.read(), catch: networkFailure }).pipe(
          Effect.flatMap((read) => (read.done ? Cause.done() : Effect.succeed(read.value))),
          Effect.tap(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                last = now
              }),
            ),
          ),
        ),
      )
    }),
  )

/**
 * The messages of an SSE response, parsed by the standard parser: CR, LF, and
 * CRLF line ends split anywhere across chunks, a leading BOM, UTF-8 split
 * across chunks, and an `id` containing NUL ignored. A `200` without a body
 * fails as undecodable, and any other status fails with `refused` of its body. With `idleMs`, a body that
 * sends no bytes for that long ends the stream. Ending the stream cancels the
 * body.
 */
export const readEvents = ({
  response,
  refused,
  idleMs,
}: {
  readonly response: Response
  readonly refused: (text: string, status: number, headers: Headers) => Failure
  readonly idleMs?: number | undefined
}): Stream.Stream<Message, Failure> => {
  if (response.status !== 200)
    return Stream.fromEffect(
      Effect.tryPromise({ try: () => response.text(), catch: networkFailure }).pipe(
        Effect.flatMap((text) => Effect.fail(refused(text, response.status, response.headers))),
      ),
    )

  const body = response.body

  if (body === null) return Stream.fail(undecodableFailure())

  return chunks(body, idleMs).pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode(DECODE)),
    Stream.mapError((error) =>
      Sse.Retry.is(error)
        ? networkFailure()
        : Schema.is(ActorError)(error)
          ? error
          : undecodableFailure(),
    ),
    Stream.mapAccum(
      (): string | undefined => undefined,
      (seen, message) =>
        [
          message.id,
          [
            {
              event: message.event,
              data: message.data,
              id: message.id === seen || message.id === "" ? undefined : message.id,
            },
          ],
        ] as const,
    ),
  )
}

/**
 * The values `run` emits as a Stream that ends when `run` returns and fails
 * with what it fails with. `signal` interrupts it, closing `run`'s scope.
 */
export const session = <A>({
  signal,
  run,
}: {
  readonly signal: AbortSignal | undefined
  readonly run: (
    emit: (value: A) => Effect.Effect<void>,
  ) => Effect.Effect<void, Failure, Scope.Scope>
}): Stream.Stream<A, Failure> =>
  Stream.callback<A, Failure>((out) =>
    run((value) => Queue.offer(out, value).pipe(Effect.asVoid)).pipe(
      Effect.scoped,
      Effect.catch((failure) => Queue.fail(out, failure)),
      Effect.andThen(Queue.end(out)),
    ),
  ).pipe(Stream.interruptWhen(aborted(signal)))

const isExpired = (failure: ActorError) =>
  Schema.is(Unauthorized)(failure.reason) && failure.reason.code === "expired"

/**
 * Runs `attempt`, one connection of a feed or a watch, again after every end
 * that another attempt can resolve: a closed or idle body, a retryable
 * `ActorError`, or one expired credential. An attempt calls `delivered` after
 * each value, which resets the backoff and permits one more credential
 * refresh. The next attempt waits for the server's `retryAfter` when the end
 * carried one, else a jittered delay growing from 100 ms to 5 s. Any other
 * failure ends the session. Which position the next attempt resumes from is
 * the attempt's own state, not this loop's.
 */
export const reconnecting = Effect.fnUntraced(function* (
  attempt: (delivered: Effect.Effect<void>) => Effect.Effect<void, Failure, Scope.Scope>,
): Effect.fn.Return<never, Failure> {
  let failures = 0
  let authRetried = false

  const delivered = Effect.sync(() => {
    failures = 0
    authRetried = false
  })

  while (true) {
    const ended = yield* attempt(delivered).pipe(Effect.scoped, Effect.flip, Effect.option)
    let hinted: number | undefined = undefined

    if (Option.isSome(ended)) {
      const failure = ended.value

      if (!Schema.is(ActorError)(failure)) return yield* failure

      const refresh = !authRetried && isExpired(failure)

      if (!failure.isRetryable && !refresh) return yield* failure

      if (refresh) authRetried = true

      hinted = Option.getOrUndefined(failure.retryAfter)
    }

    const backoff = Math.min(MAX_BACKOFF_MS, 100 * 2 ** failures)
    failures += 1
    const jitter = yield* Random.nextBetween(0.5, 1.5)

    yield* Effect.sleep(Duration.millis(hinted ?? Math.round(backoff * jitter)))
  }
})
