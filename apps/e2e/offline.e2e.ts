import { randomUUID } from "node:crypto"
import { type APIRequestContext, expect, type Page, test } from "@playwright/test"

/**
 * The chat room with a persisted offline queue, served by
 * examples/chat/src/web/serve.ts at /offline/rooms/<id>.
 */
const CHAT = "http://127.0.0.1:3003"

const roomOf = (name: string) => `${name}-${randomUUID()}`

/** The bodies the server committed to `room`, in order, read as another client would. */
const history = async (request: APIRequestContext, room: string) => {
  const response = await request.post(`${CHAT}/api/actors/Room/${room}/History`, {
    headers: { authorization: "Bearer bob" },
    data: {},
  })

  return (
    (await response.json()) as ReadonlyArray<{ readonly message: { readonly body: string } }>
  ).map((entry) => entry.message.body)
}

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

const open = async (page: Page, room: string) => {
  await page.goto(`${CHAT}/offline/rooms/${room}?user=alice`)
  await expect(page.getByTestId("queue-ready")).toHaveText("ready")
}

const say = async (page: Page, body: string) => {
  await page.getByTestId("body").fill(body)
  await page.getByRole("button", { name: "Post" }).click()
}

test("queues posts while offline and applies each exactly once, in order, when the network returns", async ({
  page,
  context,
  request,
}) => {
  const room = roomOf("offline")
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
  await say(page, "zero")
  await expect.poll(() => history(request, room)).toEqual(["zero"])
  await expect(page.getByTestId("queue").locator("li")).toHaveCount(0)

  await context.setOffline(true)
  await say(page, "one")
  await say(page, "two")
  await say(page, "three")

  const queued = page.getByTestId("queue").locator("li")

  await expect(queued).toHaveCount(3)
  expect(
    await queued.evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset["status"]),
    ),
  ).toEqual(["queued", "queued", "queued"])
  await expect(queued.nth(0)).toContainText("one")
  await expect(queued.nth(2)).toContainText("three")
  expect(await history(request, room)).toEqual(["zero"])

  const ids = await queued.evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).dataset["commandId"]),
  )

  expect(new Set(ids).size).toBe(3)
  await page.screenshot({ path: test.info().outputPath("offline-queued.png") })

  lostReply = true
  await context.setOffline(false)

  await expect(queued).toHaveCount(0, { timeout: 15_000 })
  expect(await history(request, room)).toEqual(["zero", "one", "two", "three"])

  for (const id of ids) expect(posts.answered.filter((key) => key === id).length).toBe(1)

  expect(posts.sent.filter((key) => key === ids[1]).length).toBeGreaterThan(1)
  await page.screenshot({ path: test.info().outputPath("offline-delivered.png") })
})

test("keeps queued posts across a reload and delivers them under the same ids when the API returns", async ({
  page,
  request,
}) => {
  const room = roomOf("offline-reload")
  const posts = watchPosts(page, room)

  await open(page, room)
  await say(page, "zero")
  await expect.poll(() => history(request, room)).toEqual(["zero"])

  await page.route("**/api/**", (route) => route.abort("internetdisconnected"))
  await say(page, "one")
  await say(page, "two")

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
  expect(await history(request, room)).toEqual(["zero"])

  await page.unroute("**/api/**")

  await expect(queued).toHaveCount(0, { timeout: 15_000 })
  expect(await history(request, room)).toEqual(["zero", "one", "two"])

  for (const id of ids) expect(posts.answered.filter((key) => key === id).length).toBe(1)
})

test("useCommand keeps one command id while its post waits offline, and the server applies it once", async ({
  page,
  context,
  request,
}) => {
  const room = roomOf("offline-react")
  const posts = watchPosts(page, room)

  await page.goto(`${CHAT}/react/rooms/${room}?user=alice&offline=1`)
  await expect(page.getByTestId("user")).toHaveText("alice")
  await say(page, "zero")
  await expect(page.getByTestId("post-status")).toHaveText("success")
  await expect.poll(() => history(request, room)).toEqual(["zero"])

  await context.setOffline(true)
  await say(page, "one")

  await expect(page.getByTestId("queued")).toHaveText("1")
  await expect(page.getByTestId("post-status")).toContainText("not confirmed", { timeout: 10_000 })

  const commandId = await page.getByTestId("post-status").getAttribute("data-command-id")

  expect(commandId).toMatch(/^v1\./)
  expect(await history(request, room)).toEqual(["zero"])

  await context.setOffline(false)
  await expect(page.getByTestId("queued")).toHaveText("0", { timeout: 15_000 })
  await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: zero", "alice: one"])

  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByTestId("post-status")).toHaveText("success")

  expect(await history(request, room)).toEqual(["zero", "one"])
  expect(posts.answered.filter((key) => key === commandId).length).toBeGreaterThanOrEqual(1)
  expect(await page.getByTestId("post-status").getAttribute("data-command-id")).toBe(commandId)
})
