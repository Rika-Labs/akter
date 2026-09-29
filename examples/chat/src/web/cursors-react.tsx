// Presence and live cursors with @durable-actors/react: the Live connection
// opened from the actor handle, and the peers as a reducer over its frames.
import { useActor } from "@durable-actors/react"
import { Match } from "effect"
import { type ReactNode, StrictMode, useEffect, useReducer, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  Cursor,
  DocId,
  type Here,
  type Joined,
  type Left,
  type Moved,
  type Peer,
  type Point,
} from "../cursor/contract.ts"

const query = new URLSearchParams(location.search)

const user = query.get("user") ?? "alice"

const docId = DocId.make(location.pathname.split("/").at(-1) || "notes")

const colorOf = (name: string) =>
  `hsl(${Array.from(name).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 0)} 70% 50%)`

const docs = Cursor.client({
  baseUrl: "/api",
  headers: () => ({ authorization: `Bearer ${user}` }),
})

type Frame = typeof Here.Type | typeof Joined.Type | typeof Moved.Type | typeof Left.Type

type Peers = ReadonlyMap<string, typeof Peer.Type>

/** The peers after one more frame. */
const apply = (peers: Peers, frame: Frame): Peers => {
  const next = new Map(peers)

  Match.value(frame).pipe(
    Match.tag("Here", ({ peers: here }) => {
      next.clear()

      for (const peer of here) next.set(peer.connectionId, peer)
    }),
    Match.tag("Joined", ({ peer }) => void next.set(peer.connectionId, peer)),
    Match.tag("Left", ({ connectionId }) => void next.delete(connectionId)),
    Match.tag("Moved", ({ connectionId, at }) => {
      const peer = next.get(connectionId)

      if (peer !== undefined) next.set(connectionId, { ...peer, at })
    }),
    Match.exhaustive,
  )

  return next
}

const App = (): ReactNode => {
  const doc = useActor(docs, docId)
  const [peers, dispatch] = useReducer(apply, new Map<string, typeof Peer.Type>())
  const [status, setStatus] = useState("connecting")
  const send = useRef<((point: typeof Point.Type) => Promise<void>) | undefined>(undefined)

  // Moves arrive many times a second, so the peers are folded from every frame
  // as it arrives; useConnection keeps only a window of recent frames.
  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      try {
        const connection = await doc.Live.connect(
          { color: colorOf(user) },
          { signal: controller.signal },
        )

        if (controller.signal.aborted) return void connection.close()

        send.current = connection.send
        setStatus("open")
        controller.signal.addEventListener("abort", () => void connection.close())

        for await (const frame of connection.frames) dispatch(frame)

        setStatus("closed")
      } catch {
        if (!controller.signal.aborted) setStatus("failed")
      }
    })()

    return () => controller.abort()
  }, [doc])

  return (
    <main>
      <header>
        <h1>
          Document <span data-testid="doc">{docId}</span>
        </h1>
        <span className="meta">
          signed in as <strong data-testid="user">{user}</strong> · connection{" "}
          <span data-testid="connection-status">{status}</span> · here{" "}
          <strong data-testid="here">{peers.size + 1}</strong>
        </span>
      </header>
      <div
        data-testid="stage"
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect()

          void send
            .current?.({ x: event.clientX - box.left, y: event.clientY - box.top })
            .catch(() => undefined)
        }}
      >
        {[...peers.values()].map((peer) => (
          <div
            key={peer.connectionId}
            data-testid="cursor"
            data-user={peer.user}
            data-x={peer.at?.x}
            data-y={peer.at?.y}
            hidden={peer.at === undefined}
            style={{ background: peer.color, left: peer.at?.x, top: peer.at?.y }}
          />
        ))}
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
