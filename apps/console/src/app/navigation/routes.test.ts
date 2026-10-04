import { Option } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, it } from "vitest"
import { AppRoute } from "./routes.ts"
import * as Routes from "./routes.ts"

const parse = (path: string) =>
  Routes.parseUrl(Option.getOrThrow(fromString(`https://console.test${path}`)))

describe("console routes", () => {
  it("prints every page to a path that parses back to the same route", () => {
    const pages = [
      Routes.overview(),
      Routes.project({ project: "support-bot" }),
      Routes.actorType({ actorType: "Order" }),
      Routes.actor({ actorType: "Order", key: "ord_8f2c", tab: "receipts" }),
      Routes.deployment({ deployment: "a3f9c21" }),
      Routes.acceptInvitation({ invitation: "inv_42" }),
      Routes.onboarding({ step: "deploy" }),
      Routes.settingsGeneral(),
      Routes.settingsKeys(),
      Routes.settingsAudit(),
    ]
    expect(pages.map((path) => parse(path)._tag)).toEqual([
      "Overview",
      "Project",
      "ActorType",
      "Actor",
      "Deployment",
      "AcceptInvitation",
      "Onboarding",
      "SettingsGeneral",
      "SettingsKeys",
      "SettingsAudit",
    ])
  })

  it("keeps an actor's type, key and tab apart instead of reading the key as a type", () => {
    expect(parse("/actors/Order/ord_8f2c?tab=rows")).toEqual(
      AppRoute.Actor({ actorType: "Order", key: "ord_8f2c", tab: "rows" }),
    )
    expect(parse("/actors/Order")).toEqual(AppRoute.ActorType({ actorType: "Order" }))
  })

  it("reads the onboarding step from the query and leaves it out when absent", () => {
    expect(parse("/onboarding?step=project")).toEqual(AppRoute.Onboarding({ step: "project" }))
    expect(parse("/onboarding")).toEqual(AppRoute.Onboarding({}))
  })

  it("uses the canonical invitation URL now used by account emails", () => {
    expect(parse("/invitations/inv_537")).toEqual(
      AppRoute.AcceptInvitation({ invitation: "inv_537" }),
    )
    expect(Routes.acceptInvitation({ invitation: "inv_537" })).toBe("/invitations/inv_537")
    expect(parse("/accept-invitation")._tag).toBe("NotFound")
    expect(parse("/accept-invitation?invitationId=inv_537")._tag).toBe("NotFound")
  })

  it("sends deeper or unknown paths to the not-found page with the path that missed", () => {
    expect(parse("/actors/Order/ord_8f2c/history")).toEqual(
      AppRoute.NotFound({ path: "/actors/Order/ord_8f2c/history" }),
    )
    expect(parse("/settings/billing/extra")._tag).toBe("NotFound")
  })

  it("separates signed-out screens and settings from product pages", () => {
    expect(Routes.isAuthRoute(parse("/sign-in"))).toBe(true)
    expect(Routes.isAuthRoute(parse("/"))).toBe(false)
    expect(Routes.isSettingsRoute(parse("/settings/members"))).toBe(true)
    expect(Routes.isSettingsRoute(parse("/regions"))).toBe(false)
  })
})
