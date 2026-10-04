import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Scene from "foldkit/scene"
import * as Url from "foldkit/url"
import { describe, it } from "vitest"
import type { Message } from "../shell/message.ts"
import type { Model } from "../shell/model.ts"
import { init } from "../shell/update.ts"
import { workspace } from "../workspace/fixtures.ts"
import { emptySettings, type Billing, type SettingsPage, type Usage } from "./model.ts"
import { billingScreen, usageScreen } from "./organization.ts"

const shell = (): Model => {
  const url = Option.getOrThrow(Url.fromString("http://localhost/settings/billing"))
  return { ...init({ workspace, theme: "light" }, url).model, loading: false }
}

const free: Billing = {
  plan: {
    id: "free",
    name: "Free",
    subscribed: "free",
    paymentStatus: "free",
    basePriceCents: 0,
    provisional: false,
    renewsAt: null,
    monthToDateCents: 0,
  },
  card: null,
  billingEmail: null,
  spendLimit: { limitCents: null, currentCents: 0 },
}

const usage = (commandsUsed: number): Usage => ({
  period: "2026-10",
  meters: [
    {
      meter: "commands",
      label: "Commands",
      used: commandsUsed,
      included: 1_000_000,
      overage: 0,
      overageCostCents: 0,
      unit: "count",
    },
    {
      meter: "reads",
      label: "Reads",
      used: 15_000,
      included: 0,
      overage: 0,
      overageCostCents: 0,
      unit: "count",
    },
    {
      meter: "storageGb",
      label: "Storage",
      used: 0.0042,
      included: 0.5,
      overage: 0,
      overageCostCents: 0,
      unit: "gigabytes",
    },
  ],
  commandsPerDay: [{ day: "2026-10-01", commands: 12 }],
  projects: [
    { id: "prj_1", name: "storefront", commands: 12, reads: 15_000, estimatedCostCents: 0 },
  ],
  pricing: {
    freeCommands: 1_000_000,
    readCommandWeight: 0.2,
    storagePerGbCents: 30,
    provisional: true,
  },
})

const render =
  (screen: typeof billingScreen, page: SettingsPage) =>
  (model: Model, h: HtmlBuilder<Message>): Html =>
    screen({ h, model, page }).body

const scene = (
  screen: typeof billingScreen,
  page: SettingsPage,
  ...steps: ReadonlyArray<Scene.SceneStep<Model, Message, undefined>>
) =>
  Scene.scene(
    { update: (model: Model) => ({ model }), view: render(screen, page) },
    Scene.given(shell()),
    ...steps,
  )

describe("billing", () => {
  it("shows Free's hard caps from the usage report and starts checkout without quoting a price", () =>
    scene(
      billingScreen,
      { ...emptySettings, billing: free, usage: usage(10) },
      Scene.expect(Scene.text("No monthly charge")).toExist(),
      Scene.expect(
        Scene.text(
          "1M commands a month (a read counts as 0.2 of a command) and 0.5 GB of storage. Both are hard caps: at either one, new commands are refused while reads keep working.",
        ),
      ).toExist(),
      Scene.expect(Scene.role("button", { name: "Continue to checkout" })).toBeEnabled(),
      Scene.expect(Scene.label("Plan to upgrade to")).toHaveValue("pro"),
      Scene.expect(Scene.text("No invoices yet")).toExist(),
    ))

  it("prices a paid plan from the API and says why paid limits are withheld", () =>
    scene(
      billingScreen,
      {
        ...emptySettings,
        billing: {
          ...free,
          plan: {
            ...free.plan,
            subscribed: "team",
            paymentStatus: "past_due",
            basePriceCents: 24_900,
            provisional: true,
          },
        },
        invoices: [
          {
            id: "in_1",
            number: "INV-1",
            periodStart: Date.UTC(2026, 8, 1),
            amountCents: 24_900,
            status: "open",
            pdfUrl: "https://files.example/in_1.pdf",
          },
        ],
      },
      Scene.expect(
        Scene.text(
          "$249.00 a month plus usage (provisional price) · The last payment failed, so Free limits apply until Team is paid for",
        ),
      ).toExist(),
      Scene.expect(Scene.role("button", { name: "Change plan" })).toExist(),
      Scene.expect(Scene.label("Plan to change to")).toHaveValue("pro"),
      Scene.expect(
        Scene.role("link", { name: "Invoice INV-1 PDF, opens in a new tab" }),
      ).toHaveAttr("target", "_blank"),
      Scene.expect(
        Scene.role("link", { name: "Invoice INV-1 PDF, opens in a new tab" }),
      ).toHaveAttr("href", "https://files.example/in_1.pdf"),
    ))
})

describe("usage", () => {
  it("puts one quiet notice above the meters once Free's commands are used up", () =>
    scene(
      usageScreen,
      { ...emptySettings, billing: free, usage: usage(1_000_000) },
      Scene.expectAll(Scene.all.role("note")).toHaveCount(1),
      Scene.expect(Scene.role("note")).toContainText(
        "This organization has used the 1M commands Free includes for October 2026. New commands are refused until next month; reads keep working.",
      ),
      Scene.expect(Scene.role("link", { name: "Upgrade" })).toHaveAttr("href", "/settings/billing"),
      Scene.expect(Scene.text("Counted in commands above as 3,000")).toExist(),
    ))

  it("stays quiet under the cap", () =>
    scene(
      usageScreen,
      { ...emptySettings, billing: free, usage: usage(999_999) },
      Scene.expect(Scene.role("note")).toBeAbsent(),
      Scene.expect(Scene.text("Paid prices are provisional.")).toExist(),
    ))
})
