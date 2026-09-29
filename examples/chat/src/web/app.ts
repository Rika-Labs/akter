/**
 * The chat room in a browser, over the Promise client: messages from the room's
 * event feed, posts as commands, reactions as an optimistic reducer, and typing
 * as Presence connection frames.
 */
import { ActorError, type Failure, NotCreated } from "@durable-actors/core/client"
import { Effect } from "effect"
import { MessagePosted, Room, RoomClosed, RoomId } from "../room/contract.ts"

const query = new URLSearchParams(location.search)

const user = query.get("user") ?? "alice"

const roomId = RoomId.make(location.pathname.split("/").at(-1) || "lobby")

const element = <E extends HTMLElement>(id: string) =>
  document.querySelector<E>(`[data-testid="${id}"]`)!

const messages = element<HTMLUListElement>("messages")

const status = element<HTMLElement>("feed-status")

const reactions = element<HTMLElement>("reactions")

const notice = element<HTMLElement>("notice")

const typing = element<HTMLElement>("typing")

element<HTMLElement>("room").textContent = roomId

element<HTMLElement>("user").textContent = user

/**
 * Every request goes through here, so the page can show how often its feed
 * opened.
 */
let feedsOpened = 0

const rooms = Room.client({
  baseUrl: "/api",
  headers: () => ({ authorization: `Bearer ${user}` }),
  fetch: (input, init) =>
    fetch(input, init).then((response) => {
      if (new URL(response.url).pathname.endsWith("/events") && response.ok) {
        feedsOpened += 1
        status.dataset.opened = String(feedsOpened)
        status.textContent = feedsOpened === 1 ? "live" : `live (reopened ${feedsOpened - 1}×)`
      }

      return response
    }),
})

const room = rooms.get(roomId)

const render = (entry: { readonly cursor: string; readonly event: MessagePosted }) => {
  const item = document.createElement("li")
  item.dataset.cursor = entry.cursor
  item.textContent = `${entry.event.author}: ${entry.event.body}`
  messages.append(item)
}

/**
 * A feed never creates its room: until the first post does, the page waits and
 * asks again.
 */
const follow = async (): Promise<void> => {
  try {
    const after =
      messages.lastElementChild instanceof HTMLElement
        ? messages.lastElementChild.dataset.cursor
        : undefined

    for await (const entry of room.events(MessagePosted, { after })) render(entry)
  } catch (error) {
    if (error instanceof ActorError && error.reason instanceof NotCreated) {
      status.textContent = "waiting for the first message"
      await Effect.runPromise(Effect.sleep("500 millis"))

      return follow()
    }

    status.textContent = error instanceof ActorError ? `ended: ${error.reason._tag}` : "ended"
  }
}

/**
 * The reaction count is committed state with this page's pending reactions
 * applied.
 */
const history: Array<string> = []

room.state.subscribe((state) => {
  const shown = String(state?.reactions ?? 0)
  history.push(shown)
  reactions.textContent = shown
  reactions.dataset.history = history.join(",")
})

element<HTMLFormElement>("post").addEventListener("submit", (event) => {
  event.preventDefault()
  const input = element<HTMLInputElement>("body")
  const body = input.value.trim()
  input.value = ""

  if (body === "") return

  room.Post({ body }).catch((error: Failure) => {
    notice.textContent = error instanceof RoomClosed ? "the room is closed" : "not posted"
  })
})

element<HTMLButtonElement>("react").addEventListener("click", () => {
  notice.textContent = ""

  room.React(1).catch((error: Failure) => {
    notice.textContent = error instanceof RoomClosed ? "the room is closed" : "not applied"
  })
})

const presence = async () => {
  const connection = await room.Presence.connect()
  const input = element<HTMLInputElement>("body")
  input.addEventListener("input", () => void connection.send({ typing: input.value !== "" }))

  for await (const frame of connection.frames)
    typing.textContent = frame.user !== user && frame.typing ? `${frame.user} is typing…` : ""
}

void follow()

void presence().catch(() => undefined)
