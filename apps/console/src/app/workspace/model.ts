import { Schema as S } from "effect"

/** The signed-in person. */
export const Person = S.Struct({
  name: S.String,
  email: S.String,
  role: S.String,
})
export type Person = typeof Person.Type

/** A project in the organization; `deployed` is false until its first deploy. */
export const ProjectSummary = S.Struct({
  slug: S.String,
  deployed: S.Boolean,
  region: S.String,
})
export type ProjectSummary = typeof ProjectSummary.Type

/** An actor pinned to the sidebar, with whether it is awake and when it last ran a turn. */
export const PinnedActor = S.Struct({
  actorType: S.String,
  key: S.String,
  awake: S.Boolean,
  lastTurn: S.String,
})
export type PinnedActor = typeof PinnedActor.Type

/**
 * What every signed-in page needs: who is signed in, the organization and its projects, the pinned
 * actors, and the counts the sidebar shows.
 */
export const Workspace = S.Struct({
  person: Person,
  organization: S.String,
  plan: S.String,
  projects: S.Array(ProjectSummary),
  pinned: S.Array(PinnedActor),
  deadLetters: S.Finite,
  error: S.optional(S.String),
})
export type Workspace = typeof Workspace.Type

/** An actor's address, `Type/key`, as written everywhere in the console. */
export const address = (actor: Readonly<{ actorType: string; key: string }>): string =>
  `${actor.actorType}/${actor.key}`
