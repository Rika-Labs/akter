import { BunServices } from "@effect/platform-bun"
import { Console, Effect, ManagedRuntime, Schema } from "effect"

/** The commit statuses a release requires; local verification posts them on the exact head. */
export const requiredStatuses = ["verify", "branch"] as const

export interface CommitStatus {
  readonly context: string
  readonly state: string
}

/**
 * Decides whether a commit may be released from its commit statuses, newest first as the GitHub
 * statuses API lists them. Only the newest status of a context counts, so a red rerun after a
 * green one blocks the release and a green rerun after a red one allows it; a context that never
 * reported, or whose newest state is anything but `success`, blocks it.
 */
export function releaseGate(statuses: ReadonlyArray<CommitStatus>) {
  for (const context of requiredStatuses) {
    const newest = statuses.find((status) => status.context === context)
    if (newest === undefined) throw new Error(`No commit status ${context} on the tagged commit`)
    if (newest.state !== "success")
      throw new Error(`Commit status ${context} is ${newest.state}, not success`)
  }
}

const Status = Schema.fromJsonString(
  Schema.Struct({ context: Schema.String, state: Schema.String }),
)

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* Effect.promise(() => Bun.stdin.text())
        const decode = Schema.decodeEffect(Status)
        const statuses = yield* Effect.forEach(
          input.split("\n").filter((line) => line.trim() !== ""),
          (line) => decode(line),
        )
        releaseGate(statuses)
        yield* Console.log(
          `Commit statuses on the tagged commit: ${requiredStatuses.map((context) => `${context}=${statuses.find((status) => status.context === context)?.state}`).join(", ")}`,
        )
      }),
    )
  } finally {
    await runtime.dispose()
  }
}
