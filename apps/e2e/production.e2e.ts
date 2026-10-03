import { expect, test, type Route } from "@playwright/test"

const origin = `http://127.0.0.1:${process.env.E2E_LIVE_PORT ?? "3539"}`
const session =
  '{"user":{"id":"u_real","name":"Real Session User","email":"real@example.com","emailVerified":true},"session":{"id":"s_real"}}'
const me =
  '{"user":{"id":"u_real","name":"Real Session User","email":"real@example.com","emailVerified":true,"image":null},"identityKind":"session","activeOrganizationId":"org_real","organizations":[{"role":"owner","organization":{"id":"org_real","name":"Real Organization","slug":"real-org","plan":"free","createdAt":"2026-01-01T00:00:00Z"}}]}'
const projects =
  '[{"id":"project_real","organizationId":"org_real","name":"Real Project","slug":"real-project","status":"live","homeRegion":"us-west-2","createdAt":"2026-01-01T00:00:00Z"}]'
const unimplemented = '{"_tag":"NotImplemented","operation":"pending.endpoint"}'

const controlPlane = (route: Route) => {
  const path = new URL(route.request().url()).pathname
  if (path === "/api/me") return route.fulfill({ contentType: "application/json", body: me })
  if (path === "/api/organizations/org_real/projects")
    return route.fulfill({ contentType: "application/json", body: projects })
  if (path === "/api/me/pinned-actors" || path === "/api/organizations/org_real/api-keys")
    return route.fulfill({ contentType: "application/json", body: "[]" })
  return route.fulfill({ status: 501, contentType: "application/json", body: unimplemented })
}

test("production ignores the query and stored fixture flag", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("console-fixtures", "1"))
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: "null" }),
  )
  await page.goto(`${origin}/sign-in?fixtures=1`)
  await expect(page.getByRole("heading", { name: "Sign in to Akter" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeEnabled()
  await expect(page.getByRole("note")).toHaveCount(0)
})

test("unimplemented endpoint data is labelled and read-only without replacing session identity", async ({
  page,
}) => {
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", controlPlane)
  await page.goto(`${origin}/actors?fixtures=1`)
  await expect(page.getByRole("button", { name: "Account: Real Session User" })).toBeVisible()
  await expect(page.getByRole("note")).toHaveText("Sample data — this page isn’t connected yet.")
  await expect(page.getByRole("searchbox", { name: "Filter actor types" })).toBeDisabled()
  await expect(page.getByRole("table", { name: "Actor types" }).getByRole("link")).toHaveCount(0)
})

test("a sample endpoint slice does not disable live key controls", async ({ page }) => {
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", controlPlane)
  await page.goto(`${origin}/settings/api-keys`)
  await expect(page.getByRole("note")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Create key" })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Copy HTTP endpoint" })).toBeDisabled()
})

test("client-side navigation clears a typed password", async ({ page }) => {
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: "null" }),
  )
  await page.goto(`${origin}/sign-in`)
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("not-a-real-password")
  await page.getByRole("link", { name: "Sign up" }).click()
  await page.getByRole("link", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Password", exact: true })).toHaveValue("")
})

test("an unavailable organization context fails instead of manufacturing sample identity", async ({
  page,
}) => {
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 501, contentType: "application/json", body: unimplemented }),
  )
  await page.goto(`${origin}/actors`)
  await expect(page.getByRole("button", { name: "Account: Real Session User" })).toBeVisible()
  await expect(page.getByText("This action isn’t available yet.", { exact: true })).toBeVisible()
  await expect(page.getByRole("note")).toHaveCount(0)
  await expect(page.getByRole("table")).toHaveCount(0)
})

test("an API Unauthorized leaves sign-in open even while Better Auth still reports a session", async ({
  page,
}) => {
  let meCalls = 0
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/me", (route) => {
    meCalls += 1
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"_tag":"Unauthorized","code":"expired","message":"Expired API session."}',
    })
  })
  await page.goto(`${origin}/actors`)
  await expect(page).toHaveURL(`${origin}/sign-in`)
  await expect(page.getByRole("heading", { name: "Sign in to Akter" })).toBeVisible()
  await page.waitForTimeout(200)
  await expect(page).toHaveURL(`${origin}/sign-in`)
  expect(meCalls).toBe(2)
})
