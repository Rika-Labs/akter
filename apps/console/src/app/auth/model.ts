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

/** Regions offered as a new project's home. */
export const homeRegions: ReadonlyArray<Readonly<{ id: string; place: string }>> = [
  { id: "us-east-1", place: "Virginia" },
  { id: "eu-west-1", place: "Ireland" },
  { id: "ap-southeast-1", place: "Singapore" },
]
