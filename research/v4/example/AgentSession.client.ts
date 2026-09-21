// Browser-style caller: Promises and async iterables, same contract, no Effect.
import { AgentSession, SessionId, TurnFinished } from "./AgentSession.ts"

const client = AgentSession.client({ baseUrl: "https://actors.example.com" })

export const chat = async (id: string, text: string): Promise<string> => {
  const session = client.get(SessionId.make(id))
  const turnId = await session.SendPrompt({ text })
  // replay from the start of the log, then follow the live feed
  const finished = (async () => {
    for await (const e of session.events(TurnFinished, { from: 0 })) {
      if (e.event.turnId === turnId) return e.event.text
    }
    return ""
  })()
  for await (const token of session.Tokens()) {
    if (token.turnId === turnId) console.log(token.text)
  }
  return await finished
}
