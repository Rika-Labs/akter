import { DateTime, Deferred, Effect, Layer } from "effect"
import { Intent } from "durable-actors"
import { Probe, Sender, Sink, SleepyProbe } from "./contract.ts"
import { ArchiveLive } from "./archive.ts"
import { LedgerLive } from "./ledger.ts"
import { ProbeReads, SleepyProbeReads } from "./queries.ts"

const ProbeCommands = Probe.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Probe.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
    Fill: Effect.fnUntraced(function* (blob: string) {
      const turn = yield* Probe.Turn
      yield* turn.state.set({ blob, count: turn.state.count + 1 })

      return blob.length
    }),
  }),
)

const SleepyProbeCommands = SleepyProbe.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* SleepyProbe.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
    Fill: Effect.fnUntraced(function* (blob: string) {
      const turn = yield* SleepyProbe.Turn
      yield* turn.state.set({ blob, count: turn.state.count + 1 })

      return blob.length
    }),
  }),
)

/**
 * Pending deliveries by intent payload. A benchmark registers an id before
 * sending it, and the sink's handler completes it when the relay delivers.
 * A handler that runs twice (a retried turn) completes an already-done
 * Deferred, which is a no-op.
 */
export const deliveries = new Map<string, Deferred.Deferred<void>>()

/** Sinks are spread over this many actors, so deliveries don't queue behind one activation. */
export const SINKS = 64

export const sinkOf = (id: string) => `sink-${Number(id.split("-").at(-1)) % SINKS}`

const SinkCommands = Sink.toLayer(
  Effect.succeed({
    Deliver: (id: string) =>
      Effect.suspend(() => {
        const pending = deliveries.get(id)

        return pending === undefined ? Effect.void : Deferred.succeed(pending, undefined)
      }).pipe(Effect.asVoid),
  }),
)

const SenderCommands = Sender.toLayer(
  Effect.succeed({
    Send: Effect.fnUntraced(function* (id: string) {
      yield* (yield* Sink.intents(sinkOf(id))).Deliver(id)
    }),
    SendAt: Effect.fnUntraced(function* ({ ids, atMs }) {
      for (const id of ids)
        yield* (yield* Sink.intents(sinkOf(id)))
          .Deliver(id)
          .pipe(Intent.at(DateTime.makeUnsafe(atMs)))
    }),
  }),
)

/**
 * SleepyProbe registers first: Cluster's entity reaper fixes its first sweep
 * interval from the first registration (at most 30 seconds), and a short
 * `hibernateAfter` only shortens later sweeps.
 */
export const ProbeLive = Layer.mergeAll(
  SleepyProbeCommands,
  SleepyProbeReads,
  ProbeCommands,
  ProbeReads,
  SinkCommands,
  SenderCommands,
  LedgerLive,
  ArchiveLive,
)
