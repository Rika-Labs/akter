import { KnownPlan } from "@akter/cloud-api"
import type { Workspace } from "./model.ts"

/**
 * Fixture workspace for the console until the hosted API serves `/api/workspace`. Names and
 * numbers are illustrative test data, not measurements.
 */
export const workspace: Workspace = {
  person: { id: "usr_dallen", name: "Dallen Pyrah", email: "dallen@acme.dev", role: "Owner" },
  organization: "Acme",
  plan: KnownPlan.make({ id: "pro" }),
  projects: [
    { slug: "storefront", deployed: true, region: "us-east-1" },
    { slug: "support-bot", deployed: false, region: "eu-west-1" },
  ],
  pinned: [
    { actorType: "Cart", key: "c_19af", awake: true, lastTurn: "now" },
    { actorType: "Order", key: "ord_8f2c", awake: true, lastTurn: "2m" },
    { actorType: "SupportRoom", key: "general", awake: true, lastTurn: "now" },
    { actorType: "AgentSession", key: "s_77k", awake: false, lastTurn: "14m" },
    { actorType: "NightlyReport", key: "singleton", awake: false, lastTurn: "9h" },
  ],
  deadLetters: 3,
}
