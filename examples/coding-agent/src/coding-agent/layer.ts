import { Intent, type Step, type Wait } from "@durable-actors/core"
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentId,
  CodingAgent,
  Delta,
  Ended,
  Implement,
  Implemented,
  NoActiveTurn,
  Outcome,
  PauseSandbox,
  Prompted,
  RunPrompt,
  SandboxPaused,
  SandboxStarted,
  StartSandbox,
  TurnEnded,
  TurnFailed,
  TurnInProgress,
  turns,
  turnsDdl,
  Verified,
  Verify,
} from "./contract.ts"
import { Sandboxes } from "./sandbox.ts"

const decodeOutcome = Schema.decodeUnknownOption(Outcome)

/** An agent with no turn for this long pauses its sandbox. */
const IDLE_AFTER = "15 minutes"

/**
 * Ends the active turn: the row, the event, and the idle timer that follows
 * it.
 *
 * The same key replaces a pending timer, so only the latest turn's timer is
 * live.
 */
const endTurn = Effect.fnUntraced(function* (
  turnId: string,
  outcome: typeof TurnEnded.Type.outcome,
  text: string,
) {
  const turn = yield* CodingAgent.Turn

  yield* turn.rows(turns).update({ reply: text, status: outcome }).where({ turnId })
  yield* turn.emit(TurnEnded.make({ turnId, outcome, text }))
  yield* turn.state.set({ activeTurn: undefined, idleToken: turn.commandId })

  yield* (yield* CodingAgent.intents(turn.id))
    .Idle({ token: turn.commandId })
    .pipe(Intent.after(IDLE_AFTER), Intent.key("idle"))
})

/** True when `turnId` is still the running turn; a late reply for an aborted one is not. */
const isActive = Effect.fnUntraced(function* (turnId: string) {
  return (yield* CodingAgent.Turn).state.activeTurn?.turnId === turnId
})

type Ask = Step<
  string,
  typeof Schema.String,
  typeof Schema.String,
  readonly [typeof TurnInProgress]
>

/**
 * Agent command handlers.
 *
 * `Streaming` yields the reply's deltas for one turn from the moment of
 * subscribing. A turn that already ended answers from its row; otherwise its
 * end is an event after the cursor the read started from, which the stream
 * follows. Only an ended turn decodes, because `running` is not an outcome.
 *
 * `Start` is a no-op when repeated, so it never boots a second sandbox. The
 * command id names a turn, so a retried prompt is the same turn; before the
 * sandbox is ready, `SandboxReady` runs the pending turn. `Abort` leaves the
 * running prompt to finish: its reply finds the turn inactive and is dropped.
 * A timer that was already claimed still fires once after a new prompt, so
 * `Idle` reads state instead of trusting the cancel.
 *
 * `Ship` runs outside any turn: each prompt is a recorded step and each reply
 * is an owner-event wait.
 */
export const CodingAgentCommands = CodingAgent.toLayer(
  Effect.succeed({
    Streaming: ({ turnId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const read = yield* CodingAgent.Read

          const deltas = read.progress(RunPrompt).pipe(
            Stream.filter((entry) => entry.effect.turnId === turnId),
            Stream.map(({ frame }) => Delta.make({ text: frame.delta })),
          )

          const row = yield* read.rows(turns).one({ where: { turnId } })

          const ended = Option.match(
            Option.flatMap(row, ({ status, reply }) =>
              Option.map(decodeOutcome(status), (outcome) => Ended.make({ outcome, text: reply })),
            ),
            {
              onSome: (end) => Stream.make(end),
              onNone: () =>
                read.follow(TurnEnded, { after: read.cursor }).pipe(
                  Stream.filter(({ event }) => event.turnId === turnId),
                  Stream.take(1),
                  Stream.map(({ event }) =>
                    Ended.make({ outcome: event.outcome, text: event.text }),
                  ),
                ),
            },
          )

          return Stream.merge(deltas, ended, { haltStrategy: "right" })
        }),
      ),

    Start: Effect.fnUntraced(function* ({ repo }) {
      const turn = yield* CodingAgent.Turn

      if (turn.state.repo !== undefined) return
      yield* turn.state.set({ repo })
      yield* turn.perform(StartSandbox.make({ repo }))
    }),

    Prompt: Effect.fnUntraced(function* ({ text }) {
      const turn = yield* CodingAgent.Turn
      const active = turn.state.activeTurn

      if (active !== undefined) return yield* TurnInProgress.make({ turnId: active.turnId })

      const turnId = turn.commandId

      yield* turn.rows(turns).insert({
        turnId,
        prompt: text,
        reply: "",
        status: "running",
        startedAt: DateTime.toDate(yield* DateTime.now),
      })
      yield* turn.state.set({ activeTurn: { turnId, text }, idleToken: undefined })
      yield* turn.emit(Prompted.make({ turnId, text }))
      yield* Intent.cancel("idle")

      if (turn.state.sandboxId !== undefined)
        yield* turn.perform(RunPrompt.make({ turnId, text, sandboxId: turn.state.sandboxId }))

      return turnId
    }),

    Abort: Effect.fnUntraced(function* () {
      const turn = yield* CodingAgent.Turn
      const active = turn.state.activeTurn

      if (active === undefined) return yield* NoActiveTurn.make({})
      yield* endTurn(active.turnId, "aborted", "")
    }),

    SandboxReady: Effect.fnUntraced(function* (sandboxId: string) {
      const turn = yield* CodingAgent.Turn
      yield* turn.state.set({ sandboxId })
      yield* turn.emit(SandboxStarted.make({ sandboxId }))

      if (turn.state.activeTurn !== undefined)
        yield* turn.perform(RunPrompt.make({ ...turn.state.activeTurn, sandboxId }))
    }),

    Replied: Effect.fnUntraced(function* ({ turnId, text }) {
      if (yield* isActive(turnId)) yield* endTurn(turnId, "replied", text)
    }),

    PromptFailed: Effect.fnUntraced(function* ({ effect }) {
      if (yield* isActive(effect.turnId)) yield* endTurn(effect.turnId, "failed", "")
    }),

    Idle: Effect.fnUntraced(function* ({ token }) {
      const turn = yield* CodingAgent.Turn
      const { activeTurn, idleToken, sandboxId } = turn.state

      if (activeTurn !== undefined || idleToken !== token || sandboxId === undefined) return

      yield* turn.perform(PauseSandbox.make({ sandboxId }))
      yield* turn.emit(SandboxPaused.make({ sandboxId }))
    }),

    Ship: Effect.fnUntraced(function* ({ task }) {
      const wf = yield* CodingAgent.Workflow

      const ask = (step: Ask, reply: Wait<string, typeof TurnEnded>, text: string) =>
        Effect.gen(function* () {
          const turnId = yield* step
            .run(text, (prompt) =>
              Effect.gen(function* () {
                const agent = yield* CodingAgent.get(AgentId.make(wf.id))

                return yield* agent
                  .Prompt({ text: prompt })
                  .pipe(Effect.catchTag("ActorError", (error) => Effect.die(error)))
              }),
            )
            .pipe(
              Effect.catchTag("TurnInProgress", ({ turnId }) =>
                Effect.fail(TurnFailed.make({ turnId, reason: "the agent was busy" })),
              ),
            )

          const ended = yield* reply({
            where: (event) => event.turnId === turnId,
            timeout: "1 hour",
          })

          if (Option.isNone(ended))
            return yield* TurnFailed.make({ turnId, reason: "no reply within an hour" })

          if (ended.value.outcome !== "replied")
            return yield* TurnFailed.make({ turnId, reason: ended.value.outcome })

          return ended.value.text
        })

      yield* ask(Implement, Implemented, `Implement this task, then stop: ${task}`)

      const summary = yield* ask(
        Verify,
        Verified,
        "Run the test suite, fix what broke, commit, and summarise what you did.",
      )

      return { turns: 2, summary }
    }),
  }),
)

/** Query handlers for `CodingAgent`. */
export const CodingAgentReads = CodingAgent.toQueryLayer(
  Effect.succeed({
    Sandbox: Effect.fnUntraced(function* () {
      return (yield* CodingAgent.Read).state.sandboxId ?? null
    }),
    Transcript: Effect.fnUntraced(function* ({ limit }) {
      const rows = yield* (yield* CodingAgent.Read)
        .rows(turns)
        .all({ orderBy: { startedAt: "desc", turnId: "desc" }, limit })

      return rows.map(({ turnId, prompt, reply, status }) => ({ turnId, prompt, reply, status }))
    }),
  }),
)

/** May run in another process: it gets no database, only the sandbox provider. */
export const CodingAgentEffects = CodingAgent.toEffectLayer(
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes

    return {
      StartSandbox: Effect.fnUntraced(function* ({ repo }) {
        const exec = yield* CodingAgent.Executor
        const owner = { tenant: exec.ref.tenant, agentId: exec.ref.id }

        return yield* sandboxes.create({ repo, owner, idempotencyKey: exec.effectId })
      }),
      RunPrompt: Effect.fnUntraced(function* ({ turnId, text, sandboxId }) {
        const exec = yield* CodingAgent.Executor

        return {
          turnId,
          text: yield* sandboxes.prompt({ sandboxId, text, idempotencyKey: exec.effectId }).pipe(
            Stream.tap((delta) => exec.progress(RunPrompt, { turnId, delta })),
            Stream.mkString,
          ),
        }
      }),
      PauseSandbox: ({ sandboxId }) => sandboxes.pause(sandboxId),
    }
  }),
)

/** Creates the table as a drizzle-kit migration would, then registers the agent. */
export const CodingAgentLive = Layer.unwrap(
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient).unsafe(turnsDdl)

    return Layer.mergeAll(CodingAgentCommands, CodingAgentReads, CodingAgentEffects)
  }).pipe(Effect.orDie),
)
