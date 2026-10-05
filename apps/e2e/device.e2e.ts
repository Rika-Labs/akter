import { KnownPlan } from "@akter/cloud-api"
import { expect, type Page, type Route, test } from "@playwright/test"

const origin = `http://127.0.0.1:${process.env.E2E_LIVE_PORT ?? "3539"}`
const session = {
  user: { id: "u_ada", name: "Ada Lovelace", email: "ada@acme.dev", emailVerified: true },
  session: { id: "s_ada" },
}
const me = {
  user: { ...session.user, image: null },
  identityKind: "session",
  activeOrganizationId: "org_acme",
  organizations: [
    {
      role: "member",
      organization: {
        id: "org_other",
        name: "Other Org",
        slug: "other-org",
        plan: KnownPlan.make({ id: "free" }),
        createdAt: "2026-01-01T00:00:00Z",
      },
    },
    {
      role: "owner",
      organization: {
        id: "org_acme",
        name: "Acme",
        slug: "acme",
        plan: KnownPlan.make({ id: "free" }),
        createdAt: "2026-01-01T00:00:00Z",
      },
    },
  ],
}
const unimplemented = '{"_tag":"NotImplemented","operation":"pending.endpoint"}'

interface DeviceCall {
  readonly method: string
  readonly path: string
  readonly userCode: string | null
}

/**
 * A control plane whose device routes answer as Better Auth's plugin does: the lookup reads
 * `user_code` from the query, approve and deny read `userCode` from the body, and `lookup` decides
 * the lookup's answer. Every call is recorded so a test can prove what was, or wasn't, sent.
 */
const controlPlane = async (
  page: Page,
  options: Readonly<{
    signedIn: { value: boolean }
    lookup: (code: string) => Readonly<{ status: number; body: object }>
  }>,
) => {
  const calls: Array<DeviceCall> = []
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ json: options.signedIn.value ? session : null }),
  )
  await page.route("**/auth/sign-in/email", (route) => {
    options.signedIn.value = true
    return route.fulfill({ json: { redirect: false, token: "t", user: session.user } })
  })
  await page.route("**/auth/device**", (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const body: { userCode?: string } = request.method() === "POST" ? request.postDataJSON() : {}
    const userCode = url.searchParams.get("user_code") ?? body.userCode ?? null
    calls.push({ method: request.method(), path: url.pathname, userCode })
    if (url.pathname === "/auth/device") {
      const answer = options.lookup(userCode ?? "")
      return route.fulfill({ status: answer.status, json: answer.body })
    }
    return route.fulfill({ json: { success: true } })
  })
  await page.route("**/api/**", (route) =>
    new URL(route.request().url()).pathname === "/api/me"
      ? route.fulfill({ json: me })
      : route.fulfill({ status: 501, contentType: "application/json", body: unimplemented }),
  )
  return calls
}

const pending = (code: string) => ({
  status: 200,
  body: { user_code: code, status: "pending", client_id: "akter-cli" },
})

test("approves a code the link prefilled, only after looking it up", async ({ page }) => {
  const calls = await controlPlane(page, { signedIn: { value: true }, lookup: pending })
  await page.goto(`${origin}/device?user_code=wdjb-mjht`)
  await expect(page.getByRole("textbox", { name: "Code" })).toHaveValue("wdjb-mjht")
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0)
  expect(calls).toEqual([])

  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByRole("heading", { name: "Authorize Akter CLI" })).toBeVisible()
  await expect(page.getByText("Check this code matches the one in your terminal.")).toBeVisible()
  await expect(page.locator("#device-user-code")).toHaveText("WDJB-MJHT")
  const account = page.getByRole("definition")
  await expect(account.first()).toContainText("Ada Lovelace")
  await expect(account.first()).toContainText("ada@acme.dev")
  await expect(account.nth(1)).toHaveText("All your organizations (2)")

  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByRole("heading", { name: "You can return to your terminal" })).toBeVisible()
  expect(calls).toEqual([
    { method: "GET", path: "/auth/device", userCode: "WDJBMJHT" },
    { method: "POST", path: "/auth/device/approve", userCode: "WDJBMJHT" },
  ])
})

test("denies a code typed by hand", async ({ page }) => {
  const calls = await controlPlane(page, { signedIn: { value: true }, lookup: pending })
  await page.goto(`${origin}/device`)
  await page.getByRole("textbox", { name: "Code" }).fill("kplq 7rst")
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.locator("#device-user-code")).toHaveText("KPLQ-7RST")

  await page.getByRole("button", { name: "Deny" }).click()
  await expect(page.getByRole("heading", { name: "Request denied" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0)
  expect(calls).toEqual([
    { method: "GET", path: "/auth/device", userCode: "KPLQ7RST" },
    { method: "POST", path: "/auth/device/deny", userCode: "KPLQ7RST" },
  ])
})

test("an expired code gets its own state and can't be approved", async ({ page }) => {
  const calls = await controlPlane(page, {
    signedIn: { value: true },
    lookup: () => ({
      status: 400,
      body: { error: "expired_token", error_description: "User code has expired" },
    }),
  })
  await page.goto(`${origin}/device?user_code=WDJBMJHT`)
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByRole("heading", { name: "This code has expired" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0)
  await expect(page.getByText("User code has expired")).toHaveCount(0)
  await expect(page.getByText("expired_token")).toHaveCount(0)

  await page.getByRole("button", { name: "Enter another code" }).click()
  await expect(page.getByRole("textbox", { name: "Code" })).toHaveValue("")
  expect(calls).toEqual([{ method: "GET", path: "/auth/device", userCode: "WDJBMJHT" }])
})

test("a signed-out visitor signs in and comes back with the code intact", async ({ page }) => {
  const signedIn = { value: false }
  const calls = await controlPlane(page, { signedIn, lookup: pending })
  await page.goto(`${origin}/device?user_code=WDJBMJHT`)
  await expect(page).toHaveURL(`${origin}/sign-in`)
  expect(calls).toEqual([])

  await page.getByRole("textbox", { name: "Email", exact: true }).fill("ada@acme.dev")
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("correct-password")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(`${origin}/device?user_code=WDJBMJHT`)
  await expect(page.getByRole("textbox", { name: "Code" })).toHaveValue("WDJBMJHT")

  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.locator("#device-user-code")).toHaveText("WDJB-MJHT")
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible()
})
