import { Schema as S } from "effect"
import type { Billing, Usage } from "../settings/model.ts"

/**
 * A cap the organization has reached, so new commands are refused at admission while reads keep
 * working: Free's included commands for the period (`limit` in commands), or the spend limit
 * (`limit` in cents). Storage is not here because usage reports an average over the month, not the
 * latest sample the storage cap is checked against.
 */
export const CapNotice = S.Struct({
  cap: S.Literals(["commands", "spend"]),
  period: S.String,
  limit: S.Finite,
})
export type CapNotice = typeof CapNotice.Type

/**
 * Whether a spend limit is already reached by the month's estimate. Each command whose estimate would
 * pass the limit is refused, so once the estimate has reached it any command that costs something is.
 */
export const spendLimitReached = (input: {
  readonly limitCents: number
  readonly billing: Billing
}): boolean => input.billing.spendLimit.currentCents >= input.limitCents

/**
 * The cap new commands are refused at, if one is reached. Free's allowance is a hard cap reached at
 * the allowance; a spend limit is reached as `spendLimitReached` describes.
 */
export const capReached = (input: {
  readonly billing: Billing
  readonly usage: Usage
}): CapNotice | undefined => {
  const { billing, usage } = input
  const commands = usage.meters.find((meter) => meter.meter === "commands")
  if (
    billing.plan.id === "free" &&
    commands !== undefined &&
    commands.included > 0 &&
    commands.used >= commands.included
  )
    return { cap: "commands", period: usage.period, limit: commands.included }
  const limit = billing.spendLimit.limitCents
  if (limit !== null && spendLimitReached({ limitCents: limit, billing }))
    return { cap: "spend", period: usage.period, limit }
  return undefined
}
