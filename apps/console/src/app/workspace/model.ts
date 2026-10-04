import { OrganizationPlan } from "@akter/cloud-api"
import { Function, Match, Schema as S } from "effect"
import { CommandScope } from "../commands/model.ts"
import { titleCase } from "../settings/format.ts"

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
  commandScope: S.optional(CommandScope),
  actorType: S.String,
  key: S.String,
  awake: S.Boolean,
  lastTurn: S.String,
})
export type PinnedActor = typeof PinnedActor.Type

/**
 * What every signed-in page needs: who is signed in, the organization and the plan the control
 * plane reports it on (null without an organization), its projects, the pinned actors, and the
 * counts the sidebar shows.
 */
export const Workspace = S.Struct({
  person: Person,
  organization: S.String,
  plan: S.NullOr(OrganizationPlan),
  projects: S.Array(ProjectSummary),
  pinned: S.Array(PinnedActor),
  deadLetters: S.Finite,
  error: S.optional(S.String),
})
export type Workspace = typeof Workspace.Type

/** An actor's address, `Type/key`, as written everywhere in the console. */
export const address = (actor: Readonly<{ actorType: string; key: string }>): string =>
  `${actor.actorType}/${actor.key}`

/** A plan of the control plane's catalog, as far as naming it needs. */
export const PlanName = S.Struct({ id: S.String, name: S.String })
export type PlanName = typeof PlanName.Type

/**
 * How an organization's plan reads wherever it is named. A known plan takes its catalog name, or
 * its id title-cased while the catalog isn't loaded. An organization without a billing account has
 * no plan at all, so it reads as having no billing and never as Free; a stored plan the pricing
 * configuration doesn't define reads as not recognised rather than by its stored id.
 */
export const planLabel: {
  (catalog: ReadonlyArray<PlanName>): (plan: OrganizationPlan) => string
  (plan: OrganizationPlan, catalog: ReadonlyArray<PlanName>): string
} = Function.dual(2, (plan: OrganizationPlan, catalog: ReadonlyArray<PlanName>): string =>
  Match.valueTags(plan, {
    unbound: () => "no billing",
    unknown: () => "plan not recognised",
    known: ({ id }) => catalog.find((offer) => offer.id === id)?.name ?? titleCase(id),
  }),
)
