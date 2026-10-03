import { expect, test } from "@playwright/test"

test("navigates sample pages without treating sample rows as live actor identities", async ({
  page,
}) => {
  await page.goto("/")

  await expect(page).toHaveTitle("Overview · Akter")
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible()
  await expect(page.getByRole("note")).toHaveText("Sample data — this page isn’t connected yet.")

  const navigation = page.getByRole("navigation", { name: "Project" })
  await navigation.getByRole("link", { name: "Actors" }).click()

  await expect(page).toHaveURL(/\/actors$/)
  await expect(navigation.getByRole("link", { name: "Actors" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(page.getByRole("searchbox", { name: "Filter actor types" })).toBeDisabled()
  const types = page.getByRole("table", { name: "Actor types" })
  await expect(types.getByRole("row")).toHaveCount(9)
  await expect(types.getByRole("link")).toHaveCount(0)
  await page.goto("/actors/Order")

  await expect(page).toHaveURL(/\/actors\/Order$/)
  await expect(page.getByRole("table", { name: "Order instances" }).getByRole("link")).toHaveCount(
    0,
  )
  await page.goto("/actors/Order/ord_9a01")

  await expect(page).toHaveURL(/\/actors\/Order\/ord_9a01$/)
  await expect(page.getByRole("heading", { level: 1, name: "Order/ord_9a01" })).toBeVisible()
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Actors" })
    .click()
  await expect(page.getByRole("heading", { level: 1, name: "Actors" })).toBeVisible()
})

test("swaps the sidebar for the settings navigation and back", async ({ page }) => {
  await page.goto("/")

  await page.getByRole("complementary").getByRole("link", { name: "Settings", exact: true }).click()

  const settings = page.getByRole("navigation", { name: "Settings" })
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole("navigation", { name: "Project" })).toHaveCount(0)
  await expect(settings.getByRole("heading", { name: "Organization" })).toBeVisible()

  await page.getByRole("searchbox", { name: "Search settings" }).fill("stripe")
  await expect(settings.getByRole("link")).toHaveText(["Billing"])
  await settings.getByRole("link", { name: "Billing" }).click()

  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible()
  await expect(page.getByText("Visa ending 4242")).toBeVisible()

  await page.getByRole("link", { name: "Back to storefront" }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole("navigation", { name: "Project" })).toBeVisible()
})

test("inspects sample actor rows and receipts without sending a command", async ({ page }) => {
  await page.goto("/actors/Order/ord_8f2c")

  const properties = page.getByRole("complementary", { name: "Properties" })
  await expect(properties.getByText("Awake")).toBeVisible()
  await expect(
    page.getByRole("figure").filter({ hasText: '"chargeId": "ch_3Q9xA2"' }),
  ).toBeVisible()

  const inspector = page.getByRole("navigation", { name: "Inspector" })
  await inspector.getByRole("link", { name: "Rows" }).click()
  await expect(page).toHaveURL(/tab=rows/)
  await expect(inspector.getByRole("link", { name: "Rows" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(
    page.getByRole("table", { name: "order_lines" }).getByRole("row", { name: /mug 2 1200/ }),
  ).toBeVisible()

  await inspector.getByRole("link", { name: "Receipts" }).click()
  await expect(
    page.getByRole("table", { name: "Receipts" }).getByRole("row", { name: /replayed/ }),
  ).toBeVisible()

  await expect(page.getByRole("button", { name: "Send command" })).toBeDisabled()
  await expect(page.getByRole("note")).toHaveCount(1)
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("status").filter({ hasText: "Refund committed" })).toHaveCount(0)
})

test("keeps sample dead letters read-only and never reports a retry", async ({ page }) => {
  await page.goto("/jobs")

  const jobs = page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: /Jobs/ })
  await expect(jobs).toHaveText("Jobs")
  await expect(page.getByRole("button", { name: "Retry job_31c" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Retry all" })).toBeDisabled()
  await expect(page.getByRole("table", { name: "Dead letters" }).getByRole("row")).toHaveCount(4)
  await expect(page.getByRole("note")).toHaveCount(1)
  await expect(page.getByRole("status").filter({ hasText: "Retrying" })).toHaveCount(0)
})

test("opens the command palette anywhere, navigates and switches the theme", async ({ page }) => {
  await page.goto("/deployments")

  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog", { name: "Command palette" })
  const search = palette.getByRole("combobox")
  await expect(search).toBeFocused()

  await search.fill("audit")
  await expect(palette.getByRole("option")).toHaveText(["Audit log"])
  await search.press("Enter")

  await expect(page).toHaveURL(/\/settings\/audit-log$/)
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible()

  await page.keyboard.press("ControlOrMeta+k")
  await search.fill("dark theme")
  await search.press("ArrowDown")
  await search.press("ArrowUp")
  await search.press("Enter")

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect(palette).toBeHidden()
})

test("collapses the sidebar into a drawer on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const drawer = page.locator("#navigation")
  await expect(drawer).toHaveAttribute("data-drawer", "closed")
  await expect(page.getByRole("link", { name: "Workflows" })).not.toBeInViewport()

  await page.getByRole("button", { name: "Open navigation" }).click()
  await expect(drawer).toHaveAttribute("data-drawer", "open")
  await page.getByRole("link", { name: "Workflows" }).click()

  await expect(page).toHaveURL(/\/workflows$/)
  await expect(drawer).toHaveAttribute("data-drawer", "closed")
  await expect(page.getByRole("heading", { level: 1, name: "Workflows & timers" })).toBeVisible()
})

test("answers unknown addresses with the not-found page", async ({ page }) => {
  await page.goto("/actors/Order/ord_8f2c/history")

  await expect(page).toHaveTitle("Not found · Akter")
  await expect(page.getByRole("heading", { name: "This page drifted off" })).toBeVisible()
  await page.getByRole("link", { name: "Go to overview" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible()
})
