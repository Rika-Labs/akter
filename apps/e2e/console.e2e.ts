import { expect, test } from "@playwright/test"

test("renders fixture data and follows workspace navigation", async ({ page }) => {
  await page.goto("/dashboard")

  await expect(page).toHaveTitle("Workspace overview · Forma")
  await expect(page.getByRole("heading", { name: "Workspace overview" })).toBeVisible()
  await expect(page.getByText("Northstar Studio (test data)", { exact: true })).toBeVisible()
  await expect(page.getByRole("row", { name: /Website refresh active/ })).toBeVisible()
  await expect(page.getByRole("row", { name: /Customer research planning/ })).toBeVisible()

  await page.getByRole("link", { name: "Settings" }).click()

  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole("heading", { name: "Organization settings" })).toBeVisible()
  await expect(page.getByLabel("Organization")).toHaveValue("org-1")
  await expect(page.getByLabel("Organization").getByRole("option")).toHaveText([
    "Northstar Studio",
    "Research team (test data)",
  ])
})

test("renders the empty dashboard state from the fixture query", async ({ page }) => {
  await page.goto("/dashboard?empty=1")

  await expect(page.getByRole("heading", { name: "Workspace overview" })).toBeVisible()
  await expect(page.getByText("Projects", { exact: true })).toBeVisible()
  await expect(page.getByText("0 total", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "A fresh space for good work" })).toBeVisible()
  await expect(
    page.getByText("Create an organization to start bringing your team together."),
  ).toBeVisible()
  await expect(page.getByText("Website refresh", { exact: true })).toHaveCount(0)
})

test("enforces the sign-in form boundary and reports the read-only fixture response", async ({
  page,
}) => {
  await page.goto("/sign-in")

  const email = page.getByLabel("Email address")
  const password = page.getByLabel("Password")

  await email.fill("alex@example.test")
  await password.fill("short")
  await page.getByRole("button", { name: "Sign in" }).click()

  await expect(password).toHaveJSProperty("validity.valid", false)
  await expect(page).toHaveURL(/\/sign-in$/)

  await password.fill("fixture-password")

  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/forms/sign-in") && candidate.request().method() === "POST",
  )

  await page.getByRole("button", { name: "Sign in" }).click()

  expect((await response).status()).toBe(503)
  await expect(page.getByRole("alert")).toContainText(
    "This is a read-only test fixture, not a live account service.",
  )
})
