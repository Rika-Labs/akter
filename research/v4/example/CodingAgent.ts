// Contract file: one coding agent per actor. Each actor owns an OpenCode server inside an E2B sandbox that pauses when
// the agent is idle and resumes on the next prompt. Uses every member kind: commands, internal commands, a query, a
// connection, a workflow, events, effects, a table, keyed state with a migration, vars, and lifecycle policies.
import { Effect, Schedule, Schema } from "effect"
import { Actor, Commands, Effects, Events, Hibernate, Lifecycle, Mailbox, State } from "../framework/Actor.ts"
import { OpenCodeSessionId, SandboxId } from "./services.ts"

// ---------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------

export class TurnInProgress extends Schema.TaggedError<TurnInProgress>()("TurnInProgress", { turnId: Schema.String }, { httpApiStatus: 409 }) {
  override get message(): string {
    return `turn ${this.turnId} is still running: wait for Replied or Abort it`
  }
}
export class NoActiveTurn extends Schema.TaggedError<NoActiveTurn>()("NoActiveTurn", {}, { httpApiStatus: 409 }) {
  override get message(): string {
    return `nothing to abort: the agent is idle`
  }
}
export class TurnFailed extends Schema.TaggedError<TurnFailed>()("TurnFailed", { turnId: Schema.String, reason: Schema.String }) {
  override get message(): string {
    return `turn ${this.turnId} failed: ${this.reason}`
  }
}

// ---------------------------------------------------------------------------------------------------
// Events: the actor's durable history (replayable with `agent.events({ after })`)
// ---------------------------------------------------------------------------------------------------

export class SandboxStarted extends Schema.TaggedClass<SandboxStarted>()("SandboxStarted", { sandboxId: SandboxId }) {}
export class Prompted extends Schema.TaggedClass<Prompted>()("Prompted", { turnId: Schema.String, text: Schema.String }) {}
export class Replied extends Schema.TaggedClass<Replied>()("Replied", { turnId: Schema.String, text: Schema.String }) {}
export class Aborted extends Schema.TaggedClass<Aborted>()("Aborted", { turnId: Schema.String, reason: Schema.String }) {}
export class SandboxPaused extends Schema.TaggedClass<SandboxPaused>()("SandboxPaused", { sandboxId: SandboxId }) {}

// ---------------------------------------------------------------------------------------------------
// Effects: the outside world, touched after COMMIT, at least once, by the executors in CodingAgent.server.ts
// ---------------------------------------------------------------------------------------------------

export class StartSandbox extends Schema.TaggedClass<StartSandbox>()("StartSandbox", { repo: Schema.String }) {}
export class RunPrompt extends Schema.TaggedClass<RunPrompt>()("RunPrompt", {
  turnId: Schema.String,
  text: Schema.String,
  sandboxId: SandboxId,
  sessionId: OpenCodeSessionId
}) {}
export class AbortPrompt extends Schema.TaggedClass<AbortPrompt>()("AbortPrompt", { sandboxId: SandboxId, sessionId: OpenCodeSessionId }) {}
export class PauseSandbox extends Schema.TaggedClass<PauseSandbox>()("PauseSandbox", { sandboxId: SandboxId }) {}

// ---------------------------------------------------------------------------------------------------
// Connection frames: ephemeral, never persisted
// ---------------------------------------------------------------------------------------------------

export class Delta extends Schema.TaggedClass<Delta>()("Delta", { turnId: Schema.String, text: Schema.String }) {}
export class Done extends Schema.TaggedClass<Done>()("Done", { turnId: Schema.String }) {}

// ---------------------------------------------------------------------------------------------------
// Table: the transcript as rows (big, queryable), not keyed state (small, hot)
// ---------------------------------------------------------------------------------------------------

export const agentTurns = Actor.table("agent_turns", {
  turn_id: "text",
  prompt: "text",
  reply: "text",
  status: "text", // "running" | "replied" | "aborted"
  started_at: "timestamptz"
})

// ---------------------------------------------------------------------------------------------------
// State: two versions, one migration (decision 162)
// ---------------------------------------------------------------------------------------------------

export const ActiveTurn = Schema.Struct({ turnId: Schema.String, text: Schema.String })
const StateV1 = Schema.Struct({
  repo: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sandboxId: Schema.OptionFromOptionalKey(SandboxId),
  sessionId: Schema.OptionFromOptionalKey(OpenCodeSessionId),
  activeTurn: Schema.OptionFromOptionalKey(ActiveTurn)
})
const StateV2 = Schema.Struct({
  ...StateV1.fields,
  model: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("anthropic/claude-sonnet-4")))
})

// ---------------------------------------------------------------------------------------------------
// Commands, query, connection, workflow
// ---------------------------------------------------------------------------------------------------

export const Start = Actor.command("Start", {
  description: "Create the agent for a repository and boot its sandbox. Every other command fails with NotCreated until this ran.",
  input: { repo: Schema.String, model: Schema.optionalKey(Schema.String) }
})
export const Prompt = Actor.command("Prompt", {
  description: "Send a prompt to the agent and return the turn id. Deltas arrive on the Live connection, the full reply as a Replied event. Fails with TurnInProgress while a turn is running.",
  input: { text: Schema.String },
  output: Schema.String,
  errors: [TurnInProgress]
})
export const Abort = Actor.command("Abort", {
  description: "Stop the running turn. Fails with NoActiveTurn when the agent is idle.",
  errors: [NoActiveTurn]
})
// internal: executors and the run loop report back as durable intents
export const SandboxReady = Actor.command("SandboxReady", {
  description: "Internal: the sandbox booted, OpenCode is listening and a session exists.",
  input: { sandboxId: SandboxId, sessionId: OpenCodeSessionId }
})
export const TurnDone = Actor.command("TurnDone", {
  description: "Internal: OpenCode went idle (or errored) after a prompt; records the reply.",
  input: { turnId: Schema.String, text: Schema.String, error: Schema.optionalKey(Schema.String) }
})
export const Idle = Actor.command("Idle", {
  description: "Internal: the idle timer fired; pauses the sandbox when no turn is running."
})
export const SandboxLost = Actor.command("SandboxLost", {
  description: "Internal: the sandbox no longer exists (killed or expired); a new one is started if a turn is pending.",
  input: { sandboxId: SandboxId }
})

export const Transcript = Actor.query("Transcript", {
  description: "The last `limit` turns, newest first, from committed rows on the caller's node.",
  input: { limit: Schema.Number },
  output: Schema.Array(Schema.Struct({ turnId: Schema.String, prompt: Schema.String, reply: Schema.String, status: Schema.String }))
})

export const Live = Actor.connection("Live", {
  description: "Live output: Delta frames while a turn runs, Done when it finishes. The client sends nothing.",
  server: Schema.Union([Delta, Done])
})

/** A durable, multi-turn job the agent owns: prompt, wait for the reply, prompt again, and so on. */
export const Ship = Actor.workflow("Ship", {
  description: "Implement a task and get it committed: one turn to implement, one to run the tests and commit. Survives runner restarts and sandbox loss.",
  input: { task: Schema.String },
  output: Schema.Struct({ turns: Schema.Number, summary: Schema.String }),
  errors: [TurnFailed]
})

export const CodingAgent = Actor.make("CodingAgent", {
  description: "One OpenCode agent in one E2B sandbox. The sandbox pauses when idle and resumes on the next prompt; the transcript is durable.",
  // no `id`: the framework mints one (`CodingAgent.create()`); `CodingAgent.id` is the branded schema (decision 164)
  commands: [Start, Prompt, Abort, SandboxReady, TurnDone, Idle, SandboxLost],
  internal: [SandboxReady, TurnDone, Idle, SandboxLost],
  queries: [Transcript],
  connections: [Live],
  workflows: [Ship],
  events: [SandboxStarted, Prompted, Replied, Aborted, SandboxPaused],
  effects: [StartSandbox, RunPrompt, AbortPrompt, PauseSandbox],
  tables: [agentTurns],
  state: StateV2.fields,
  migrations: [Actor.migration(StateV1, StateV2, (old) => ({ ...old, model: "anthropic/claude-sonnet-4" }))],
  // per-activation cache: the sandbox host the run loop last connected to (decision 160); dropped on hibernation
  vars: { host: Schema.OptionFromOptionalKey(Schema.String) },
  lifecycle: [
    Lifecycle.createdBy(Start),
    Hibernate.after("5 minutes"), // the activation sleeps; the sandbox is paused separately by the idle timer
    Commands.timeout("10 seconds"),
    Mailbox.capacity(100),
    // five tries, then `onEffectFailed` runs inside a turn and the effect is dead-lettered
    Effects.retry(Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 5 }))),
    Events.keep("90 days"),
    State.maxBytes("16 KiB")
  ]
})
export type CodingAgentId = typeof CodingAgent.id.Type
