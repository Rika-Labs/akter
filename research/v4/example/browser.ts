// Promise client: what a non-Effect caller (a browser bundle) writes. No Effect runtime, same error classes.
import { ActorUnavailable, CommandConflict } from "../framework/Actor.ts"
import { Chat, MessageAdded, type RoomId, Typing } from "./Chat.ts"
import { Counter, CounterId } from "./Counter.ts"

const token = "..."
const baseUrl = "https://actors.example.com"

const chat = Chat.client({ baseUrl, headers: { authorization: `Bearer ${token}` }, timeoutInMs: 10_000 })

// thrown: InvalidMessage | NotAMember | CommandConflict | ActorUnavailable | InvalidInput | Unauthorized | TransportError
export const send = (roomId: RoomId, body: string, signal?: AbortSignal) =>
  chat.get(roomId).SendMessage({ body }, { signal }) // commandId minted here, reused on retry

// the same key twice is a replay, not a second message
export const sendOnce = async (roomId: RoomId, body: string, key: string) => {
  try {
    return await chat.get(roomId).SendMessage({ body }, { commandId: key })
  } catch (e) {
    if (e instanceof CommandConflict) {
      // same key, different body: a caller bug, retrying will never help
      throw e
    }
    if (e instanceof ActorUnavailable) {
      // 503: retry with the same key, the receipt makes it safe
      return await chat.get(roomId).SendMessage({ body }, { commandId: key })
    }
    throw e
  }
}

// replay from sequence 0, then join the live feed — one async iterable
export async function* follow(roomId: RoomId, signal: AbortSignal) {
  for await (const e of chat.get(roomId).events(MessageAdded, { after: 0, signal })) yield e.event.message
}

// a connection is an AsyncIterable of server frames plus `send` / `close`
export const live = async (roomId: RoomId, signal: AbortSignal) => {
  const conn = chat.get(roomId).Live({ since: 0 }, { signal })
  await conn.send(new Typing({ userId: "me" }))
  for await (const frame of conn) {
    // `Message` is a plain Schema.Class, so the union is narrowed with `in`, not on `_tag`
    if ("_tag" in frame) {
      console.log(`${frame.userId} is typing`)
    } else {
      console.log(`${frame.authorId}: ${frame.body}`)
    }
  }
  conn.close()
}

// zero-argument commands take just the options; queries look the same
export const bumpCounter = async () => {
  const counter = Counter.client({ baseUrl }).get(CounterId.make("c1"))
  await counter.Increment(1)
  await counter.Reset()
  return await counter.GetCount()
}
