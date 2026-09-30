import { Data, Schema } from "effect"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Actor, Fleet } from "@durable-actors/core"
import { fleetClient } from "@durable-actors/core/client"
import { pgTable, text } from "drizzle-orm/pg-core"
import {
  useActor,
  useActorState,
  useCommand,
  useConnection,
  useEventFeed,
  useQuery,
  useWatch,
} from "./index.ts"
import type { ConnectionMessage, ProgressOfConnection } from "@durable-actors/core/client"
import { keepLast, receive } from "./connection.ts"

const Posted = Actor.event("Posted", { text: Schema.String })

const Post = Actor.command("Post", { payload: Schema.String })

const Count = Actor.query("Count", { success: Schema.Finite, watch: true })

const Presence = Actor.connection("Presence", { server: Schema.String, client: Schema.String })

const Render = Actor.job("Render", {
  payload: { steps: Schema.Int },
  progress: Schema.Struct({ percent: Schema.Finite }),
})

const Watch = Actor.connection("Watch", {
  server: Schema.String,
  progress: { jobs: [Render] },
})

const Room = Actor.make("ReactRoom", {
  key: Schema.String,
  events: [Posted],
  feeds: [Posted],
  jobs: { Render: { job: Render } },
  api: { Post, Count, Presence, Watch },
})

const refuse = () => Promise.reject(new Error("rendering must not fetch"))

const rooms = Room.client({ baseUrl: "http://server.invalid", fetch: refuse })

const Posts = Actor.table(
  pgTable("react_posts", { id: text("id").primaryKey(), author: text("author").notNull() }),
)

Actor.make("ReactAuthor", { key: Schema.String, tables: [Posts], api: {} })

const PostsByAuthor = Fleet.view("PostsByAuthor", {
  from: Posts,
  groupBy: ["author"],
  select: { posts: Fleet.count() },
})

const fleet = fleetClient({
  views: [PostsByAuthor],
  baseUrl: "http://server.invalid",
  fetch: refuse,
})

const Page = () => {
  const room = useActor(rooms, "r1")
  const state = useActorState(room)
  const post = useCommand(rooms, (text: string, options) => room.Post(text, options))
  const count = useQuery((options) => room.Count(options), [room])
  const feed = useEventFeed(room, Posted, { storageKey: "r1" })
  const watched = useWatch((options) => room.Count.watch(options), [room])
  const authors = useWatch((options) => fleet.PostsByAuthor.subscribe({}, options), [])
  const presence = useConnection(room.Presence, undefined)

  return createElement(
    "p",
    null,
    `${post.state.status} ${String(count.loading)} ${feed.entries.length} ${String(watched.data)} ${String(authors.data?.rows.length)} ${presence.status} ${JSON.stringify(state ?? null)}`,
  )
}

describe("@durable-actors/react", () => {
  it("renders on a server without fetching, connecting, or touching browser globals", () => {
    expect("window" in globalThis).toBe(false)
    expect(renderToString(createElement(Page))).toBe(
      "<p>idle true 0 undefined undefined connecting null</p>",
    )
  })

  it("keeps at most `keep` recent connection frames, and none for zero", () => {
    expect(keepLast(["a", "b"], "c", 2)).toEqual(["b", "c"])
    expect(keepLast(["a"], "b", 0)).toEqual([])
  })

  it("files a connection's frames and progress apart, and leaves resync notices to onResync", () => {
    const Message = Data.taggedEnum<ConnectionMessage<string, ProgressOfConnection<typeof Watch>>>()
    const nothing = { frames: [], progress: [] }

    const percent = (seq: number) =>
      Message.Progress({
        jobId: "e1",
        attempt: 1,
        seq,
        job: "Render",
        frame: { percent: seq },
      })

    const frame = receive(
      nothing,
      Message.Frame({ frame: "hi", cursor: undefined, event: undefined }),
      2,
    )

    const first = receive(frame, percent(1), 2)
    const second = receive(first, percent(2), 2)
    const third = receive(second, percent(3), 2)

    expect(third.frames).toEqual(["hi"])
    expect(third.progress.map((message) => message.seq)).toEqual([2, 3])
    expect(receive(third, Message.ResyncReplayed(), 2)).toBe(third)
  })

  it("types the progress a hook returns by job", () => {
    const Typed = () => {
      const watch = useConnection(rooms.get("r1").Watch, undefined)

      for (const message of watch.progress)
        if (message.job === "Render")
          expectTypeOf(message.frame).toEqualTypeOf<{ readonly percent: number }>()

      return null
    }

    const Plain = () => {
      const presence = useConnection(rooms.get("r1").Presence, undefined)

      expectTypeOf(presence.progress).toEqualTypeOf<ReadonlyArray<never>>()

      return null
    }

    expect([Typed, Plain]).toHaveLength(2)
  })

  it("keys a connection by its primitive params, and requires a key for object params", () => {
    const Params = Actor.connection("Params", {
      payload: Schema.Struct({ room: Schema.String }),
      server: Schema.String,
      client: Schema.String,
    })

    const Lobby = Actor.make("ReactLobby", { key: Schema.String, api: { Params } })
    const lobby = Lobby.client({ baseUrl: "http://server.invalid", fetch: refuse }).get("l1")

    const Keyed = () => {
      useConnection(lobby.Params, { room: "a" }, { key: "a" })
      // @ts-expect-error object params need an explicit session key
      useConnection(lobby.Params, { room: "a" })
      // @ts-expect-error a session key is a primitive, not an object compared by identity
      useConnection(lobby.Params, { room: "a" }, { key: { room: "a" } })
      useConnection(rooms.get("r1").Presence, undefined)

      return null
    }

    expect(Keyed).toBeTypeOf("function")
  })
})
