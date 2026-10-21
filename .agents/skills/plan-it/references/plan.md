# Plan shape

````markdown
# <Goal in one sentence>

<Two sentences: what changes, for whom, and the biggest risk.>

## Before and after

<Two small diagrams, or one fork, showing the flow today and after the change.>

## One real case

<A traced example with real names, step by step, as it will work after the change.>

## Design

Example sketches, not existing APIs or paths; replace them with the actual public boundary.
How a caller uses it:

```ts
const program = Effect.gen(function* () {
  const receipt = yield* threads.archive({ threadId, commandId })
})
```

The shape behind it:

```ts
export interface ArchiveThread {
  readonly threadId: ThreadId
  readonly commandId: CommandId
}
export const archive: (input: ArchiveThread) => Effect.Effect<Receipt, Conflict | NotFound, Threads>
```

Rejected: <the other design in two sentences, and why it lost>.

## Prototype results

- <Question, what was tried, what it showed, link to screenshots or output.>

## What changes

| Owner           | Change         | Risk |
| --------------- | -------------- | ---- |
| `<owning-path>` | <what and why> | low  |

## Steps

- [ ] **1. <Smallest change that can be checked alone.>**
  - Files: edit `<path>`, create `<path>`.
  - You see: <the observable result: screen state, response, log line>.
  - Evidence: <the test run, screenshot, row or SHA that checks this box>.
- [ ] **2. ...**

## Not doing

- <Scope cut on purpose, and why.>

## Open questions

- <Only product or preference calls for the user, as numbered options with a recommendation.>
````
