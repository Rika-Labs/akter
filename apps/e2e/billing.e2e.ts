import { expect, type Page, type Route, test } from "@playwright/test"

const origin = `http://127.0.0.1:${process.env.E2E_LIVE_PORT ?? "3539"}`
const session = {
  user: { id: "u_bill", name: "Billing Owner", email: "owner@example.com", emailVerified: true },
  session: { id: "s_bill" },
}
const organization = (plan: string) => ({
  id: "org_bill",
  name: "Billing Org",
  slug: "billing-org",
  plan,
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

const freeBilling = {
  plan: plan({ id: "free", name: "Free", basePriceCents: 0, estimate: 0 }),
  paymentMethod: null,
  billingEmail: null,
  spendLimit: { limitCents: null, currentSpendCents: 0 },
}

const proBilling = (limitCents: number | null) => ({
  plan: plan({ id: "pro", name: "Pro", basePriceCents: 2_731, estimate: 3_102 }),
  paymentMethod: { brand: "visa", lastFour: "4242", expiryMonth: 4, expiryYear: 2031 },
  billingEmail: "owner@example.com",
  spendLimit: { limitCents, currentSpendCents: 3_102 },
})

const usage = (input: { commands: number; included: number }) => ({
  period: "2026-10",
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
  await expect(page.getByText("No monthly charge")).toBeVisible()
  await expect(
    page.getByText(
      "1M commands a month (a read counts as 0.2 of a command) and 0.5 GB of storage. Both are hard caps",
    ),
  ).toBeVisible()
  await expect(page.getByText("No invoices yet")).toBeVisible()
  await expect(page.getByRole("note")).toHaveCount(0)
  await page.getByRole("combobox", { name: "Plan to upgrade to" }).selectOption("team")
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
    "This organization has used the 1M commands Free includes for October 2026.",
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
  await expect(page.getByRole("note")).toContainText("1M commands Free includes")
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
