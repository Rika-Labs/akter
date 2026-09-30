import { expect, test } from "@playwright/test"
import { proxy } from "./proxy.ts"
import { bearer, CHAT, openRoom, post, say, uniqueId } from "./room.ts"

test("replays events after a dropped connection and never shows a gap as continuous", async ({
  page,
  context,
  request,
}) => {
  const room = uniqueId("r1")
  const network = await proxy()

  try {
    await openRoom({ page, room, origin: network.url })
    await say({ page, body: "one" })
    await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: one"])
    await expect(page.getByTestId("feed-status")).toHaveAttribute("data-opened", "1")

    await context.setOffline(true)
    network.cut()

    await post({ request, room: room, user: "bob", body: "two" })
    await post({ request, room: room, user: "bob", body: "three" })
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId("messages").locator("li")).toHaveCount(1)

    network.restore()
    await context.setOffline(false)

    await expect(page.getByTestId("messages").locator("li")).toHaveText([
      "alice: one",
      "bob: two",
      "bob: three",
    ])

    await expect(page.getByTestId("feed-status")).toHaveAttribute("data-opened", /^[2-9]\d*$/)

    const cursors = await page
      .getByTestId("messages")
      .locator("li")
      .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.cursor))

    expect(cursors).toEqual(["1", "2", "3"])
    await page.screenshot({ path: test.info().outputPath("chat-after-reconnect.png") })
  } finally {
    await network.close()
  }
})

test("rolls back an optimistic reaction the server rejects", async ({ page, request }) => {
  const room = uniqueId("reactions")
  await openRoom({ page, room })

  await page.getByTestId("react").click()
  await expect(page.getByTestId("reactions")).toHaveText("1")

  const minted = await request.post(`${CHAT}/api/command-ids`, { headers: bearer("bob") })
  const { commandId } = (await minted.json()) as { readonly commandId: string }

  const archived = await request.post(`${CHAT}/api/actors/Room/${room}/Archive`, {
    headers: { ...bearer("bob"), "idempotency-key": commandId },
  })

  expect(archived.status()).toBe(204)

  await page.getByTestId("react").click()
  await expect(page.getByTestId("notice")).toHaveText("the room is closed")
  await expect(page.getByTestId("reactions")).toHaveText("1")

  await expect(page.getByTestId("reactions")).toHaveAttribute("data-history", /,2,1$/)
})

test("keeps the original command id across a retried POST after a lost response", async ({
  page,
}) => {
  const room = uniqueId("retry")
  const keys: Array<string | undefined> = []
  let dropped = false

  await page.route(`**/api/actors/Room/${room}/Post`, async (route) => {
    keys.push(route.request().headers()["idempotency-key"])
    const response = await route.fetch()

    if (dropped) return route.fulfill({ response })

    dropped = true
    expect(response.status()).toBe(200)

    return route.abort("connectionreset")
  })

  await openRoom({ page, room })
  await say({ page, body: "once" })

  await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: once"])
  await expect.poll(() => keys.length).toBe(2)
  expect(keys[0]).toBeDefined()
  expect(keys[1]).toBe(keys[0])
  await page.waitForTimeout(500)
  await expect(page.getByTestId("messages").locator("li")).toHaveCount(1)
})

test("rejects a request with no credentials before any turn runs", async ({ request }) => {
  const room = uniqueId("anonymous")

  const refused = await request.post(`${CHAT}/api/actors/Room/${room}/Post`, {
    headers: { "idempotency-key": "v1.1.2.00000000-0000-4000-8000-000000000000" },
    data: { body: "sneaky" },
  })

  expect(refused.status()).toBe(401)
  expect(
    ((await refused.json()) as { readonly reason: { readonly code: string } }).reason.code,
  ).toBe("missing_credentials")

  const history = await request.post(`${CHAT}/api/actors/Room/${room}/History`, {
    headers: bearer("bob"),
    data: {},
  })

  expect(await history.json()).toEqual([])
})
