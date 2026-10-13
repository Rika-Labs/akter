import { Result, Schema } from "effect"
import { Caller } from "../contract/caller.ts"
import { Crons } from "../contract/cron.ts"
import type { AnyActor } from "../contract/make.ts"
import type { Action } from "../contract/members.ts"
import type { Registered } from "../handlers/registry.ts"
import { Actions } from "./action.ts"
import { CommandIds } from "./command-ids.ts"
import { Digest } from "./digest.ts"
import { Entry, Outcome } from "./entries.ts"
import type { ActionEntry, Send, Timer } from "./entries.ts"
import { Layouts } from "./layout.ts"
import type { Decoded, Image } from "./layout.ts"
import { Indexes } from "./indexes.ts"
import type { OwnerIndex } from "./indexes.ts"
import { PagedItems } from "../handlers/lists.ts"
import type { PageCache } from "../handlers/page-tree.ts"

/** An actor contract with its bound handlers. */
export interface Bound {
  readonly actor: AnyActor
  readonly registered: Registered
}

/** The actors an engine runs and how many shards it splits them over. */
export interface Catalog {
  readonly actors: ReadonlyMap<string, Bound>
  readonly shards: number
}

/** One resident actor instance. */
export interface ActorRecord {
  readonly actor: AnyActor
  readonly key: Decoded
  readonly keyJson: Schema.Json
  readonly address: string
  image: Image
  created: boolean
  version: number
  position: { readonly offset: number; readonly index: number; readonly at: number } | undefined
}

/** A client command id's admission record and outcome, kept until it expires. */
export interface ClientRecord {
  readonly commandId: string
  readonly address: string
  readonly member: string
  readonly digest: string
  readonly caller: Caller
  readonly outcome: Outcome
  readonly expiresAt: number
}

/** A durable send to another shard, waiting until the receiver's segment holding it is durable. */
export interface PendingSend {
  readonly stream: string
  readonly sequence: number
  readonly send: Send
  readonly ref: string
  readonly onBehalfOf: string | undefined
}

/** A started job that has not ended. */
export interface JobRecord {
  readonly jobId: string
  readonly address: string
  readonly job: string
  readonly payload: Schema.Json
  readonly key: string | undefined
  readonly onBehalfOf: string | undefined
  attempt: number
  at: number
  failure: typeof Entry.cases.JobFailed.Type | undefined
  done: "Succeeded" | "Failed" | undefined
  suspended: string | undefined
  readonly workflow: Array<Schema.Json>
  readonly steps: Map<string, Schema.Json>
}

/** A pending timer of one actor. */
export interface TimerRecord {
  readonly address: string
  readonly timer: Timer
  readonly onBehalfOf: string | undefined
}

/**
 * A shard's durable state: everything a checkpoint holds and recovery rebuilds. It changes only
 * by `record`, once per durable entry, in log order.
 */
export interface ShardImage {
  readonly shard: number
  offset: number
  lastAt: number
  readonly actors: Map<string, ActorRecord>
  readonly clients: Map<number, Map<string, ClientRecord>>
  readonly received: Map<string, number>
  readonly calls: Map<string, Map<string, Outcome>>
  readonly timers: Map<string, TimerRecord>
  readonly outbox: Map<string, Array<PendingSend>>
  readonly sequences: Map<string, number>
  readonly jobs: Map<string, JobRecord>
  index: OwnerIndex
}

/** Client ids are kept in pages by expiry, each this wide; a page drops once admission passes its end. */
export const clientBucketWidth = 60_000

const empty = (shard: number): ShardImage => ({
  shard,
  offset: -1,
  lastAt: 0,
  actors: new Map(),
  clients: new Map(),
  received: new Map(),
  calls: new Map(),
  timers: new Map(),
  outbox: new Map(),
  sequences: new Map(),
  jobs: new Map(),
  index: Indexes.empty(),
})

const encodeCaller = Schema.encodeResult(Caller)

const addressOf = (actor: string, key: Schema.Json): string => `${actor}/${JSON.stringify(key)}`

const shardOf = (address: string, shards: number): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < address.length; i++)
    hash = Math.imul(hash ^ address.charCodeAt(i), 0x01000193)
  return (hash >>> 0) % shards
}

const bucketOf = (expiresAt: number): number =>
  Math.ceil(expiresAt / clientBucketWidth) * clientBucketWidth

const streamOf = (from: number, to: number): string => `${from}>${to}`

/** The bound actor named `name`, or a defect: a log naming an undeclared actor cannot be replayed. */
const bound = (catalog: Catalog, name: string): Bound => {
  const found = catalog.actors.get(name)
  if (found === undefined) throw new Error(`Actor ${name} is not part of this engine`)
  return found
}

/** The resident record of an actor instance, created at its initial image on first use. */
const resident = (
  image: ShardImage,
  catalog: Catalog,
  name: string,
  keyJson: Schema.Json,
): ActorRecord => {
  const address = addressOf(name, keyJson)
  const existing = image.actors.get(address)
  if (existing !== undefined) return existing
  const { actor } = bound(catalog, name)
  const layout = Layouts.of(actor)
  const record: ActorRecord = {
    actor,
    key: layout.key.decode(keyJson),
    keyJson,
    address,
    image: layout.initial,
    created: false,
    version: 0,
    position: undefined,
  }
  image.actors.set(address, record)
  return record
}

/** Arms the next tick of every cron action of an actor, after `from`. */
const armCrons = (image: ShardImage, record: ActorRecord, from: number): void => {
  for (const [member, declaration] of Object.entries<Action>(record.actor.actions)) {
    if (declaration.cron === undefined) continue
    armCron(image, record.address, member, declaration.cron, from)
  }
}

const armCron = (
  image: ShardImage,
  address: string,
  member: string,
  expression: string,
  from: number,
): void => {
  const at = Crons.parse(expression).next(from)
  const commandId = CommandIds.derive(address, "cron", member, at)
  image.timers.set(commandId, {
    address,
    timer: { commandId, at, member, payload: null, cron: true },
    onBehalfOf: undefined,
  })
}

/** The digest admission compares a retried payload against. */
const payloadDigest = (payload: Schema.Json): string => Digest.hex(JSON.stringify(payload))

const recordAction = (
  image: ShardImage,
  catalog: Catalog,
  entry: ActionEntry,
  after: Image,
): void => {
  const record = resident(image, catalog, entry.actor, entry.key)
  record.image = after
  record.version++
  image.lastAt = Math.max(image.lastAt, entry.at)
  if (!record.created) {
    record.created = true
    armCrons(image, record, entry.at)
  }
  Indexes.update(image.index, record)
  Entry.cases.Action.fields.origin.match(entry.origin, {
    External: ({ expiresAt }) => {
      const bucket = bucketOf(expiresAt)
      const page = image.clients.get(bucket) ?? new Map<string, ClientRecord>()
      page.set(entry.commandId, {
        commandId: entry.commandId,
        address: record.address,
        member: entry.member,
        digest: entry.digest,
        caller: entry.caller,
        outcome: entry.effects.outcome,
        expiresAt,
      })
      image.clients.set(bucket, page)
    },
    Delivery: ({ stream, sequence }) => {
      image.received.set(stream, sequence)
    },
    JobCall: ({ jobId }) => {
      const calls = image.calls.get(jobId) ?? new Map<string, Outcome>()
      calls.set(entry.commandId, entry.effects.outcome)
      image.calls.set(jobId, calls)
    },
    Fired: () => {
      const fired = image.timers.get(entry.commandId)
      image.timers.delete(entry.commandId)
      const expression =
        fired === undefined ? undefined : record.actor.actions[fired.timer.member]?.cron
      if (expression !== undefined)
        armCron(image, record.address, entry.member, expression, entry.at)
    },
    Local: () => {},
  })
  for (const bucket of image.clients.keys()) if (bucket < image.lastAt) image.clients.delete(bucket)
  for (const timer of entry.effects.timers)
    image.timers.set(timer.commandId, {
      address: record.address,
      timer,
      onBehalfOf: principalOf(entry.caller),
    })
  for (const send of entry.effects.sends) {
    const target = shardOf(addressOf(send.actor, send.key), catalog.shards)
    if (target === image.shard) continue
    const stream = streamOf(image.shard, target)
    const sequence = image.sequences.get(stream) ?? 1
    image.sequences.set(stream, sequence + 1)
    const queue = image.outbox.get(stream) ?? []
    queue.push({
      stream,
      sequence,
      send,
      ref: record.address,
      onBehalfOf: principalOf(entry.caller),
    })
    image.outbox.set(stream, queue)
  }
  for (const start of entry.effects.starts) {
    if (image.jobs.has(start.jobId)) continue
    image.jobs.set(start.jobId, {
      jobId: start.jobId,
      address: record.address,
      job: start.job,
      payload: start.payload,
      key: start.key,
      onBehalfOf: principalOf(entry.caller),
      attempt: 0,
      at: 0,
      failure: undefined,
      done: undefined,
      suspended: undefined,
      workflow: [],
      steps: new Map(),
    })
  }
}

const principalOf = (caller: Caller): string | undefined =>
  Caller.match(caller, {
    User: ({ subject }) => subject,
    Anonymous: () => undefined,
    System: ({ onBehalfOf }) => onBehalfOf,
  })

/**
 * Records one durable entry in the shard image. `after` is the actor image the entry produced: the
 * live engine passes what it computed when it ran the action, recovery what replay computed.
 */
const record = (
  image: ShardImage,
  catalog: Catalog,
  entry: Entry,
  after: Image | undefined,
  pages?: PageCache,
): void =>
  Entry.match(entry, {
    Replayed: () => {},
    Audit: () => {},
    Action: (action) => {
      const record = resident(image, catalog, action.actor, action.key)
      recordAction(image, catalog, action, after ?? record.image)
    },
    Seed: (seed) => {
      const record = resident(image, catalog, seed.actor, seed.key)
      record.image = after ?? Actions.apply(record.actor, record.image, seed.set, [], seed.lists)
      if (!record.created) {
        record.created = true
        armCrons(image, record, image.lastAt)
      }
      Indexes.update(image.index, record)
    },
    Forked: (forked) => {
      const record = resident(image, catalog, forked.actor, forked.key)
      if (record.created) throw new Error("Fork target already exists")
      const layout = Layouts.of(record.actor)
      const restored = Actions.apply(record.actor, layout.initial, forked.state, [], [])
      const lists = new Map(restored.lists)
      for (const saved of forked.lists) {
        const list = layout.lists.get(saved.field)
        if (list === undefined) continue
        if (pages === undefined) throw new Error("Fork recovery requires a page resolver")
        lists.set(
          saved.field,
          new PagedItems(saved.keys, saved.ordered, pages, list.ordering, list.item),
        )
      }
      record.image = after ?? { ...restored, lists }
      record.created = true
      record.version = 0
      Indexes.update(image.index, record)
      for (const timer of forked.timers)
        image.timers.set(timer.commandId, { address: record.address, timer, onBehalfOf: undefined })
      for (const job of forked.jobs)
        image.jobs.set(job.jobId, {
          ...job,
          address: record.address,
          key: job.key,
          onBehalfOf: undefined,
          attempt: 0,
          at: forked.at,
          failure: undefined,
          done: undefined,
          suspended: undefined,
          workflow: [],
          steps: new Map(job.steps.map(({ name, value }) => [name, value])),
        })
    },
    Delivered: ({ stream, sequence }) => {
      const queue = image.outbox.get(stream)
      if (queue === undefined) return
      const remaining = queue.filter((pending) => pending.sequence !== sequence)
      if (remaining.length === 0) image.outbox.delete(stream)
      else image.outbox.set(stream, remaining)
    },
    Attempt: ({ jobId, attempt, at }) => {
      const job = image.jobs.get(jobId)
      if (job !== undefined) {
        job.attempt = attempt
        job.at = at
        job.failure = undefined
      }
    },
    JobFailed: (entry) => {
      const job = image.jobs.get(entry.jobId)
      if (job !== undefined) job.failure = entry
    },
    Workflow: ({ jobId, value }) => {
      image.jobs.get(jobId)?.workflow.push(value)
    },
    Step: ({ jobId, name, value }) => {
      image.jobs.get(jobId)?.steps.set(name, value)
    },
    Done: ({ jobId, outcome }) => {
      const job = image.jobs.get(jobId)
      if (job !== undefined) job.done = outcome
    },
    JobRetired: ({ jobId }) => {
      image.jobs.delete(jobId)
    },
    Retired: ({ jobId }) => {
      image.calls.delete(jobId)
    },
    Skipped: ({ commandId, at }) => {
      const skipped = image.timers.get(commandId)
      image.timers.delete(commandId)
      image.lastAt = Math.max(image.lastAt, at)
      if (skipped === undefined) return
      const owner = image.actors.get(skipped.address)
      const expression = owner?.actor.actions[skipped.timer.member]?.cron
      if (expression !== undefined)
        armCron(image, skipped.address, skipped.timer.member, expression, at)
    },
    Released: () => {},
  })

/** A shard's durable state and how one entry changes it. */
export const Durable = {
  empty,
  record,
  resident,
  bound,
  addressOf,
  shardOf,
  bucketOf,
  payloadDigest,
  principalOf,
  encodeCaller: (caller: Caller): Schema.Json => Result.getOrThrow(encodeCaller(caller)),
}
