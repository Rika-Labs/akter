import { Rule } from "@rikalabs/proof"

export default [
  Rule.noul({
    id: "responsibility-naming",
    statement:
      "Standalone exported functions must identify their specific operation, not merely say that work happens. A generic action name for a specific conversion, calculation, parser, or formatter is a violation: the caller should not need to inspect its body or parameter names to discover its purpose. A descriptive filename does not repair an uninformative standalone function name. Domain-scoped methods, framework-required entrypoints, local callbacks, and established mathematical names may keep their conventional names. Evaluate existing code, not only added lines.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: ["export function handle(text: string) { return text.replace(/<[^>]*>/g, '') }"],
      clean: [
        "export function stripHtmlTags(text: string) { return text.replace(/<[^>]*>/g, '') }",
        "export const tool = { name: 'strip_html', execute(input: { text: string }) { return stripHtmlTags(input.text) } }",
      ],
    },
  }),
  Rule.noul({
    id: "module-cohesion",
    statement:
      "A source module must not implement unrelated domain responsibilities in the same file. Independent operations from different domains belong in different modules, even when each function has a good name. Related operations serving one capability belong together. Wiring several capabilities in an application entrypoint, re-exporting a package API, and testing several cases are not unrelated implementations. Judge only the supplied code; do not assume unseen code is missing. This applies to existing file contents, not only added lines.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: [
        "export function shippingCost(weight: number) { return weight * 2 }\nexport function markdownHeading(text: string) { return '# ' + text }",
      ],
      clean: [
        "export function shippingCost(weight: number) { return weight * 2 }\nexport function shippingCostWithInsurance(weight: number, value: number) { return shippingCost(weight) + value * 0.01 }",
        "export { Shipping } from './shipping'\nexport { Markdown } from './markdown'",
      ],
    },
  }),
  Rule.noul({
    id: "valuable-comments",
    statement:
      "Code must not contain comments that merely repeat what the adjacent code explicitly says. Narrating an assignment, function call, loop, return, or deletion without explaining why is a violation. Decorative section labels, self-praise, and abandoned commented-out implementations are also violations. Keep comments explaining non-obvious reasons, constraints, units, security requirements, or workarounds. License notices, functional tool directives, prose documents, and comment text inside string literals are not violations. Evaluate comments anywhere in the supplied file contents; no added-line marker is required.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: [
        "// Increment the counter\ncount++",
        "// This elegant helper provides a robust, seamless implementation.\nreturn user.id",
        "// Old implementation:\n// return fetchAllUsers()",
      ],
      clean: [
        "// Sign the original bytes: parsing and re-encoding changes the provider's signature.\nverifySignature(rawBody)",
        "// Keep the old key until all sessions signed before rotation expire.\nkeys.retain(previousKey)",
        "/** Returns the byte offset, not a Unicode character index. */\nexport function offset() {}",
      ],
    },
  }),
  Rule.noul({
    id: "errors-preserved",
    statement:
      "Errors must keep their declared type and their cause. Swallowing a typed error into a bare Error, dropping the cause, catching broadly and returning a generic failure, or rethrowing without the original error are violations. Declared errors on a contract are never wrapped in ActorError or any other framework error — ActorError is reserved for the reasons the runtime itself produces (ActorUnavailable, MailboxFull, Timeout, CommandConflict, CommandExpired, InvalidCommandId, NotCreated, Unauthorized, InvalidInput, TransportError). Converting through Effect.catchTag/catchReasons into a typed error carrying the cause, or letting the declared error propagate, is clean. A deliberate fallback at the outermost HTTP boundary that renders the failure as a user-facing error response is also clean.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: [
        "try { return await call() } catch { throw new Error('command failed') }",
        "catch (e) { return Effect.fail(new ActorError({ reason: 'InvalidInput', message: 'failed' })) }",
        "Effect.catchAll(() => Effect.succeed(null))",
      ],
      clean: [
        "Effect.catchTag('HttpError', (cause) => new SessionExpired({ cause }))",
        "catch (cause) { throw new ActorError({ reason: 'TransportError', cause }) }",
        "return yield* command.execute(input)",
      ],
    },
  }),
  Rule.noul({
    id: "turn-transaction-boundary",
    statement:
      "A command handler runs inside one framework-owned transaction (fence, receipt, handler, commit). Inside a handler it is a violation to: perform best-effort side effects that must be durable (use ctx.perform/intents instead), call another actor's request/reply handle directly instead of an intent, open a second database transaction, or do unbounded work that outlives the turn. Effects scheduled through ctx, events emitted through ctx, and state writes through the context stay inside the transaction and are clean. Outside a turn — run loops, streams, connection handlers, workflow bodies — the same calls are fine because the runtime drives them through turns.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: [
        "handler: (ctx, input) => Effect.gen(function* () { yield* ctx.actors.get(Other, id).Notify.send({}) ; yield* ctx.state.update(...) })",
        "handler: (ctx) => sql.unsafe('UPDATE users SET ...')",
      ],
      clean: [
        "handler: (ctx, input) => Effect.gen(function* () { yield* ctx.self.Ship.start(input); yield* ctx.emit(Started(input)) })",
        "handler: (ctx, input) => ctx.perform('send-email', { run: () => resend.send(input) })",
      ],
    },
  }),
  Rule.noul({
    id: "contract-runtime-separation",
    statement:
      "Contract-side code — the durable-actors root entry, the client entry, and actor contract.ts files — must stay browser-safe and free of runtime machinery. Importing effect/unstable/sql, effect/unstable/cluster, @effect/sql-pg, or packages/durable-actors/src/runtime internals from contract files is a violation. Only runtime/ and testing/ code may touch those modules; contract files reference the Database tag and Drizzle types only. Server-side handler code (layer.ts, effects/, workflows/) may import services but still goes through the Actors tag, not the runtime internals directly.",
    severity: "request-changes",
    threshold: 0.85,
    include: ["packages/durable-actors/**", "packages/deployments/**", "examples/**"],
    examples: {
      violate: [
        "// contract.ts\nimport { SqlClient } from 'effect/unstable/sql'\nexport const Users = Actor.make('users', { ... })",
        "import { PgClient } from '@effect/sql-pg'\nexport const Counter = Actor.make('counter', { commands: [...] })",
      ],
      clean: [
        "// contract.ts\nimport { Actor } from 'durable-actors'\nexport const Counter = Actor.make('counter', { commands: [Actor.command('increment')] })",
        "// layer.ts\nexport const layer = Counter.toLayer({ increment: (ctx, input) => ctx.state.update(...) })",
      ],
    },
  }),
  Rule.noul({
    id: "durable-transition-tests",
    statement:
      "Every durable transition needs a failure-path test. Adding a command handler, a state migration step, an effect with retry/dead-letter, a workflow, a hibernation boundary, or a timer without a test that exercises the failure side (rollback, replay, upcast from a seeded older row, dead-letter, rehydration after interruption) is a violation. Happy-path tests alone do not satisfy this. Pure queries, projections of committed state, one-off operational scripts, and unchanged behavior with existing failure coverage are clean.",
    severity: "request-changes",
    threshold: 0.85,
    include: ["packages/durable-actors/**", "packages/deployments/**", "examples/**"],
    examples: {
      violate: [
        "it('increments', () => Effect.gen(function* () { const c = yield* test.get(Counter, 'a'); expect(yield* c.Increment.send({})).toBe(1) }))",
        "migrations: [Actor.migration(StateV1, StateV2, upcast)] // with only V2-shape tests",
      ],
      clean: [
        "it('rolls back a failed turn and replays the declared failure', () => Effect.gen(function* () { const c = yield* test.get(Counter, 'a'); const exit = yield* c.Charge.send({ amount: -1 }).pipe(Effect.exit); expect(Exit.isFailure(exit)).toBe(true); expect(yield* c.Balance.query()).toBe(0) }))",
        "it('upcasts a seeded V1 state row on the next turn', () => ...)",
      ],
    },
  }),
  Rule.noul({
    id: "no-placeholder-tests",
    statement:
      "Tests must assert behavior. it.todo, a test that only expects no throw, expect(true), or a snapshot of scaffolding presented as coverage are violations. A placeholder it(...) reserved for a task that does not exist yet is also a violation — add the test with the first real behavior. Skipping a genuinely environment-gated case with a reason comment is clean.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: [
        "it('works', () => { expect(true).toBe(true) })",
        "it.todo('handles rollback')",
        "it('creates the actor', async () => { await create() })",
      ],
      clean: [
        "it('rejects a second writer with CommandConflict', () => ...)",
        "it.skipIf(!process.env.TEST_DATABASE_URL)('fences on Postgres', () => ...)",
      ],
    },
  }),
  Rule.noul({
    id: "no-ai-surface",
    statement:
      "The framework ships no AI-specific surface. Adding Actor.toolkit, Actor.mcp, MCP server glue, llms.txt generation, agent-specific options on serve, or framework features that exist only for LLM consumers is a violation — OpenAPI output is what tool generators consume. Building an agent as an ordinary actor (like examples/coding-agent) that uses contracts, receipts, events, effects, workflows and connections is clean.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: ["Actor.mcp({ tools: [...] })", "serve({ actors, ai: { generateLlmsTxt: true } })"],
      clean: [
        "export const CodingAgent = Actor.make('coding-agent', { commands: [...], workflows: [...], connections: [...] })",
        "serve({ actors: [Counter], openapi: true })",
      ],
    },
  }),
  Rule.noul({
    id: "docs-authority-metadata",
    statement:
      "Every document under docs/ keeps its header metadata block: a Responsibility line, an Authority line, an Owner role line, and a Change policy line, immediately under the title. Removing these lines, leaving a placeholder, or adding a spec document without them is a violation. Documents that are pure indexes (README.md files listing sibling documents) may omit Owner role and Change policy.",
    severity: "request-changes",
    threshold: 0.85,
    include: ["docs/**"],
    examples: {
      violate: ["# Command turns\n\nThis document describes how turns work."],
      clean: [
        "# Command turns\n\n**Responsibility:** what a command turn does.  \n**Authority:** contract.  \n**Owner role:** runtime architecture.  \n**Change policy:** requires an ADR.\n\nA command turn is ...",
      ],
    },
  }),
]
