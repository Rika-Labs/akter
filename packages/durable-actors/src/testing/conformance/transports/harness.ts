import { type Cause, Context, Effect, Layer, Queue, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import type { ActorRef } from "../../../identity/caller.ts"
import type { ServeOptions } from "../../../serve/layer.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceEnvironment } from "../../conformance.ts"
import { Said } from "./actors.ts"
import { type WireSocket, decodeReason, opened, serveSockets } from "./wire.ts"

interface SseMessage {
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

const FeedEntry = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.toCodecJson(Said),
    commandId: Schema.String,
    timestamp: Schema.Finite,
  }),
)

export const decodeEntry = Schema.decodeUnknownEffect(FeedEntry)

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/**
 * An event feed read over `fetch`, as the Promise client reads one: SSE
 * messages parsed from the body, comments skipped. Closed with the scope.
 */
export const feed = (
  host: string,
  id: string,
  query: string,
  headers: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)

    const response = yield* client
      .execute(
        HttpClientRequest.get(`http://${host}/api/actors/FeedRoom/${id}/events?${query}`, {
          headers,
        }),
      )
      .pipe(Effect.orDie)

    const messages = yield* Queue.unbounded<SseMessage, Cause.Done>()

    if (response.status !== 200)
      return { status: response.status, body: yield* response.text.pipe(Effect.orDie), messages }

    let text = ""

    yield* response.stream.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          text += chunk
          let end = text.indexOf("\n\n")

          while (end !== -1) {
            const block = text.slice(0, end)
            text = text.slice(end + 2)
            end = text.indexOf("\n\n")
            const fields = new Map<string, string>()

            for (const line of block.split("\n"))
              if (!line.startsWith(":")) {
                const colon = line.indexOf(":")
                fields.set(line.slice(0, colon), line.slice(colon + 2))
              }

            if (fields.has("data"))
              yield* Queue.offer(messages, {
                id: fields.get("id"),
                event: fields.get("event"),
                data: fields.get("data")!,
              })
          }
        }),
      ),
      Effect.ignore,
      Effect.andThen(Queue.end(messages)),
      Effect.forkScoped,
    )

    return { status: 200, body: "", messages }
  })

/** The next `count` feed messages, failing the test if they don't arrive in time. */
export const take = (
  messages: Queue.Dequeue<SseMessage, Cause.Done>,
  count: number,
  timeout = 20_000,
) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    () =>
      Queue.take(messages).pipe(
        Effect.catch(() => Effect.die(new Error("The feed ended"))),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.die(new Error("No feed message arrived")),
        }),
      ),
  )

/** The `Said` text a feed message carries. */
export const textOf = (message: SseMessage) =>
  decodeEntry(message.data).pipe(
    Effect.orDie,
    Effect.map((entry) => entry.event.text),
  )

/** The reason of a feed's `end` message or a refused feed's body, without its `_tag` key. */
export const feedReason = (data: string) =>
  decodeBody(data).pipe(
    Effect.flatMap(decodeReason),
    Effect.orDie,
    Effect.map(({ reason }) => ({ tag: reason._tag, code: reason.code, cause: reason.cause })),
  )

const CursorBody = Schema.Struct({ _tag: Schema.String, cursor: Schema.String })

export const cursorError = (body: string) =>
  decodeBody(body).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CursorBody)),
    Effect.orDie,
    Effect.map((error) => ({ tag: error._tag, cursor: error.cursor })),
  )

export const rows = Effect.fnUntraced(function* (ref: ActorRef) {
  const sql = yield* SqlClient.SqlClient

  const [counts] = yield* sql<{ connections: number; generations: number }>`
    SELECT
      (SELECT count(*)::int FROM actor_connections WHERE tenant_id = ${ref.tenant}
        AND actor_type = ${ref.actor} AND actor_id = ${ref.id}) AS connections,
      (SELECT count(*)::int FROM actor_generations WHERE tenant_id = ${ref.tenant}
        AND actor_type = ${ref.actor} AND actor_id = ${ref.id}) AS generations`

  return counts!
}, Effect.orDie)

export const setup = (
  environment: ConformanceEnvironment,
  options?: Partial<ServeOptions<never>>,
) =>
  Effect.gen(function* () {
    const test = yield* ActorTest
    const host = yield* serveSockets(environment, options)

    return { test, host, token: (subject = "alice") => `Bearer ${test.tenant}:${subject}` }
  })

/** Says `hello` and reads through `open` and the open handler's greeting. */
export const greet = (ws: WireSocket, authorization: string, name = "alice") =>
  Effect.gen(function* () {
    yield* ws.send({ t: "hello", authorization, params: { name } })
    const open = yield* opened((yield* ws.until("open")).at(-1))
    yield* ws.until("frame")

    return open
  })
