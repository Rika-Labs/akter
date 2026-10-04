import type { CapState } from "@akter/cloud-api"
import { Match, Schema as S } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import type { Billing } from "../settings/model.ts"

/**
 * The one cap a page explains while the edge refuses at it, as the control plane reports it:
 * `Unbound` when the organization has no billing account and every new command is refused,
 * otherwise Free's command allowance for `period` (`commands`, null when the cap doesn't say how
 * many units a command weighs), a tenant's storage sample at its cap, the spend limit in cents, or
 * the organization's live connections (which refuse new connections, not commands).
 */
export const CapNotice = defineTaggedUnion({
  Unbound: {},
  CommandCap: { period: S.String, commands: S.NullOr(S.Finite) },
  StorageCap: { usedBytes: S.Finite, limitBytes: S.Finite },
  SpendCap: { period: S.String, limitCents: S.Finite },
  ConnectionCap: { open: S.Finite, limit: S.Finite },
})
export type CapNotice = typeof CapNotice.Type

/**
 * Whether the organization has no billing account: the edge refuses every new command and no
 * plan's allowances or prices apply to it, whatever plan the reports fall back to.
 */
export const isUnbound = (caps: ReadonlyArray<CapState>): boolean =>
  caps.some((cap) => cap.reason === "unbound")

/** The caps in the order a page explains them: the hard stops before the limit a person set. */
const precedence: ReadonlyArray<CapState["cap"]> = ["commands", "storage", "spend", "connections"]

/**
 * The cap a page explains, if the edge is refusing at one now. Only `refusing` counts: a cap that
 * is merely reached (`atCap`) still admits work the edge would take. An `unbound` cap outranks the
 * rest, because every new command is refused whatever the usage, and has no limit to quote. The
 * command cap counts usage units, in which a read weighs one and a command `unitsPerCommand`, so
 * its limit is quoted in commands by dividing by that weight.
 */
export const capNotice = (input: {
  readonly caps: ReadonlyArray<CapState>
  readonly period: string
}): CapNotice | undefined => {
  if (isUnbound(input.caps)) return CapNotice.Unbound()
  const refusing = precedence
    .map((name) => input.caps.find((cap) => cap.cap === name && cap.refusing))
    .find((cap) => cap !== undefined && cap.limit !== null)
  if (refusing === undefined || refusing.limit === null) return undefined
  const { used, limit } = refusing
  return Match.value(refusing.cap).pipe(
    Match.withReturnType<CapNotice>(),
    Match.when("commands", () =>
      CapNotice.CommandCap({
        period: input.period,
        commands: refusing.unitsPerCommand === undefined ? null : limit / refusing.unitsPerCommand,
      }),
    ),
    Match.when("storage", () => CapNotice.StorageCap({ usedBytes: used, limitBytes: limit })),
    Match.when("spend", () => CapNotice.SpendCap({ period: input.period, limitCents: limit })),
    Match.when("connections", () => CapNotice.ConnectionCap({ open: used, limit })),
    Match.exhaustive,
  )
}

/**
 * Whether a spend limit not yet saved is already reached by the month's estimate, so saving it
 * would refuse new commands right away. The control plane's cap state describes only the saved
 * limit, so a limit being chosen is checked here.
 */
export const spendLimitReached = (input: {
  readonly limitCents: number
  readonly billing: Billing
}): boolean => input.billing.spendLimit.currentCents >= input.limitCents
