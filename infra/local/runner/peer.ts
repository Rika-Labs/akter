import { layerClientProtocol, layerSocketServer } from "@effect/platform-bun/BunClusterSocket"
import { Runner } from "@rikalabs/akter/runtime"
import { Effect, Layer } from "effect"
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
 * container's private address.
 */
export const peerRunner = Layer.unwrap(
  Effect.sync(() => {
    const host = privateAddress()

    return Runner.socket({
      address: { host, port: PEER_PORT },
      listenAddress: { host, port: PEER_PORT },
      transport: Layer.merge(layerSocketServer, layerClientProtocol),
    })
  }),
)
