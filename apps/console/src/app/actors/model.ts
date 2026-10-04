import {
  ActorTypeSummary as CloudActorTypeSummary,
  CommandCaller,
  JobStatus,
  SeriesWindow,
} from "@akter/cloud-api"
import { Schema as S } from "effect"
import { CommandScope } from "../commands/model.ts"

/** One actor type deployed in the project and how busy it is, exactly as the runtime API reports it. */
export const ActorTypeSummary = CloudActorTypeSummary
export type ActorTypeSummary = typeof ActorTypeSummary.Type

/** The actor types list. */
export const ActorsPage = S.TaggedStruct("ActorsPage", {
  types: S.Array(ActorTypeSummary),
})
export type ActorsPage = typeof ActorsPage.Type

/**
 * One instance of a type: its key, whether it is awake (null when the runtime does not say), and its
 * last command and turn, which read `—` when unreported.
 */
export const ActorInstance = S.Struct({
  key: S.String,
  awake: S.NullOr(S.Boolean),
  generation: S.Finite,
  lastCommand: S.String,
  lastTurn: S.String,
})
export type ActorInstance = typeof ActorInstance.Type

/** A command the type handled over the window: its total and its mean rate. */
export const CommandVolume = S.Struct({ name: S.String, count: S.Finite, perSecond: S.Finite })

/** A type's window: commands per second at each UTC instant and the volume of each command. */
export const TypeActivity = S.Struct({
  window: SeriesWindow,
  hours: S.Array(S.String),
  perSecond: S.Array(S.Finite),
  commands: S.Array(CommandVolume),
})
export type TypeActivity = typeof TypeActivity.Type

/**
 * One actor type in detail: its numbers, its activity over the window, and the instances on its
 * first page. `activitySample` marks activity that fell back to sample data on an otherwise live
 * page.
 */
export const ActorTypePage = S.TaggedStruct("ActorTypePage", {
  commandScope: S.optional(CommandScope),
  summary: ActorTypeSummary,
  instances: S.Array(ActorInstance),
  activity: TypeActivity,
  activitySample: S.Boolean,
})
export type ActorTypePage = typeof ActorTypePage.Type

/** A row in the actor's owned table. */
export const OwnedRow = S.Struct({ cells: S.Array(S.String) })

/**
 * A stored command receipt; `result` and `at` read `—` when the runner does not report them.
 * `caller` is whom the command ran as, null when the runner's record of it does not decode, and
 * `expires` when the runner stops answering a retry from it.
 */
export const Receipt = S.Struct({
  commandId: S.String,
  command: S.String,
  result: S.String,
  caller: S.NullOr(CommandCaller),
  at: S.String,
  expires: S.String,
  replayed: S.Boolean,
})

/**
 * An event class the actor emitted, with the cursor and emission time of its newest event and its
 * subscribers, null when unreported.
 */
export const EmittedEvent = S.Struct({
  cursor: S.String,
  name: S.String,
  emitted: S.String,
  subscribers: S.NullOr(S.Finite),
})

/** Work the actor handed off after a commit; `status` is the contract's job status. */
export const ActorJob = S.Struct({
  id: S.String,
  name: S.String,
  attempts: S.Finite,
  status: JobStatus,
})

/** The actor's live connections: how many sockets it holds, null when unreported, and the cursor of its event feed. */
export const ActorConnections = S.Struct({
  sockets: S.NullOr(S.Finite),
  feedCursor: S.NullOr(S.String),
})

/**
 * One entry in the actor's activity feed. `caller` is whom its command ran as, null when unreported
 * or once the command's receipt has expired.
 */
export const ActorActivity = S.Struct({
  key: S.String,
  committed: S.Boolean,
  title: S.String,
  subject: S.String,
  detail: S.String,
  caller: S.NullOr(CommandCaller),
  time: S.String,
})

/** A table the actor owns, with each cell written as text. */
export const OwnedTable = S.Struct({
  name: S.String,
  columns: S.Array(S.String),
  rows: S.Array(OwnedRow),
})

/**
 * Everything the actor inspector shows about one instance. A null is a fact
 * the runner does not report, shown as unknown rather than as zero or empty;
 * `runner` and `region` already read `—` when unreported. `state` is null when
 * an entry of the committed state does not decode, since part of it would
 * misstate the whole.
 */
export const ActorPage = S.TaggedStruct("ActorPage", {
  commandScope: S.optional(CommandScope),
  actorType: S.String,
  key: S.String,
  awake: S.NullOr(S.Boolean),
  generation: S.Finite,
  turn: S.NullOr(S.Finite),
  runner: S.String,
  region: S.String,
  tenant: S.String,
  mailbox: S.NullOr(S.Finite),
  state: S.NullOr(S.String),
  tables: S.NullOr(S.Array(OwnedTable)),
  receipts: S.Array(Receipt),
  events: S.Array(EmittedEvent),
  jobs: S.Array(ActorJob),
  connections: ActorConnections,
  activity: S.NullOr(S.Array(ActorActivity)),
})
export type ActorPage = typeof ActorPage.Type

/**
 * An actor address that has never received a command. It is not an error: sending the command that
 * creates the actor is how it comes to exist, so the inspector offers exactly that.
 */
export const MissingActorPage = S.TaggedStruct("MissingActorPage", {
  commandScope: CommandScope,
  actorType: S.String,
  key: S.String,
})
export type MissingActorPage = typeof MissingActorPage.Type

/** The inspector's tabs, in order. */
export const inspectorTabs = ["state", "rows", "receipts", "events", "jobs", "connections"] as const

/** One inspector tab. */
export type InspectorTab = (typeof inspectorTabs)[number]

/** The tab named in the URL, or the state tab when it names none or an unknown one. */
export const inspectorTab = (tab: string | undefined): InspectorTab =>
  inspectorTabs.find((candidate) => candidate === tab) ?? "state"
