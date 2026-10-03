import { Schema as S } from "effect"

/** One actor type deployed in the project and how busy it is. */
export const ActorTypeSummary = S.Struct({
  name: S.String,
  commands: S.Array(S.String),
  instances: S.Finite,
  awake: S.Finite,
  perSecond: S.Finite,
  p99: S.String,
})
export type ActorTypeSummary = typeof ActorTypeSummary.Type

/** The actor types list. */
export const ActorsPage = S.TaggedStruct("ActorsPage", {
  types: S.Array(ActorTypeSummary),
})
export type ActorsPage = typeof ActorsPage.Type

/** One instance of a type: its key, whether it is awake, and its last turn. */
export const ActorInstance = S.Struct({
  key: S.String,
  awake: S.Boolean,
  generation: S.Finite,
  lastTurn: S.String,
  mailbox: S.Finite,
  runner: S.String,
})
export type ActorInstance = typeof ActorInstance.Type

/** A command the type accepts and how often it ran today. */
export const CommandVolume = S.Struct({ name: S.String, today: S.Finite, p99: S.String })

/** One actor type in detail: its numbers, its commands, its hottest instances. */
export const ActorTypePage = S.TaggedStruct("ActorTypePage", {
  summary: ActorTypeSummary,
  hours: S.Array(S.String),
  perSecond: S.Array(S.Finite),
  commands: S.Array(CommandVolume),
  instances: S.Array(ActorInstance),
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

/** An event the actor emitted. */
export const EmittedEvent = S.Struct({
  cursor: S.Finite,
  name: S.String,
  subscribers: S.Finite,
  at: S.String,
})

/** Work the actor handed off after a commit. */
export const ActorJob = S.Struct({
  id: S.String,
  name: S.String,
  attempts: S.Finite,
  status: S.Literals(["Done", "Retrying", "Dead"]),
  at: S.String,
})

/** A live client connected to the actor. */
export const ActorConnection = S.Struct({
  id: S.String,
  kind: S.String,
  client: S.String,
  since: S.String,
  parked: S.Boolean,
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
  table: S.Struct({ name: S.String, columns: S.Array(S.String), rows: S.Array(OwnedRow) }),
  receipts: S.Array(Receipt),
  events: S.Array(EmittedEvent),
  jobs: S.Array(ActorJob),
  connections: S.Array(ActorConnection),
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
