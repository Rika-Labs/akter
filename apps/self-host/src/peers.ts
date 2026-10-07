import { connect as plainConnect } from "node:net"
import { connect as tlsConnect } from "node:tls"
import { Console, Effect, FileSystem, Schema } from "effect"

class PeerCheckFailed extends Schema.TaggedError<PeerCheckFailed>()("PeerCheckFailed", {
  cause: Schema.Defect(),
}) {}

const peers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const ca = yield* fs.readFileString("/run/secrets/ca.pem")
  const cert = yield* fs.readFileString("/run/secrets/certificate.pem")
  const key = yield* fs.readFileString("/run/secrets/key.pem")
  yield* Effect.callback<void, PeerCheckFailed>((resume) => {
    const socket = tlsConnect(
      {
        host: "runner-b",
        port: 9000,
        ca,
        cert,
        key,
        minVersion: "TLSv1.3",
        servername: "runner-b",
        checkServerIdentity: (_host, peer) =>
          peer.subjectaltname === "URI:spiffe://akter/deployment/self-host"
            ? undefined
            : new Error("Peer identity does not match deployment"),
      },
      () => {
        const verified = socket.authorized && socket.getProtocol() === "TLSv1.3"
        socket.destroy()
        if (!verified) {
          resume(
            Effect.fail(
              PeerCheckFailed.make({ cause: new Error("Authenticated TLS 1.3 handshake failed") }),
            ),
          )
          return
        }
        resume(Effect.void)
      },
    )
    socket.once("error", (cause) => resume(Effect.fail(PeerCheckFailed.make({ cause }))))
    return Effect.sync(() => {
      socket.destroy()
    })
  }).pipe(Effect.timeout("3 seconds"))
  yield* Effect.callback<void, PeerCheckFailed>((resume) => {
    const socket = plainConnect({ host: "runner-b", port: 9000 }, () => {
      socket.write("GET / HTTP/1.1\r\nHost: runner-b\r\n\r\n")
    })
    socket.once("data", () =>
      resume(
        Effect.fail(
          PeerCheckFailed.make({ cause: new Error("Plaintext peer received application data") }),
        ),
      ),
    )
    socket.once("end", () => {
      socket.destroy()
      resume(Effect.void)
    })
    socket.once("error", (cause) => {
      if ("code" in cause && cause.code === "ECONNRESET") resume(Effect.void)
      else resume(Effect.fail(PeerCheckFailed.make({ cause })))
    })
    return Effect.sync(() => {
      socket.destroy()
    })
  }).pipe(Effect.timeout("3 seconds"))
  yield* Console.log(
    "PEERS_OK authenticated TLS 1.3 accepted; plaintext peer refused without application bytes",
  )
})

const services =
  typeof Bun === "undefined"
    ? (await import("@effect/platform-node")).NodeServices.layer
    : (await import("@effect/platform-bun")).BunServices.layer

await Effect.runPromise(peers.pipe(Effect.provide(services)))
