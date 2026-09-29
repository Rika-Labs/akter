import { Schema } from "effect"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Actor } from "@durable-actors/core"
import {
  useActor,
  useActorState,
  useCommand,
  useConnection,
  useEventFeed,
  useQuery,
} from "./index.ts"
import { keepLast } from "./connection.ts"

class Posted extends Actor.Event<Posted>()("Posted", { text: Schema.String }) {}

const Post = Actor.command("Post", { input: Schema.String })

const Count = Actor.query("Count", { output: Schema.Finite })

const Presence = Actor.connection("Presence", { server: Schema.String, client: Schema.String })

const Room = Actor.make("ReactRoom", {
  key: Schema.String,
  events: [Posted],
  feeds: [Posted],
  api: { Post, Count, Presence },
})

// A fetch that fails the test if anything reaches the network while rendering.
const refuse = () => Promise.reject(new Error("rendering must not fetch"))

const rooms = Room.client({ baseUrl: "http://server.invalid", fetch: refuse })

const Page = () => {
  const room = useActor(rooms, "r1")
  const state = useActorState(room)
  const post = useCommand(rooms, (text: string, options) => room.Post(text, options))
  const count = useQuery((options) => room.Count(options), [room])
  const feed = useEventFeed(room, Posted, { storageKey: "r1" })
  const presence = useConnection(room.Presence, undefined)

  return createElement(
    "p",
    null,
    `${post.state.status} ${String(count.loading)} ${feed.entries.length} ${presence.status} ${JSON.stringify(state ?? null)}`,
  )
}

describe("@durable-actors/react", () => {
  it("renders on a server without fetching, connecting, or touching browser globals", () => {
    expect("window" in globalThis).toBe(false)
    expect(renderToString(createElement(Page))).toBe("<p>idle true 0 connecting null</p>")
  })

  it("keeps at most `keep` recent connection frames, and none for zero", () => {
    expect(keepLast(["a", "b"], "c", 2)).toEqual(["b", "c"])
    expect(keepLast(["a"], "b", 0)).toEqual([])
  })
})
