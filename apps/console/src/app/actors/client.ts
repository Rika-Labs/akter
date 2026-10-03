import { Effect } from "effect"
import {
  actorTypes,
  commandVolumes,
  instancesOf,
  order,
  perSecondSeries,
  typeHours,
} from "./fixtures.ts"
import { type ActorPage, ActorTypePage, ActorsPage } from "./model.ts"

/** Loads the project's actor types. Fixture-backed until the inspection API is hosted. */
export const loadActors: Effect.Effect<ActorsPage> = Effect.succeed(
  ActorsPage.make({
    types: actorTypes,
  }),
)

/** Loads one actor type, or nothing when the project has no such type. */
export const loadActorType = (name: string): Effect.Effect<ActorTypePage | undefined> => {
  const summary = actorTypes.find((candidate) => candidate.name === name)
  return Effect.sync(() =>
    summary === undefined
      ? undefined
      : ActorTypePage.make({
          summary,
          hours: typeHours,
          perSecond: perSecondSeries(summary),
          commands: commandVolumes(summary),
          instances: instancesOf(name),
        }),
  )
}

/**
 * Loads one actor for the inspector. The fixture inspects `Order/ord_8f2c` in detail and answers
 * other known instances with the same shape of data under their own address.
 */
export const loadActor = (
  input: Readonly<{ actorType: string; key: string }>,
): Effect.Effect<ActorPage | undefined> => {
  const known = actorTypes.some((candidate) => candidate.name === input.actorType)
  const instance = instancesOf(input.actorType).find((candidate) => candidate.key === input.key)
  return Effect.sync(() =>
    known
      ? {
          ...order,
          actorType: input.actorType,
          key: input.key,
          awake: instance?.awake ?? order.awake,
          generation: instance?.generation ?? order.generation,
          runner: instance?.runner ?? order.runner,
          mailbox: instance?.mailbox ?? order.mailbox,
        }
      : undefined,
  )
}
