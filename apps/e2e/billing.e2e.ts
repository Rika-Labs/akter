import { KnownPlan, UnboundPlan, UnknownPlan } from "@akter/cloud-api"
import { expect, type Page, type Route, test } from "@playwright/test"

const origin = `http://127.0.0.1:${process.env.E2E_LIVE_PORT ?? "3539"}`
const session = {
  user: { id: "u_bill", name: "Billing Owner", email: "owner@example.com", emailVerified: true },
  session: { id: "s_bill" },
}
const organizationPlan = (plan: string) => {
  if (plan === "free" || plan === "pro") return KnownPlan.make({ id: plan })
  if (plan === "legacy") return UnknownPlan.make({ id: plan })
  return UnboundPlan.make({})
}
const organization = (plan: string) => ({
  id: "org_bill",
  name: "Billing Org",
  slug: "billing-org",
  plan: organizationPlan(plan),
  createdAt: "2026-01-01T00:00:00Z",
})
const project = {
  id: "prj_bill",
  organizationId: "org_bill",
  name: "Ledger",
  slug: "ledger",
  status: "empty",
  homeRegion: "us-west-2",
  createdAt: "2026-01-01T00:00:00Z",
}

const plan = (input: { id: string; name: string; basePriceCents: number; estimate: number }) => ({
  id: input.id,
  subscribedId: input.id,
  paymentStatus: input.id === "free" ? "free" : "active",
  name: input.name,
  basePriceCents: input.basePriceCents,
  currency: "usd",
  renewsAt: input.id === "free" ? null : "2026-11-01T00:00:00Z",
  monthToDateEstimateCents: input.estimate,
  provisional: true,
})

type Cap = "commands" | "spend" | "connections" | "storage"

/** Caps as the control plane reports them; `refusing` names the ones the edge refuses at now. */
const caps = (input: {
  readonly plan: "free" | "pro"
  readonly commandUnits: number
  readonly storageBytes?: number
  readonly spendLimitCents?: number | null
  readonly refusing?: ReadonlyArray<Cap>
}) => {
  const refusing = (cap: Cap) => input.refusing?.includes(cap) ?? false
  const free = input.plan === "free"
  return [
    {
      cap: "commands",
      limit: free ? 5_000_000 : null,
      used: input.commandUnits,
      atCap: refusing("commands"),
      refusing: refusing("commands"),
      unitsPerCommand: 5,
    },
    {
      cap: "spend",
      limit: input.spendLimitCents ?? null,
      used: free ? 0 : 3_102,
      atCap: refusing("spend"),
      refusing: refusing("spend"),
    },
    {
      cap: "connections",
      limit: free ? 100 : 5_000,
      used: 2,
      atCap: false,
      refusing: false,
    },
    {
      cap: "storage",
      limit: free ? 500_000_000 : null,
      used: input.storageBytes ?? 120_000_000,
      atCap: refusing("storage"),
      refusing: refusing("storage"),
    },
  ]
}

/** An organization without a billing account: every cap refuses, with no limit to quote. */
const unboundCaps = caps({ plan: "free", commandUnits: 600 }).map((cap) => ({
  ...cap,
  limit: null,
  atCap: false,
  refusing: true,
  reason: "unbound",
}))

const freeBilling = {
  plan: plan({ id: "free", name: "Free", basePriceCents: 0, estimate: 0 }),
  paymentMethod: null,
  billingEmail: null,
  spendLimit: { limitCents: null, currentSpendCents: 0 },
  caps: caps({ plan: "free", commandUnits: 600_000 }),
}

/** An organization without a billing account, as billing reports it: no plan, limit or spend. */
const unboundBilling = {
  plan: UnboundPlan.make({}),
  paymentMethod: null,
  billingEmail: null,
  spendLimit: { limitCents: null, currentSpendCents: 0 },
  caps: unboundCaps,
}

/** The catalog the API serves; Team is renamed so a hardcoded plan name would show. */
const catalog = {
  plans: [
    {
      id: "free",
      name: "Free",
      basePriceCents: 0,
      currency: "usd",
      allowances: {
        commands: 1_000_000,
        commandCap: 1_000_000,
        storageGb: 0.5,
        concurrentConnections: 100,
      },
      overage: { commandCentsPerMillion: 0, storageCentsPerGbMonth: 0 },
      features: ["command-cap", "storage-cap"],
      provisional: false,
    },
    {
      id: "pro",
      name: "Pro",
      basePriceCents: 2_731,
      currency: "usd",
      allowances: {
        commands: 25_000_000,
        commandCap: null,
        storageGb: 10,
        concurrentConnections: 5_000,
      },
      overage: { commandCentsPerMillion: 100, storageCentsPerGbMonth: 30 },
      features: ["command-overage", "storage-overage", "checkout"],
      provisional: true,
    },
    {
      id: "team",
      name: "Studio",
      basePriceCents: 19_900,
      currency: "usd",
      allowances: {
        commands: 300_000_000,
        commandCap: null,
        storageGb: 100,
        concurrentConnections: 50_000,
      },
      overage: { commandCentsPerMillion: 60, storageCentsPerGbMonth: 30 },
      features: ["command-overage", "storage-overage", "checkout"],
      provisional: true,
    },
    {
      id: "enterprise",
      name: "Enterprise",
      basePriceCents: 250_000,
      currency: "usd",
      allowances: {
        commands: 5_000_000_000,
        commandCap: null,
        storageGb: 1_000,
        concurrentConnections: 100_000,
      },
      overage: { commandCentsPerMillion: 50, storageCentsPerGbMonth: 30 },
      features: ["command-overage", "storage-overage", "checkout"],
      provisional: true,
    },
  ],
  readCommandWeight: 0.2,
  provisional: true,
}

const proBilling = (limitCents: number | null) => ({
  plan: plan({ id: "pro", name: "Pro", basePriceCents: 2_731, estimate: 3_102 }),
  paymentMethod: { brand: "visa", lastFour: "4242", expiryMonth: 4, expiryYear: 2031 },
  billingEmail: "owner@example.com",
  spendLimit: { limitCents, currentSpendCents: 3_102 },
  caps: caps({ plan: "pro", commandUnits: 600_000, spendLimitCents: limitCents }),
})

const usage = (input: {
  commands: number
  included: number
  caps?: ReadonlyArray<object>
  storageBytes?: number
}) => ({
  period: "2026-10",
  latestStorageSample: {
    bytes: input.storageBytes ?? 120_000_000,
    sampledAt: "2026-10-04T09:00:00Z",
  },
  caps:
    input.caps ??
    caps({
      plan: input.included === 1_000_000 ? "free" : "pro",
      commandUnits: input.commands * 5,
      refusing:
        input.included === 1_000_000 && input.commands >= input.included ? ["commands"] : [],
    }),
  meters: [
    {
      meter: "commands",
      used: input.commands,
      included: input.included,
      overage: Math.max(0, input.commands - input.included),
      overageCostCents: 0,
    },
    { meter: "reads", used: 40_000, included: 0, overage: 0, overageCostCents: 0 },
    { meter: "storageGb", used: 0.12, included: 0.5, overage: 0, overageCostCents: 0 },
  ],
  commandsPerDay: [
    { day: "2026-10-01", commands: 410_000 },
    { day: "2026-10-02", commands: 590_000 },
  ],
  byProject: [
    {
      projectId: "prj_bill",
      name: "Ledger",
      commands: 992_000,
      reads: 40_000,
      storageGbMonths: 0.12,
      estimatedCostCents: 0,
    },
  ],
  pricing: {
    freeCommands: 1_000_000,
    readCommandWeight: 0.2,
    storagePerGbCents: 30,
    provisional: true,
  },
})

/** An actor as the inspector reads it; only its address and type matter to the send dialog. */
const inspector = {
  address: "Order/ord-quota",
  state: { total: 3 },
  turn: null,
  tables: null,
  receipts: [],
  events: [],
  jobs: [],
  connections: { sockets: null, feedCursor: null },
  properties: {
    status: null,
    type: "Order",
    generation: 1,
    runner: null,
    region: null,
    tenant: "org_bill",
    mailboxDepth: null,
  },
  timeline: null,
}

const invoices = [
  {
    id: "in_1",
    number: "AKT-0001",
    periodStart: "2026-09-01T00:00:00Z",
    periodEnd: "2026-10-01T00:00:00Z",
    amountCents: 2_731,
    currency: "usd",
    status: "paid",
    pdfUrl: "https://pay.stripe.com/invoice/acct_562/in_1/pdf",
  },
  {
    id: "in_local_0",
    number: "LOCAL-0",
    periodStart: "2026-08-01T00:00:00Z",
    periodEnd: "2026-09-01T00:00:00Z",
    amountCents: 2_731,
    currency: "usd",
    status: "paid",
    pdfUrl: `${origin}/billing/invoices/in_local_0/pdf`,
  },
]

/** Answers the control plane for one organization; `extra` sees each billing request first. */
const controlPlane =
  (input: {
    readonly plan: string
    readonly billing: () => object
    readonly usage: object
    readonly extra?: (route: Route, path: string) => Promise<void> | undefined
  }) =>
  async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    const handled = input.extra?.(route, path)
    if (handled !== undefined) return handled
    if (path === "/api/me")
      return route.fulfill({
        json: {
          user: { ...session.user, image: null },
          identityKind: "session",
          activeOrganizationId: "org_bill",
          organizations: [{ role: "owner", organization: organization(input.plan) }],
        },
      })
    if (path === "/api/organizations/org_bill/projects") return route.fulfill({ json: [project] })
    if (path === "/api/me/pinned-actors") return route.fulfill({ json: [] })
    if (path === "/api/organizations/org_bill/billing")
      return route.fulfill({ json: input.billing() })
    if (path === "/api/organizations/org_bill/billing/invoices")
      return route.fulfill({ json: input.plan === "free" ? [] : invoices })
    if (path === "/api/organizations/org_bill/usage") return route.fulfill({ json: input.usage })
    if (path === "/api/billing/plans") return route.fulfill({ json: catalog })
    return route.fulfill({
      status: 501,
      contentType: "application/json",
      body: '{"_tag":"NotImplemented","operation":"pending.endpoint"}',
    })
  }

const signIn = (page: Page) =>
  page.route("**/auth/get-session", (route) => route.fulfill({ json: session }))

test("shows Free's caps from the API and sends the chosen plan to Stripe Checkout", async ({
  page,
}) => {
  const checkouts: Array<unknown> = []
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page)
  await page.route("https://checkout.stripe.com/c/pay/cs_test_562", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Checkout stand-in</h1>" }),
  )
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "free",
      billing: () => freeBilling,
      usage: usage({ commands: 120_000, included: 1_000_000 }),
      extra: (route, path) => {
        if (path !== "/api/organizations/org_bill/billing/checkout") return undefined
        checkouts.push(route.request().postDataJSON())
        return route.fulfill({ json: { url: "https://checkout.stripe.com/c/pay/cs_test_562" } })
      },
    }),
  )
  await page.goto(`${origin}/settings/billing`)
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible()
  await expect(page.getByText("No monthly charge")).toHaveCount(1)
  await expect(
    page.getByText(
      "1M commands a month (a read counts as 0.2 of a command) and 0.5 GB of storage. Both are hard caps",
    ),
  ).toBeVisible()
  await expect(page.getByText("No invoices yet")).toBeVisible()
  await expect(page.getByRole("note")).toHaveCount(0)
  const picker = page.getByRole("combobox", { name: "Plan to upgrade to" })
  await expect(picker.getByRole("option")).toHaveText([
    "Pro · $27.31 / mo (provisional)",
    "Studio · $199 / mo (provisional)",
    "Enterprise · $2,500 / mo (provisional)",
  ])
  const comparison = page.getByRole("table", { name: "Plan comparison" })
  await expect(comparison.getByRole("row")).toHaveCount(5)
  for (const cell of await comparison.getByRole("cell").all())
    expect(
      await cell.evaluate((element) => element.scrollWidth <= element.clientWidth),
      (await cell.textContent()) ?? "",
    ).toBe(true)
  await expect(comparison.getByRole("row").nth(2).getByRole("cell").nth(1)).toHaveText(
    "$27.31 / mo",
  )
  await expect(comparison.getByRole("row").nth(1).getByRole("cell")).toHaveText([
    "Free (current)",
    "$0",
    "1Mhard cap",
    "0.5 GBhard cap",
    "100",
  ])
  await expect(comparison.getByRole("row").nth(3)).toContainText(
    "Studio$199 / mo300Mthen $0.60 per million",
  )
  await expect(
    page.getByText(
      "Pro, Studio, and Enterprise prices are provisional: they aren’t final and may change before they are published.",
    ),
  ).toBeVisible()
  await picker.selectOption("team")
  await page.getByRole("button", { name: "Continue to checkout" }).click()
  await expect(page).toHaveURL("https://checkout.stripe.com/c/pay/cs_test_562")
  await expect(page.getByRole("heading", { name: "Checkout stand-in" })).toBeVisible()
  expect(checkouts).toEqual([{ plan: "team" }])
})

test("opens the billing portal in a new tab and links invoice PDFs", async ({ page, context }) => {
  let portals = 0
  await signIn(page)
  await context.route("https://billing.stripe.com/p/session/test_562", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Portal stand-in</h1>" }),
  )
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "pro",
      billing: () => proBilling(null),
      usage: usage({ commands: 120_000, included: 25_000_000 }),
      extra: (route, path) => {
        if (path !== "/api/organizations/org_bill/billing/portal") return undefined
        portals += 1
        return route.fulfill({ json: { url: "https://billing.stripe.com/p/session/test_562" } })
      },
    }),
  )
  await page.goto(`${origin}/settings/billing`)
  await expect(page.getByText("Visa ending 4242")).toBeVisible()
  await expect(page.getByText("$27.31 a month plus usage (provisional price)")).toBeVisible()
  const pdf = page.getByRole("link", { name: "Invoice AKT-0001 PDF, opens in a new tab" })
  await expect(pdf).toHaveAttribute("href", "https://pay.stripe.com/invoice/acct_562/in_1/pdf")
  await expect(pdf).toHaveAttribute("target", "_blank")
  await expect(page.getByText("LOCAL-0 · paid", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Invoice LOCAL-0 PDF, opens in a new tab" }),
  ).toHaveCount(0)
  const opened = context.waitForEvent("page")
  await page.getByRole("button", { name: "Update" }).click()
  const portal = await opened
  await expect(portal).toHaveURL("https://billing.stripe.com/p/session/test_562")
  await expect(portal.getByRole("heading", { name: "Portal stand-in" })).toBeVisible()
  expect(await portal.evaluate(() => window.opener)).toBeNull()
  await expect(page).toHaveURL(`${origin}/settings/billing`)
  expect(portals).toBe(1)
})

test("saves a spend limit and requests a paid plan change", async ({ page }) => {
  let limit: number | null = null
  const changes: Array<unknown> = []
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "pro",
      billing: () => proBilling(limit),
      usage: usage({ commands: 120_000, included: 25_000_000 }),
      extra: (route, path) => {
        if (path === "/api/organizations/org_bill/billing/spend-limit") {
          expect(route.request().method()).toBe("PUT")
          const body: unknown = route.request().postDataJSON()
          expect(body).toEqual({ limitCents: 50_000 })
          limit = 50_000
          return route.fulfill({ json: { limitCents: 50_000, currentSpendCents: 3_102 } })
        }
        if (path === "/api/organizations/org_bill/billing/plan") {
          changes.push(route.request().postDataJSON())
          return route.fulfill({ json: { requestId: "req_1", status: "pending" } })
        }
        return undefined
      },
    }),
  )
  await page.goto(`${origin}/settings/billing`)
  const select = page.getByRole("combobox", { name: "Monthly spend limit" })
  await expect(select).toHaveValue("none")
  await select.selectOption("50000")
  await expect(page.getByText("Spend limit saved")).toBeVisible()
  await expect(page.getByRole("meter", { name: "Spend this month" })).toHaveAttribute(
    "aria-valuetext",
    "$31.02 of $500.00, 6%",
  )
  await page.reload()
  await expect(page.getByRole("combobox", { name: "Monthly spend limit" })).toHaveValue("50000")
  await page.getByRole("combobox", { name: "Plan to change to" }).selectOption("enterprise")
  await page.getByRole("button", { name: "Change plan" }).click()
  await expect(page.getByText("Changing to Enterprise")).toBeVisible()
  await expect(page.getByText("Enterprise applies once the payment goes through.")).toBeVisible()
  expect(changes).toEqual([{ plan: "enterprise" }])
})

test("shows live usage and one quiet notice at Free's command cap", async ({ page }) => {
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "free",
      billing: () => freeBilling,
      usage: usage({ commands: 1_000_000, included: 1_000_000 }),
    }),
  )
  await page.goto(`${origin}/settings/usage`)
  const notice = page.getByRole("note")
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText(
    "This organization has used the 1M commands its plan includes for October 2026.",
  )
  await expect(notice.getByRole("link", { name: "Upgrade" })).toHaveAttribute(
    "href",
    "/settings/billing",
  )
  await expect(page.getByRole("meter", { name: "Commands" })).toHaveAttribute(
    "aria-valuemax",
    "1000000",
  )
  await expect(page.getByText("Counted in commands above as 8,000")).toBeVisible()
  const table = page.getByRole("table", { name: "Usage by project" })
  await expect(table).toContainText("Ledger")
  await expect(table.getByRole("row").nth(1)).toHaveText(["Ledger992K40K$0.00"])
  await page.goto(`${origin}/`)
  await expect(page.getByRole("heading", { name: "Ship your first actor" })).toBeVisible()
  await expect(page.getByRole("note")).toContainText("used the 1M commands its plan includes")
})

test("refuses a billing link off Stripe and closes the tab it opened", async ({
  page,
  context,
}) => {
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "pro",
      billing: () => proBilling(null),
      usage: usage({ commands: 120_000, included: 25_000_000 }),
      extra: (route, path) =>
        path === "/api/organizations/org_bill/billing/portal"
          ? route.fulfill({ json: { url: "https://billing.stripe.com.evil.dev/p/session/x" } })
          : undefined,
    }),
  )
  await page.goto(`${origin}/settings/billing`)
  const opened = context.waitForEvent("page")
  await page.getByRole("button", { name: "Update" }).click()
  const tab = await opened
  await expect(
    page.getByText("Billing returned a link the console doesn’t recognise, so it wasn’t opened."),
  ).toBeVisible()
  await expect.poll(() => tab.isClosed()).toBe(true)
  await expect(page).toHaveURL(`${origin}/settings/billing`)
})

test("never shows an organization without a billing account as Free", async ({ page }) => {
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "unbound",
      billing: () => ({ ...freeBilling, plan: UnboundPlan.make({}), caps: unboundCaps }),
      usage: usage({ commands: 120, included: 1_000_000, caps: unboundCaps }),
    }),
  )
  await page.goto(`${origin}/settings/usage`)
  const notice = page.getByRole("note")
  await expect(notice).toHaveCount(1)
  await expect(notice).toHaveText(
    "Billing isn’t set up for this organization, so new commands are refused. Set up billing",
  )
  await expect(notice.getByRole("link", { name: "Set up billing" })).toHaveAttribute(
    "href",
    "/settings/billing",
  )
  await expect(page.getByRole("meter")).toHaveCount(0)
  await expect(page.getByRole("main")).not.toContainText("of 1M")
  await page.goto(`${origin}/`)
  await expect(page.getByRole("heading", { name: "Ship your first actor" })).toBeVisible()
  await expect(page.getByRole("note")).toHaveText(
    "Billing isn’t set up for this organization, so new commands are refused. Set up billing",
  )
  await page.getByRole("link", { name: "Set up billing" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible()
  await expect(page.getByText("Billing isn’t set up", { exact: true })).toBeVisible()
  await expect(page.getByRole("table", { name: "Plan comparison" })).not.toContainText("current")
  await expect(page.getByText("No monthly charge")).toHaveCount(0)
  await expect(page.getByText("Free", { exact: true })).toHaveCount(1)
  await expect(
    page.getByRole("table", { name: "Plan comparison" }).getByText("Free", { exact: true }),
  ).toHaveCount(1)
  await expect(page.getByRole("combobox", { name: "Plan to upgrade to" })).toBeVisible()
})

test("names an unbound organization's plan as no billing and prices nothing for it", async ({
  page,
}) => {
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "unbound",
      billing: () => unboundBilling,
      usage: usage({ commands: 120, included: 1_000_000, caps: unboundCaps }),
    }),
  )
  await page.goto(`${origin}/`)
  const account = page.getByRole("button", { name: "Account: Billing Owner" })
  await expect(account).toContainText("Billing Org · no billing")
  await expect(account).not.toContainText("Free")
  await page.goto(`${origin}/settings/billing`)
  await expect(page.getByText("Billing isn’t set up", { exact: true })).toBeVisible()
  await expect(account).toContainText("Billing Org · no billing")
  await expect(page.getByText("This month so far")).toHaveCount(0)
  await expect(page.getByText("No monthly charge")).toHaveCount(0)
  await page.goto(`${origin}/settings/usage`)
  await expect(page.getByRole("table", { name: "Usage by project" })).toContainText("Ledger")
  await expect(page.getByRole("columnheader", { name: "Estimate" })).toHaveCount(0)
  await expect(page.getByRole("main")).not.toContainText("$")
  await expect(page.getByRole("main")).not.toContainText("provisional")
})

test("says an unknown plan isn't recognised, calmly, while org context still loads", async ({
  page,
}) => {
  const unknownPlan = {
    status: 503,
    contentType: "application/json",
    body: '{"_tag":"Unavailable","message":"The organization\'s plan legacy is not in the pricing configuration","retryAfterSeconds":60,"reason":"unknownPlan"}',
  }
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "legacy",
      billing: () => freeBilling,
      usage: usage({ commands: 120_000, included: 1_000_000 }),
      extra: (route, path) =>
        path === "/api/organizations/org_bill/billing" ||
        path === "/api/organizations/org_bill/usage"
          ? route.fulfill(unknownPlan)
          : undefined,
    }),
  )
  await page.goto(`${origin}/settings/billing`)
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible()
  await expect(
    page.getByText("This organization’s plan isn’t recognised. Contact support."),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Account: Billing Owner" })).toContainText(
    "Billing Org · plan not recognised",
  )
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0)
  await expect(page.getByText("Billing can’t be read right now")).toHaveCount(0)
  await expect(page.getByRole("main")).not.toContainText("legacy")
  await page.goto(`${origin}/settings/usage`)
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible()
  await expect(
    page.getByText("This organization’s plan isn’t recognised. Contact support."),
  ).toBeVisible()
  await expect(page.getByRole("meter")).toHaveCount(0)
  await page.goto(`${origin}/`)
  await expect(page.getByRole("heading", { name: "Ship your first actor" })).toBeVisible()
  const notice = page.getByRole("note")
  await expect(notice).toHaveText(
    "This organization’s plan isn’t recognised, so new commands are refused. Contact support.",
  )
  await expect(notice.getByRole("link")).toHaveCount(0)
})

test("explains a tenant at Free's storage cap from the latest sample", async ({ page }) => {
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "free",
      billing: () => freeBilling,
      usage: usage({
        commands: 120_000,
        included: 1_000_000,
        storageBytes: 640_000_000,
        caps: caps({
          plan: "free",
          commandUnits: 600_000,
          storageBytes: 512_340_000,
          refusing: ["storage"],
        }),
      }),
    }),
  )
  await page.goto(`${origin}/settings/usage`)
  const notice = page.getByRole("note")
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText(
    "A tenant stores 0.51 GB of the 0.5 GB its plan allows, so new commands are paused; reads keep working.",
  )
  await expect(notice.getByRole("link", { name: "Upgrade" })).toHaveAttribute(
    "href",
    "/settings/billing",
  )
  await expect(
    page.getByText(
      "Latest sample across serving deployments, taken Oct 4, 09:00 UTC. The largest tenant holds 0.51 GB of the 0.5 GB each tenant may store",
    ),
  ).toBeVisible()
  await expect(page.getByText("0.64 GB")).toBeVisible()
})

test("explains a plan the pricing doesn't know calmly instead of as an outage", async ({
  page,
}) => {
  const unavailable = {
    status: 503,
    contentType: "application/json",
    body: '{"_tag":"Unavailable","message":"The organization\'s plan legacy is not in the pricing configuration","retryAfterSeconds":60}',
  }
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "free",
      billing: () => freeBilling,
      usage: usage({ commands: 120_000, included: 1_000_000 }),
      extra: (route, path) =>
        path === "/api/organizations/org_bill/billing" ||
        path === "/api/organizations/org_bill/usage"
          ? route.fulfill(unavailable)
          : undefined,
    }),
  )
  await page.goto(`${origin}/settings/billing`)
  await expect(
    page.getByText(
      "Billing can’t be read right now, so plan and usage figures aren’t shown. Try again in a minute.",
    ),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
  await expect(page.getByText("We couldn’t reach Akter")).toHaveCount(0)
})

test("explains a typed quota refusal in the send dialog and links to Billing", async ({ page }) => {
  let sends = 0
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "free",
      billing: () => freeBilling,
      usage: usage({ commands: 120_000, included: 1_000_000 }),
      extra: (route, path) => {
        if (path === "/api/organizations/org_bill/projects")
          return route.fulfill({ json: [{ ...project, status: "live" }] })
        if (path.endsWith("/runtime/actors/Order/ord-quota"))
          return route.fulfill({ json: inspector })
        if (!path.endsWith("/runtime/commands") || route.request().method() !== "POST")
          return undefined
        sends += 1
        return route.fulfill({
          status: 429,
          contentType: "application/json",
          body: '{"_tag":"QuotaExceeded","organizationId":"org_bill","period":"2026-10","limitUnits":5000000,"usedUnits":5000000,"requestedUnits":5,"retryAfterMs":2419200000}',
        })
      },
    }),
  )
  await page.goto(`${origin}/actors/Order/ord-quota`)
  await page.getByRole("button", { name: "Send command", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await dialog.getByLabel("Command", { exact: true }).fill("Refund")
  await dialog.getByLabel("Payload", { exact: true }).fill('{"amount":17}')
  await dialog.getByRole("button", { name: "Send command", exact: true }).click()
  const alert = dialog.getByRole("alert")
  await expect(alert).toHaveText(
    "This organization has used all the commands its plan includes for October 2026, so new commands are refused until the month ends. Reads keep working; upgrading raises the allowance. Open Billing",
  )
  await expect(alert.getByRole("link", { name: "Open Billing" })).toHaveAttribute(
    "href",
    "/settings/billing",
  )
  expect(sends).toBe(1)
})

test("explains a command the edge couldn't bill and offers no resend with the same ID", async ({
  page,
}) => {
  let sends = 0
  await signIn(page)
  await page.route(
    "**/api/**",
    controlPlane({
      plan: "unbound",
      billing: () => unboundBilling,
      usage: usage({ commands: 120, included: 1_000_000, caps: unboundCaps }),
      extra: (route, path) => {
        if (path === "/api/organizations/org_bill/projects")
          return route.fulfill({ json: [{ ...project, status: "live" }] })
        if (path.endsWith("/runtime/actors/Order/ord-quota"))
          return route.fulfill({ json: inspector })
        if (!path.endsWith("/runtime/commands") || route.request().method() !== "POST")
          return undefined
        sends += 1
        return route.fulfill({
          status: 402,
          contentType: "application/json",
          body: '{"_tag":"QuotaUnbound","deployment":"dep_bill","tenant":"org_bill","reason":"account"}',
        })
      },
    }),
  )
  await page.goto(`${origin}/actors/Order/ord-quota`)
  await page.getByRole("button", { name: "Send command", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await dialog.getByLabel("Command", { exact: true }).fill("Refund")
  await dialog.getByLabel("Payload", { exact: true }).fill('{"amount":17}')
  const send = dialog.getByRole("button", { name: "Send command", exact: true })
  await send.click()
  const alert = dialog.getByRole("alert")
  await expect(alert).toHaveText(
    "Billing isn’t set up for this organization, so the command wasn’t run. Choose a plan in Billing, then send it as a new command. Open Billing",
  )
  await expect(alert.getByRole("link", { name: "Open Billing" })).toHaveAttribute(
    "href",
    "/settings/billing",
  )
  await expect(alert).not.toContainText("couldn’t reach Akter")
  await expect(send).toBeDisabled()
  expect(sends).toBe(1)
})
