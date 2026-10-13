import { Result, Schema } from "effect"
import { Caller } from "../contract/caller.ts"
import { Actions } from "../execution/action.ts"
import { Durable } from "../execution/durable.ts"
import type { Catalog, ClientRecord, ShardImage } from "../execution/durable.ts"
import { JobFailedEntry, Outcome, Send, Timer, formatVersion } from "../execution/entries.ts"
import { Layouts } from "../execution/layout.ts"
import { Lists } from "../handlers/lists.ts"
import { IndexSnapshot, Indexes } from "../execution/indexes.ts"

const Snapshot = Schema.Struct({
  actor: Schema.String,
  key: Schema.Json,
  created: Schema.Boolean,
  state: Schema.Record(Schema.String, Schema.Json),
  lists: Schema.Array(Schema.Struct({ field: Schema.String, items: Schema.Array(Schema.Json) })),
})

/**
 * A shard checkpoint: every resident actor's encoded state and lists, the deduplication state, the
 * timers, the pending sends and the open jobs, as of `offset`. Recovery decodes it with the running
 * build's schemas, so added state fields take their decoding defaults.
 */
export const Checkpoint = Schema.Struct({
  format: Schema.Literal(formatVersion),
  shard: Schema.Int,
  offset: Schema.Int,
  lastAt: Schema.Finite,
  actors: Schema.Array(Snapshot),
  index: Schema.optionalKey(IndexSnapshot),
  clients: Schema.Array(
    Schema.Struct({
      commandId: Schema.String,
      address: Schema.String,
      member: Schema.String,
      digest: Schema.String,
      caller: Caller,
      outcome: Outcome,
      expiresAt: Schema.Finite,
    }),
  ),
  received: Schema.Array(Schema.Struct({ stream: Schema.String, sequence: Schema.Int })),
  calls: Schema.Array(
    Schema.Struct({
      jobId: Schema.String,
      outcomes: Schema.Array(Schema.Struct({ commandId: Schema.String, outcome: Outcome })),
    }),
  ),
  timers: Schema.Array(
    Schema.Struct({
      address: Schema.String,
      timer: Timer,
      onBehalfOf: Schema.optional(Schema.String),
    }),
  ),
  outbox: Schema.Array(
    Schema.Struct({
      stream: Schema.String,
      sequence: Schema.Int,
      send: Send,
      ref: Schema.String,
      onBehalfOf: Schema.optional(Schema.String),
    }),
  ),
  sequences: Schema.Array(Schema.Struct({ stream: Schema.String, next: Schema.Int })),
  jobs: Schema.Array(
    Schema.Struct({
      jobId: Schema.String,
      address: Schema.String,
      job: Schema.String,
      payload: Schema.Json,
      key: Schema.optional(Schema.String),
      onBehalfOf: Schema.optional(Schema.String),
      attempt: Schema.Int,
      at: Schema.Finite,
      failure: Schema.optional(JobFailedEntry),
      done: Schema.optional(Schema.Literals(["Succeeded", "Failed"])),
      workflow: Schema.Array(Schema.Json),
      steps: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.Json })),
    }),
  ),
})

/** A shard checkpoint. */
export type Checkpoint = typeof Checkpoint.Type

const checkpointJson = Schema.fromJsonString(Checkpoint)
const encodeText = Schema.encodeResult(checkpointJson)
const decodeText = Schema.decodeResult(checkpointJson)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Captures a shard image as a checkpoint. */
const capture = (image: ShardImage): Checkpoint => ({
  format: formatVersion,
  shard: image.shard,
  offset: image.offset,
  lastAt: image.lastAt,
  index: Indexes.capture(image.index),
  actors: Array.from(image.actors.values(), (record) => {
    const layout = Layouts.of(record.actor)
    return {
      actor: record.actor.name,
      key: record.keyJson,
      created: record.created,
      state: { ...record.image.encoded },
      lists: Array.from(layout.lists, ([field, list]) => ({
        field,
        items: Lists.all(record.image.lists.get(field) ?? Lists.empty, list.ordering).map(
          list.item.encode,
        ),
      })),
    }
  }),
  clients: Array.from(image.clients.values(), (page) => Array.from(page.values())).flat(),
  received: Array.from(image.received, ([stream, sequence]) => ({ stream, sequence })),
  calls: Array.from(image.calls, ([jobId, outcomes]) => ({
    jobId,
    outcomes: Array.from(outcomes, ([commandId, outcome]) => ({ commandId, outcome })),
  })),
  timers: Array.from(image.timers.values(), (record) => ({
    ...record,
    onBehalfOf: record.onBehalfOf,
  })),
  outbox: Array.from(image.outbox.values())
    .flat()
    .map((pending) => ({
      stream: pending.stream,
      sequence: pending.sequence,
      send: pending.send,
      ref: pending.ref,
      onBehalfOf: pending.onBehalfOf,
    })),
  sequences: Array.from(image.sequences, ([stream, next]) => ({ stream, next })),
  jobs: Array.from(image.jobs.values(), (job) => ({
    jobId: job.jobId,
    address: job.address,
    job: job.job,
    payload: job.payload,
    key: job.key,
    onBehalfOf: job.onBehalfOf,
    attempt: job.attempt,
    at: job.at,
    failure: job.failure,
    done: job.done,
    workflow: job.workflow,
    steps: Array.from(job.steps, ([name, value]) => ({ name, value })),
  })),
})

/**
 * Rebuilds a shard image from a checkpoint. Each actor starts at its initial image under the
 * running build's schema and takes the checkpoint's fields and list items, so a field added since
 * keeps its default; a field that no longer decodes refuses the whole checkpoint.
 */
const restore = (catalog: Catalog, checkpoint: Checkpoint): ShardImage => {
  const image = Durable.empty(checkpoint.shard)
  image.offset = checkpoint.offset
  image.lastAt = checkpoint.lastAt
  if (checkpoint.index !== undefined) image.index = Indexes.restore(checkpoint.index)
  for (const snapshot of checkpoint.actors) {
    const record = Durable.resident(image, catalog, snapshot.actor, snapshot.key)
    record.created = snapshot.created
    record.image = Actions.apply(
      record.actor,
      record.image,
      snapshot.state,
      [],
      snapshot.lists.map(({ field, items }) => ({ field, put: items, delete: [] })),
    )
    Indexes.update(image.index, record)
  }
  for (const address of image.index.rows.keys())
    if (image.actors.get(address)?.created !== true)
      throw new Error("Checkpoint index names an actor without durable state")
  for (const client of checkpoint.clients) {
    const bucket = Durable.bucketOf(client.expiresAt)
    const page = image.clients.get(bucket) ?? new Map<string, ClientRecord>()
    page.set(client.commandId, client)
    image.clients.set(bucket, page)
  }
  for (const { stream, sequence } of checkpoint.received) image.received.set(stream, sequence)
  for (const { jobId, outcomes } of checkpoint.calls)
    image.calls.set(jobId, new Map(outcomes.map(({ commandId, outcome }) => [commandId, outcome])))
  for (const timer of checkpoint.timers)
    image.timers.set(timer.timer.commandId, { ...timer, onBehalfOf: timer.onBehalfOf })
  for (const pending of checkpoint.outbox) {
    const queue = image.outbox.get(pending.stream) ?? []
    queue.push({ ...pending, onBehalfOf: pending.onBehalfOf })
    image.outbox.set(pending.stream, queue)
  }
  for (const { stream, next } of checkpoint.sequences) image.sequences.set(stream, next)
  for (const job of checkpoint.jobs)
    image.jobs.set(job.jobId, {
      ...job,
      key: job.key,
      onBehalfOf: job.onBehalfOf,
      failure: job.failure,
      done: job.done,
      suspended: undefined,
      workflow: Array.from(job.workflow),
      steps: new Map(job.steps.map(({ name, value }) => [name, value])),
    })
  return image
}

/** Checkpoint bytes: UTF-8 JSON with the format version first. */
export const Checkpoints = {
  capture,
  restore,
  encode: (checkpoint: Checkpoint): Uint8Array =>
    encoder.encode(Result.getOrThrow(encodeText(checkpoint))),
  decode: (bytes: Uint8Array): Result.Result<Checkpoint, Schema.SchemaError> =>
    decodeText(decoder.decode(bytes)),
}
