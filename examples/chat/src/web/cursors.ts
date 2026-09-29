/**
 * Presence and live cursors in a browser, over the Promise client: one Live
 * connection per page, the peers from its Here, Joined, Moved and Left frames,
 * and this page's own pointer sent as frames.
 */
import { Match } from "effect"
import { Cursor, DocId, type Peer } from "../cursor/contract.ts"

const query = new URLSearchParams(location.search)

const user = query.get("user") ?? "alice"

const docId = DocId.make(location.pathname.split("/").at(-1) || "notes")

const element = <E extends HTMLElement>(id: string) =>
  document.querySelector<E>(`[data-testid="${id}"]`)!

const stage = element<HTMLElement>("stage")

const status = element<HTMLElement>("connection-status")

const here = element<HTMLElement>("here")

element<HTMLElement>("doc").textContent = docId

element<HTMLElement>("user").textContent = user

const colorOf = (name: string) =>
  `hsl(${Array.from(name).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 0)} 70% 50%)`

const docs = Cursor.client({
  baseUrl: "/api",
  headers: () => ({ authorization: `Bearer ${user}` }),
})

const doc = docs.get(docId)

const peers = new Map<string, HTMLElement>()

const place = (peer: typeof Peer.Type) => {
  const cursor = peers.get(peer.connectionId) ?? document.createElement("div")

  if (!peers.has(peer.connectionId)) {
    cursor.dataset.testid = "cursor"
    cursor.dataset.user = peer.user
    cursor.style.background = peer.color
    cursor.hidden = true
    peers.set(peer.connectionId, cursor)
    stage.append(cursor)
  }

  if (peer.at !== undefined) {
    cursor.hidden = false
    cursor.dataset.x = String(peer.at.x)
    cursor.dataset.y = String(peer.at.y)
    cursor.style.left = `${peer.at.x}px`
    cursor.style.top = `${peer.at.y}px`
  }

  here.textContent = String(peers.size + 1)
}

const connect = async () => {
  const connection = await doc.Live.connect({ color: colorOf(user) })
  status.textContent = "open"

  stage.addEventListener("pointermove", (event) => {
    const box = stage.getBoundingClientRect()
    void connection.send({ x: event.clientX - box.left, y: event.clientY - box.top })
  })

  for await (const frame of connection.frames)
    Match.value(frame).pipe(
      Match.tag("Here", ({ peers: open }) => {
        for (const cursor of peers.values()) cursor.remove()

        peers.clear()
        open.forEach(place)
        here.textContent = String(peers.size + 1)
      }),
      Match.tag("Joined", ({ peer }) => place(peer)),
      Match.tag("Moved", ({ connectionId, at }) => {
        const cursor = peers.get(connectionId)

        if (cursor !== undefined)
          place({ connectionId, user: cursor.dataset.user!, color: cursor.style.background, at })
      }),
      Match.tag("Left", ({ connectionId }) => {
        peers.get(connectionId)?.remove()
        peers.delete(connectionId)
        here.textContent = String(peers.size + 1)
      }),
      Match.exhaustive,
    )

  status.textContent = "closed"
}

void connect().catch(() => {
  status.textContent = "failed"
})
