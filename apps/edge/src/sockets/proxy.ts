import {
  ActorError,
  actorErrorBody,
  ClientWireMessage,
  closeCodeOf,
  reauthenticationDigest,
  requestDigest,
  SUBPROTOCOL,
  Unauthorized,
} from "@durable-actors/core"
import type { ServerWebSocket } from "bun"
import { Data, Deferred, Effect, Option, Predicate, Queue, Result, Schema } from "effect"
import type { Principal } from "../principals/authenticate.ts"
import { type Edge, route, unavailable } from "../routing/forward.ts"
import type { Deployment } from "../routing/hosts.ts"
import { claimsFor } from "../signing/claims.ts"

/** What a client socket delivers, in order: its messages, then its close. */
export type Inbound = Data.TaggedEnum<{
  Message: { readonly data: string | Uint8Array<ArrayBuffer> }
  Closed: {}
}>

export const Inbound = Data.taggedEnum<Inbound>()

/** What the edge knows about one client socket when it accepts the upgrade. */
export interface SocketData {
  readonly deployment: Deployment
  /** The upgrade's path and query, which the runner is sent and every assertion binds. */
  readonly target: string
  /** The session id every assertion of this socket carries as `sid`. */
  readonly session: string
  /** The principal the upgrade's own credential proved, if it carried one; `hello` carries it on. */
  readonly upgrade: Principal | undefined
  readonly inbox: Queue.Queue<Inbound>
}

type Reason = ActorError["reason"]

const decodeClient = Schema.decodeUnknownOption(Schema.fromJsonString(ClientWireMessage))

const encodeClient = Schema.encodeEffect(Schema.fromJsonString(ClientWireMessage))

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const noBody = new Uint8Array(0)

const samePrincipal = (left: Principal, right: Principal) =>
  left.tenant === right.tenant && left.caller.subject === right.caller.subject

/** A code a server may send in a close frame; 1005 and 1006 only describe a closure. */
const sendable = (code: number) => (code === 1005 || code === 1006 ? 1011 : code)

/**
 * Proxies one client socket to a runner of its tenant's home region. `hello`
 * and `reauthenticate` credentials are verified here and replaced with
 * assertions for this session; every other message passes through as is.
 * Holders stay in runners: a lost edge process loses the socket, and the
 * client reconnects.
 */
export const proxySocket = Effect.fnUntraced(function* (
  edge: Edge,
  ws: ServerWebSocket<SocketData>,
) {
  const { deployment, target, session, upgrade, inbox } = ws.data
  const path = new URL(target, "http://edge").pathname
  let upstream: WebSocket | undefined

  const end = Effect.fnUntraced(function* (reason: Reason) {
    const error = yield* encodeJson({
      t: "end",
      error: yield* actorErrorBody(ActorError.make({ reason })),
    }).pipe(Effect.orDie)

    ws.send(error)
    ws.close(closeCodeOf(reason))
    upstream?.close(1000)
  })

  const assertion = Effect.fnUntraced(function* (
    principal: Principal,
    region: string,
    req: string,
  ) {
    const claims = yield* claimsFor({
      issuer: edge.options.issuer,
      deployment: deployment.id,
      region,
      lifetime: edge.options.assertionLifetime,
      principal,
      req,
      path,
      commandId: undefined,
      session,
    })

    return yield* edge.keys.sign(claims)
  })

  const authenticate = (credential: string) =>
    edge.authenticator.authenticate({ deployment: deployment.id, credential }).pipe(Effect.result)

  const first = yield* Queue.take(inbox)

  if (Inbound.$is("Closed")(first)) return

  // `hello` must come first; anything else goes on unchanged, and the runner refuses it.
  const decoded = Predicate.isString(first.data) ? decodeClient(first.data) : Option.none()
  const hello = Option.isSome(decoded) && decoded.value.t === "hello" ? decoded.value : undefined
  let principal = upgrade

  if (hello?.authorization !== undefined) {
    const proved = yield* authenticate(hello.authorization)

    if (Result.isFailure(proved)) return yield* end(proved.failure)

    // The upgrade and its hello must prove the same caller, as a runner requires of both.
    if (upgrade !== undefined && !samePrincipal(upgrade, proved.success))
      return yield* end(Unauthorized.make({ code: "invalid_credentials" }))
    principal = proved.success
  }

  const chosen = yield* route(edge, deployment, principal)

  if (Result.isFailure(chosen)) return yield* end(chosen.failure)
  const routed = chosen.success
  let greeting = first.data

  // The runner authenticates the session from `hello` alone: its credential
  // becomes an assertion bound to the upgrade, carrying this session's id.
  if (hello !== undefined && principal !== undefined) {
    const opening = yield* requestDigest({
      method: "GET",
      target,
      idempotencyKey: undefined,
      body: noBody,
    })

    const signed = yield* assertion(principal, routed.region, opening)

    if (signed === undefined) return yield* end(unavailable("No signing key is usable"))

    greeting = yield* encodeClient({ ...hello, authorization: `Bearer ${signed}` }).pipe(
      Effect.orDie,
    )
  }

  const opened = yield* Deferred.make<boolean>()
  const runner = routed.urls[0]!.replace(/^http/, "ws")

  upstream = new WebSocket(`${runner}${target}`, [SUBPROTOCOL])
  upstream.binaryType = "arraybuffer"
  upstream.onopen = () => Deferred.doneUnsafe(opened, Effect.succeed(true))

  upstream.onmessage = (event: MessageEvent<string | ArrayBuffer>) =>
    ws.send(Predicate.isString(event.data) ? event.data : new Uint8Array(event.data))

  upstream.onclose = (event: CloseEvent) => {
    Deferred.doneUnsafe(opened, Effect.succeed(false))
    Queue.offerUnsafe(inbox, Inbound.Closed())
    ws.close(sendable(event.code), event.reason)
  }

  if (!(yield* Deferred.await(opened))) return

  upstream.send(greeting)

  while (true) {
    const next = yield* Queue.take(inbox)

    if (Inbound.$is("Closed")(next) || upstream.readyState !== WebSocket.OPEN) {
      upstream.close(1000)

      return
    }

    const message = Predicate.isString(next.data) ? decodeClient(next.data) : Option.none()

    if (Option.isNone(message) || message.value.t !== "reauthenticate") {
      upstream.send(next.data)
      continue
    }

    // A renewal binds this session's upgrade path and its session id.
    const renewed = yield* authenticate(message.value.authorization)

    if (Result.isFailure(renewed)) return yield* end(renewed.failure)

    const req = yield* reauthenticationDigest({ path, session })
    const signed = yield* assertion(renewed.success, routed.region, req)

    if (signed === undefined) return yield* end(unavailable("No signing key is usable"))

    upstream.send(
      yield* encodeClient({ t: "reauthenticate", authorization: `Bearer ${signed}` }).pipe(
        Effect.orDie,
      ),
    )
  }
})
