// Chat from a Promise-only caller, against `bun run start`:
//   bun run client alice "hello"
import { ActorError } from "durable-actors/client"
import { Chat, RoomFull } from "./chat/contract.ts"

const [user = "alice", text = "hello"] = Bun.argv.slice(2)

const rooms = Chat.client({
  baseUrl: "http://localhost:3000",
  // Called before every attempt, so a refreshed credential keeps the same command id.
  headers: () => ({ authorization: `Bearer ${user}` }),
  timeoutInMs: 10_000,
})

const lobby = rooms.get("lobby")

// Minted once; every retry, and this explicit resend, carries the same id and gets the same receipt.
const commandId = await rooms.commandId()

try {
  const count = await lobby.Post({ text }, { commandId })
  const again = await lobby.Post({ text }, { commandId })
  console.log(`posted as message ${count} (resend replayed ${again})`)
} catch (error) {
  if (error instanceof RoomFull) console.log(`the room is full at ${error.limit} messages`)
  else if (error instanceof ActorError) console.log(`not posted: ${error.reason._tag}`)
  else throw error
}

for (const message of await lobby.History()) console.log(`${message.author}: ${message.text}`)
