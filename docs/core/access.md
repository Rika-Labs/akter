# Access

Two checks decide whether a request gets through. The server's authentication provider works out **who is calling**, once per request or connection. Each actor's `access` function decides **what that caller may do**.

## Who is calling

Every handler sees a `caller`, which is one of three things:

| Caller                                    | Who it is                                                     |
| ----------------------------------------- | ------------------------------------------------------------- |
| `User { subject }`                        | A signed-in person or service, identified by `subject`        |
| `Anonymous`                               | A request without credentials                                 |
| `System { source, subject, onBehalfOf? }` | Akter itself, delivering a send, timer, cron tick or job call |

A `System` caller's `source` says which mechanism made the call (`send`, `timer`, `cron`, `job`, `operator` or `process`), and `onBehalfOf` carries the subject of the user whose command started the chain, when there was one.

## Authentication

`Akter.serve` takes an `auth` provider. For tokens from an identity provider, use `Auth.jwt`:

```ts
import { Auth } from "@rikalabs/akter/server"

export const auth = Auth.jwt({
  issuer: "https://login.example.com/",
  audience: "my-app",
  jwks: new URL("https://login.example.com/.well-known/jwks.json"),
  tenant: () => "default",
})
```

It verifies the bearer token's signature, issuer, audience and expiry, and makes the caller a `User` whose subject is the token's `sub` claim. Pass `subject` to read it from another claim.

To check credentials your own way, use `Auth.make`. It receives the request's headers and cookies, and returns the caller or fails with `Unauthorized`:

```ts
const auth = Auth.make((request) => {
  const token = request.headers["authorization"]?.replace("Bearer ", "")
  const subject = token === undefined ? undefined : sessions.get(token)
  return subject === undefined
    ? Effect.succeed({ caller: anonymous, tenant: "default" })
    : Effect.succeed({ caller: User.make({ subject }), tenant: "default" })
})
```

`Auth.none` makes every caller `Anonymous`. It's what `akter dev` uses.

### Cookies

`Auth.jwt` and a plain `Auth.make` function read the `authorization: Bearer` header. Browsers can't set that header on a WebSocket, so for browser sessions, name a cookie instead:

```ts
const auth = Auth.make({
  cookies: { name: "session" },
  authenticate: (request) => lookupSession(request.cookies["session"]),
})
```

The provider then receives the request's cookies. Add `bearer: true` to accept either.

Every provider returns a tenant along with the caller. Return `"default"`: the server refuses every other tenant for now.

A WebSocket session checks its credentials again every 60 seconds, and runs `access` again. A user who loses access is disconnected at the next check. Change the interval with `reauthorizeEvery` on `Akter.serve`.

## What they may do

`access` gets the caller and a description of the request, and returns `true` to let it through:

```ts
import { Effect, Schema } from "effect"
import { Actor, type AccessRequest, type Caller } from "@rikalabs/akter"

export const Page = Actor.make("Page", {
  state: Schema.Struct({
    draft: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    published: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
  commands: {
    edit: Actor.command(Schema.String),
    publish: Actor.command(),
  },
  views: {
    live: Actor.view(Schema.String),
  },
  access: (caller: Caller, request: AccessRequest) =>
    caller._tag !== "Anonymous" || request.kind === "view",
})
```

Here anyone can read the `live` view, but only signed-in callers can edit, publish or read the full state, which includes the draft.

`request.kind` is one of `command`, `state`, `list`, `view`, `broadcast`, `join`, `find` or `reauthorize`, and `request.member` names the command, view, list or broadcast. TypeScript can't infer the parameter types of an `access` function, so annotate them with `Caller` and `AccessRequest` as above.

Without an `access` function, an actor admits `User` and `System` callers and turns away `Anonymous` ones.

`access` runs on every call made through a client, including calls from [jobs](jobs.md#call-actors), which arrive as `System` callers. If you write an `access` function that admits only users, jobs can't call that actor. Sends, timers and cron are delivered by Akter itself and don't go through `access`.

## Rules that depend on state

`access` sees the caller and the request, not the actor's state. A rule like "only members can post" belongs in the command, where the state is:

```ts
post: (room, body, { caller, id, now }) => {
  if (!isUser(caller) || !room.members.includes(caller.subject)) return NotAMember.make({})
  room.messages.put({ id: id(), at: now(), body })
}
```

Views can do the same for reads. A view handler also gets `caller`, so it can return only what that caller is allowed to see.

## Narrowed callers

If `access` is a type guard, handlers see the narrowed type. With `access: isUser`, `ctx.caller` is a `User` or a `System` caller in every handler, and the `Anonymous` case disappears from your code.
