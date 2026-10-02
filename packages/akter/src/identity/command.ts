import { Context, Schema } from "effect"

/**
 * A client-issued command id: `v1.<issuedAt>.<expiresAt>.<uuid v4>`, with both
 * times in epoch milliseconds on the database clock.
 */
export const CommandId = Schema.String.check(
  Schema.isPattern(
    /^v1\.[1-9]\d{0,14}\.[1-9]\d{0,14}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
)

/** The explicit command id for the command calls it is provided to, set by `Actor.commandId(id)`; undefined lets each call mint its own. */
export const CurrentCommandId = Context.Reference<string | undefined>("akter/CurrentCommandId", {
  defaultValue: () => undefined,
})

/**
 * Every id a receipt may carry: an external id, or a framework delivery id
 * derived from the durable record it delivers, whose version-8 digest no
 * caller can present because external admission accepts only version 4.
 */
export const InternalCommandId = Schema.String.check(
  Schema.isPattern(
    /^v1\.[1-9]\d{0,14}\.[1-9]\d{0,14}\.[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
)

/** The issue and expiry times, in epoch milliseconds, encoded in a command id. */
export const commandTimes = (id: string) => {
  const parts = InternalCommandId.make(id).split(".")

  return { issuedAt: Number(parts[1]), expiresAt: Number(parts[2]) }
}
