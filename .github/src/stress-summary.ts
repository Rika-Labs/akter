import { BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, FileSystem, ManagedRuntime, Option, Schema } from "effect"
import { stressSummary, tallyFlakes, VitestReport } from "./stress.ts"

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  await runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* Config.String("STRESS_DIR")
      const runs = yield* Config.Int("STRESS_RUNS")
      const suites = (yield* Config.String("STRESS_SUITES")).split(" ")

      const reports = yield* Effect.forEach(
        Array.from({ length: runs }, (_, i) => i + 1).flatMap((run) =>
          suites.map((suite) => ({ suite, run: `${suite}-${run}` })),
        ),
        ({ suite, run }) =>
          Effect.all({
            report: fs
              .readFileString(`${directory}/${run}.json`)
              .pipe(Effect.flatMap(Schema.decodeEffect(VitestReport)), Effect.option),
            status: fs.readFileString(`${directory}/${run}.status`).pipe(
              Effect.map((text) => text.trim()),
              Effect.flatMap(Schema.decodeEffect(Schema.FiniteFromString)),
              Effect.option,
            ),
            log: fs.readFileString(`${directory}/${run}.log`).pipe(Effect.option),
          }).pipe(
            Effect.map(({ report, status, log }) => ({
              run,
              suite,
              report: Option.getOrUndefined(report),
              status: Option.getOrUndefined(status),
              unhandledErrors: Option.exists(log, (text) =>
                /Vitest caught \d+ unhandled errors?/.test(text),
              ),
            })),
          ),
      )

      const flakes = tallyFlakes(reports)
      const summary = stressSummary({ runs, flakes })
      yield* Console.log(summary)

      const summaryPath = yield* Config.option(Config.String("GITHUB_STEP_SUMMARY"))

      if (Option.isSome(summaryPath))
        yield* fs.writeFileString(summaryPath.value, `## Stress\n\n${summary}`, { flag: "a" })

      for (const { name, failed } of flakes)
        yield* Console.log(`::error title=Flaky case::${name} failed in runs ${failed.join(", ")}`)

      if (flakes.length > 0) return yield* Effect.die(new Error("Stress found failing cases"))
    }),
  )
} finally {
  await runtime.dispose()
}
