import type { RegionId } from "@akter/cloud-api"
import { Schema as S } from "effect"

/** An invitation to join an organization, as shown before accepting it. */
export const InvitationPage = S.TaggedStruct("InvitationPage", {
  id: S.String,
  organization: S.String,
  members: S.Finite,
  plan: S.String,
  inviter: S.String,
  email: S.String,
  role: S.String,
})
export type InvitationPage = typeof InvitationPage.Type

/** The steps of onboarding, in order. */
export const onboardingSteps = ["organization", "project", "deploy"] as const

/** One onboarding step. */
export type OnboardingStep = (typeof onboardingSteps)[number]

/** The step named in the URL, or the first step. */
export const onboardingStep = (step: string | undefined): OnboardingStep =>
  onboardingSteps.find((candidate) => candidate === step) ?? "organization"

/** Regions offered as a new project's home; the cloud contract's launch regions. */
export const homeRegions: ReadonlyArray<Readonly<{ id: RegionId; place: string }>> = [
  { id: "us-east-1", place: "Virginia" },
  { id: "us-west-2", place: "Oregon" },
]

/** The URL slug a display name implies: lowercase letters, digits and inner hyphens. */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
