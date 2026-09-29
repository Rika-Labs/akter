import { Actor, Unauthorized, User } from "@durable-actors/core"
import { Effect, Option } from "effect"
import { Headers } from "effect/unstable/http"
import { Room } from "./room/contract.ts"

// A stand-in for a real identity provider: the bearer token is the user's name. Use Actor.auth.jwt in production.
// A browser's WebSocket can't send headers, so a connection's `hello` frame carries it as `credential`.
export const demoAuth = Actor.auth.make((request) =>
  Option.match(
    request.credential === undefined
      ? Headers.get(request.headers, "authorization")
      : Option.some(request.credential),
    {
      onNone: () => Effect.fail(Unauthorized.make({ code: "missing_credentials" })),
      onSome: (header) => {
        const match = /^Bearer ([a-z0-9-]{1,64})$/.exec(header)

        return match === null
          ? Effect.fail(Unauthorized.make({ code: "invalid_credentials" }))
          : Effect.succeed({ tenant: "chat-demo", caller: User.make({ subject: match[1]! }) })
      },
    },
  ),
)

/** The chat server's HTTP routes: Room over Actor.serve, plus its OpenAPI document. */
export const routes = Actor.serve({
  actors: [Room],
  auth: demoAuth,
  openapi: { path: "/openapi.json", title: "Chat" },
})
