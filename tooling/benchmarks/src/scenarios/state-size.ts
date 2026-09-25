import { Effect } from "effect"
import { load, summarize } from "../measure.ts"
import { Probe, SleepyProbe } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"
import { HIBERNATION_WAIT, reactivated } from "./cold-activation.ts"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

/** Seeded alphanumeric text: roughly what zstd sees from ids and tokens, not a best case. */
const text = (length: number, seed: number) => {
  let state = seed >>> 0
  let out = ""

  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    out += ALPHABET[state % ALPHABET.length]
  }

  return out
}

/** Stored state is zstd-compressed JSON; this times the codec alone, off the database. */
const codec = (json: string) => {
  const bytes = new TextEncoder().encode(json)
  const compressTimes: Array<number> = []
  const decompressTimes: Array<number> = []
  let compressed = Bun.zstdCompressSync(bytes)

  for (let index = 0; index < 200; index += 1) {
    const start = performance.now()
    compressed = Bun.zstdCompressSync(bytes)
    const middle = performance.now()
    new TextDecoder().decode(Bun.zstdDecompressSync(compressed))
    compressTimes.push(middle - start)
    decompressTimes.push(performance.now() - middle)
  }

  return {
    compressedBytes: compressed.byteLength,
    zstdCompressP50Ms: summarize(compressTimes).p50,
    zstdDecompressP50Ms: summarize(decompressTimes).p50,
  }
}

/** Largest blob the default 65,536-byte `maxStateBytes` admits with the counter and JSON framing. */
const SIZES = [256, 4096, 16_384, 32_768, 61_440]

/**
 * Cost of stored state size up to the default `maxStateBytes`: rewriting the
 * whole blob each turn, holding it while a small key changes, and waking an
 * actor that must read and decompress it.
 */
export const stateSize: Scenario = {
  name: "state-size",
  description:
    "State growing toward the default maxStateBytes (65,536): rewrite the blob every turn, hold it while touching a counter, and wake an actor that stores it.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const operations = quick ? 50 : 500
      const sleepers = quick ? 20 : 100
      const results: Array<CaseResult> = []

      for (const bytes of quick ? [256, 16_384] : SIZES) {
        const blobs = Array.from({ length: 8 }, (_, index) => text(bytes, bytes + index))
        const stored = codec(`{"blob":"${blobs[0]!}","count":1}`)

        results.push(
          ...(yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const writer = yield* Probe.get("rewrite")
              const holder = yield* Probe.get("hold")
              yield* holder.Fill(blobs[0]!).pipe(Effect.orDie)
              yield* load({
                workers: 1,
                operations: 20,
                operation: (index) => writer.Fill(blobs[index % 8]!),
              })

              const rewrite = yield* measure({
                name: `rewrite-${bytes}`,
                parameters: { stateBytes: bytes, workers: 1 },
                instruments,
                workers: 1,
                operations,
                operation: (index) => writer.Fill(blobs[index % 8]!),
                extra: stored,
              })

              const hold = yield* measure({
                name: `hold-${bytes}`,
                parameters: { stateBytes: bytes, workers: 1 },
                instruments,
                workers: 1,
                operations,
                operation: () => holder.Add(1),
              })

              const sleeper = (index: number) => SleepyProbe.get(`sleepy-${index}`)

              yield* load({
                workers: 8,
                operations: sleepers,
                operation: (index) =>
                  sleeper(index).pipe(Effect.flatMap((probe) => probe.Fill(blobs[index % 8]!))),
              })
              yield* Effect.sleep(HIBERNATION_WAIT)

              const wake = yield* measure({
                name: `wake-${bytes}`,
                parameters: { stateBytes: bytes, workers: 1, hibernateAfterMs: 250 },
                instruments,
                workers: 1,
                operations: sleepers,
                operation: (index) => sleeper(index).pipe(Effect.flatMap((probe) => probe.Add(1))),
              })

              return [
                rewrite,
                hold,
                { ...wake, extra: { reactivatedFraction: yield* reactivated } },
              ]
            }),
          )),
        )
      }

      return results
    }),
}
