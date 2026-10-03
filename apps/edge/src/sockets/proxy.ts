import {
  ActorError,
  ClientWireMessage,
  reauthenticationDigest,
  requestDigest,
  SUBPROTOCOL,
  Unauthorized,
} from "@rikalabs/akter"
import { actorErrorBody, closeCodeOf } from "@rikalabs/akter/runtime"
import type { ServerWebSocket } from "bun"
import { Data, Deferred, Effect, Option, Predicate, Queue, Result, Schema } from "effect"
import type { Principal } from "../principals/authenticate.ts"
import { ANONYMOUS_TENANT, type Edge, route, unavailable } from "../routing/forward.ts"
import { type Lease, type QuotaError, QuotaUnavailable, quotaFailure } from "../quotas.ts"
import type { Deployment } from "../routing/hosts.ts"
import { claimsFor } from "../signing/claims.ts"

/** What a client socket delivers, in order: its messages, then its close. */
export type Inbound = Data.TaggedEnum<{
  Message: { readonly data: string | Uint8Array<ArrayBuffer>; readonly bytes: number }
  Closed: {}
}>

/** Constructors and matchers for `Inbound`. */
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
  readonly lease: Lease
  readonly inbox: Queue.Queue<Inbound>
  /** Bytes of client messages received and not yet handed to a runner. */
  pending: number
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
 *
 * `hello` must come first; anything else goes on unchanged, and the runner
 * refuses it. The upgrade and its hello must prove the same caller, as a
 * runner requires of both. Like HTTP forwarding, it tries each ready runner of
 * the region in turn until one accepts.
 *
 * The runner authenticates the session from `hello` alone: the credential
 * becomes an assertion bound to the upgrade and carrying this session's id. It
 * is signed once a runner has accepted the socket, so failing over first can't
 * age it. A renewal binds the same upgrade path and session id.
 *
 * Messages wait for the runner while its socket's buffer is over
 * `socketBufferBytes`; the server closes a client whose waiting messages pass
 * that bound, so one socket holds a bounded amount of edge memory.
 *
 * Once the caller is known, the socket holds a connection lease for as long as
 * the scope lives, and a caller whose organization is at its connection cap
 * gets an `end` frame carrying the quota error. Socket frames are
 * app-defined, so they are not metered.
 */
export const proxySocket = Effect.fnUntraced(function* (
  edge: Edge,
  ws: ServerWebSocket<SocketData>,
) {
  const { deployment, target, session, upgrade, inbox } = ws.data
  const path = new URL(target, "http://edge").pathname
  let upstream: WebSocket | undefined

  const finish = Effect.fnUntraced(function* (error: Schema.Json, code: number) {
    ws.send(yield* encodeJson({ t: "end", error }).pipe(Effect.orDie))
    ws.close(code)
    upstream?.close(1000)
  })

  const end = Effect.fnUntraced(function* (reason: Reason) {
    yield* finish(yield* actorErrorBody(ActorError.make({ reason })), closeCodeOf(reason))
  })

  const endQuota = Effect.fnUntraced(function* (error: QuotaError) {
    const failure = yield* quotaFailure(error)

    yield* finish(failure.body, failure.closeCode)
  })

  const holdLease = Effect.fnUntraced(function* (lease: Lease) {
    yield* Effect.addFinalizer(() => edge.quotas.releaseLease(lease).pipe(Effect.ignore))
    yield* lease.lost.pipe(Effect.andThen(endQuota(QuotaUnavailable.make())), Effect.forkScoped)
  })

  yield* holdLease(ws.data.lease)

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

  const take = Queue.take(inbox).pipe(
    Effect.tap((inbound) =>
      Effect.sync(() => {
        if (Inbound.$is("Message")(inbound)) ws.data.pending -= inbound.bytes
      }),
    ),
  )

  const first = yield* take.pipe(
    Effect.timeoutOption(edge.options.helloTimeout),
    Effect.map(Option.getOrElse(() => undefined)),
  )

  if (first === undefined) {
    ws.close(1008, "hello timeout")

    return
  }

  if (Inbound.$is("Closed")(first)) return

  const decoded = Predicate.isString(first.data) ? decodeClient(first.data) : Option.none()
  const hello = Option.isSome(decoded) && decoded.value.t === "hello" ? decoded.value : undefined
  let principal = upgrade

  if (hello?.authorization !== undefined) {
    const proved = yield* authenticate(hello.authorization)

    if (Result.isFailure(proved)) return yield* end(proved.failure)

    if (upgrade !== undefined && !samePrincipal(upgrade, proved.success))
      return yield* end(Unauthorized.make({ code: "invalid_credentials" }))
    principal = proved.success
  }

  let leased = ws.data.lease

  if (leased.tenant !== (principal?.tenant ?? ANONYMOUS_TENANT)) {
    const organization = yield* edge.quotas
      .organization(deployment.id, principal?.tenant ?? ANONYMOUS_TENANT)
      .pipe(Effect.result)

    if (Result.isFailure(organization)) return yield* endQuota(organization.failure)

    if (organization.success !== leased.organizationId) {
      const replacement = yield* edge.quotas
        .acquireLease({
          deployment: deployment.id,
          tenant: principal?.tenant ?? ANONYMOUS_TENANT,
          kind: "socket",
        })
        .pipe(Effect.result)

      if (Result.isFailure(replacement)) return yield* endQuota(replacement.failure)

      yield* holdLease(replacement.success)
      yield* edge.quotas.releaseLease(leased).pipe(Effect.ignore)
      leased = replacement.success
    }
  }

  if (yield* leased.isLost) return yield* endQuota(QuotaUnavailable.make())

  const chosen = yield* route(edge, deployment, principal)

  if (Result.isFailure(chosen)) return yield* end(chosen.failure)
  const routed = chosen.success

  const connect = (url: string) =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<boolean>()
      const socket = new WebSocket(`${url.replace(/^http/, "ws")}${target}`, [SUBPROTOCOL])

      socket.onopen = () => Deferred.doneUnsafe(opened, Effect.succeed(true))
      socket.onclose = () => Deferred.doneUnsafe(opened, Effect.succeed(false))

      const accepted = yield* Deferred.await(opened).pipe(
        Effect.timeoutOption(edge.options.assertionLifetime),
        Effect.map(Option.getOrElse(() => false)),
      )

      if (!accepted) socket.close()

      return accepted ? Option.some(socket) : Option.none()
    })

  for (const url of routed.urls) {
    const connected = yield* connect(url)

    if (Option.isSome(connected)) {
      upstream = connected.value
      break
    }
  }

  if (upstream === undefined) return yield* end(unavailable("No runner accepted the socket"))

  const open = upstream
  open.binaryType = "arraybuffer"

  open.onmessage = (event: MessageEvent<string | ArrayBuffer>) =>
    ws.send(Predicate.isString(event.data) ? event.data : new Uint8Array(event.data))

  open.onclose = (event: CloseEvent) => {
    Queue.offerUnsafe(inbox, Inbound.Closed())
    ws.close(sendable(event.code), event.reason)
  }

  let greeting = first.data

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

  upstream.send(greeting)

  while (true) {
    const next = yield* take

    if (Inbound.$is("Closed")(next) || upstream.readyState !== WebSocket.OPEN) {
      upstream.close(1000)

      return
    }

    const message = Predicate.isString(next.data) ? decodeClient(next.data) : Option.none()

    if (Option.isNone(message) || message.value.t !== "reauthenticate") {
      while (upstream.bufferedAmount > edge.options.socketBufferBytes) yield* Effect.sleep(5)
      upstream.send(next.data)
      continue
    }

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
