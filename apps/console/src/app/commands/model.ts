import { Schema as S } from "effect"

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

/** The commands page: the actor types the filter offers. */
export const CommandsPage = S.TaggedStruct("CommandsPage", {
  types: S.Array(S.String),
})
export type CommandsPage = typeof CommandsPage.Type
