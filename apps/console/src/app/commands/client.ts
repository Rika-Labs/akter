import { Effect } from "effect"
import { actorTypes } from "../actors/fixtures.ts"
import { tailEntry } from "./fixtures.ts"
import { CommandsPage, type TailEntry } from "./model.ts"

/** Loads what the live tail page needs before the stream starts. */
export const loadCommands: Effect.Effect<CommandsPage> = Effect.succeed(
  CommandsPage.make({
    types: actorTypes.map((type) => type.name),
  }),
)

/**
 * The next committed turn after `sequence`. Today it replays fixture turns; the hosted tail will be
 * a server-sent event stream with the same entry type.
 */
export const nextTurn = (sequence: number): TailEntry => tailEntry(sequence)
