import { Effect } from "effect"
import { load } from "../measure.ts"
import { Archive } from "../probe/archive.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const KIB = 1024

/** Sizes with every case; 16 and 32 KiB add `set` only, beside the state-size rewrite band. */
const SIZES = [4 * KIB, 64 * KIB, 1024 * KIB]

const SET_ONLY = [16 * KIB, 32 * KIB]

const CHUNKS = 16

/**
 * Blob cost by entry size on one warm actor per case: replacing an entry,
 * appending a chunk, reading a one-chunk and a 16-chunk entry from a query,
 * and compacting 16 chunks into one. Bytes are generated in the handler, so
 * no case pays for a large command payload.
 */
export const blobs: Scenario = {
  name: "blobs",
  description:
    "turn.blob set and append turns, read.blob reads of one-chunk and 16-chunk entries, and compact of 16 chunks, at 4 KiB, 64 KiB, and 1 MiB (set also at 16 and 32 KiB).",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []

      for (const size of quick
        ? [4 * KIB, 1024 * KIB]
        : [...SIZES, ...SET_ONLY].sort((a, b) => a - b)) {
        const large = size >= 1024 * KIB
        const writes = quick ? 20 : large ? 100 : 500
        const reads = quick ? 50 : large ? 200 : 1000
        const compactions = quick ? 10 : large ? 50 : 200
        const setOnly = SET_ONLY.includes(size)
        const parameters = { blobBytes: size, workers: 1 }

        results.push(
          ...(yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const cases: Array<CaseResult> = []
              const writer = yield* Archive.get("set")
              const put = (index: number) => writer.Put({ name: "doc", size, variant: index % 8 })
              yield* load({ workers: 1, operations: 20, operation: put })

              cases.push(
                yield* measure({
                  name: `set-${size}`,
                  parameters,
                  instruments,
                  workers: 1,
                  operations: writes,
                  operation: put,
                  listStatements: true,
                }),
              )

              if (setOnly) return cases

              const appender = yield* Archive.get("append")
              const add = (index: number) => appender.Add({ name: "log", size, variant: index % 8 })
              yield* load({ workers: 1, operations: 20, operation: add })

              cases.push(
                yield* measure({
                  name: `append-${size}`,
                  parameters,
                  instruments,
                  workers: 1,
                  operations: writes,
                  operation: add,
                  listStatements: true,
                }),
              )

              const reader = yield* Archive.get("read")
              yield* reader.Put({ name: "doc", size, variant: 0 }).pipe(Effect.orDie)

              for (let chunk = 0; chunk < CHUNKS; chunk += 1)
                yield* reader
                  .Add({ name: "chunked", size: size / CHUNKS, variant: chunk })
                  .pipe(Effect.orDie)

              for (const [name, entry, chunks] of [
                [`read-${size}`, "doc", 1],
                [`read-${CHUNKS}-chunks-${size}`, "chunked", CHUNKS],
              ] as const) {
                const read = () => reader.Length(entry)
                yield* load({ workers: 1, operations: 50, operation: read })

                cases.push(
                  yield* measure({
                    name,
                    parameters: { ...parameters, chunks },
                    instruments,
                    workers: 1,
                    operations: reads,
                    operation: read,
                  }),
                )
              }

              // Each operation compacts its own entry of 16 chunks, so none is already compact.
              const compactor = yield* Archive.get("compact")

              for (let entry = 0; entry < compactions + 5; entry += 1)
                for (let chunk = 0; chunk < CHUNKS; chunk += 1)
                  yield* compactor
                    .Add({ name: `entry-${entry}`, size: size / CHUNKS, variant: chunk })
                    .pipe(Effect.orDie)

              yield* load({
                workers: 1,
                operations: 5,
                operation: (index) => compactor.Compact(`entry-${compactions + index}`),
              })

              cases.push(
                yield* measure({
                  name: `compact-${CHUNKS}-chunks-${size}`,
                  parameters: { ...parameters, chunks: CHUNKS },
                  instruments,
                  workers: 1,
                  operations: compactions,
                  operation: (index) => compactor.Compact(`entry-${index}`),
                  listStatements: true,
                }),
              )

              return cases
            }),
          )),
        )
      }

      return results
    }),
}
