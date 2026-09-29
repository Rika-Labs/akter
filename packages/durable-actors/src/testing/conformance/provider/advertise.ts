import { connect } from "node:net"
import { Duration, Effect } from "effect"

/** A runner's advertised address, as `host:port`. */
export interface AdvertisedAddress {
  readonly host: string
  readonly port: number
}

/**
 * Parses a comma-separated list of `host:port`, where `host` may be a name,
 * an IPv4 address, or a bracketed IPv6 address. A malformed entry fails
 * instead of being dropped, so a typo cannot pass as "every address reached".
 */
export const parseAdvertised = (
  list: string,
): Effect.Effect<ReadonlyArray<AdvertisedAddress>, Error> =>
  Effect.forEach(
    list
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
    (entry) => {
      const match = /^(\[[0-9a-fA-F:.]+\]|[^:\s[\]]+):(\d{1,5})$/.exec(entry)
      const port = Number(match?.[2])

      return match === null || port < 1 || port > 65_535
        ? Effect.fail(new Error(`"${entry}" is not host:port`))
        : Effect.succeed({ host: match[1]!.replace(/^\[|\]$/g, ""), port })
    },
  ).pipe(
    Effect.filterOrFail(
      (addresses) => addresses.length > 0,
      () => new Error("No advertised address given"),
    ),
  )

/**
 * Opens a TCP connection to `address` and reports whether it was accepted
 * within `timeout`. It proves the address routes to a listener from where this
 * process runs; it says nothing about what listens there.
 */
export const canConnect = (address: AdvertisedAddress, timeout: Duration.Input) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ host: address.host, port: address.port })
    const finish = (reached: boolean) => {
      socket.destroy()
      resume(Effect.succeed(reached))
    }

    socket.setTimeout(Duration.toMillis(Duration.fromInputUnsafe(timeout)))
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))

    return Effect.sync(() => socket.destroy())
  })

/** The `host:port` of every address this process cannot connect to. */
export const unreachable = (addresses: ReadonlyArray<AdvertisedAddress>, timeout: Duration.Input) =>
  Effect.forEach(
    addresses,
    (address) =>
      Effect.map(canConnect(address, timeout), (reached) =>
        reached ? [] : [`${address.host}:${address.port}`],
      ),
    { concurrency: 8 },
  ).pipe(Effect.map((missed) => missed.flat()))
