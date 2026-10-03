import { Effect } from "effect"
import { InvitationPage } from "./model.ts"

/**
 * Loads an invitation by id. Fixture-backed: every id resolves to the same invitation until the
 * hosted auth service issues real ones.
 */
export const loadInvitation = (id: string): Effect.Effect<InvitationPage> =>
  Effect.succeed(
    InvitationPage.make({
      id,
      organization: "Acme",
      members: 4,
      plan: "Pro",
      inviter: "Dallen Pyrah",
      email: "lee@acme.dev",
      role: "Member",
    }),
  )
