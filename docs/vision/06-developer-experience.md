# 06 — Developer experience

## Vision

Durable Actors should feel like application development, not infrastructure assembly.

The canonical server framework is Effect-native. A conventional TypeScript SDK is derived from the same actor definitions and protocol, so users can write ordinary Promise-based clients without creating a second runtime.

## The API should be obvious

```ts
const Room = Actor.define({
  name: "room",
  commands: {
    sendMessage: {
      input: SendMessage,
      handler: (input) =>
        Effect.gen(function* () {
          const ctx = yield* Context
          yield* ctx.database.insert(messages).values(input)
          yield* ctx.emit("messageAdded", input)
        }),
    },
  },
})
```

The framework should provide:

- typed commands and events;
- Drizzle-compatible relational queries;
- generated client contracts;
- useful local development;
- actionable errors;
- visible runtime state;
- stable defaults before advanced configuration.

Users should not need to understand leases, pollers, relay loops, fencing generations, or recovery tables to build a feature. Operators still need access to those details when diagnosing a failure.
