import * as Net from "node:net"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { endpointOf } from "./state.ts"

const Listening = Schema.Struct({ port: Schema.Finite })

describe("endpointOf", () => {
  it("strips the brackets from an IPv6 literal and keeps its port", () => {
    expect(endpointOf("postgresql://user:secret@[2001:db8::5]:6543/state")).toEqual({
      host: "2001:db8::5",
      port: 6543,
    })
    expect(endpointOf("postgresql://user:secret@[::1]/state")).toEqual({ host: "::1", port: 5432 })
    expect(endpointOf("postgresql://user:secret@db.example.test:7000/state")).toEqual({
      host: "db.example.test",
      port: 7000,
    })
  })

  it("gives Net.connect an address it dials", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.callback<Net.Server>((resume) => {
            const server = Net.createServer((socket) => socket.end())
            server.listen(0, "::1", () => resume(Effect.succeed(server)))
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void))
            }),
        )
        const { port } = yield* Schema.decodeUnknownEffect(Listening)(server.address())
        const connected = yield* Effect.callback<boolean>((resume) => {
          const socket = Net.connect(endpointOf(`postgresql://user:secret@[::1]:${port}/state`))
          socket.once("connect", () => {
            socket.destroy()
            resume(Effect.succeed(true))
          })
          socket.once("error", () => resume(Effect.succeed(false)))
        })
        expect(connected).toBe(true)
      }).pipe(Effect.scoped),
    ))
})
