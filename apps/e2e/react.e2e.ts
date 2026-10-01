import { expect, test } from "@playwright/test"
import { proxy } from "./proxy.ts"
import { history, openRoom, post, say, uniqueId } from "./room.ts"

test("useCommand retries a command after its responses were lost and the server keeps one receipt", async ({
  page,
  request,
}) => {
  const room = uniqueId("react-retry")
  const keys: Array<string | undefined> = []
  let lose = true

  await page.route(`**/api/actors/Room/${room}/Post`, async (route) => {
    keys.push(route.request().headers()["idempotency-key"])
    const response = await route.fetch()

    return lose ? route.abort("connectionreset") : route.fulfill({ response })
  })

  await openRoom({ page, room, at: "react/rooms" })
  await say({ page, body: "once" })

  await expect(page.getByTestId("post-status")).toContainText("not confirmed", { timeout: 10_000 })
  const commandId = await page.getByTestId("post-status").getAttribute("data-command-id")
  expect(commandId).toMatch(/^v1\./)

  lose = false
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByTestId("post-status")).toHaveText("success")

  expect(keys.length).toBeGreaterThan(1)
  expect(new Set(keys)).toEqual(new Set([commandId]))
  expect(await history({ request, room: room })).toEqual(["once"])
  await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: once"])
})

test("useEventFeed resumes after a dropped connection and after a reload with no gap or repeat", async ({
  page,
  context,
  request,
}) => {
  const room = uniqueId("react-feed")
  const network = await proxy()

  try {
    await openRoom({ page, room, at: "react/rooms", origin: network.url })
    await say({ page, body: "one" })
    await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: one"])

    await context.setOffline(true)
    network.cut()
    await post({ request, room: room, user: "bob", body: "two" })
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId("messages").locator("li")).toHaveCount(1)
    network.restore()
    await context.setOffline(false)

    await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: one", "bob: two"])
    await expect(page.getByTestId("cursor")).toHaveText("2")

    await page.reload()
    await expect(page.getByTestId("cursor")).toHaveText("2")
    await expect(page.getByTestId("presence")).toHaveText("open")
    await expect(page.getByTestId("messages").locator("li")).toHaveCount(0)
    await post({ request, room: room, user: "bob", body: "three" })
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
  const room = uniqueId("react-state")
  await post({ request, room: room, user: "bob", body: "hello" })
  await openRoom({ page, room, at: "react/rooms" })
  await expect(page.getByTestId("presence")).toHaveText("open")

  await page.getByTestId("react").click()
  await page.getByTestId("react").click()
  await expect(page.getByTestId("reactions")).toHaveText("2")
})
