import { Context, Deferred, Effect, Layer, Stream } from "effect"

/** The agent a sandbox was created for, recorded as provider metadata. */
export interface SandboxOwner {
  readonly tenant: string
  readonly agentId: string
}

/**
 * A sandbox as the provider lists it: its owner, start time in epoch
 * milliseconds and whether it is paused.
 */
export interface SandboxInfo {
  readonly sandboxId: string
  readonly owner: SandboxOwner
  readonly startedAt: number
  readonly paused: boolean
}

/**
 * The sandbox provider: one VM per agent running a coding agent server.
 * Calls that create or charge for work take an idempotency key, so a retried
 * job reuses the sandbox or reply its first attempt produced.
 */
export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    readonly create: (request: {
      readonly repo: string
      readonly owner: SandboxOwner
      readonly idempotencyKey: string
    }) => Effect.Effect<string>
    /** The reply to `text` as it streams; resumes a paused sandbox first. */
    readonly prompt: (request: {
      readonly sandboxId: string
      readonly text: string
      readonly idempotencyKey: string
    }) => Stream.Stream<string>
    readonly pause: (sandboxId: string) => Effect.Effect<void>
    readonly list: Effect.Effect<ReadonlyArray<SandboxInfo>>
    /** Killing a sandbox that is already gone does nothing. */
    readonly kill: (sandboxId: string) => Effect.Effect<void>
  }
>()("@durable-actors/coding-agent/coding-agent/sandbox/Sandboxes") {}

/** An in-memory provider: sandboxes are map entries and replies echo the prompt. */
export interface FakeSandboxes {
  readonly sandboxes: Map<string, SandboxInfo & { readonly repo: string }>
  /** Prompt calls per idempotency key, including repeats. */
  readonly prompts: Map<string, number>
  /** When set, the next prompt waits for it before replying. */
  gate: Deferred.Deferred<void> | undefined
  /** Milliseconds between reply pieces, as a model streams; 0 replies at once. */
  paceMs: number
  /** The provider clock, in epoch milliseconds. */
  now: () => number
}

/** An empty in-memory provider state whose clock is `now`. */
export const fakeSandboxes = (now: () => number = Date.now): FakeSandboxes => ({
  sandboxes: new Map(),
  prompts: new Map(),
  gate: undefined,
  paceMs: 0,
  now,
})

/**
 * `Sandboxes` backed by the in-memory provider `fake`; it honors idempotency
 * keys like a real one.
 */
export const fakeLayer = (fake: FakeSandboxes) =>
  Layer.succeed(Sandboxes, {
    create: ({ repo, owner, idempotencyKey }) =>
      Effect.sync(() => {
        const sandboxId = `sbx-${idempotencyKey}`

        if (!fake.sandboxes.has(sandboxId))
          fake.sandboxes.set(sandboxId, {
            sandboxId,
            owner,
            repo,
            startedAt: fake.now(),
            paused: false,
          })

        return sandboxId
      }),
    prompt: ({ sandboxId, text, idempotencyKey }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          fake.prompts.set(idempotencyKey, (fake.prompts.get(idempotencyKey) ?? 0) + 1)
          const sandbox = fake.sandboxes.get(sandboxId)

          if (sandbox !== undefined) fake.sandboxes.set(sandboxId, { ...sandbox, paused: false })
          const gate = fake.gate
          fake.gate = undefined

          if (gate !== undefined) yield* Deferred.await(gate)

          const pace = fake.paceMs

          return Stream.fromIterable(["Done: ", text]).pipe(
            Stream.tap(() => (pace === 0 ? Effect.void : Effect.sleep(pace))),
          )
        }),
      ),
    pause: (sandboxId) =>
      Effect.sync(() => {
        const sandbox = fake.sandboxes.get(sandboxId)

        if (sandbox !== undefined) fake.sandboxes.set(sandboxId, { ...sandbox, paused: true })
      }),
    list: Effect.sync(() => [...fake.sandboxes.values()]),
    kill: (sandboxId) => Effect.sync(() => void fake.sandboxes.delete(sandboxId)),
  })
