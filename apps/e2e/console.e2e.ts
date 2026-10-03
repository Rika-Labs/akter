import { expect, test } from "@playwright/test"

test("moves from the overview to an actor through the sidebar and its tables", async ({ page }) => {
  await page.goto("/")

  await expect(page).toHaveTitle("Overview · Akter")
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible()

  const navigation = page.getByRole("navigation", { name: "Project" })
  await navigation.getByRole("link", { name: "Actors" }).click()

  await expect(page).toHaveURL(/\/actors$/)
  await expect(navigation.getByRole("link", { name: "Actors" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await page.getByRole("searchbox", { name: "Filter actor types" }).fill("refund")
  const types = page.getByRole("table", { name: "Actor types" })
  await expect(types.getByRole("row")).toHaveCount(2)
  await types.getByRole("link", { name: "Order" }).click()

  await expect(page).toHaveURL(/\/actors\/Order$/)
  await page
    .getByRole("table", { name: "Order instances" })
    .getByRole("link", { name: "ord_9a01" })
    .click()

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

test("inspects an actor's rows and receipts and sends it a command", async ({ page }) => {
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

  await page.getByRole("button", { name: "Send command" }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await expect(dialog.getByLabel("Command", { exact: true })).toBeFocused()
  await dialog.getByLabel("Command", { exact: true }).fill("Refund")
  await dialog.getByRole("button", { name: "Send command" }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByRole("status").filter({ hasText: "Refund committed" })).toBeVisible()
})

test("retries a dead letter and the sidebar count follows", async ({ page }) => {
  await page.goto("/jobs")

  const jobs = page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: /Jobs/ })
  await expect(jobs).toContainText("3")
  await page.getByRole("button", { name: "Retry job_31c" }).click()

  await expect(page.getByRole("table", { name: "Dead letters" }).getByRole("row")).toHaveCount(3)
  await expect(jobs).toContainText("2")
  await expect(page.getByRole("status").filter({ hasText: "Retrying job_31c" })).toBeVisible()
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
