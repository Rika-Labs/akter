import { Clock, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { Deployment } from "./deployment.ts"

/** A reply from one runner's listener; no status means the connection failed. */
interface Reply {
  readonly status: number | undefined
  readonly text: string
}

const Refusal = Schema.Struct({ reason: Schema.Struct({ _tag: Schema.String }) })

const Minted = Schema.Struct({ commandId: Schema.String })

const Readiness = Schema.Struct({ ready: Schema.Boolean, reason: Schema.optional(Schema.String) })

const PostBody = Schema.Struct({ body: Schema.String })

const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(Refusal))

const decodeMinted = Schema.decodeUnknownOption(Schema.fromJsonString(Minted))

const decodeReadiness = Schema.decodeUnknownOption(Schema.fromJsonString(Readiness))

const encodePost = Schema.encodeEffect(Schema.fromJsonString(PostBody))

/**
 * Sends one request to `port` as the rehearsal's user; a refused or dropped
 * connection is a reply with no status. A request with a `key` is a `POST`
 * carrying it as its idempotency key, and `post` alone is a `POST` without one.
 */
export const request = Effect.fnUntraced(function* (
  port: number,
  path: string,
  init?: { readonly key?: string; readonly body?: string; readonly post?: boolean },
) {
  const client = yield* HttpClient.HttpClient
  const url = `http://127.0.0.1:${port}${path}`

  const base =
    init?.post === true || init?.key !== undefined
      ? HttpClientRequest.post(url)
      : HttpClientRequest.get(url)

  const keyed =
    init?.key === undefined ? base : HttpClientRequest.setHeader(base, "idempotency-key", init.key)

  const authed = HttpClientRequest.bearerToken(keyed, "ada")

  const sent =
    init?.body === undefined
      ? authed
      : HttpClientRequest.bodyText(authed, init.body, "application/json")

  return yield* client.execute(sent).pipe(
    Effect.flatMap((response) =>
      Effect.map(response.text, (text): Reply => ({ status: response.status, text })),
    ),
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed((): Reply => ({ status: undefined, text: "" })),
  )
})

/** What a runner's `/ready` says. */
export const readiness = Effect.fnUntraced(function* (port: number) {
  const { status, text } = yield* request(port, "/ready")
  const decoded = decodeReadiness(text)

  return {
    status,
    reason: Option.match(decoded, {
      onNone: () => undefined,
      onSome: ({ reason }) => reason,
    }),
  }
})

/** The `_tag` of the declared or protocol failure in a refused reply. */
export const refusal = (reply: Reply) =>
  Option.match(decodeRefusal(reply.text), {
    onNone: () => undefined,
    onSome: ({ reason }) => reason._tag,
  })

/** One message the load generator sent, and where it stands. */
export interface Sent {
  readonly id: string
  readonly room: string
  readonly body: string
  readonly startedAt: number
  ackedAt?: number
  refused?: string
}

/**
 * Sends chat posts through the deployment's listeners as clients behind a
 * load balancer would: each post takes a command id from `/command-ids`, goes
 * only to a listener whose `/ready` answers 200, and is retried under the same
 * id and idempotency key on any transport failure or server error, until it is
 * acknowledged or a runner refuses it outright. Message bodies start with
 * `label`, so the bodies of two loads never collide.
 */
export const makeLoad = ({
  current,
  label,
}: {
  readonly current: () => Deployment
  readonly label: string
}) =>
  Effect.sync(() => {
    const order: Array<Sent> = []
    let running = true
    let turn = 0

    const ready = Effect.fnUntraced(function* () {
      while (true) {
        const ports = current().ports()

        for (let index = 0; index < ports.length; index++) {
          const { port } = ports[(turn++ + index) % ports.length]!

          if ((yield* readiness(port)).status === 200) return port
        }

        yield* Effect.sleep("100 millis")
      }
    })

    const mint = Effect.fnUntraced(function* () {
      while (true) {
        const reply = yield* request(yield* ready(), "/command-ids", { post: true })

        const minted = Option.match(decodeMinted(reply.text), {
          onNone: () => undefined,
          onSome: ({ commandId }) => commandId,
        })

        if (reply.status === 200 && minted !== undefined) return minted

        yield* Effect.sleep("100 millis")
      }
    })

    const post = Effect.fnUntraced(function* (room: string, body: string) {
      const id = yield* mint()
      const message: Sent = { id, room, body, startedAt: yield* Clock.currentTimeMillis }
      order.push(message)

      while (message.ackedAt === undefined && message.refused === undefined) {
        const reply = yield* request(yield* ready(), `/actors/Room/${room}/Post`, {
          key: id,
          body: yield* encodePost({ body }).pipe(Effect.orDie),
        })

        if (reply.status === 200) message.ackedAt = yield* Clock.currentTimeMillis
        else if (reply.status !== undefined && reply.status < 500)
          message.refused = refusal(reply) ?? String(reply.status)
        else yield* Effect.sleep("100 millis")
      }
    })

    const acknowledged = () => order.filter(({ ackedAt }) => ackedAt !== undefined).length

    return {
      order,
      acknowledged,
      /** Starts `count` clients posting to `rooms` rooms until `stop`; join the fiber after it. */
      clients: (count: number, rooms: number) =>
        Effect.forEach(
          Array.from({ length: count }, (_, client) => client),
          (client) =>
            Effect.gen(function* () {
              for (let index = 0; running; index++)
                yield* post(
                  `room-${(client + index * count) % rooms}`,
                  `${label} ${client}-${index}`,
                )
            }),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.forkChild),
      stop: Effect.sync(() => {
        running = false
      }),
      /** Waits until `count` more posts than now have been acknowledged. */
      untilMore: Effect.fnUntraced(function* (count: number) {
        const target = acknowledged() + count

        yield* Effect.gen(function* () {
          while (acknowledged() < target) yield* Effect.sleep("50 millis")
        }).pipe(
          Effect.timeoutOrElse({
            duration: "90 seconds",
            orElse: () =>
              Effect.die(new Error(`Timed out waiting for ${count} more acknowledgements`)),
          }),
        )
      }),
      /** Sends `message` again under its original key, as a client retrying after a restore does. */
      resend: Effect.fnUntraced(function* (message: Sent) {
        return yield* request(yield* ready(), `/actors/Room/${message.room}/Post`, {
          key: message.id,
          body: yield* encodePost({ body: message.body }).pipe(Effect.orDie),
        })
      }),
    }
  })
