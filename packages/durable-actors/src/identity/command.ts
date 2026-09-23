import { Context, Schema } from "effect"

export const CommandId = Schema.String.check(
  Schema.isPattern(
    /^v1\.[1-9]\d{0,14}\.[1-9]\d{0,14}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
)

export const CurrentCommandId = Context.Reference<string | undefined>(
  "durable-actors/CurrentCommandId",
  {
    defaultValue: () => undefined,
  },
)

export const commandTimes = (id: string) => {
  const parts = CommandId.make(id).split(".")

  return { issuedAt: Number(parts[1]), expiresAt: Number(parts[2]) }
}
