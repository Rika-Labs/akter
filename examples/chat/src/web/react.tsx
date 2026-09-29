/**
 * The chat room with @durable-actors/react: the feed with a cursor kept across
 * reloads, posts as one command id per intent with an explicit retry,
 * optimistic reactions, and Presence.
 */
import {
  useActor,
  useActorState,
  useCommand,
  useConnection,
  useEventFeed,
} from "@durable-actors/react"
import { ActorError, type Failure, Offline } from "@durable-actors/core/client"
import { Schema } from "effect"
import { type FormEvent, StrictMode, useState, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { MessagePosted, Room, RoomId } from "../room/contract.ts"

const query = new URLSearchParams(location.search)

const user = query.get("user") ?? "alice"

const roomId = RoomId.make(location.pathname.split("/").at(-1) || "lobby")

/**
 * A short timeout, so a post whose responses keep getting lost fails and
 * offers a retry. With `?offline=1` every post is also saved in IndexedDB and
 * delivered under its command id once the server can be reached.
 */
const rooms = Room.client({
  baseUrl: "/api",
  headers: () => ({ authorization: `Bearer ${user}` }),
  timeoutInMs: 2_000,
  offline: query.has("offline") ? Offline.indexedDb(`chat-react:${user}`) : undefined,
})

const noQueued: ReadonlyArray<never> = []

const subscribeQueue = (listener: () => void) => rooms.offline?.subscribe(listener) ?? (() => {})

/** A failure as one line: its tag, and an `ActorError`'s reason. */
const describe = (failure: Failure) =>
  Schema.is(ActorError)(failure) ? `ActorError ${failure.reason._tag}` : failure._tag

const App = () => {
  const room = useActor(rooms, roomId)
  const feed = useEventFeed(room, MessagePosted, { storageKey: `chat:${roomId}` })
  const state = useActorState(room)
  const presence = useConnection(room.Presence, undefined)
  const post = useCommand(rooms, (body: string, options) => room.Post({ body }, options))

  const queued = useSyncExternalStore(
    subscribeQueue,
    () => rooms.offline?.pending ?? noQueued,
    () => noQueued,
  )

  const [body, setBody] = useState("")

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (body.trim() === "") return

    void post.run(body.trim()).catch(() => undefined)
    setBody("")
  }

  return (
    <main>
      <header>
        <h1>
          Room <span data-testid="room">{roomId}</span>
        </h1>
        <span className="meta">
          signed in as <strong data-testid="user">{user}</strong> · presence{" "}
          <span
            data-testid="presence"
            title={presence.error === undefined ? undefined : describe(presence.error)}
          >
            {presence.status}
          </span>{" "}
          · cursor <span data-testid="cursor">{feed.cursor ?? "none"}</span> · queued{" "}
          <span data-testid="queued">{queued.length}</span>
        </span>
      </header>
      <ul data-testid="messages">
        {feed.entries.map((entry) => (
          <li key={entry.cursor} data-cursor={entry.cursor}>
            {entry.event.author}: {entry.event.body}
          </li>
        ))}
      </ul>
      {feed.gap ? <p data-testid="gap">Messages were pruned; reload the room.</p> : null}
      <form onSubmit={submit}>
        <input
          data-testid="body"
          value={body}
          placeholder="Say something"
          onChange={(event) => setBody(event.target.value)}
        />
        <button type="submit">Post</button>
      </form>
      <p
        data-testid="post-status"
        data-command-id={"commandId" in post.state ? post.state.commandId : ""}
      >
        {post.state.status === "error" ? (
          <>
            {post.state.expired ? "expired: post it again" : "not confirmed"}{" "}
            {post.state.expired ? null : (
              <button type="button" onClick={() => void post.retry().catch(() => undefined)}>
                Retry
              </button>
            )}
          </>
        ) : (
          post.state.status
        )}
      </p>
      <div className="actions">
        <button
          type="button"
          data-testid="react"
          onClick={() => void room.React(1).catch(() => undefined)}
        >
          👍 React
        </button>
        <span>
          reactions: <strong data-testid="reactions">{state?.reactions ?? 0}</strong>
        </span>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
