// Chat from a Promise-only caller, against `bun run serve`:
//   bun run client alice "hello"
import { ActorError } from "@durable-actors/core/client"
import { Room, RoomClosed, RoomId } from "./room/contract.ts"

const [user = "alice", body = "hello"] = Bun.argv.slice(2)

const rooms = Room.client({
  baseUrl: "http://localhost:3000",
  // Called before every attempt, so a refreshed credential keeps the same command id.
  headers: () => ({ authorization: `Bearer ${user}` }),
  timeoutInMs: 10_000,
})

const lobby = rooms.get(RoomId.make("lobby"))

// Minted once; every retry, and this explicit resend, carries the same id and gets the same receipt.
const commandId = await rooms.commandId()

try {
  const id = await lobby.Post({ body }, { commandId })
  const again = await lobby.Post({ body }, { commandId })
  console.log(`posted as message ${id} (resend replayed ${again})`)
} catch (error) {
  if (error instanceof RoomClosed) console.log("the room is closed")
  else if (error instanceof ActorError) console.log(`not posted: ${error.reason._tag}`)
  else throw error
}

for (const { cursor, message } of await lobby.History({}))
  console.log(`${cursor} ${message.author}: ${message.body}`)
