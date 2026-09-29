import { Clock, DateTime, Deferred, Effect, Layer } from "effect"
import { Intent } from "@durable-actors/core"
import {
  CronProbe,
  EventProbe,
  Probe,
  ResidentProbe,
  RetentionProbe,
  Sender,
  Sink,
  SleepyProbe,
  Ticked,
} from "./contract.ts"
import { EffectProbeLive } from "./effects.ts"
import { ArchiveLive } from "./archive.ts"
import { LedgerLive } from "./ledger.ts"
import { MintLive } from "./mint.ts"
import { EventProbeReads, ProbeReads, SleepyProbeReads } from "./queries.ts"
import { ReducerProbeLive } from "./reducers.ts"
import { WorkflowProbeLive } from "./workflows.ts"

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
    Weigh: Effect.fnUntraced(function* (payload: string) {
      const turn = yield* Probe.Turn
      yield* turn.state.set({ count: turn.state.count + 1 })

      return payload.length
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

const ResidentProbeCommands = ResidentProbe.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* ResidentProbe.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
  }),
)

const EventProbeCommands = EventProbe.toLayer(
  Effect.succeed({
    Emit: Effect.fnUntraced(function* (count: number) {
      const turn = yield* EventProbe.Turn

      for (let n = 0; n < count; n++) yield* turn.emit(Ticked.make({ n }))

      return count
    }),
  }),
)

const RetentionProbeCommands = RetentionProbe.toLayer(
  Effect.succeed({
    Emit: Effect.fnUntraced(function* (count: number) {
      const turn = yield* RetentionProbe.Turn

      for (let n = 0; n < count; n++) yield* turn.emit(Ticked.make({ n }))

      return count
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
    SendMany: Effect.fnUntraced(function* ({ offset, count, atMs }) {
      for (let index = offset; index < offset + count; index++) {
        const id = `subscriber-${index}`
        yield* (yield* Sink.intents(sinkOf(id)))
          .Deliver(id)
          .pipe(Intent.at(DateTime.makeUnsafe(atMs)))
      }
    }),
  }),
)

/** Each `CronProbe` tick handler run: its actor, command id, and wall-clock epoch milliseconds. */
export const cronFires: Array<{
  readonly id: string
  readonly commandId: string
  readonly at: number
}> = []

const CronProbeCommands = CronProbe.toLayer(
  Effect.succeed({
    Open: Effect.fnUntraced(function* () {
      const turn = yield* CronProbe.Turn
      yield* turn.state.set({ count: turn.state.count + 1 })
    }),
    Tick: Effect.fnUntraced(function* () {
      const turn = yield* CronProbe.Turn
      const at = yield* Clock.currentTimeMillis
      cronFires.push({ id: turn.id, commandId: turn.commandId, at })
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
  ResidentProbeCommands,
  EventProbeCommands,
  EventProbeReads,
  RetentionProbeCommands,
  SinkCommands,
  SenderCommands,
  LedgerLive,
  EffectProbeLive,
  ArchiveLive,
  ReducerProbeLive,
  WorkflowProbeLive,
  MintLive,
  CronProbeCommands,
)
