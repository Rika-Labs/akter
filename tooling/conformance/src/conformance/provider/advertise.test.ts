import { createServer, type Server } from "node:net"
import { Config, Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import { BadAdvertised, parseAdvertised, unreachable } from "./advertise.ts"

const listening = () =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((socket) => socket.end())
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
    }),
    (server) => Effect.sync(() => server.close()),
  )

const portOf = (server: Server) => (server.address() as { port: number }).port

describe("advertised address parsing", () => {
  it("reads names, IPv4, and bracketed IPv6 hosts", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* parseAdvertised("runner-1.railway.internal:4000, 10.0.0.7:80,[fd12::7]:443"),
        ).toEqual([
          { host: "runner-1.railway.internal", port: 4000 },
          { host: "10.0.0.7", port: 80 },
          { host: "fd12::7", port: 443 },
        ])
      }),
    ))

  it("fails on an entry without a port, a port out of range, or an empty list", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const bad of ["runner-1", "runner-1:0", "runner-1:70000", "runner-1:x", "", " , "])
          expect(yield* Effect.flip(parseAdvertised(bad))).toBeInstanceOf(BadAdvertised)
      }),
    ))
})

describe("advertised address reachability", () => {
  it("reports exactly the addresses nothing accepts a connection on", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const up = yield* listening()
          const down = yield* listening()
          const closed = portOf(down)
          yield* Effect.callback<void>((resume) => {
            down.close(() => resume(Effect.void))
          })

          const missed = yield* unreachable(
            [
              { host: "127.0.0.1", port: portOf(up) },
              { host: "127.0.0.1", port: closed },
            ],
            "1 second",
          )

          expect(missed).toEqual([`127.0.0.1:${closed}`])
        }),
      ),
    ))
})

const advertised = Option.getOrUndefined(
  Effect.runSync(Config.option(Config.String("DURABLE_ADVERTISED_ADDRESSES"))),
)

/**
 * The Railway advertise-address gate. Run it from inside each replica's private
 * network (for example `railway run`) with every replica's advertised address
 * in `DURABLE_ADVERTISED_ADDRESSES`; a replica passes only when it reaches every
 * address, its own included.
 */
describe.skipIf(advertised === undefined || advertised === "")(
  "Railway advertise address (skipped when DURABLE_ADVERTISED_ADDRESSES is unset: needs a Railway deployment)",
  () => {
    it("reaches every advertised runner address from this replica", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const addresses = yield* parseAdvertised(advertised!)

          expect(yield* unreachable(addresses, "5 seconds")).toEqual([])
        }),
      ))
  },
)
