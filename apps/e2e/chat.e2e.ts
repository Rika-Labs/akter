import { randomUUID } from "node:crypto"
import { once } from "node:events"
import {
  type AddressInfo,
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net"
import { type APIRequestContext, expect, type Page, test } from "@playwright/test"

// The chat example served by examples/chat/src/web/serve.ts, on a fresh in-memory database.
const CHAT = "http://127.0.0.1:3003"

const bearer = (user: string) => ({ authorization: `Bearer ${user}` })

/** Posts as `user` straight to the served API, as another client would. */
const post = async (request: APIRequestContext, room: string, user: string, body: string) => {
  const minted = await request.post(`${CHAT}/api/command-ids`, { headers: bearer(user) })
  const { commandId } = (await minted.json()) as { readonly commandId: string }

  const response = await request.post(`${CHAT}/api/actors/Room/${room}/Post`, {
    headers: { ...bearer(user), "idempotency-key": commandId },
    data: { body },
  })

  expect(response.status()).toBe(200)
}

const open = async (page: Page, room: string, user = "alice") => {
  await page.goto(`${CHAT}/rooms/${room}?user=${user}`)
  await expect(page.getByTestId("user")).toHaveText(user)
}

const say = async (page: Page, body: string) => {
  await page.getByTestId("body").fill(body)
  await page.getByRole("button", { name: "Post" }).click()
}

/**
 * A TCP proxy in front of the chat server that the test can cut, the way a
 * lost network would: `cut` destroys every open connection and refuses new
 * ones until `restore`. Chromium's offline mode alone leaves an open stream up.
 */
const proxy = async () => {
  const sockets = new Set<Socket>()
  let down = false

  const server: Server = createServer((client) => {
    if (down) return client.destroy()

    const upstream = createConnection({ host: "127.0.0.1", port: 3003 })
    sockets.add(client).add(upstream)
    client.pipe(upstream)
    upstream.pipe(client)

    for (const socket of [client, upstream]) {
      socket.on("error", () => undefined)
      socket.on("close", () => {
        sockets.delete(socket)
        client.destroy()
        upstream.destroy()
      })
    }
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    cut: () => {
      down = true

      for (const socket of sockets) socket.destroy()
    },
    restore: () => {
      down = false
    },
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}

// Each test uses its own room, so tests share the server without sharing state.
// Rooms are unique per run too: the server may keep rooms across runs when DATABASE_URL names Postgres.
const roomOf = (name: string) => `${name}-${randomUUID()}`

test("replays events after a dropped connection and never shows a gap as continuous", async ({
  page,
  context,
  request,
}) => {
  const room = roomOf("r1")
  const network = await proxy()

  try {
    await page.goto(`${network.url}/rooms/${room}?user=alice`)
    await say(page, "one")
    await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: one"])
    await expect(page.getByTestId("feed-status")).toHaveAttribute("data-opened", "1")

    // The browser loses its connection: its open feed stream is cut, and nothing gets through.
    await context.setOffline(true)
    network.cut()

    // Committed while the browser is away.
    await post(request, room, "bob", "two")
    await post(request, room, "bob", "three")
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId("messages").locator("li")).toHaveCount(1)

    network.restore()
    await context.setOffline(false)

    await expect(page.getByTestId("messages").locator("li")).toHaveText([
      "alice: one",
      "bob: two",
      "bob: three",
    ])

    // The feed reopened after the cursor it had, so nothing was repeated or skipped.
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
  const room = roomOf("reactions")
  await open(page, room)

  await page.getByTestId("react").click()
  await expect(page.getByTestId("reactions")).toHaveText("1")

  // The room closes behind the page's back; its committed state still says open.
  const minted = await request.post(`${CHAT}/api/command-ids`, { headers: bearer("bob") })
  const { commandId } = (await minted.json()) as { readonly commandId: string }

  const archived = await request.post(`${CHAT}/api/actors/Room/${room}/Archive`, {
    headers: { ...bearer("bob"), "idempotency-key": commandId },
  })

  expect(archived.status()).toBe(204)

  await page.getByTestId("react").click()
  await expect(page.getByTestId("notice")).toHaveText("the room is closed")
  await expect(page.getByTestId("reactions")).toHaveText("1")

  // The reaction showed at once, then rolled back when the server refused it.
  await expect(page.getByTestId("reactions")).toHaveAttribute("data-history", /,2,1$/)
})

test("keeps the original command id across a retried POST after a lost response", async ({
  page,
}) => {
  const room = roomOf("retry")
  const keys: Array<string | undefined> = []
  let dropped = false

  // The first response to the post never reaches the page, after the server committed it.
  await page.route(`**/api/actors/Room/${room}/Post`, async (route) => {
    keys.push(route.request().headers()["idempotency-key"])
    const response = await route.fetch()

    if (dropped) return route.fulfill({ response })

    dropped = true
    expect(response.status()).toBe(200)

    return route.abort("connectionreset")
  })

  await open(page, room)
  await say(page, "once")

  await expect(page.getByTestId("messages").locator("li")).toHaveText(["alice: once"])
  await expect.poll(() => keys.length).toBe(2)
  expect(keys[0]).toBeDefined()
  expect(keys[1]).toBe(keys[0])
  await page.waitForTimeout(500)
  await expect(page.getByTestId("messages").locator("li")).toHaveCount(1)
})

test("rejects a request with no credentials before any turn runs", async ({ request }) => {
  const room = roomOf("anonymous")

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
