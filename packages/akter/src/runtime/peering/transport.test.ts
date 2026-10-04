import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { connect as connectTcp, createServer as createTcpServer, type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { connect, createServer, type ConnectionOptions, type TLSSocket } from "node:tls"
import { DateTime, type Duration, Effect, Layer, Option, Redacted } from "effect"
import { RunnerAddress, Runners, ShardingConfig } from "effect/cluster"
import { RpcMessage, RpcSerialization } from "effect/rpc"
import { Socket, SocketServer } from "effect/socket"
import { describe, expect, it } from "vitest"
import { Runner } from "../runner.ts"
import { PeerHealth } from "./transport.ts"
import { RunnerAuthority } from "./authority.ts"
import type { RunnerCredentials } from "./credentials.ts"

const DEPLOYMENT = "deployment-a"

const decoder = new TextDecoder()

/**
 * One runner's transport on a loopback port, with credentials the test can
 * replace while it runs and a server handler that echoes and counts every
 * connection it is handed.
 */
const runner = Effect.fnUntraced(function* (
  initial: RunnerCredentials,
  options?: {
    readonly refreshTimeout?: Duration.Input
    readonly unhealthyAfter?: Duration.Input
  },
) {
  const state = {
    credentials: initial,
    hang: false,
    accepted: 0,
    frames: [] as Array<string>,
  }
  const context = yield* Layer.build(
    Runner.mtls({
      deployment: DEPLOYMENT,
      credentials: Effect.suspend(() =>
        state.hang ? Effect.never : Effect.succeed(state.credentials),
      ),
      refreshEvery: "50 millis",
      ...options,
    }).pipe(
      Layer.provide(
        ShardingConfig.layer({
          runnerAddress: Option.some(
            RunnerAddress.RunnerAddress.make({ host: "127.0.0.1", port: 1 }),
          ),
          runnerListenAddress: Option.some(
            RunnerAddress.RunnerAddress.make({ host: "127.0.0.1", port: 0 }),
          ),
        }),
      ),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
  )
  const server = yield* SocketServer.SocketServer.pipe(Effect.provideContext(context))
  const clients = yield* Runners.RpcClientProtocol.pipe(Effect.provideContext(context))
  const health = yield* PeerHealth.pipe(Effect.provideContext(context))
  yield* server
    .run((socket) =>
      Effect.gen(function* () {
        state.accepted += 1
        const pull = yield* Socket.readerBytes(socket)
        const writer = yield* socket.writer

        while (true) {
          const frames = yield* pull
          for (const frame of frames) state.frames.push(decoder.decode(frame))
          yield* writer.writeAll(frames)
        }
      }).pipe(Effect.scoped, Effect.ignore),
    )
    .pipe(Effect.forkScoped)
  const port = "port" in server.address ? server.address.port : 0

  return { state, port, clients, health }
})

/**
 * One set of credentials per entry of `names`, each leaf naming those
 * subject alternative names, all issued with the system `openssl` by one
 * throwaway authority: shapes `RunnerAuthority` never issues.
 */
const crafted = (...names: ReadonlyArray<string>): Array<RunnerCredentials> => {
  const directory = mkdtempSync(`${tmpdir()}/akter-peering-`)
  const run = (...args: Array<string>) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "pipe" })
  const read = (name: string) => readFileSync(`${directory}/${name}`, "utf8")

  try {
    run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key")
    run(
      "req",
      "-x509",
      "-new",
      "-key",
      "ca.key",
      "-sha256",
      "-days",
      "2",
      "-subj",
      "/CN=crafted",
      "-out",
      "ca.pem",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    )

    return names.map((san, index) => {
      run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${index}.ec`)
      run("pkcs8", "-topk8", "-nocrypt", "-in", `${index}.ec`, "-out", `${index}.key`)
      run("req", "-new", "-key", `${index}.key`, "-subj", "/CN=leaf", "-out", `${index}.csr`)
      writeFileSync(
        `${directory}/${index}.ext`,
        `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=${san}\n`,
      )
      run(
        "x509",
        "-req",
        "-in",
        `${index}.csr`,
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-days",
        "1",
        "-sha256",
        "-extfile",
        `${index}.ext`,
        "-out",
        `${index}.pem`,
      )

      return {
        ca: read("ca.pem"),
        certificate: read(`${index}.pem`),
        key: Redacted.make(read(`${index}.key`)),
      }
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Resolves with `opened` once a raw TLS client finishes its side of the handshake, or with `ended` if it never does. */
const handshake = (port: number, options: ConnectionOptions) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly socket: TLSSocket; readonly ended: () => boolean }>((resume) => {
      let ended = false
      const socket = connect({
        host: "127.0.0.1",
        port,
        servername: "runner.akter.internal",
        checkServerIdentity: () => undefined,
        ...options,
      })
      socket.on("error", () => undefined)
      socket.once("close", () => {
        ended = true
        resume(Effect.succeed({ socket, ended: () => true }))
      })
      socket.once("secureConnect", () => resume(Effect.succeed({ socket, ended: () => ended })))
    }),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  )

/** `echo` when the runner served a raw TLS client, `refused` when either side ended the session first. */
const attempt = (port: number, options: ConnectionOptions) =>
  Effect.gen(function* () {
    const { socket, ended } = yield* handshake(port, options)

    if (ended()) return "refused"

    return yield* Effect.callback<"echo" | "refused">((resume) => {
      socket.once("data", (data) =>
        resume(Effect.succeed(String(data) === "ping" ? "echo" : "refused")),
      )
      socket.once("close", () => resume(Effect.succeed("refused")))
      socket.write("ping")
    })
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption("3 seconds"),
    Effect.map(Option.getOrElse(() => "refused")),
  )

const presenting = (credentials: RunnerCredentials, ca = credentials.ca): ConnectionOptions => ({
  ca,
  cert: credentials.certificate,
  key: Redacted.value(credentials.key),
})

const expired = (authority: RunnerAuthority) =>
  Effect.flatMap(DateTime.now, (now) =>
    authority.issue({
      deployment: DEPLOYMENT,
      notBefore: DateTime.subtract(now, { days: 2 }),
      validFor: "1 day",
    }),
  )

/** A loopback listener the test controls, recording what reaches it. */
const listener = <A>(make: (heard: Array<A>) => ReturnType<typeof createTcpServer>) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly port: number
      readonly heard: Array<A>
      readonly close: () => void
    }>((resume) => {
      const heard: Array<A> = []
      const server = make(heard)
      server.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            port: (server.address() as AddressInfo).port,
            heard,
            close: () => server.close(),
          }),
        ),
      )
    }),
    ({ close }) => Effect.sync(close),
  )

const settle = Effect.sleep("300 millis")

/**
 * Sets the process-wide switch that tells Node and Bun TLS clients not to
 * verify servers, which an operator may set for unrelated outbound calls.
 */
const disableVerification = () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
}

const restoreVerification = () => {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
}

describe("runner mutual TLS", () => {
  it("serves only peers of its own deployment with an unexpired certificate from a trusted authority", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* RunnerAuthority.make()
        const stranger = yield* RunnerAuthority.make()
        const own = yield* authority.issue({ deployment: DEPLOYMENT })
        const target = yield* runner(own)

        expect(yield* attempt(target.port, presenting(own))).toBe("echo")
        expect(target.state.accepted).toBe(1)

        expect(yield* attempt(target.port, { ca: own.ca })).toBe("refused")
        expect(
          yield* attempt(
            target.port,
            presenting(yield* stranger.issue({ deployment: DEPLOYMENT }), own.ca),
          ),
        ).toBe("refused")
        expect(
          yield* attempt(
            target.port,
            presenting(yield* authority.issue({ deployment: "deployment-b" })),
          ),
        ).toBe("refused")
        expect(yield* attempt(target.port, presenting(yield* expired(authority)))).toBe("refused")
        expect(target.state.accepted).toBe(1)

        const plaintext = yield* Effect.callback<string>((resume) => {
          let received = ""
          const socket = connectTcp(target.port, "127.0.0.1", () =>
            socket.write('{"_tag":"Ping"}\n'),
          )
          socket.on("data", (data) => {
            received += String(data)
          })
          socket.on("error", () => undefined)
          socket.once("close", () => resume(Effect.succeed(received)))
        })
        expect(plaintext).not.toContain("Ping")
        expect(target.state.accepted).toBe(1)
        expect(target.state.frames).toEqual(["ping"])
      }).pipe(Effect.scoped),
    ))

  for (const insecure of [false, true])
    it(`refuses to send to a listener that is not a runner of its deployment${insecure ? ", even with NODE_TLS_REJECT_UNAUTHORIZED=0" : ""}`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const authority = yield* RunnerAuthority.make()
          const stranger = yield* RunnerAuthority.make()
          const caller = yield* runner(yield* authority.issue({ deployment: DEPLOYMENT }))
          const [own, extra] = crafted(
            `URI:${Runner.identity(DEPLOYMENT)}`,
            `URI:${Runner.identity(DEPLOYMENT)},DNS:runner.akter.internal`,
          )
          const strict = yield* runner(own!)

          if (insecure)
            yield* Effect.acquireRelease(Effect.sync(disableVerification), () =>
              Effect.sync(restoreVerification),
            )

          const impostor = (credentials: RunnerCredentials) =>
            listener<string>((heard) => {
              const server = createServer({
                cert: credentials.certificate,
                key: Redacted.value(credentials.key),
              })
              server.on("secureConnection", (socket) =>
                socket.on("data", (data) => heard.push(String(data))),
              )
              server.on("tlsClientError", () => undefined)

              return server
            })

          const plaintext = yield* listener<Uint8Array>((heard) =>
            createTcpServer((socket) => socket.on("data", (data) => heard.push(Buffer.from(data)))),
          )

          const send = (from: Effect.Success<ReturnType<typeof runner>>, port: number) =>
            Effect.gen(function* () {
              const protocol = yield* from.clients.make(
                RunnerAddress.RunnerAddress.make({ host: "127.0.0.1", port }),
              )
              yield* settle
              yield* protocol
                .send(0, RpcMessage.constPing)
                .pipe(Effect.timeout("1 second"), Effect.ignore)
              yield* settle
            }).pipe(Effect.scoped)

          const impostors = [
            yield* impostor(yield* authority.issue({ deployment: "deployment-b" })),
            yield* impostor(yield* stranger.issue({ deployment: DEPLOYMENT })),
            yield* impostor(yield* expired(authority)),
          ]

          for (const { port } of [...impostors, plaintext]) yield* send(caller, port)

          const unlisted = yield* impostor(extra!)
          yield* send(strict, unlisted.port)

          expect(impostors.map(({ heard }) => heard)).toEqual([[], [], []])
          expect(unlisted.heard).toEqual([])
          expect(plaintext.heard.length).toBeGreaterThan(0)
          expect(plaintext.heard.every((data) => data[0] === 0x16)).toBe(true)
          expect(decoder.decode(Buffer.concat(plaintext.heard))).not.toContain("Ping")

          const peer = yield* runner(yield* authority.issue({ deployment: DEPLOYMENT }))
          yield* send(caller, peer.port)
          expect(peer.state.accepted).toBe(1)
          expect(peer.state.frames.join("")).toContain('"_tag":"Ping"')
        }).pipe(Effect.scoped),
      ))

  it("refuses a peer whose certificate names anything besides its identity", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const identity = `URI:${Runner.identity(DEPLOYMENT)}`
        const [own, ...others] = crafted(
          identity,
          `${identity},DNS:runner.akter.internal`,
          `${identity},URI:${Runner.identity("deployment-b")}`,
          `${identity},email:ops@example.com`,
          `DNS:spiffe://akter/deployment/${DEPLOYMENT}`,
        )
        const target = yield* runner(own!)

        expect(yield* attempt(target.port, presenting(own!))).toBe("echo")
        for (const other of others)
          expect(yield* attempt(target.port, presenting(other, own!.ca))).toBe("refused")
        expect(target.state.accepted).toBe(1)

        for (const other of others) {
          const exit = yield* Effect.exit(runner(other).pipe(Effect.scoped))
          expect(String(exit)).toContain("must name only the identity")
        }
      }).pipe(Effect.scoped),
    ))

  it("never resumes a session, so a ticket from a removed authority reaches no handler", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const outgoing = yield* RunnerAuthority.make()
        const incoming = yield* RunnerAuthority.make()
        const old = yield* outgoing.issue({ deployment: DEPLOYMENT })
        const target = yield* runner(old)
        const sessions: Array<Buffer> = []

        const { socket } = yield* handshake(target.port, presenting(old))
        socket.on("session", (session) => sessions.push(session))
        yield* Effect.callback<void>((resume) => {
          socket.once("data", () => resume(Effect.void))
          socket.write("ping")
        })
        yield* settle

        target.state.credentials = yield* incoming.issue({ deployment: DEPLOYMENT })
        yield* settle
        const before = target.state.accepted
        const ca = `${old.ca}${incoming.certificate}`
        const resumed = [
          ...(yield* Effect.forEach(sessions, (session) => attempt(target.port, { ca, session }))),
          yield* attempt(target.port, { ca }),
        ]

        expect(resumed.every((result) => result === "refused")).toBe(true)
        expect(target.state.accepted).toBe(before)
      }).pipe(Effect.scoped),
    ))

  it("stops reporting healthy once its certificate expires", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* RunnerAuthority.make()
        const target = yield* runner(
          yield* authority.issue({
            deployment: DEPLOYMENT,
            notBefore: yield* DateTime.now,
            validFor: "2 seconds",
          }),
        )

        expect(yield* target.health.healthy).toBe(true)
        yield* Effect.sleep("2500 millis")
        expect(yield* target.health.healthy).toBe(false)

        target.state.credentials = yield* authority.issue({ deployment: DEPLOYMENT })
        yield* settle
        expect(yield* target.health.healthy).toBe(true)
      }).pipe(Effect.scoped),
    ))

  it("times out a hanging credential load and reports unhealthy once loads keep failing past the bound", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* RunnerAuthority.make()
        const own = yield* authority.issue({ deployment: DEPLOYMENT })
        const target = yield* runner(own, {
          refreshTimeout: "100 millis",
          unhealthyAfter: "800 millis",
        })

        target.state.hang = true
        yield* Effect.sleep("400 millis")
        expect(yield* target.health.healthy).toBe(true)
        yield* Effect.sleep("900 millis")
        expect(yield* target.health.healthy).toBe(false)
        expect(yield* attempt(target.port, presenting(own))).toBe("echo")

        target.state.hang = false
        yield* Effect.sleep("400 millis")
        expect(yield* target.health.healthy).toBe(true)

        target.state.credentials = { ...own, ca: "" }
        yield* Effect.sleep("1200 millis")
        expect(yield* target.health.healthy).toBe(false)

        const stuck = yield* Effect.exit(
          Layer.build(
            Runner.mtls({
              deployment: DEPLOYMENT,
              credentials: Effect.never,
              refreshTimeout: "100 millis",
            }).pipe(
              Layer.provide(
                ShardingConfig.layer({
                  runnerAddress: Option.some(
                    RunnerAddress.RunnerAddress.make({ host: "127.0.0.1", port: 0 }),
                  ),
                }),
              ),
              Layer.provide(RpcSerialization.layerNdjson),
            ),
          ).pipe(Effect.scoped, Effect.timeoutOption("2 seconds")),
        )
        expect(String(stuck)).toContain("took longer than")
      }).pipe(Effect.scoped),
    ))

  it("rotates its authority, certificate and key in place without dropping an established session", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const outgoing = yield* RunnerAuthority.make()
        const incoming = yield* RunnerAuthority.make()
        const both = `${outgoing.certificate}${incoming.certificate}`
        const old = yield* outgoing.issue({ deployment: DEPLOYMENT })
        const renewed = yield* incoming.issue({ deployment: DEPLOYMENT })
        const target = yield* runner(old)

        const { socket: established } = yield* handshake(target.port, presenting(old))
        const echo = (text: string) =>
          Effect.callback<string>((resume) => {
            established.once("data", (data) => resume(Effect.succeed(String(data))))
            established.write(text)
          })
        expect(yield* echo("before")).toBe("before")

        target.state.credentials = { ...old, ca: both }
        yield* settle
        expect(yield* attempt(target.port, presenting(renewed, both))).toBe("echo")
        expect(yield* attempt(target.port, presenting(old))).toBe("echo")

        target.state.credentials = { ...renewed, ca: both }
        yield* settle
        expect(yield* attempt(target.port, presenting(old))).toBe("refused")
        expect(yield* attempt(target.port, presenting(old, both))).toBe("echo")

        target.state.credentials = renewed
        yield* settle
        expect(yield* attempt(target.port, presenting(old, both))).toBe("refused")
        expect(yield* attempt(target.port, presenting(renewed))).toBe("echo")

        target.state.credentials = yield* incoming.issue({ deployment: "deployment-b" })
        yield* settle
        target.state.credentials = {
          ...renewed,
          key: (yield* incoming.issue({ deployment: DEPLOYMENT })).key,
        }
        yield* settle
        expect(yield* attempt(target.port, presenting(renewed))).toBe("echo")

        expect(yield* echo("after")).toBe("after")
        expect(target.state.accepted).toBe(6)
      }).pipe(Effect.scoped),
    ))

  it("dials with the credentials current at each connection", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const outgoing = yield* RunnerAuthority.make()
        const incoming = yield* RunnerAuthority.make()
        const caller = yield* runner(yield* outgoing.issue({ deployment: DEPLOYMENT }))
        const target = yield* runner(yield* incoming.issue({ deployment: DEPLOYMENT }))
        const dial = Effect.gen(function* () {
          const protocol = yield* caller.clients.make(
            RunnerAddress.RunnerAddress.make({ host: "127.0.0.1", port: target.port }),
          )
          yield* settle
          yield* protocol
            .send(0, RpcMessage.constPing)
            .pipe(Effect.timeout("1 second"), Effect.ignore)
          yield* settle
        }).pipe(Effect.scoped)

        yield* dial
        expect(target.state.accepted).toBe(0)

        caller.state.credentials = yield* incoming.issue({ deployment: DEPLOYMENT })
        yield* settle
        yield* dial
        expect(target.state.accepted).toBe(1)
      }).pipe(Effect.scoped),
    ))

  it("refuses to start with credentials for another deployment, expired, mismatched, or from an untrusted authority", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* RunnerAuthority.make()
        const stranger = yield* RunnerAuthority.make()
        const own = yield* authority.issue({ deployment: DEPLOYMENT })
        const refusals = [
          [yield* authority.issue({ deployment: "deployment-b" }), "identity"],
          [yield* expired(authority), "valid only"],
          [{ ...own, key: (yield* authority.issue({ deployment: DEPLOYMENT })).key }, "key"],
          [{ ...own, ca: stranger.certificate }, "not issued"],
          [{ ...own, ca: "" }, "certificate authority"],
        ] as const

        for (const [credentials, reason] of refusals) {
          const exit = yield* Effect.exit(runner(credentials).pipe(Effect.scoped))
          expect(exit._tag).toBe("Failure")
          expect(String(exit)).toContain(reason)
        }

        expect(() => Runner.mtls({ deployment: "a/b", credentials: Effect.succeed(own) })).toThrow(
          "Runner deployment",
        )
      }).pipe(Effect.scoped),
    ))
})
