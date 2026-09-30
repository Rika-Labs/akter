import { Content, type ContentRef } from "@durable-actors/core"
import { sweepContent } from "@durable-actors/core/testing"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Shelf } from "../probe/archive.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/** Incompressible bytes of `size`, distinct per `variant`. */
const bytesOf = (size: number, variant: number) => {
  const bytes = new Uint8Array(size)
  let state = (size * 31 + variant * 7919 + 17) >>> 0

  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    bytes[index] = state >>> 24
  }

  return bytes
}

const upload = (bytes: Uint8Array) => Content.upload(bytes).pipe(Effect.orDie)

/**
 * Which of `distinct` items the `index`th upload of a skewed set is: item
 * `k` is drawn about twice as often as item `2k`, as a few popular logos and
 * templates are uploaded by many users.
 */
const skewed = (index: number, distinct: number) => {
  const u = ((Math.imul(index + 1, 2_654_435_761) >>> 0) % 1_000_000) / 1_000_000

  return Math.min(distinct - 1, Math.floor(Math.exp(u * Math.log(distinct + 1)) - 1))
}

const storedBytes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{ contents: number; bytes: number }>`
    SELECT (SELECT count(*)::int FROM tenant_contents) AS contents,
      (SELECT COALESCE(sum(octet_length(bytes)), 0)::float8 FROM tenant_content_chunks) AS bytes`

  return row!
}).pipe(Effect.orDie)

/** Tenant-scoped content: dedup, upload, attach, read, and sweep costs. */
export const contentBlobs: Scenario = {
  name: "content-blobs",
  description:
    "Shared content: deduplication of a skewed upload set, upload, attach, and read latency by size, and sweep cost per thousand candidates.",
  run: (context) =>
    Effect.gen(function* () {
      const results: Array<CaseResult> = []

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const size = 64 * 1024
            const distinct = context.quick ? 50 : 200
            const uploads = context.quick ? 500 : 2000

            const result = yield* measure({
              name: "dedup-skewed",
              parameters: { size, distinct, uploads, workers: 8 },
              instruments,
              workers: 8,
              operations: uploads,
              operation: (index) => upload(bytesOf(size, skewed(index, distinct))),
            })

            const stored = yield* storedBytes

            return {
              ...result,
              extra: {
                storedContents: stored.contents,
                storedBytes: stored.bytes,
                uploadedBytes: uploads * size,
                dedupRatio: Math.round(((uploads * size) / stored.bytes) * 100) / 100,
              },
            }
          }),
        ),
      )

      for (const size of [4 * 1024, 1024 * 1024, 8 * 1024 * 1024])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            measure({
              name: `upload-${size / 1024}k`,
              parameters: { size, workers: 1 },
              instruments,
              workers: 1,
              operations: context.quick ? 20 : size > 1024 * 1024 ? 50 : 300,
              operation: (index) => upload(bytesOf(size, index)),
              listStatements: true,
            }),
          ),
        )

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const ref = yield* upload(bytesOf(4096, 0))
            const shelf = yield* Shelf.get("attach")

            return yield* measure({
              name: "attach",
              parameters: { workers: 1 },
              instruments,
              workers: 1,
              operations: context.quick ? 300 : 3000,
              operation: (index) => shelf.Attach({ name: `f${index}`, ref }),
              listStatements: true,
            })
          }),
        ),
      )

      for (const size of [4 * 1024, 1024 * 1024])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const ref: ContentRef = yield* upload(bytesOf(size, 1))
              const shelf = yield* Shelf.get("read")
              yield* shelf.Attach({ name: "file", ref }).pipe(Effect.orDie)

              return yield* measure({
                name: `read-${size / 1024}k`,
                parameters: { size, workers: 1 },
                instruments,
                workers: 1,
                operations: context.quick ? 100 : 1000,
                operation: () => shelf.Size("file"),
                listStatements: true,
              })
            }),
          ),
        )

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const candidates = 1000

            for (let index = 0; index < candidates; index += 1)
              yield* upload(bytesOf(1024, 10_000 + index))

            const shelf = yield* Shelf.get("sweep")

            for (let index = 0; index < candidates; index += 2)
              yield* shelf
                .Attach({ name: `f${index}`, ref: yield* upload(bytesOf(1024, 10_000 + index)) })
                .pipe(Effect.orDie)

            yield* sql`UPDATE tenant_contents SET granted_until_ms = 0`.pipe(Effect.orDie)

            return yield* measure({
              name: "sweep-1000",
              parameters: { candidates, referenced: candidates / 2, workers: 1 },
              instruments,
              workers: 1,
              operations: 1,
              operation: () => sweepContent,
              listStatements: true,
            })
          }),
        ),
      )

      return results
    }),
}
