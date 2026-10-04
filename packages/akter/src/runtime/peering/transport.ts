import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer"
import { constants, createPrivateKey, X509Certificate } from "node:crypto"
import { connect, createSecureContext, type TLSSocket } from "node:tls"
import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Scope } from "effect"
import { type RunnerAddress, Runners, ShardingConfig } from "effect/cluster"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket, SocketServer } from "effect/socket"
import { identity, type RunnerCredentials } from "./credentials.ts"

/**
 * Whether a verified peer certificate belongs to the deployment `expected`
 * names: its subject alternative names are exactly that one URI, so no
 * extra name, Akter identity or otherwise, rides along.
 */
const belongs = (peer: { readonly subjectaltname?: string } | undefined, expected: string) =>
  peer?.subjectaltname === `URI:${expected}`

const certificates = (pem: string) =>
  (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu) ?? []).map(
    (block) => new X509Certificate(block),
  )

const issued = (certificate: X509Certificate, by: X509Certificate) =>
  certificate.checkIssued(by) && certificate.verify(by.publicKey)

/**
 * Checks credentials before any peer sees them and builds the TLS context
 * that presents them, so a runner refuses to start, or keeps its previous
 * credentials, rather than present a certificate its peers would refuse:
 * one for another deployment, one outside its validity window, one its key
 * does not match, or one no trusted authority issued. Session tickets are
 * off, so every connection runs a full handshake and its peer's chain and
 * validity are checked again rather than resumed from an earlier session.
 */
const prepare = (credentials: RunnerCredentials, expected: string, now: number) => {
  const authorities = certificates(credentials.ca)
  const chain = certificates(credentials.certificate)
  const leaf = chain[0]

  if (authorities.length === 0 || authorities.some((authority) => !authority.ca))
    throw new Error("Runner credentials need at least one certificate authority in ca")

  if (leaf === undefined) throw new Error("Runner credentials need a certificate")

  if (!belongs({ subjectaltname: leaf.subjectAltName }, expected))
    throw new Error(`Runner certificate must name only the identity ${expected}`)

  if (now < Date.parse(leaf.validFrom) || now > Date.parse(leaf.validTo))
    throw new Error(`Runner certificate is valid only from ${leaf.validFrom} to ${leaf.validTo}`)

  if (!leaf.checkPrivateKey(createPrivateKey(Redacted.value(credentials.key))))
    throw new Error("Runner key does not match its certificate")

  for (const [index, certificate] of chain.entries()) {
    const next = chain[index + 1]

    if (
      next === undefined
        ? !authorities.some((authority) => issued(certificate, authority))
        : !issued(certificate, next)
    )
      throw new Error("Runner certificate is not issued by a certificate authority in ca")
  }

  return {
    context: createSecureContext({
      ca: credentials.ca,
      cert: credentials.certificate,
      key: Redacted.value(credentials.key),
      minVersion: "TLSv1.3",
      secureOptions: constants.SSL_OP_NO_TICKET,
    }),
    expires: Date.parse(leaf.validTo),
  }
}

/**
 * Whether this runner can still peer: false once its current certificate has
 * expired, or once no credential load has succeeded for longer than the
 * transport's `unhealthyAfter`. Readiness reports `peering` while it is false.
 */
export class PeerHealth extends Context.Service<
  PeerHealth,
  { readonly healthy: Effect.Effect<boolean> }
>()("@rikalabs/akter/runtime/peering/transport/PeerHealth") {}

/** Peer transport options for `Runner.mtls`. */
export interface MutualTlsOptions<E> {
  /** The deployment every peer must belong to; its identity is `Runner.identity(deployment)`. */
  readonly deployment: string
  /**
   * Reads this runner's credentials. It runs once before the listener opens
   * and again every `refreshEvery`, so replacing what it reads rotates the
   * certificate, key, or trusted authorities without a restart.
   */
  readonly credentials: Effect.Effect<RunnerCredentials, E>
  /** Default 1 minute. */
  readonly refreshEvery?: Duration.Input
  /** How long one credential load may take before it counts as failed. Default 10 seconds. */
  readonly refreshTimeout?: Duration.Input
  /**
   * How long loads may keep failing, or hanging, before readiness reports
   * `peering`. Default 5 minutes. An expired current certificate reports
   * `peering` at once.
   */
  readonly unhealthyAfter?: Duration.Input
}

/**
 * Every client names the same server, so the listener picks the current
 * credentials through its SNI callback whatever address the peer dialled.
 */
const SERVER_NAME = "runner.akter.internal"

/**
 * Runner-to-runner TCP with mutual TLS 1.3. Each side presents its
 * deployment's certificate and accepts a peer only when the peer's chain
 * reaches a trusted authority, is within its validity window, and carries
 * exactly this deployment's identity; a plaintext peer, a peer without a
 * certificate, and a peer of another deployment never reach the runner's RPC
 * handler. Credentials are reloaded every `refreshEvery`: new connections use
 * the latest valid ones, established connections keep the session they
 * authenticated, and credentials that fail validation are logged and
 * ignored while the previous ones stay in use. A runner whose certificate has
 * expired, or whose loads have failed for `unhealthyAfter`, stops reporting
 * ready.
 */
export const mtls = <E>(options: MutualTlsOptions<E>) => {
  const expected = identity(options.deployment)
  const duration = (value: Duration.Input, name: string) => {
    const result = Duration.fromInputUnsafe(value)

    if (!Number.isFinite(Duration.toMillis(result)) || Duration.toMillis(result) < 1)
      throw new Error(`${name} must be finite and at least 1 millisecond`)

    return result
  }
  const refreshEvery = duration(options.refreshEvery ?? "1 minute", "refreshEvery")
  const refreshTimeout = duration(options.refreshTimeout ?? "10 seconds", "refreshTimeout")
  const unhealthyAfter = duration(options.unhealthyAfter ?? "5 minutes", "unhealthyAfter")

  return Layer.effectContext(
    Effect.gen(function* () {
      const load = Effect.flatMap(options.credentials, (credentials) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => ({ ...prepare(credentials, expected, now), loaded: now })),
        ),
      ).pipe(
        Effect.timeoutOrElse({
          duration: refreshTimeout,
          orElse: () =>
            Effect.die(
              new Error(
                `Runner peer credentials took longer than ${Duration.toMillis(refreshTimeout)} ms`,
              ),
            ),
        }),
      )

      let current = yield* load.pipe(Effect.orDie)

      yield* load.pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            current = next
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Runner peer credentials were not reloaded; keeping the current ones",
            cause,
          ),
        ),
        Effect.delay(refreshEvery),
        Effect.forever,
        Effect.forkScoped,
      )

      const health = PeerHealth.of({
        healthy: Effect.map(
          Clock.currentTimeMillis,
          (now) =>
            now <= current.expires && now - current.loaded <= Duration.toMillis(unhealthyAfter),
        ),
      })

      const config = yield* ShardingConfig.ShardingConfig
      const listen = Option.orElse(config.runnerListenAddress, () => config.runnerAddress)

      if (Option.isNone(listen))
        return yield* Effect.die(new Error("Runner.mtls needs a runner listen address"))

      const server = yield* NodeSocketServer.makeTls({
        host: listen.value.host,
        port: listen.value.port,
        minVersion: "TLSv1.3",
        requestCert: true,
        rejectUnauthorized: true,
        secureOptions: constants.SSL_OP_NO_TICKET,
        SNICallback: (_name, done) => done(null, current.context),
      })

      const accepted = (socket: TLSSocket) =>
        socket.authorized &&
        !socket.isSessionReused() &&
        belongs(socket.getPeerCertificate(), expected)

      /**
       * Opens one connection with the credentials current at that moment.
       * The handshake stays interruptible, so the reader's open timeout
       * abandons a listener that never answers it, such as a plaintext peer.
       */
      const open = (address: RunnerAddress.RunnerAddress) =>
        Effect.gen(function* () {
          let socket: TLSSocket | undefined
          let secured = false

          yield* Scope.addFinalizer(
            yield* Effect.scope,
            Effect.sync(() => (secured ? socket?.destroySoon() : socket?.destroy())),
          )

          return yield* Effect.callback<TLSSocket, Socket.SocketError>((resume) => {
            socket = connect({
              host: address.host,
              port: address.port,
              servername: SERVER_NAME,
              secureContext: current.context,
              rejectUnauthorized: true,
              checkServerIdentity: (_host, peer) =>
                belongs(peer, expected)
                  ? undefined
                  : new Error(
                      `Peer at ${address.host}:${address.port} is not a runner of ${expected}`,
                    ),
            })
            const opened = socket

            const refuse = (cause: Error) =>
              resume(
                Effect.fail(
                  Socket.SocketError.make({
                    reason: Socket.SocketOpenError.make({ kind: "Unknown", cause }),
                  }),
                ),
              )

            opened.once("secureConnect", () => {
              if (!accepted(opened)) {
                opened.destroy()

                return refuse(
                  new Error(
                    `Peer at ${address.host}:${address.port} is not a runner of ${expected}`,
                  ),
                )
              }

              secured = true
              resume(Effect.succeed(opened))
            })
            opened.once("error", refuse)
          })
        })

      const serialization = yield* RpcSerialization.RpcSerialization

      return Context.make(
        SocketServer.SocketServer,
        SocketServer.SocketServer.of({
          address: server.address,
          run: (handler) =>
            server.run((socket) =>
              Effect.gen(function* () {
                const connection = Option.getOrUndefined(
                  yield* Effect.serviceOption(NodeSocket.NetSocket),
                ) as TLSSocket | undefined

                if (connection !== undefined && accepted(connection)) return yield* handler(socket)

                connection?.destroy()
              }),
            ),
        }),
      ).pipe(
        Context.add(
          Runners.RpcClientProtocol,
          Runners.RpcClientProtocol.of({
            codecFor: serialization.codecFor,
            make: Effect.fnUntraced(function* (address) {
              const socket = yield* NodeSocket.fromDuplex(open(address), { openTimeout: 1000 })

              return yield* RpcClient.makeProtocolSocket().pipe(
                Effect.provideService(Socket.Socket, socket),
                Effect.provideService(RpcSerialization.RpcSerialization, serialization),
              )
            }, Effect.orDie),
          }),
        ),
        Context.add(PeerHealth, health),
      )
    }),
  )
}
