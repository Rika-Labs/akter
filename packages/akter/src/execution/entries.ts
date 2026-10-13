import { Result, Schema } from "effect"
import { Caller } from "../contract/caller.ts"
import { DefectKind } from "../contract/errors.ts"
import { AuditRecord } from "../store/audit.ts"

/** The format version of every checkpoint page this engine writes. */
export const formatVersion = 1

/** An action's recorded result: its encoded reply, declared failure or defect. */
export const Outcome = Schema.Union([
  Schema.TaggedStruct("Success", { value: Schema.Json }),
  Schema.TaggedStruct("Failure", { error: Schema.Json }),
  Schema.TaggedStruct("Defect", { kind: DefectKind, detail: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))

/** An action's recorded result. */
export type Outcome = typeof Outcome.Type

/** The writes one action made to one list, encoded: whole items put, keys deleted. */
export const ListWrite = Schema.Struct({
  field: Schema.String,
  put: Schema.Array(Schema.Json),
  delete: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
})

/** The writes one action made to one list. */
export type ListWrite = typeof ListWrite.Type

/** A staged send: a one-way action on another actor under a derived id. */
export const Send = Schema.Struct({
  commandId: Schema.String,
  actor: Schema.String,
  key: Schema.Json,
  member: Schema.String,
  payload: Schema.Json,
})

/** A staged send. */
export type Send = typeof Send.Type

/** A staged timer on the acting actor, due at an epoch-millisecond instant. */
export const Timer = Schema.Struct({
  commandId: Schema.String,
  at: Schema.Finite,
  member: Schema.String,
  payload: Schema.Json,
  cron: Schema.Boolean,
})

/** A staged timer. */
export type Timer = typeof Timer.Type

/** A staged job start under its job id. */
export const Start = Schema.Struct({
  jobId: Schema.String,
  job: Schema.String,
  payload: Schema.Json,
  key: Schema.optionalKey(Schema.String),
})

/** A staged job start. */
export type Start = typeof Start.Type

/** A staged event, published after durability. */
export const Emit = Schema.Struct({ event: Schema.String, value: Schema.Json })

/** A staged event. */
export type Emit = typeof Emit.Type

/** Where an action came from, which decides how its id is deduplicated. */
export const Origin = Schema.Union([
  Schema.TaggedStruct("External", { expiresAt: Schema.Finite }),
  Schema.TaggedStruct("Delivery", { stream: Schema.String, sequence: Schema.Int }),
  Schema.TaggedStruct("Local", {}),
  Schema.TaggedStruct("Fired", {}),
  Schema.TaggedStruct("JobCall", { jobId: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))

/** Where an action came from. */
export type Origin = typeof Origin.Type

/**
 * Everything an action did, encoded: its outcome, the state fields it set or removed, its list
 * writes and its staged work. Replay runs the handler again and compares the whole record.
 */
export const Effects = Schema.Struct({
  outcome: Outcome,
  set: Schema.Record(Schema.String, Schema.Json),
  unset: Schema.Array(Schema.String),
  lists: Schema.Array(ListWrite),
  sends: Schema.Array(Send),
  timers: Schema.Array(Timer),
  starts: Schema.Array(Start),
  events: Schema.Array(Emit),
  ids: Schema.Int,
  randoms: Schema.Int,
})

/** Everything an action did, encoded. */
export type Effects = typeof Effects.Type

/** One executed action: its admission record and everything it did. */
export const ActionEntry = Schema.TaggedStruct("Action", {
  commandId: Schema.String,
  origin: Origin,
  actor: Schema.String,
  key: Schema.Json,
  member: Schema.String,
  payload: Schema.Json,
  digest: Schema.String,
  caller: Caller,
  at: Schema.Finite,
  connection: Schema.optional(Schema.String),
  effects: Effects,
})

/** One executed action. */
export type ActionEntry = typeof ActionEntry.Type

/** An operator's initial state for an instance, written before its first action. */
export const SeedEntry = Schema.TaggedStruct("Seed", {
  actor: Schema.String,
  key: Schema.Json,
  set: Schema.Record(Schema.String, Schema.Json),
  lists: Schema.Array(ListWrite),
})

/** The receiver's segment holding a delivery is durable; the sender's pending send is done. */
export const DeliveredEntry = Schema.TaggedStruct("Delivered", {
  stream: Schema.String,
  sequence: Schema.Int,
})

/** A job attempt began; calls it makes carry ids derived from this attempt. */
export const AttemptEntry = Schema.TaggedStruct("Attempt", {
  jobId: Schema.String,
  attempt: Schema.Int,
  at: Schema.Finite,
})

/** An attempt's terminal failure, recorded before any backoff or failure action. */
export const JobFailedEntry = Schema.TaggedStruct("JobFailed", {
  jobId: Schema.String,
  attempt: Schema.Int,
  cause: Schema.Literals(["Failed", "Defect", "Timeout"]),
  ambiguous: Schema.Boolean,
  retryAt: Schema.Finite,
})

/** Encoded workflow bookkeeping owned and fenced by the job's shard. */
export const WorkflowEntry = Schema.TaggedStruct("Workflow", {
  jobId: Schema.String,
  value: Schema.Json,
})

/** A job step finished; it never runs again. */
export const StepEntry = Schema.TaggedStruct("Step", {
  jobId: Schema.String,
  name: Schema.String,
  attempt: Schema.Int,
  value: Schema.Json,
})

/** A job ended; its call stream on receivers retires. */
export const DoneEntry = Schema.TaggedStruct("Done", {
  jobId: Schema.String,
  outcome: Schema.Literals(["Succeeded", "Failed"]),
})

/** A receiver dropped the call stream of a finished job. */
export const RetiredEntry = Schema.TaggedStruct("Retired", { jobId: Schema.String })

/** All receivers acknowledged stream retirement; the completed job's cleanup obligation is gone. */
export const JobRetiredEntry = Schema.TaggedStruct("JobRetired", { jobId: Schema.String })

/**
 * A cron tick found older than `cronSkipIfOlderThan` when it came due, at admission time `at`: it
 * is dropped without running, and the entry's next tick is the first scheduled time after `at`.
 */
export const SkippedEntry = Schema.TaggedStruct("Skipped", {
  commandId: Schema.String,
  at: Schema.Finite,
})

/**
 * A draining owner gave the shard up: the segment before it is covered by a checkpoint, so the
 * next owner replays nothing this owner wrote. It is always alone in the shard's last segment.
 */
export const ReleasedEntry = Schema.TaggedStruct("Released", {})

/** Every log entry. */
export const Entry = Schema.Union([
  Schema.TaggedStruct("Replayed", { checkpoint: Schema.String }),
  Schema.TaggedStruct("Audit", { record: AuditRecord }),
  ActionEntry,
  SeedEntry,
  DeliveredEntry,
  AttemptEntry,
  JobFailedEntry,
  WorkflowEntry,
  StepEntry,
  DoneEntry,
  RetiredEntry,
  JobRetiredEntry,
  SkippedEntry,
  ReleasedEntry,
]).pipe(Schema.toTaggedUnion("_tag"))

/** Every log entry. */
export type Entry = typeof Entry.Type

const entryJson = Schema.fromJsonString(Entry)
const encodeEntryText = Schema.encodeResult(entryJson)
const decodeEntryText = Schema.decodeResult(entryJson)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * One entry's bytes inside a store segment: UTF-8 JSON. The segment around it carries the writer,
 * the lease's open offset and the build, so an entry records only what happened.
 */
export const EntryCodec = {
  encode: (entry: Entry): Uint8Array => encoder.encode(Result.getOrThrow(encodeEntryText(entry))),
  decode: (bytes: Uint8Array): Result.Result<Entry, Schema.SchemaError> =>
    decodeEntryText(decoder.decode(bytes)),
}
