import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Scene from "foldkit/scene"
import * as Url from "foldkit/url"
import { describe, it } from "vitest"
import type { Message } from "../shell/message.ts"
import type { Model } from "../shell/model.ts"
import { init } from "../shell/update.ts"
import { workspace } from "../workspace/fixtures.ts"
import { type CapState, UnboundPlan } from "@akter/cloud-api"
import { plansSlice } from "./fixtures.ts"
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
  caps: [],
}

const plans = plansSlice.plans ?? null

/** Free's caps as the control plane reports them with `commandUnits` used. */
const freeCaps = (commandUnits: number): ReadonlyArray<CapState> => [
  {
    cap: "commands",
    limit: 5_000_000,
    used: commandUnits,
    atCap: commandUnits >= 5_000_000,
    refusing: commandUnits + 5 > 5_000_000,
    unitsPerCommand: 5,
  },
  { cap: "spend", limit: null, used: 0, atCap: false, refusing: false },
  { cap: "connections", limit: 100, used: 3, atCap: false, refusing: false },
  { cap: "storage", limit: 500_000_000, used: 4_200_000, atCap: false, refusing: false },
]

const unboundCaps: ReadonlyArray<CapState> = freeCaps(0).map((cap) => ({
  cap: cap.cap,
  limit: null,
  used: cap.used,
  atCap: false,
  refusing: true,
  reason: "unbound",
}))

/** An organization without a billing account, as billing reports it: no plan and every cap unbound. */
const unbound: Billing = {
  ...free,
  plan: UnboundPlan.make({}),
  caps: unboundCaps,
}

const usage = (commandsUsed: number): Usage => ({
  period: "2026-10",
  latestStorageSample: { bytes: 4_200_000, sampledAt: Date.UTC(2026, 9, 4, 9) },
  caps: freeCaps(commandsUsed * 5),
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
  it("shows Free's hard caps from the catalog and starts checkout from its plans", () =>
    scene(
      billingScreen,
      { ...emptySettings, billing: free, plans, usage: usage(10) },
      Scene.expect(Scene.text("No monthly charge")).toExist(),
      Scene.expect(
        Scene.text(
          "1M commands a month (a read counts as 0.2 of a command) and 0.5 GB of storage. Both are hard caps: at either one, new commands are refused while reads keep working.",
        ),
      ).toExist(),
      Scene.expect(Scene.role("button", { name: "Continue to checkout" })).toBeEnabled(),
      Scene.expect(Scene.label("Plan to upgrade to")).toHaveValue("pro"),
      Scene.expect(Scene.role("option", { name: "Team · $249 / mo (provisional)" })).toExist(),
      Scene.expect(Scene.role("table", { name: "Plan comparison" })).toContainText(
        "Free (current)",
      ),
      Scene.expect(Scene.role("table", { name: "Plan comparison" })).toContainText(
        "25Mthen $1.00 per million",
      ),
      Scene.expect(Scene.role("cell", { name: "$249 / mo" })).toExist(),
      Scene.expect(Scene.role("cell", { name: "$0" })).toExist(),
      Scene.expect(
        Scene.text(
          "Pro, Team, and Enterprise prices are provisional: they aren’t final and may change before they are published.",
        ),
      ).toExist(),
      Scene.expect(Scene.text("No invoices yet")).toExist(),
      Scene.expect(Scene.role("note")).toBeAbsent(),
    ))

  it("offers no plan to buy when the catalog couldn't be read", () =>
    scene(
      billingScreen,
      { ...emptySettings, billing: free, usage: usage(10) },
      Scene.expect(Scene.label("Plan to upgrade to")).toBeAbsent(),
      Scene.expect(Scene.role("table", { name: "Plan comparison" })).toBeAbsent(),
      Scene.expect(Scene.text("No monthly charge")).toExist(),
    ))

  it("never calls an organization without a billing account Free", () =>
    scene(
      billingScreen,
      { ...emptySettings, billing: unbound, plans, usage: usage(0) },
      Scene.expect(Scene.text("Billing isn’t set up")).toExist(),
      Scene.expect(
        Scene.text(
          "This organization has no billing account, so new commands are refused. Choosing a plan sets one up.",
        ),
      ).toExist(),
      Scene.expectAll(Scene.all.text("Free")).toHaveCount(1),
      Scene.expect(Scene.text("Included")).toBeAbsent(),
      Scene.expect(Scene.role("table", { name: "Plan comparison" })).not.toContainText("(current)"),
      Scene.expect(Scene.text("Applies once you’re on a paid plan.")).toExist(),
    ))

  it("reads an unbound organization from billing's own plan, even without usage", () =>
    scene(
      billingScreen,
      { ...emptySettings, billing: unbound, plans },
      Scene.expect(Scene.text("Billing isn’t set up")).toExist(),
      Scene.expect(Scene.text("Included")).toBeAbsent(),
      Scene.expect(Scene.role("note")).toBeAbsent(),
    ))

  it("shows an unbound organization no price, estimate or allowance of its own", () =>
    scene(
      billingScreen,
      { ...emptySettings, billing: unbound, plans, usage: usage(0) },
      Scene.expect(Scene.text("This month so far")).toBeAbsent(),
      Scene.expect(Scene.text("No monthly charge")).toBeAbsent(),
      Scene.expect(Scene.text("Choose a plan")).toExist(),
      Scene.expect(Scene.role("button", { name: "Continue to checkout" })).toExist(),
    ))

  it("says calmly that an unknown plan isn't recognised instead of failing or pricing it", () =>
    scene(
      billingScreen,
      { ...emptySettings, unknownPlan: true, plans },
      Scene.expect(Scene.text("Plan not recognised")).toExist(),
      Scene.expect(
        Scene.text("This organization’s plan isn’t recognised. Contact support."),
      ).toExist(),
      Scene.expect(Scene.text("Billing isn’t set up")).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Continue to checkout" })).toBeAbsent(),
      Scene.expect(Scene.label("Monthly spend limit")).toBeAbsent(),
    ))

  it("names the plan from the billing response instead of assuming Free", () =>
    scene(
      billingScreen,
      {
        ...emptySettings,
        billing: { ...free, plan: { ...free.plan, name: "Hobby" } },
        plans,
        usage: usage(10),
      },
      Scene.expect(
        Scene.text("Applies once you’re on a paid plan; Hobby stops at what it includes instead."),
      ).toExist(),
      Scene.expect(Scene.role("button", { name: "Continue to checkout" })).toExist(),
    ))

  it("states a refusing cap on Billing without linking back to it", () =>
    scene(
      billingScreen,
      { ...emptySettings, billing: { ...free, caps: freeCaps(5_000_000) }, plans, usage: usage(0) },
      Scene.expect(Scene.role("note")).toHaveText(
        "This organization has used the 1M commands its plan includes for October 2026. New commands are refused until next month; reads keep working.",
      ),
      Scene.expect(Scene.role("link", { name: "Upgrade" })).toBeAbsent(),
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
        plans,
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
      Scene.expect(Scene.role("option", { name: "Team · $249 / mo (provisional)" })).toBeAbsent(),
      Scene.expect(
        Scene.role("link", { name: "Invoice INV-1 PDF, opens in a new tab" }),
      ).toHaveAttr("target", "_blank"),
      Scene.expect(
        Scene.role("link", { name: "Invoice INV-1 PDF, opens in a new tab" }),
      ).toHaveAttr("href", "https://files.example/in_1.pdf"),
    ))
})

describe("usage", () => {
  it("puts one quiet notice above the meters once the edge refuses at Free's commands", () =>
    scene(
      usageScreen,
      { ...emptySettings, usage: usage(1_000_000) },
      Scene.expectAll(Scene.all.role("note")).toHaveCount(1),
      Scene.expect(Scene.role("note")).toContainText(
        "This organization has used the 1M commands its plan includes for October 2026. New commands are refused until next month; reads keep working.",
      ),
      Scene.expect(Scene.role("link", { name: "Upgrade" })).toHaveAttr("href", "/settings/billing"),
      Scene.expect(Scene.text("Counted in commands above as 3,000")).toExist(),
    ))

  it("stays quiet while the edge still admits a command", () =>
    scene(
      usageScreen,
      { ...emptySettings, usage: usage(999_999) },
      Scene.expect(Scene.role("note")).toBeAbsent(),
      Scene.expect(Scene.text("Paid prices are provisional.")).toExist(),
      Scene.expect(Scene.selector("div")).toContainText("of 1M"),
      Scene.expect(Scene.selector("div")).toContainText("of 0.5 GB"),
      Scene.expect(
        Scene.text(
          "Commands plus reads, a read counting as 0.2 of a command. This plan stops new commands here until next month; reads keep working",
        ),
      ).toExist(),
    ))

  it("explains an unbound organization calmly, with one notice and no Free wording", () =>
    scene(
      usageScreen,
      { ...emptySettings, usage: { ...usage(12), caps: unboundCaps } },
      Scene.expectAll(Scene.all.role("note")).toHaveCount(1),
      Scene.expect(Scene.role("note")).toContainText(
        "Billing isn’t set up for this organization, so new commands are refused.",
      ),
      Scene.expect(Scene.role("link", { name: "Set up billing" })).toHaveAttr(
        "href",
        "/settings/billing",
      ),
      Scene.expect(Scene.role("note")).not.toContainText("Free"),
      Scene.expect(
        Scene.text("Commands plus reads, a read counting as 0.2 of a command"),
      ).toExist(),
      Scene.expect(Scene.text("Average stored this month")).toExist(),
      Scene.expectAll(Scene.all.role("meter")).toHaveCount(0),
      Scene.expect(Scene.selector("div")).not.toContainText("of 1M"),
      Scene.expect(Scene.selector("div")).not.toContainText("of 0.5 GB"),
      Scene.expect(Scene.selector("div")).not.toContainText("Nothing included"),
    ))

  it("lets no allowance or price Free's pricing gives an unbound organization leak", () =>
    scene(
      usageScreen,
      {
        ...emptySettings,
        usage: {
          ...usage(12),
          caps: unboundCaps,
          meters: usage(12).meters.map((meter) => ({ ...meter, overageCostCents: 700 })),
          projects: [
            { id: "prj_1", name: "storefront", commands: 12, reads: 15, estimatedCostCents: 1_234 },
          ],
        },
      },
      Scene.expect(Scene.selector("div")).not.toContainText("$"),
      Scene.expect(Scene.selector("div")).not.toContainText("provisional"),
      Scene.expect(Scene.selector("div")).not.toContainText("allowance"),
      Scene.expect(Scene.selector("div")).not.toContainText("per GB"),
      Scene.expect(Scene.role("columnheader", { name: "Estimate" })).toBeAbsent(),
      Scene.expect(Scene.role("table", { name: "Usage by project" })).toContainText("storefront"),
    ))

  it("says calmly that an unknown plan isn't recognised instead of showing usage", () =>
    scene(
      usageScreen,
      { ...emptySettings, unknownPlan: true },
      Scene.expect(
        Scene.text("This organization’s plan isn’t recognised. Contact support."),
      ).toExist(),
      Scene.expectAll(Scene.all.role("meter")).toHaveCount(0),
    ))

  it("shows the latest storage sample and the storage cap the edge refuses at", () =>
    scene(
      usageScreen,
      {
        ...emptySettings,
        usage: {
          ...usage(12),
          latestStorageSample: { bytes: 734_000_000, sampledAt: Date.UTC(2026, 9, 4, 9) },
          caps: freeCaps(60).map((cap) =>
            cap.cap === "storage"
              ? { ...cap, used: 512_340_000, atCap: true, refusing: true }
              : cap,
          ),
        },
      },
      Scene.expectAll(Scene.all.role("note")).toHaveCount(1),
      Scene.expect(Scene.role("note")).toContainText(
        "A tenant stores 0.51 GB of the 0.5 GB its plan allows, so new commands are paused; reads keep working.",
      ),
      Scene.expect(
        Scene.text(
          "Latest sample across serving deployments, taken Oct 4, 09:00 UTC. The largest tenant holds 0.51 GB of the 0.5 GB each tenant may store",
        ),
      ).toExist(),
      Scene.expect(Scene.text("0.73 GB")).toExist(),
    ))
})

describe("costs", () => {
  const pro: Billing = {
    ...free,
    plan: {
      ...free.plan,
      id: "pro",
      name: "Pro",
      subscribed: "pro",
      paymentStatus: "active",
      basePriceCents: 2_500,
      provisional: true,
      monthToDateCents: 2_500.3,
    },
    spendLimit: { limitCents: null, currentCents: 30_000 },
  }

  it("shows a fraction of a cent as under a cent and marks provisional estimates", () =>
    scene(
      usageScreen,
      {
        ...emptySettings,
        billing: pro,
        usage: {
          ...usage(25_000_001.5),
          caps: [],
          meters: [
            {
              meter: "commands",
              label: "Commands",
              used: 25_000_001.5,
              included: 25_000_000,
              overage: 1.5,
              overageCostCents: 0.3,
              unit: "count",
            },
          ],
          projects: [
            { id: "prj_1", name: "storefront", commands: 2, reads: 0, estimatedCostCents: 0.3 },
          ],
        },
      },
      Scene.expect(Scene.role("meter", { name: "Commands" })).toExist(),
      Scene.expect(
        Scene.text(
          "Commands plus reads, a read counting as 0.2 of a command. <$0.01 over the allowance so far",
        ),
      ).toExist(),
      Scene.expect(
        Scene.text(
          "Estimates share out usage beyond the allowance; the plan’s price is not split. They use provisional prices.",
        ),
      ).toExist(),
      Scene.expect(Scene.role("table", { name: "Usage by project" })).toContainText("<$0.01"),
    ))

  it("estimates the month from provisional prices when the plan's are", () =>
    scene(
      billingScreen,
      { ...emptySettings, billing: pro },
      Scene.expect(
        Scene.text(
          "Estimated from provisional prices: the plan’s price plus usage beyond what it includes",
        ),
      ).toExist(),
    ))

  it("asks before saving a spend limit the month's estimate has already reached", () =>
    Scene.scene(
      {
        update: (model: Model) => ({ model }),
        view: render(billingScreen, { ...emptySettings, billing: pro }),
      },
      Scene.given({ ...shell(), choices: { ...shell().choices, spendLimit: "25000" } }),
      Scene.expect(Scene.text("New commands will be refused right away")).toExist(),
      Scene.expect(Scene.role("button", { name: "Save limit" })).toBeEnabled(),
    ))

  it("saves a limit above the estimate without asking", () =>
    Scene.scene(
      {
        update: (model: Model) => ({ model }),
        view: render(billingScreen, { ...emptySettings, billing: pro }),
      },
      Scene.given({ ...shell(), choices: { ...shell().choices, spendLimit: "50000" } }),
      Scene.expect(Scene.text("New commands will be refused right away")).toBeAbsent(),
      Scene.expect(Scene.role("meter", { name: "Spend this month" })).toExist(),
    ))
})
