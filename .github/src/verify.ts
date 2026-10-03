import { Config, Effect, Option, Schedule, Schema } from "effect"
import { BunRuntime } from "@effect/platform-bun"

interface Check {
  readonly command: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>>
}

const missingProcess = Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))

const signalGroup = (pid: number, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    try {
      process.kill(-pid, signal)
    } catch (cause) {
      if (!missingProcess(cause)) throw cause
    }
  })

const groupAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(-pid, 0)
      return true
    } catch (cause) {
      if (missingProcess(cause)) return false
      throw cause
    }
  })

/** Runs independent checks in owned process groups so failure or interruption also terminates their test-worker descendants. */
export const runChecks = (checks: ReadonlyArray<Check>) =>
  Effect.scoped(
    Effect.forEach(
      checks,
      (check) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn([...check.command], {
              env: { ...Bun.env, ...check.env },
              stdout: "inherit",
              stderr: "inherit",
              detached: true,
            }),
          ),
          (child) =>
            Effect.gen(function* () {
              yield* signalGroup(child.pid, "SIGTERM")
              const ended = yield* groupAlive(child.pid).pipe(
                Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (alive) => !alive }),
                Effect.timeoutOption("5 seconds"),
              )
              if (Option.isNone(ended)) {
                yield* signalGroup(child.pid, "SIGKILL")
              }
              yield* Effect.promise(() => child.exited)
            }),
        ).pipe(
          Effect.flatMap((child) => Effect.promise(() => child.exited)),
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.die(new Error(`${check.command[0]} verification failed with exit ${code}`)),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    ),
  )

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* () {
      const nodeReplica = yield* Config.String("TEST_NODE_REPLICA_DATABASE_URL")
      const nodeDatabase = yield* Config.String("TEST_NODE_DATABASE_URL")
      yield* runChecks([
        {
          command: ["bun", "run", "test:node:core"],
          env: { TEST_DATABASE_URL: nodeDatabase, TEST_REPLICA_DATABASE_URL: nodeReplica },
        },
        {
          command: [
            "bun",
            "run",
            "turbo",
            "run",
            "lint",
            "lint:root",
            "typecheck",
            "test",
            "build",
            "test:integration",
            "test:e2e",
            "--concurrency=100%",
            "--summarize",
            ...process.argv.slice(2),
          ],
        },
      ])
    }),
  )
}
