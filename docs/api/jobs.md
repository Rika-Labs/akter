# Jobs in 0.2

Jobs run I/O as Effects in the same `toLayer` as an actor's synchronous actions. Declare `Actor.job({ payload?, retry?, timeout?, concurrency?, onFailure })` and start it with `ctx.start.<name>(payload, { key? })`. `onFailure` must name an internal action accepting `Actor.JobFailure`. Defaults are one attempt and concurrency one per declaration per shard; `retry.backoff` is a duration. No cancellation, compensation or workflow-run handle is exposed.

The handler receives `{ self, step, emit, id, attempt }`; `attempt` starts at one. Application service requirements flow into `toLayer`, while the engine supplies the client and workflow services. Jobs cannot require an escaping `Scope`; use `Effect.scoped` to close a resource scope inside the job.

```ts
import { Effect, Stream } from "effect"
import { DurableClock } from "@rikalabs/akter/server"

const generate = (payload, { self, step, emit, id }) =>
  Effect.gen(function* () {
    const model = yield* Model
    const text = yield* step(
      "generate",
      model.stream(payload.prompt).pipe(
        Stream.tap((token) => emit.token(token)),
        Stream.runFold(
          () => "",
          (all, token) => all + token,
        ),
      ),
    )
    yield* step("save", self.answer(text))
    yield* DurableClock.sleep({ name: "cooldown", duration: "10 seconds" })
    yield* step(
      "notify",
      Effect.suspend(() => Mailer.send({ text, key: id() })),
    )
  })
```

`step(name, effect)` records JSON-encodable or void success values. Use `step(name, schema, effect)` for a non-JSON value such as a bigint or a class. Schemas must require no services for encoding or decoding. Names must be static, unique, nonempty, not `body`, and contain no NUL. Once its success is durable, a step never runs again, even when a later step causes a new attempt. A failed or interrupted step can repeat external I/O, so pass a provider idempotency key; `id()` inside a step is stable for that job, step and ordinal across retries.

Actor-call ids are UUIDv8 values derived from `<jobId>/<step-or-body>/<attempt>/<ordinal>`. Crash replay keeps the attempt and returns the receiver's stored outcome. A deliberate retry gets fresh actor-call ids. Put calls that must not repeat across retries inside a step, or make the receiving action idempotent. Calls within one scope are sequential; parallel calls need distinct steps. Completed calls are journaled independently of their enclosing step, so replay need not resend them.

When retries are spent, `onFailure` receives `{ job, declaration, key?, payload, attempts, cause, ambiguous }` once. `payload` is encoded; `cause` is `Failed`, `Defect` or `Timeout`. A typed step failure clears that step's ambiguity; an interrupted, defective or timed-out running step may already have reached its provider. A crash during failure delivery retries the same derived action id and preserves the recorded cause.

`DurableClock.sleep({ name, duration })` journals the deadline for short and long waits, preserves it across restart/owner movement and contributes to drain-time `nextDue`. `Effect.sleep` is a local wait and restarts with the body. Progress events publish immediately and can repeat on a mid-stream retry; they are not durable facts or subscriber history. Save final text through an actor call as shown above.

With `Akter.serve({ runner })`, job actor calls use the receiver's shard owner over mTLS, preserving their derived command ids and original caller attribution. Job completion remains pending until every receiver's per-job call stream is durably retired; owner movement resumes that cleanup rather than rerunning completed steps.

The [background-work contract](../contracts/08-background-work.md) owns the guarantees; [E5 verification](../verification/e5-jobs.md) names the failure scenarios and provider limits. Cluster delivery and the operator inspection surface are separate milestones.
