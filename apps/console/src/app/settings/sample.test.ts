import { describe, expect, it } from "vitest"
import { Action } from "../shell/action.ts"
import { notificationKey, memberRoleKey, spendLimitKey } from "./keys.ts"
import { emptySettings, type SettingsSection } from "./model.ts"
import { actionSections, blockedBySample } from "./sample.ts"

const sampleOf = (...sampleSections: ReadonlyArray<SettingsSection>) => ({
  ...emptySettings,
  sampleSections,
})

describe("blockedBySample", () => {
  const cases: ReadonlyArray<readonly [Action, SettingsSection]> = [
    [Action.SaveToggle({ key: "openInNewTab", enabled: true }), "preferences"],
    [Action.SaveChoice({ key: "timeZone", value: "UTC" }), "preferences"],
    [
      Action.SaveToggle({
        key: notificationKey({ channel: "email", event: "deploy_failed" }),
        enabled: true,
      }),
      "notifications",
    ],
    [Action.SaveChoice({ key: spendLimitKey, value: "none" }), "billing"],
    [Action.SaveChoice({ key: memberRoleKey("mem_1"), value: "admin" }), "members"],
    [Action.UpdateProfile({ name: "Maya" }), "profile"],
    [Action.SendPasswordReset({ email: "maya@acme.dev" }), "profile"],
    [Action.UpdateOrganization({ name: "Acme", slug: "acme" }), "organization"],
    [Action.InviteMember({ email: "a@b.co", role: "member" }), "invitations"],
    [Action.ResendInvitation({ id: "inv_1" }), "invitations"],
    [Action.AddDomain({ hostname: "api.acme.dev", environment: "production" }), "domains"],
    [Action.VerifyDomain({ id: "dom_1" }), "domains"],
    [Action.AddRegion({ region: "eu-west-1" }), "regions"],
    [Action.ConnectIntegration({ kind: "slack" }), "integrations"],
    [Action.StartCheckout({ plan: "pro" }), "billing"],
    [Action.OpenBillingPortal(), "billing"],
    [
      Action.SetVariable({ environment: "production", name: "LOG_LEVEL", value: "debug" }),
      "environments",
    ],
    [Action.CreateKey({ name: "ci", permission: "read", projectScoped: true }), "keys"],
    [Action.RevokeKey({ id: "key_1", name: "ci" }), "keys"],
    [Action.DeleteProject({ slug: "storefront" }), "project"],
  ]

  it.each(cases)("blocks %o only when %s is sample", (action, section) => {
    expect(blockedBySample(sampleOf(section), action)).toBe(true)
    expect(blockedBySample(sampleOf(), action)).toBe(false)
    const others = (["endpoints", "audit", "usage", "invoices"] as const).filter(
      (other) => other !== section,
    )
    expect(blockedBySample(sampleOf(...others), action)).toBe(false)
  })

  it("does not tie console-local keys or other pages' actions to a section", () => {
    expect(actionSections(Action.SaveToggle({ key: "local-only", enabled: true }))).toEqual([])
    expect(actionSections(Action.RollBack({ id: "dep_1", commit: "abc" }))).toEqual([])
  })
})
