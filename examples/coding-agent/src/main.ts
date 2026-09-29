/**
 * A coding agent is an ordinary actor: effects run the sandbox, a workflow ships a task in two
 * turns, and a singleton reaps orphaned sandboxes. Uses Postgres when DATABASE_URL is set,
 * otherwise an in-memory PGlite, and a stand-in sandbox provider:
 *   bun run start "add a --dry-run flag"
 */
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actor, User } from "@durable-actors/core"
import { Actors, Database } from "@durable-actors/core/runtime"
import { Config, Console, Effect, Layer, Option, Schema } from "effect"
import { AgentId, CodingAgent } from "./coding-agent/contract.ts"
import { CodingAgentLive } from "./coding-agent/layer.ts"
import { fakeLayer, fakeSandboxes } from "./coding-agent/sandbox.ts"
import { SandboxReaper } from "./sandbox-reaper/contract.ts"
import { SandboxReaperLive } from "./sandbox-reaper/layer.ts"

const tenant = "coding-agent-demo"

const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.option(Config.Redacted("DATABASE_URL"))

    return Option.isSome(url) ? Database.postgres({ url: url.value }) : Database.pglite()
  }),
)

/**
 * Runs the agent and reaper with a fake sandbox provider. Only the `demo` user
 * may call them; relay deliveries and workflow step commands skip the
 * authorize hook.
 */
const live = Layer.mergeAll(CodingAgentLive, SandboxReaperLive).pipe(
  Layer.provide(fakeLayer(fakeSandboxes())),
  Layer.provideMerge(
    Actors.layer({
      authorize: ({ caller, ref, kind }) =>
        Effect.succeed(
          (kind === "command" || kind === "query") &&
            ref.tenant === tenant &&
            Schema.is(User)(caller) &&
            caller.subject === "demo",
        ),
    }),
  ),
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
}).pipe(Actor.tenant(tenant), Actor.as(User.make({ subject: "demo" })))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
