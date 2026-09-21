// Server file: the turn is a transaction, the sandbox and OpenCode are effects, following the model's output is the
// run loop, and multi-turn jobs are the workflow. Nothing here blocks the mailbox on a network call.
import { Effect, Option, Schedule, Schema, Stream } from "effect"
import {
  Aborted,
  AbortPrompt,
  agentTurns,
  CodingAgent,
  Delta,
  Done,
  NoActiveTurn,
  PauseSandbox,
  Prompted,
  Replied,
  RunPrompt,
  SandboxPaused,
  SandboxStarted,
  StartSandbox,
  TurnFailed,
  TurnInProgress
} from "./CodingAgent.ts"
import { OpenCode, Sandboxes } from "./services.ts"

export const CodingAgentLive = CodingAgent.toLayer(
  Effect.gen(function*() {
    const sandboxes = yield* Sandboxes
    const opencode = yield* OpenCode

    return CodingAgent.of({
      // the creating command (Lifecycle.createdBy): everything else fails NotCreated until this turn committed
      Start: Effect.fn(function*(ctx, { repo, model }) {
        yield* ctx.state.set(model === undefined ? { repo } : { repo, model })
        yield* ctx.perform(new StartSandbox({ repo }))
      }),
      Prompt: Effect.fn(function*(ctx, { text }) {
        if (Option.isSome(ctx.state.activeTurn)) return yield* new TurnInProgress({ turnId: ctx.state.activeTurn.value.turnId })
        const turnId = ctx.commandId // client-minted: a retried Prompt is the same turn, not a second one
        yield* ctx.rows(agentTurns).insert({ turn_id: turnId, prompt: text, reply: "", status: "running", started_at: ctx.now })
        yield* ctx.state.set({ activeTurn: Option.some({ turnId, text }) })
        yield* ctx.emit(new Prompted({ turnId, text }))
        yield* ctx.timers.cancel("idle") // a running turn is not idle
        // sandbox up: run now; sandbox not yet ready (or lost): SandboxReady picks the pending turn up
        yield* Option.match(Option.all({ sandboxId: ctx.state.sandboxId, sessionId: ctx.state.sessionId }), {
          onNone: () => Effect.void,
          onSome: ({ sandboxId, sessionId }) => ctx.perform(new RunPrompt({ turnId, text, sandboxId, sessionId }))
        })
        return turnId
      }),
      Abort: Effect.fn(function*(ctx) {
        if (Option.isNone(ctx.state.activeTurn)) return yield* new NoActiveTurn()
        const { turnId } = ctx.state.activeTurn.value
        yield* ctx.rows(agentTurns).update({ status: "aborted" }, { where: { turn_id: turnId } })
        yield* ctx.state.set({ activeTurn: Option.none() })
        yield* ctx.emit(new Aborted({ turnId, reason: "aborted by caller" }))
        yield* ctx.connections.broadcast(new Done({ turnId }))
        yield* ctx.self.Idle.after("15 minutes", { key: "idle" })
        yield* Option.match(Option.all({ sandboxId: ctx.state.sandboxId, sessionId: ctx.state.sessionId }), {
          onNone: () => Effect.void,
          onSome: ({ sandboxId, sessionId }) => ctx.perform(new AbortPrompt({ sandboxId, sessionId }))
        })
      }),

      // internal: reached only by executors, the run loop, timers and workflows
      SandboxReady: Effect.fn(function*(ctx, { sandboxId, sessionId }) {
        yield* ctx.state.set({ sandboxId: Option.some(sandboxId), sessionId: Option.some(sessionId) })
        yield* ctx.emit(new SandboxStarted({ sandboxId }))
        yield* Option.match(ctx.state.activeTurn, {
          onNone: () => ctx.self.Idle.after("15 minutes", { key: "idle" }),
          onSome: ({ turnId, text }) => ctx.perform(new RunPrompt({ turnId, text, sandboxId, sessionId }))
        })
      }),
      TurnDone: Effect.fn(function*(ctx, { turnId, text, error }) {
        // a reply for a turn that was aborted meanwhile is ignored: the state is the truth, not the network
        if (!Option.exists(ctx.state.activeTurn, (t) => t.turnId === turnId)) return
        yield* ctx.state.set({ activeTurn: Option.none() })
        if (error === undefined) {
          yield* ctx.rows(agentTurns).update({ reply: text, status: "replied" }, { where: { turn_id: turnId } })
          yield* ctx.emit(new Replied({ turnId, text }))
        } else {
          yield* ctx.rows(agentTurns).update({ reply: text, status: "failed" }, { where: { turn_id: turnId } })
          yield* ctx.emit(new Aborted({ turnId, reason: error }))
        }
        yield* ctx.connections.broadcast(new Done({ turnId }))
        yield* ctx.self.Idle.after("15 minutes", { key: "idle" })
      }),
      Idle: Effect.fn(function*(ctx) {
        if (Option.isSome(ctx.state.activeTurn)) return
        yield* Option.match(ctx.state.sandboxId, {
          onNone: () => Effect.void,
          onSome: (sandboxId) => Effect.andThen(ctx.perform(new PauseSandbox({ sandboxId })), ctx.emit(new SandboxPaused({ sandboxId })))
        })
      }),
      SandboxLost: Effect.fn(function*(ctx, { sandboxId }) {
        if (!Option.contains(ctx.state.sandboxId, sandboxId)) return // a stale report about an older sandbox
        yield* ctx.state.set({ sandboxId: Option.none(), sessionId: Option.none() })
        // a pending turn restarts the sandbox; SandboxReady then re-runs it
        if (Option.isSome(ctx.state.activeTurn)) yield* ctx.perform(new StartSandbox({ repo: ctx.state.repo }))
      }),

      // the client only listens: deltas come from the run loop's broadcasts
      Live: (_ctx, inbound) => inbound.pipe(Stream.drain),

      // the workflow body: request/reply on the owner is fine here, there is no turn to hold open
      Ship: Effect.fn(function*(ctx, { task }) {
        const ask = (name: string, text: string) =>
          Effect.gen(function*() {
            // the framework pipes Actor.commandId(`${executionId}:${name}`), so a retried activity is the same turn
            const turnId = yield* ctx.activity(name, {
              output: Schema.String,
              errors: [TurnFailed],
              run: ctx.owner.Prompt({ text }).pipe(
                // the owner's only framework reason here is NotCreated (Lifecycle.createdBy), and a workflow only exists
                // for a created owner: that is a bug, not an error to handle
                Effect.catchTag("ActorError", (e) => Effect.die(e)),
                // someone else is prompting: wait our turn, then give up with the workflow's own error
                Effect.retry({ while: (e) => e._tag === "TurnInProgress", schedule: Schedule.spaced("30 seconds").pipe(Schedule.upTo({ times: 20 })) }),
                Effect.catchTag("TurnInProgress", (e) => new TurnFailed({ turnId: e.turnId, reason: "the agent stayed busy for ten minutes" }))
              )
            })
            const reply = yield* ctx.waitFor(Replied, { where: (e) => e.turnId === turnId, timeout: "1 hour" })
            return yield* Option.match(reply, {
              onNone: () => new TurnFailed({ turnId, reason: "no reply within an hour" }),
              onSome: (e) => Effect.succeed(e.text)
            })
          })
        yield* ask("implement", `Implement this task, then stop: ${task}`)
        const summary = yield* ask("verify", "Run the test suite, fix what you broke, commit with a descriptive message, and summarise what you did.")
        return { turns: 2, summary }
      })
    }, {
      hooks: [
        // after Effects.retry is exhausted the effect is dead-lettered and this runs inside a turn (it may write)
        CodingAgent.onEffectFailed((ctx, effect, cause) =>
          Effect.gen(function*() {
            yield* Effect.logError(`${effect._tag} gave up`, cause)
            if (effect._tag === "RunPrompt" || effect._tag === "StartSandbox") {
              yield* Option.match(ctx.state.activeTurn, {
                onNone: () => Effect.void,
                onSome: ({ turnId }) =>
                  Effect.all([
                    ctx.state.set({ activeTurn: Option.none() }),
                    ctx.rows(agentTurns).update({ status: "failed" }, { where: { turn_id: turnId } }),
                    ctx.emit(new Aborted({ turnId, reason: `${effect._tag} failed` })),
                    ctx.connections.broadcast(new Done({ turnId }))
                  ], { discard: true })
              })
            }
          })),
        CodingAgent.onDefect((_ctx, command, cause) => Effect.logError(`defect in ${command}`, cause))
      ],
      effects: {
        // boot the sandbox and one OpenCode session; the session id lives in state so RunPrompt never creates one
        StartSandbox: (ctx, effect) =>
          Effect.gen(function*() {
            const sandbox = yield* sandboxes.create({ repo: effect.repo })
            const sessionId = yield* opencode.connect(sandbox.host).createSession
            yield* ctx.self.SandboxReady.send({ sandboxId: sandbox.id, sessionId })
          }),
        // `connect` resumes a paused sandbox; a sandbox that is gone is reported, not retried
        RunPrompt: (ctx, effect) =>
          sandboxes.connect(effect.sandboxId).pipe(
            Effect.flatMap((sandbox) => opencode.connect(sandbox.host).prompt(effect.sessionId, effect.text)),
            Effect.catchTag("SandboxGone", () => ctx.self.SandboxLost.send({ sandboxId: effect.sandboxId }))
          ),
        AbortPrompt: (_ctx, effect) =>
          sandboxes.connect(effect.sandboxId).pipe(
            Effect.flatMap((sandbox) => opencode.connect(sandbox.host).abort(effect.sessionId)),
            Effect.catchTag("SandboxGone", () => Effect.void) // nothing left to abort
          ),
        PauseSandbox: (_ctx, effect) => sandboxes.pause(effect.sandboxId)
      },
      // follows OpenCode's event bus while a turn is running: deltas to the connections, the reply back as an intent.
      // No transaction here; a crash mid-turn re-follows from the committed state on the next wake.
      run: (ctx) =>
        Stream.concat(Stream.succeed(ctx.state), ctx.state.changes).pipe(
          Stream.map((s) => Option.all({ turn: s.activeTurn, sandboxId: s.sandboxId, sessionId: s.sessionId })),
          // one subscription per turn, not per state write
          Stream.changesWith((a, b) => Option.getOrUndefined(a)?.turn.turnId === Option.getOrUndefined(b)?.turn.turnId),
          Stream.switchMap((target) =>
            Option.match(target, {
              onNone: () => Stream.empty,
              onSome: ({ turn, sandboxId, sessionId }) =>
                Stream.fromEffect(
                  Effect.gen(function*() {
                    // `vars.host` caches the sandbox host for this activation (decision 160); hibernation drops it
                    const host = yield* Option.match(ctx.vars.host, {
                      onNone: () => Effect.map(sandboxes.connect(sandboxId), (s) => s.host),
                      onSome: Effect.succeed
                    })
                    yield* ctx.vars.set({ host: Option.some(host) })
                    const text = yield* opencode.connect(host).events.pipe(
                      Stream.filter((e) => e.sessionId === sessionId),
                      Stream.takeUntil((e) => e._tag !== "Delta"),
                      Stream.tap((e) => e._tag === "Delta" ? ctx.connections.broadcast(new Delta({ turnId: turn.turnId, text: e.text })) : Effect.void),
                      Stream.runFold(() => ({ text: "", error: undefined as string | undefined }), (acc, e) =>
                        e._tag === "Delta" ? { ...acc, text: acc.text + e.text } : e._tag === "Error" ? { ...acc, error: e.reason } : acc)
                    )
                    yield* ctx.self.TurnDone.send({ turnId: turn.turnId, text: text.text, error: text.error })
                  }).pipe(
                    // failures by name (decision 149): transport noise is retried, a lost sandbox is the actor's decision
                    Effect.retry({ while: (e) => e._tag !== "SandboxGone", schedule: Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 5 })) }),
                    Effect.catchTag("SandboxGone", () => ctx.self.SandboxLost.send({ sandboxId })),
                    Effect.catchTags({
                      SandboxError: (e) => ctx.self.TurnDone.send({ turnId: turn.turnId, text: "", error: e.message }),
                      OpenCodeError: (e) => ctx.self.TurnDone.send({ turnId: turn.turnId, text: "", error: e.message })
                    })
                  )
                )
            })),
          Stream.runDrain
        )
    })
  })
)

// the transcript is committed rows: served from the caller's node without waking the activation
export const CodingAgentReads = CodingAgent.toQueryLayer({
  Transcript: (ctx, { limit }) =>
    ctx.rows(agentTurns).all({ orderBy: { column: "started_at", direction: "desc" }, limit }).pipe(
      Effect.map((rows) => rows.map((r) => ({ turnId: r.turn_id, prompt: r.prompt, reply: r.reply, status: r.status })))
    )
})
