import { Actor, RetentionGap, UnknownCursor } from "@durable-actors/core"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { Schema } from "effect"

export const AgentId = Schema.NonEmptyString.pipe(Schema.brand("AgentId"))

export class TurnInProgress extends Schema.TaggedError<TurnInProgress>()("TurnInProgress", {
  turnId: Schema.String,
}) {}

export class NoActiveTurn extends Schema.TaggedError<NoActiveTurn>()("NoActiveTurn", {}) {}

export class TurnFailed extends Schema.TaggedError<TurnFailed>()("TurnFailed", {
  turnId: Schema.String,
  reason: Schema.String,
}) {}

/** The transcript as rows: it grows without bound, so it is not keyed state. */
export const turns = Actor.table(
  pgTable("agent_turns", {
    turnId: text("turn_id").primaryKey(),
    prompt: text("prompt").notNull(),
    reply: text("reply").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  }),
)

/** What drizzle-kit generates for `turns`; the runtime checks its primary key at startup. */
export const turnsDdl = `CREATE TABLE IF NOT EXISTS agent_turns (
  routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
  turn_id text NOT NULL, prompt text NOT NULL, reply text NOT NULL, status text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_id, turn_id))`

export const Outcome = Schema.Literals(["replied", "aborted", "failed"])

export class SandboxStarted extends Actor.Event<SandboxStarted>()("SandboxStarted", {
  sandboxId: Schema.String,
}) {}

export class Prompted extends Actor.Event<Prompted>()("Prompted", {
  turnId: Schema.String,
  text: Schema.String,
}) {}

export class TurnEnded extends Actor.Event<TurnEnded>()("TurnEnded", {
  turnId: Schema.String,
  outcome: Outcome,
  text: Schema.String,
}) {}

export class SandboxPaused extends Actor.Event<SandboxPaused>()("SandboxPaused", {
  sandboxId: Schema.String,
}) {}

// Effects touch the sandbox provider after the turn commits, at least once.
export class StartSandbox extends Actor.effect<StartSandbox>()("StartSandbox", {
  input: { repo: Schema.String },
  success: Schema.String,
}) {}

export const Reply = Schema.Struct({ turnId: Schema.String, text: Schema.String })

/** Runs one prompt; the reply streams as progress frames while it is written. */
export class RunPrompt extends Actor.effect<RunPrompt>()("RunPrompt", {
  input: { turnId: Schema.String, text: Schema.String, sandboxId: Schema.String },
  success: Reply,
  progress: Schema.Struct({ turnId: Schema.String, delta: Schema.String }),
}) {}

export class PauseSandbox extends Actor.effect<PauseSandbox>()("PauseSandbox", {
  input: { sandboxId: Schema.String },
}) {}

export const ActiveTurn = Schema.Struct({ turnId: Schema.String, text: Schema.String })

export const AgentState = Actor.state({
  repo: Schema.optional(Schema.String),
  sandboxId: Schema.optional(Schema.String),
  activeTurn: Schema.optional(ActiveTurn),
  /** The token of the pending idle timer; an older timer that fires anyway does nothing. */
  idleToken: Schema.optional(Schema.String),
})

export const Start = Actor.command("Start", { input: Schema.Struct({ repo: Schema.String }) })

/** Returns the turn id; the reply arrives as a `TurnEnded` event. */
export const Prompt = Actor.command("Prompt", {
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  errors: [TurnInProgress],
})

export const Abort = Actor.command("Abort", { errors: [NoActiveTurn] })

export const Transcript = Actor.query("Transcript", {
  input: Schema.Struct({ limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })) }),
  output: Schema.Array(
    Schema.Struct({
      turnId: Schema.String,
      prompt: Schema.String,
      reply: Schema.String,
      status: Schema.String,
    }),
  ),
})

/** The sandbox the agent uses now, if any; the reaper kills only sandboxes no agent uses. */
export const Sandbox = Actor.query("Sandbox", { output: Schema.NullOr(Schema.String) })

/** Implements a task in two turns: one to write it, one to test and commit it. */
export const Ship = Actor.workflow("Ship", {
  input: { task: Schema.String },
  output: Schema.Struct({ turns: Schema.Int, summary: Schema.String }),
  errors: [TurnFailed],
})

export const Implement = Ship.step("implement", {
  input: Schema.String,
  success: Schema.String,
  errors: [TurnInProgress],
})

export const Implemented = Ship.wait("implemented", TurnEnded)

export const Verify = Ship.step("verify", {
  input: Schema.String,
  success: Schema.String,
  errors: [TurnInProgress],
})

export const Verified = Ship.wait("verified", TurnEnded)

// Internal: only the effect routes and the idle timer reach them.
export const SandboxReady = Actor.command("SandboxReady", { input: Schema.String })

export const Replied = Actor.command("Replied", { input: Reply })

export const PromptFailed = Actor.command("PromptFailed", { input: Actor.DeadLetter(RunPrompt) })

export const Idle = Actor.command("Idle", { input: Schema.Struct({ token: Schema.String }) })

/** A piece of the reply as the executor writes it: live, never stored, and lossy under load. */
export const Delta = Schema.TaggedStruct("Delta", { text: Schema.String })

/** How the turn ended and its whole reply, from the committed `TurnEnded` event. */
export const Ended = Schema.TaggedStruct("Ended", { outcome: Outcome, text: Schema.String })

/**
 * One turn's reply: deltas while it is written, then `Ended` once the turn
 * commits its end, and the stream completes. A client that subscribes late or
 * misses deltas still gets the whole reply in `Ended`.
 */
export const Streaming = Actor.stream("Streaming", {
  input: Schema.Struct({ turnId: Schema.String }),
  output: Schema.Union([Delta, Ended]),
  errors: [UnknownCursor, RetentionGap],
  progress: { effects: [RunPrompt] },
})

/**
 * One coding agent with its own sandbox. The sandbox pauses when the agent is
 * idle and resumes on the next prompt; the transcript is durable.
 */
export const CodingAgent = Actor.make("CodingAgent", {
  key: AgentId,
  state: AgentState,
  tables: [turns],
  events: [SandboxStarted, Prompted, TurnEnded, SandboxPaused],
  effects: [StartSandbox, RunPrompt, PauseSandbox],
  api: { Start, Prompt, Abort, Sandbox, Transcript, Ship, Streaming },
  internal: { SandboxReady, Replied, PromptFailed, Idle },
  policy: {
    createdBy: Start,
    effects: {
      StartSandbox: { onSuccess: SandboxReady },
      RunPrompt: { timeout: "10 minutes", onSuccess: Replied, onDeadLetter: PromptFailed },
    },
  },
})
