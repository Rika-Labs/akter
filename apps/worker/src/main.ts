import { Effect } from "effect"

// The worker composition will be added with the first runtime milestone.
// Keep this process boundary separate so background work can scale independently.
await Effect.log("Durable Actors worker is not configured yet").pipe(Effect.runPromise)
