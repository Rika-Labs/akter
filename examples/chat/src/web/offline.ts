/**
 * The chat room with an offline queue: each post is saved in IndexedDB before
 * it is sent, listed while it waits, and delivered in order under its original
 * command id once the server can be reached, even after a reload.
 */
import { Offline } from "@durable-actors/core/client"
import { Room, RoomId } from "../room/contract.ts"

const query = new URLSearchParams(location.search)

const user = query.get("user") ?? "alice"

const roomId = RoomId.make(location.pathname.split("/").at(-1) || "lobby")

const element = <E extends HTMLElement>(id: string) =>
  document.querySelector<E>(`[data-testid="${id}"]`)!

const rooms = Room.client({
  baseUrl: "/api",
  headers: () => ({ authorization: `Bearer ${user}` }),
  timeoutInMs: 1_000,
  offline: Offline.indexedDb(`chat:${user}`),
})

const room = rooms.get(roomId)

const queue = rooms.offline

if (queue === undefined) throw new Error("the offline queue is not configured")

element("room").textContent = roomId

element("user").textContent = user

const ready = element("queue-ready")

const list = element<HTMLUListElement>("queue")

queue.ready.then(
  () => {
    ready.textContent = "ready"
  },
  () => {
    ready.textContent = "unavailable"
  },
)

queue.subscribe((pending) => {
  list.replaceChildren(
    ...pending.map((command) => {
      const item = document.createElement("li")

      item.dataset["commandId"] = command.commandId
      item.dataset["status"] = command.status
      item.textContent = `${command.status}: ${JSON.stringify(command.input)}`

      return item
    }),
  )
})

element<HTMLFormElement>("post").addEventListener("submit", (event) => {
  event.preventDefault()

  const input = element<HTMLInputElement>("body")
  const body = input.value.trim()

  input.value = ""

  if (body === "") return

  room.Post({ body }).catch(() => undefined)
})
