import { expect, type Page, test } from "@playwright/test"
import { history, openRoom, say, uniqueId } from "./room.ts"

/** Records the command id of every post the page attempts, and of every one the server answered. */
const watchPosts = (page: Page, room: string) => {
  const sent: Array<string> = []
  const answered: Array<string> = []

  page.on("request", (request) => {
    if (request.url().endsWith(`/api/actors/Room/${room}/Post`))
      sent.push(request.headers()["idempotency-key"]!)
  })

  page.on("response", (response) => {
    if (response.url().endsWith(`/api/actors/Room/${room}/Post`) && response.ok())
      answered.push(response.request().headers()["idempotency-key"]!)
  })

  return { sent, answered }
}

/** Opens `room` on the offline page once its saved queue has been read. */
const open = async (page: Page, room: string) => {
  await openRoom({ page, room, at: "offline/rooms" })
  await expect(page.getByTestId("queue-ready")).toHaveText("ready")
}

test("queues posts while offline and applies each exactly once, in order, when the network returns", async ({
  page,
  context,
  request,
}) => {
  const room = uniqueId("offline")
  const posts = watchPosts(page, room)
  let lostReply = false

  await page.route(`**/api/actors/Room/${room}/Post`, async (route) => {
    const body = route.request().postData() ?? ""

    if (!body.includes("two") || !lostReply) return route.continue()

    lostReply = false
    await route.fetch()

    return route.abort("connectionreset")
  })

  await open(page, room)
  await say({ page, body: "zero" })
  await expect.poll(() => history({ request, room: room })).toEqual(["zero"])
  await expect(page.getByTestId("queue").locator("li")).toHaveCount(0)

  await context.setOffline(true)
  await say({ page, body: "one" })
  await say({ page, body: "two" })
  await say({ page, body: "three" })

  const queued = page.getByTestId("queue").locator("li")

  await expect(queued).toHaveCount(3)
  expect(
    await queued.evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset["status"]),
    ),
  ).toEqual(["queued", "queued", "queued"])
  await expect(queued.nth(0)).toContainText("one")
  await expect(queued.nth(2)).toContainText("three")
  expect(await history({ request, room: room })).toEqual(["zero"])

  const ids = await queued.evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).dataset["commandId"]),
  )

  expect(new Set(ids).size).toBe(3)
  await page.screenshot({ path: test.info().outputPath("offline-queued.png") })

  lostReply = true
  await context.setOffline(false)

  await expect(queued).toHaveCount(0, { timeout: 15_000 })
  expect(await history({ request, room: room })).toEqual(["zero", "one", "two", "three"])

  for (const id of ids) expect(posts.answered.filter((key) => key === id).length).toBe(1)

  expect(posts.sent.filter((key) => key === ids[1]).length).toBeGreaterThan(1)
  await page.screenshot({ path: test.info().outputPath("offline-delivered.png") })
})

test("keeps queued posts across a reload and delivers them under the same ids when the API returns", async ({
  page,
  request,
}) => {
  const room = uniqueId("offline-reload")
  const posts = watchPosts(page, room)

  await open(page, room)
  await say({ page, body: "zero" })
  await expect.poll(() => history({ request, room: room })).toEqual(["zero"])

  await page.route("**/api/**", (route) => route.abort("internetdisconnected"))
  await say({ page, body: "one" })
  await say({ page, body: "two" })

  const queued = page.getByTestId("queue").locator("li")

  await expect(queued).toHaveCount(2)

  const ids = await queued.evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).dataset["commandId"]),
  )

  await page.reload()
  await expect(page.getByTestId("queue-ready")).toHaveText("ready")
  await expect(queued).toHaveCount(2)

  expect(
    await queued.evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset["commandId"]),
    ),
  ).toEqual(ids)
  expect(await history({ request, room: room })).toEqual(["zero"])

  await page.unroute("**/api/**")

  await expect(queued).toHaveCount(0, { timeout: 15_000 })
  expect(await history({ request, room: room })).toEqual(["zero", "one", "two"])

  for (const id of ids) expect(posts.answered.filter((key) => key === id).length).toBe(1)
})

test("useCommand keeps one command id while its post waits offline, and the server applies it once", async ({
  page,
  context,
  request,
}) => {
  const room = uniqueId("offline-react")
  const posts = watchPosts(page, room)

  await openRoom({ page, room, at: "react/rooms", query: "&offline=1" })
  await say({ page, body: "zero" })
  await expect(page.getByTestId("post-status")).toHaveText("success")
  await expect.poll(() => history({ request, room: room })).toEqual(["zero"])

  await context.setOffline(true)
  await say({ page, body: "one" })

  await expect(page.getByTestId("queued")).toHaveText("1")
  await expect(page.getByTestId("post-status")).toContainText("not confirmed", { timeout: 10_000 })

  const commandId = await page.getByTestId("post-status").getAttribute("data-command-id")

  expect(commandId).toMatch(/^v1\./)
  expect(await history({ request, room: room })).toEqual(["zero"])

  await context.setOffline(false)
  await expect(page.getByTestId("queued")).toHaveText("0", { timeout: 15_000 })
  await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: zero", "alice: one"])

  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByTestId("post-status")).toHaveText("success")

  expect(await history({ request, room: room })).toEqual(["zero", "one"])
  expect(posts.answered.filter((key) => key === commandId).length).toBeGreaterThanOrEqual(1)
  expect(await page.getByTestId("post-status").getAttribute("data-command-id")).toBe(commandId)
})
