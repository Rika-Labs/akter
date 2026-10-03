import { ActorTypeSummary as CloudActorTypeSummary, JobStatus } from "@akter/cloud-api"
import { Schema as S } from "effect"

/** One actor type deployed in the project and how busy it is, exactly as the runtime API reports it. */
export const ActorTypeSummary = CloudActorTypeSummary
export type ActorTypeSummary = typeof ActorTypeSummary.Type

/** The actor types list. */
export const ActorsPage = S.TaggedStruct("ActorsPage", {
  types: S.Array(ActorTypeSummary),
})
export type ActorsPage = typeof ActorsPage.Type

/** One instance of a type: its key, whether it is awake, and its last command and turn. */
export const ActorInstance = S.Struct({
  key: S.String,
  awake: S.Boolean,
  generation: S.Finite,
  lastCommand: S.String,
  lastTurn: S.String,
})
export type ActorInstance = typeof ActorInstance.Type

/** A command the type accepts and how often it ran today. */
export const CommandVolume = S.Struct({ name: S.String, today: S.Finite, p99: S.String })

/** A type's day: commands per second by hour and the volume of each command. */
export const TypeActivity = S.Struct({
  hours: S.Array(S.String),
  perSecond: S.Array(S.Finite),
  commands: S.Array(CommandVolume),
})

/**
 * One actor type in detail: its numbers and the instances on its first page. `activity` is drawn
 * when the source reports a per-type history.
 */
export const ActorTypePage = S.TaggedStruct("ActorTypePage", {
  summary: ActorTypeSummary,
  instances: S.Array(ActorInstance),
  activity: S.optional(TypeActivity),
})
export type ActorTypePage = typeof ActorTypePage.Type

/** A row in the actor's owned table. */
export const OwnedRow = S.Struct({ cells: S.Array(S.String) })

/** A stored command result that a retry returns. */
export const Receipt = S.Struct({
  commandId: S.String,
  command: S.String,
  result: S.String,
  at: S.String,
  replayed: S.Boolean,
})

/** An event class the actor emitted, with the cursor of its newest event and its subscribers. */
export const EmittedEvent = S.Struct({
  cursor: S.String,
  name: S.String,
  subscribers: S.Finite,
})

/** Work the actor handed off after a commit; `status` is the contract's job status. */
export const ActorJob = S.Struct({
  id: S.String,
  name: S.String,
  attempts: S.Finite,
  status: JobStatus,
})

/** The actor's live connections: how many sockets it holds and the cursor of its event feed. */
export const ActorConnections = S.Struct({
  sockets: S.Finite,
  feedCursor: S.NullOr(S.String),
})

/** One entry in the actor's activity feed. */
export const ActorActivity = S.Struct({
  key: S.String,
  committed: S.Boolean,
  title: S.String,
  subject: S.String,
  detail: S.String,
  time: S.String,
})

/** A table the actor owns, with each cell written as text. */
export const OwnedTable = S.Struct({
  name: S.String,
  columns: S.Array(S.String),
  rows: S.Array(OwnedRow),
})

/** Everything the actor inspector shows about one instance. */
export const ActorPage = S.TaggedStruct("ActorPage", {
  actorType: S.String,
  key: S.String,
  awake: S.Boolean,
  generation: S.Finite,
  turn: S.Finite,
  runner: S.String,
  tenant: S.String,
  mailbox: S.Finite,
  state: S.String,
  tables: S.Array(OwnedTable),
  receipts: S.Array(Receipt),
  events: S.Array(EmittedEvent),
  jobs: S.Array(ActorJob),
  connections: ActorConnections,
  activity: S.Array(ActorActivity),
})
export type ActorPage = typeof ActorPage.Type

/** The inspector's tabs, in order. */
export const inspectorTabs = ["state", "rows", "receipts", "events", "jobs", "connections"] as const

/** One inspector tab. */
export type InspectorTab = (typeof inspectorTabs)[number]

/** The tab named in the URL, or the state tab when it names none or an unknown one. */
export const inspectorTab = (tab: string | undefined): InspectorTab =>
  inspectorTabs.find((candidate) => candidate === tab) ?? "state"
