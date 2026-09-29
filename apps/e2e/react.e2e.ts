import { randomUUID } from "node:crypto"
import { type APIRequestContext, expect, type Page, test } from "@playwright/test"
import { proxy } from "./proxy.ts"

// The chat room with @durable-actors/react, served by examples/chat/src/web/serve.ts.
const CHAT = "http://127.0.0.1:3003"

const bearer = (user: string) => ({ authorization: `Bearer ${user}` })

const roomOf = (name: string) => `${name}-${randomUUID()}`

const post = async (request: APIRequestContext, room: string, user: string, body: string) => {
  const minted = await request.post(`${CHAT}/api/command-ids`, { headers: bearer(user) })
  const { commandId } = (await minted.json()) as { readonly commandId: string }

  const response = await request.post(`${CHAT}/api/actors/Room/${room}/Post`, {
    headers: { ...bearer(user), "idempotency-key": commandId },
    data: { body },
  })

  expect(response.status()).toBe(200)
}

const history = async (request: APIRequestContext, room: string) => {
  const response = await request.post(`${CHAT}/api/actors/Room/${room}/History`, {
    headers: bearer("bob"),
    data: {},
  })

  return (
    (await response.json()) as ReadonlyArray<{ readonly message: { readonly body: string } }>
  ).map((entry) => entry.message.body)
}

const say = async (page: Page, body: string) => {
  await page.getByTestId("body").fill(body)
  await page.getByRole("button", { name: "Post" }).click()
}

test("useCommand retries a command after its responses were lost and the server keeps one receipt", async ({
  page,
  request,
}) => {
  const room = roomOf("react-retry")
  const keys: Array<string | undefined> = []
  let lose = true

  // Every response to the post is lost until the test lets one through; the server commits the first.
  await page.route(`**/api/actors/Room/${room}/Post`, async (route) => {
    keys.push(route.request().headers()["idempotency-key"])
    const response = await route.fetch()

    return lose ? route.abort("connectionreset") : route.fulfill({ response })
  })

  await page.goto(`${CHAT}/react/rooms/${room}?user=alice`)
  await expect(page.getByTestId("user")).toHaveText("alice")
  await say(page, "once")

  // The client gives up after its timeout; the hook keeps the intent and offers a retry.
  await expect(page.getByTestId("post-status")).toContainText("not confirmed", { timeout: 10_000 })
  const commandId = await page.getByTestId("post-status").getAttribute("data-command-id")
  expect(commandId).toMatch(/^v1\./)

  lose = false
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByTestId("post-status")).toHaveText("success")

  // Every attempt, the client's own retries and the user's, carried the intent's one id.
  expect(keys.length).toBeGreaterThan(1)
  expect(new Set(keys)).toEqual(new Set([commandId]))
  expect(await history(request, room)).toEqual(["once"])
  await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: once"])
})

test("useEventFeed resumes after a dropped connection and after a reload with no gap or repeat", async ({
  page,
  context,
  request,
}) => {
  const room = roomOf("react-feed")
  const network = await proxy()

  try {
    await page.goto(`${network.url}/react/rooms/${room}?user=alice`)
    await say(page, "one")
    await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: one"])

    await context.setOffline(true)
    network.cut()
    await post(request, room, "bob", "two")
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId("messages").locator("li")).toHaveCount(1)
    network.restore()
    await context.setOffline(false)

    await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: one", "bob: two"])
    await expect(page.getByTestId("cursor")).toHaveText("2")

    // A reload resumes after the stored cursor: nothing already shown repeats, and what commits next arrives.
    await page.reload()
    await expect(page.getByTestId("cursor")).toHaveText("2")
    await expect(page.getByTestId("presence")).toHaveText("open")
    await expect(page.getByTestId("messages").locator("li")).toHaveCount(0)
    await post(request, room, "bob", "three")
    await expect(page.getByTestId("messages").locator("li")).toHaveText(["bob: three"])
    await expect(page.getByTestId("cursor")).toHaveText("3")

    const cursors = await page
      .getByTestId("messages")
      .locator("li")
      .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.cursor))

    expect(cursors).toEqual(["3"])
    await page.screenshot({ path: test.info().outputPath("react-after-reload.png") })
  } finally {
    await network.close()
  }
})

test("useActorState shows an optimistic reaction at once and settles on the committed count", async ({
  page,
  request,
}) => {
  const room = roomOf("react-state")
  // A connection never creates its actor, so a first post does.
  await post(request, room, "bob", "hello")
  await page.goto(`${CHAT}/react/rooms/${room}?user=alice`)
  await expect(page.getByTestId("presence")).toHaveText("open")

  await page.getByTestId("react").click()
  await page.getByTestId("react").click()
  await expect(page.getByTestId("reactions")).toHaveText("2")
})
