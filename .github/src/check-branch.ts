import { BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, FileSystem, ManagedRuntime, Schema } from "effect"
import { branchPolicy } from "./policy.ts"

const Pull = Schema.fromJsonString(
  Schema.Struct({
    pull_request: Schema.Struct({
      base: Schema.Struct({ ref: Schema.String }),
      head: Schema.Struct({ ref: Schema.String }),
      user: Schema.Struct({ login: Schema.String }),
    }),
  }),
)

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  await runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Config.String("GITHUB_EVENT_PATH")
      const { pull_request: pr } = yield* Schema.decodeEffect(Pull)(yield* fs.readFileString(path))
      branchPolicy({ base: pr.base.ref, branch: pr.head.ref, author: pr.user.login })
      yield* Console.log("Main-only issue-linked branch policy passed")
    }),
  )
} finally {
  await runtime.dispose()
}
