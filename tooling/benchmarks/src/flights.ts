import { createServer, connect, type Socket, type AddressInfo } from "node:net"
import { Effect, type Scope } from "effect"

/**
 * A TCP relay in front of Postgres that counts flights: each time a client
 * writes after the server last answered it. One flight is one round trip the
 * client waited for, however many statements it carried.
 */
export interface FlightCounter {
  readonly port: number
  readonly reset: Effect.Effect<void>
  readonly flights: Effect.Effect<number>
}

/** Starts a `FlightCounter` relay to `upstream`, closed with the scope. */
export const flightCounter = (upstream: URL): Effect.Effect<FlightCounter, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<FlightCounter & { readonly close: () => void }>((resume) => {
      const sockets = new Set<Socket>()
      let flights = 0

      const server = createServer((client) => {
        const server = connect({ host: upstream.hostname, port: Number(upstream.port || 5432) })
        let answered = true
        sockets.add(client)
        sockets.add(server)
        client.setNoDelay(true)
        server.setNoDelay(true)

        client.on("data", (chunk: Buffer) => {
          if (answered) flights += 1
          answered = false
          server.write(chunk)
        })

        server.on("data", (chunk: Buffer) => {
          answered = true
          client.write(chunk)
        })

        const close = () => {
          client.destroy()
          server.destroy()
          sockets.delete(client)
          sockets.delete(server)
        }

        client.on("close", close)
        server.on("close", close)
        client.on("error", close)
        server.on("error", close)
      })

      server.listen(0, "127.0.0.1", () => {
        const address = server.address()

        resume(
          Effect.succeed({
            port: (address as AddressInfo).port,
            reset: Effect.sync(() => {
              flights = 0
            }),
            flights: Effect.sync(() => flights),
            close: () => {
              for (const socket of sockets) socket.destroy()
              server.close()
            },
          }),
        )
      })
    }),
    (counter) => Effect.sync(counter.close),
  )
