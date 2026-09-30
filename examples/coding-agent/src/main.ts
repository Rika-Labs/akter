/**
 * A coding agent is an ordinary actor: effects run the sandbox, a workflow ships a task in two
 * turns, and a singleton reaps orphaned sandboxes. Uses Postgres when DATABASE_URL is set,
 * otherwise an in-memory PGlite, and a stand-in sandbox provider:
 *   bun run start "add a --dry-run flag"
 */
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actors, Database } from "@durable-actors/core/runtime"
import { Config, Console, Effect, Layer, Option } from "effect"
import { AgentId, CodingAgent } from "./coding-agent/contract.ts"
import { CodingAgentLive } from "./coding-agent/layer.ts"
import { fakeLayer, fakeSandboxes } from "./coding-agent/sandbox.ts"
import { SandboxReaper } from "./sandbox-reaper/contract.ts"
import { SandboxReaperLive } from "./sandbox-reaper/layer.ts"

const DatabaseLive = Layer.unwrap(
  Effect.map(
    Config.option(Config.Redacted("DATABASE_URL")),
    Option.match({ onNone: () => Database.pglite(), onSome: (url) => Database.postgres({ url }) }),
  ),
)

/**
 * Runs the agent and reaper with a fake sandbox provider. The demo calls them
 * from this process, so it runs as the trusted process caller and needs no
 * access policy; nothing is served.
 */
const live = Layer.mergeAll(CodingAgentLive, SandboxReaperLive).pipe(
  Layer.provide(fakeLayer(fakeSandboxes())),
  Layer.provideMerge(Actors.layer()),
  Layer.provide(DatabaseLive),
  Layer.provide(BunCrypto.layer),
)

const program = Effect.gen(function* () {
  const task = Bun.argv[2] ?? "add a --dry-run flag"
  const agent = yield* CodingAgent.get(AgentId.make("demo"))
  yield* agent.Start({ repo: "github.com/acme/app" })

  const ship = yield* agent.Ship({ task })
  yield* Console.log({ execution: ship.executionId, result: yield* ship.result })

  for (const { status, prompt, reply } of yield* agent.Transcript({ limit: 10 }))
    yield* Console.log(`[${status}] ${prompt}\n  -> ${reply}`)

  yield* (yield* SandboxReaper.get()).Sweep()
})

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
