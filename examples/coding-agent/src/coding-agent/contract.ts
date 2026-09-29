import { Actor, RetentionGap, UnknownCursor } from "@durable-actors/core"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { Schema } from "effect"

/** An agent's key: a non-empty string. */
export const AgentId = Schema.NonEmptyString.pipe(Schema.brand("AgentId"))

/**
 * Declared failure when a prompt arrives while a turn is still running;
 * carries the running turn's id.
 */
export class TurnInProgress extends Schema.TaggedError<TurnInProgress>()("TurnInProgress", {
  turnId: Schema.String,
}) {}

/** Declared failure of `Abort` when no turn is running. */
export class NoActiveTurn extends Schema.TaggedError<NoActiveTurn>()("NoActiveTurn", {}) {}

/** Declared failure of the `Ship` workflow: the agent was busy or gave no reply within an hour. */
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

/** How a turn ended. */
export const Outcome = Schema.Literals(["replied", "aborted", "failed"])

/** A sandbox was created for the agent. */
export class SandboxStarted extends Actor.Event<SandboxStarted>()("SandboxStarted", {
  sandboxId: Schema.String,
}) {}

/** A prompt was accepted as a new turn. */
export class Prompted extends Actor.Event<Prompted>()("Prompted", {
  turnId: Schema.String,
  text: Schema.String,
}) {}

/** A turn ended, with its outcome and the reply text (empty unless it replied). */
export class TurnEnded extends Actor.Event<TurnEnded>()("TurnEnded", {
  turnId: Schema.String,
  outcome: Outcome,
  text: Schema.String,
}) {}

/** The agent went idle and its sandbox was paused. */
export class SandboxPaused extends Actor.Event<SandboxPaused>()("SandboxPaused", {
  sandboxId: Schema.String,
}) {}

/**
 * Effects touch the sandbox provider after the turn commits, at least once.
 */
export class StartSandbox extends Actor.effect<StartSandbox>()("StartSandbox", {
  input: { repo: Schema.String },
  success: Schema.String,
}) {}

/** A finished reply for one turn. */
export const Reply = Schema.Struct({ turnId: Schema.String, text: Schema.String })

/** Runs one prompt; the reply streams as progress frames while it is written. */
export class RunPrompt extends Actor.effect<RunPrompt>()("RunPrompt", {
  input: { turnId: Schema.String, text: Schema.String, sandboxId: Schema.String },
  success: Reply,
  progress: Schema.Struct({ turnId: Schema.String, delta: Schema.String }),
}) {}

/** Pauses the sandbox; performed by the idle timer. */
export class PauseSandbox extends Actor.effect<PauseSandbox>()("PauseSandbox", {
  input: { sandboxId: Schema.String },
}) {}

/** The turn currently running. */
export const ActiveTurn = Schema.Struct({ turnId: Schema.String, text: Schema.String })

/** Agent state: repo, sandbox, running turn and idle-timer token. */
export const AgentState = Actor.state({
  repo: Schema.optional(Schema.String),
  sandboxId: Schema.optional(Schema.String),
  activeTurn: Schema.optional(ActiveTurn),
  /** The token of the pending idle timer; an older timer that fires anyway does nothing. */
  idleToken: Schema.optional(Schema.String),
})

/** Boots the agent's sandbox for `repo`; repeating it does nothing. */
export const Start = Actor.command("Start", { input: Schema.Struct({ repo: Schema.String }) })

/** Returns the turn id; the reply arrives as a `TurnEnded` event. */
export const Prompt = Actor.command("Prompt", {
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  errors: [TurnInProgress],
})

/** Ends the running turn as aborted; fails with `NoActiveTurn` when none runs. */
export const Abort = Actor.command("Abort", { errors: [NoActiveTurn] })

/** The latest turns, newest first, up to `limit` (1 to 100). */
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

/** Workflow step that prompts the agent to write the task. */
export const Implement = Ship.step("implement", {
  input: Schema.String,
  success: Schema.String,
  errors: [TurnInProgress],
})

/** Waits for the end of the implementing turn. */
export const Implemented = Ship.wait("implemented", TurnEnded)

/** Workflow step that prompts the agent to test and commit. */
export const Verify = Ship.step("verify", {
  input: Schema.String,
  success: Schema.String,
  errors: [TurnInProgress],
})

/** Waits for the end of the verifying turn. */
export const Verified = Ship.wait("verified", TurnEnded)

/**
 * Records the started sandbox and runs the turn that was waiting for it. Internal:
 * only the effect routes and the idle timer reach the internal commands.
 */
export const SandboxReady = Actor.command("SandboxReady", { input: Schema.String })

/** A prompt's reply arrived from the executor. */
export const Replied = Actor.command("Replied", { input: Reply })

/** A prompt exhausted its retries. */
export const PromptFailed = Actor.command("PromptFailed", { input: Actor.DeadLetter(RunPrompt) })

/** Idle timer: pauses the sandbox unless a newer turn has replaced the token. */
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
