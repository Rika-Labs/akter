import { ConfigProvider, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { guard } from "./guard.ts"

const run = (input: {
  readonly operation: string | undefined
  readonly stage: string | undefined
  readonly ci: boolean
}) =>
  Effect.exit(
    guard({ operation: input.operation, stage: input.stage }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ GITHUB_ACTIONS: String(input.ci) }),
      ),
    ),
  )

describe("operation guard", () => {
  it("lets CI deploy every stage and destroy a pull request preview", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const [operation, stage] of [
          ["deploy", "preview"],
          ["deploy", "prod"],
          ["deploy", "pr-12"],
          ["destroy", "pr-12"],
        ])
          expect((yield* run({ operation, stage, ci: true }))._tag).toBe("Success")
      }),
    ))

  it("never destroys production or the preview stage from CI", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const stage of ["prod", "preview"]) {
          const outcome = yield* run({ operation: "destroy", stage, ci: true })
          expect(outcome._tag).toBe("Failure")
          expect(String(outcome)).toContain(`Stage ${stage} is never destroyed from CI`)
        }
      }),
    ))

  it("leaves their destruction to an operator at a terminal", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const stage of ["prod", "preview"])
          expect((yield* run({ operation: "destroy", stage, ci: false }))._tag).toBe("Success")
      }),
    ))

  it("refuses an unknown stage, a missing stage and an unknown operation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const [operation, stage] of [
          ["deploy", "staging"],
          ["destroy", "dev"],
          ["deploy", undefined],
          ["plan", "prod"],
          [undefined, "prod"],
        ])
          expect((yield* run({ operation, stage, ci: false }))._tag).toBe("Failure")
      }),
    ))
})
