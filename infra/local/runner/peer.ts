import { Runner } from "@rikalabs/akter/runtime"
import { Config, Effect, Layer } from "effect"
import { networkInterfaces } from "node:os"

/** The port runners reach each other on; it is never published outside the container network. */
export const PEER_PORT = 9000

/**
 * The container's own private IPv4 address, which peers use to reach this
 * runner directly. A loopback or wildcard address would send peers to
 * themselves.
 */
const privateAddress = () => {
  const found = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)

  if (found === undefined) throw new Error("no private IPv4 address to advertise to peer runners")

  return found.address
}

/**
 * Runner wiring shared by the served runner and the one-shot migration: the
 * public socket runner with default shard count and lock expiration, so every
 * process agrees on the layout the database records, advertising this
 * container's private address. Runners of every local deployment share one
 * Docker network, so peers authenticate with the certificate the local
 * platform issued this container for `RUNNER_PEER_DEPLOYMENT`, and refuse
 * any other deployment's runners.
 */
export const peerRunner = Layer.unwrap(
  Effect.gen(function* () {
    const host = privateAddress()
    const credentials = {
      ca: yield* Config.String("RUNNER_PEER_CA"),
      certificate: yield* Config.String("RUNNER_PEER_CERTIFICATE"),
      key: yield* Config.Redacted("RUNNER_PEER_KEY"),
    }

    return Runner.socket({
      address: { host, port: PEER_PORT },
      listenAddress: { host, port: PEER_PORT },
      transport: Runner.mtls({
        deployment: yield* Config.String("RUNNER_PEER_DEPLOYMENT"),
        credentials: Effect.succeed(credentials),
      }),
    })
  }),
)
