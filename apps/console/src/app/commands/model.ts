import { Schema as S } from "effect"
import { EnvironmentName, ProjectId } from "@akter/cloud-api"

/** The server-resolved scope of the actor shown when a send dialog is opened. */
export const CommandScope = S.Struct({ projectId: ProjectId, environment: EnvironmentName })
export type CommandScope = typeof CommandScope.Type

/** How a turn ended: committed, refused with a typed error, or answered from its receipt. */
export const TurnResult = S.Literals(["ok", "error", "replayed"])
export type TurnResult = typeof TurnResult.Type

/** One committed turn in the live tail. */
export const TailEntry = S.Struct({
  sequence: S.Finite,
  time: S.String,
  took: S.String,
  actorType: S.String,
  key: S.String,
  command: S.String,
  result: TurnResult,
  detail: S.String,
})
export type TailEntry = typeof TailEntry.Type

/** The live tail's state: newest turns first, whether it is paused, and the type filter. */
export const Tail = S.Struct({
  entries: S.Array(TailEntry),
  paused: S.Boolean,
  filter: S.String,
  next: S.Finite,
})
export type Tail = typeof Tail.Type

/**
 * The commands page: the actor types the filter offers and the committed turns already recorded,
 * newest first, which the live tail continues from.
 */
export const CommandsPage = S.TaggedStruct("CommandsPage", {
  types: S.Array(S.String),
  recent: S.Array(TailEntry),
})
export type CommandsPage = typeof CommandsPage.Type

/**
 * What an actor answered to a command sent from the console. A refusal the actor itself returned
 * is an answer, not a transport failure, so it stays distinct from `ConsoleError`.
 */
export const CommandSucceeded = S.TaggedStruct("CommandSucceeded", {
  commandId: S.String,
  result: S.Json,
  replayed: S.Boolean,
})
export type CommandSucceeded = typeof CommandSucceeded.Type

/** The actor ran the command and returned its own typed error, with that error's payload. */
export const CommandRejected = S.TaggedStruct("CommandRejected", {
  commandId: S.String,
  errorTag: S.String,
  error: S.Json,
  replayed: S.Boolean,
})
export type CommandRejected = typeof CommandRejected.Type

export const CommandAnswer = S.Union([CommandSucceeded, CommandRejected])
export type CommandAnswer = typeof CommandAnswer.Type

/**
 * The last command the send dialog sent: its command ID and the input it was sent with. Sending the
 * same input again reuses the ID, so a retry runs at most once; `generated` marks an ID the console
 * minted, which a change to the command or payload discards so the next send gets a fresh one.
 */
export const CommandSubmission = S.Struct({
  id: S.String,
  command: S.String,
  payload: S.String,
  generated: S.Boolean,
})
export type CommandSubmission = typeof CommandSubmission.Type
