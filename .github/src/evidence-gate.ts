import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, ManagedRuntime, Schema } from "effect"
import { github } from "../../infra/src/github.ts"
import { evidencePolicy } from "./policy.ts"

const RunEvent = Schema.fromJsonString(
  Schema.Struct({
    workflow_run: Schema.Struct({
      id: Schema.Int,
      event: Schema.String,
      path: Schema.String,
      head_sha: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      repository: Schema.Struct({ full_name: Schema.String }),
      pull_requests: Schema.Array(Schema.Struct({ number: Schema.Int })),
    }),
  }),
)

const runtime = ManagedRuntime.make(BunServices.layer)

const settings = await runtime.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const event = yield* Schema.decodeEffect(RunEvent)(
      yield* fs.readFileString(yield* Config.String("GITHUB_EVENT_PATH")),
    )

    const repository = yield* Config.String("GITHUB_REPOSITORY")

    return { event, repository }
  }),
)

const run = settings.event.workflow_run

const [owner = "", repo = ""] = settings.repository.split("/")

if (run.event !== "pull_request" || run.path !== ".github/workflows/ci.yml")
  throw new Error("Unexpected verification workflow")

try {
  for (const linked of run.pull_requests) {
    const pr = await github.getPull(owner, repo, linked.number)

    if (pr.head.sha !== run.head_sha) continue
    let conclusion: "success" | "failure" = "success"

    let summary =
      "Successful verification run has a nonempty current-SHA artifact; review and human merge approval remain required."

    try {
      const base = await github.contentSha(owner, repo, pr.baseSha, ".github/workflows/ci.yml")
      const head = await github.contentSha(owner, repo, pr.head.sha, ".github/workflows/ci.yml")

      if (base === undefined || head === undefined || base !== head)
        throw new Error(
          "Verification workflow changed: requires a separately approved policy rollout",
        )

      const found = (await github.artifacts(owner, repo, run.id)).artifacts.find(
        (a) => a.name === `evidence-${pr.head.sha}`,
      )

      if (found === undefined) throw new Error("Current-SHA evidence artifact missing")
      evidencePolicy({
        currentSha: pr.head.sha,
        runSha: run.head_sha,
        conclusion: run.conclusion ?? "unknown",
        event: run.event,
        repository: settings.repository,
        runRepository: run.repository.full_name,
        artifact: { name: found.name, expired: found.expired, size: found.size_in_bytes },
      })
    } catch (error) {
      conclusion = "failure"
      summary = String(error)
    }

    await github.check(owner, repo, pr.head.sha, conclusion, summary)
  }
} finally {
  await github.dispose()
  await runtime.dispose()
}
