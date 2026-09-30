import { randomUUID } from "node:crypto"
import { type APIRequestContext, expect, type Page } from "@playwright/test"

/** The chat example served by examples/chat/src/web/serve.ts, on a fresh in-memory database. */
export const CHAT = "http://127.0.0.1:3003"

/** The counter example served by examples/counter/src/web/serve.ts, on a fresh in-memory database. */
export const COUNTER = "http://127.0.0.1:3004"

/** The chat pages: the Promise client, the React hooks, and the offline queue. */
export type RoomPage = "rooms" | "react/rooms" | "offline/rooms"

/**
 * An id for one test's room, document or counter, so tests share a server
 * without sharing state. Ids are unique per run too: the server may keep
 * rooms across runs when DATABASE_URL names Postgres.
 */
export const uniqueId = (name: string) => `${name}-${randomUUID()}`

/** The example's development credential for `user`. */
export const bearer = (user: string) => ({ authorization: `Bearer ${user}` })

/** Posts as `user` straight to the served API, as another client would. */
export const post = async ({
  request,
  room,
  user,
  body,
}: {
  readonly request: APIRequestContext
  readonly room: string
  readonly user: string
  readonly body: string
}) => {
  const minted = await request.post(`${CHAT}/api/command-ids`, { headers: bearer(user) })
  const { commandId } = (await minted.json()) as { readonly commandId: string }

  const response = await request.post(`${CHAT}/api/actors/Room/${room}/Post`, {
    headers: { ...bearer(user), "idempotency-key": commandId },
    data: { body },
  })

  expect(response.status()).toBe(200)
}

/** The bodies the server committed to `room`, in order, read as another client would. */
export const history = async ({
  request,
  room,
}: {
  readonly request: APIRequestContext
  readonly room: string
}) => {
  const response = await request.post(`${CHAT}/api/actors/Room/${room}/History`, {
    headers: bearer("bob"),
    data: {},
  })

  return (
    (await response.json()) as ReadonlyArray<{ readonly message: { readonly body: string } }>
  ).map((entry) => entry.message.body)
}

/** Opens `room` on one of the chat pages as `user`, through `origin` when a proxy stands in front. */
export const openRoom = async ({
  page,
  room,
  at = "rooms",
  user = "alice",
  origin = CHAT,
  query = "",
}: {
  readonly page: Page
  readonly room: string
  readonly at?: RoomPage
  readonly user?: string
  readonly origin?: string
  readonly query?: string
}) => {
  await page.goto(`${origin}/${at}/${room}?user=${user}${query}`)
  await expect(page.getByTestId("user")).toHaveText(user)
}

/** Posts `body` through the page's form. */
export const say = async ({ page, body }: { readonly page: Page; readonly body: string }) => {
  await page.getByTestId("body").fill(body)
  await page.getByRole("button", { name: "Post" }).click()
}
