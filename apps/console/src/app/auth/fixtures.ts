import { KnownPlan } from "@akter/cloud-api"
import { InvitationPage } from "./model.ts"

/** The invitation every id resolves to in fixture mode. */
export const invitation = (id: string): InvitationPage =>
  InvitationPage.make({
    id,
    organization: "Acme",
    members: 4,
    plan: KnownPlan.make({ id: "pro" }),
    catalog: [],
    inviter: "Dallen Pyrah",
    email: "lee@acme.dev",
    role: "Member",
  })
