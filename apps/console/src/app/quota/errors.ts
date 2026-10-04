import { formatCompact, formatCurrency, formatInteger } from "@akter/ui/geometry"
import {
  CommandRefused,
  ConnectionLimitExceeded,
  QuotaExceeded,
  QuotaUnbound,
  SpendLimitExceeded,
  StorageQuotaExceeded,
} from "@akter/cloud-api"
import { Match, Option, Predicate, Schema } from "effect"
import { dollars, formatGigabytes, formatPeriod } from "../settings/format.ts"

/**
 * A plan refusal of new work: one of the cloud API's own usage errors with the framework's tags and
 * fields, the same refusal a `CommandRefused` carries as its typed `reason`, or the edge's own
 * `QuotaUnbound` for a command it has no billing account or plan to bill to.
 */
export type QuotaRefusal =
  | QuotaExceeded
  | SpendLimitExceeded
  | ConnectionLimitExceeded
  | StorageQuotaExceeded
  | QuotaUnbound
  | Extract<CommandRefused["reason"], { readonly _tag: QuotaKind }>

const usageKinds = [
  "QuotaExceeded",
  "SpendLimitExceeded",
  "ConnectionLimitExceeded",
  "StorageQuotaExceeded",
] as const
type QuotaKind = (typeof usageKinds)[number]

/**
 * Whether an error kind is a refusal Billing lifts: a plan refusal, which a plan or spend-limit
 * change lifts, or `QuotaUnbound` for an organization without a billing account, which choosing a
 * plan sets up.
 */
export const isQuotaKind = (kind: string): boolean =>
  kind === "QuotaUnbound" || usageKinds.some((quota) => quota === kind)

/**
 * The error kind a refusal is shown under. A `QuotaUnbound` for a deployment with no organization
 * or a plan the pricing doesn't define is `Unbillable`, since only support can fix it and Billing
 * offers no way out; one for a missing billing account keeps its tag, which links to Billing.
 */
export const quotaKind = (refusal: QuotaRefusal): string =>
  Predicate.isTagged(refusal, "QuotaUnbound") && refusal.reason !== "account"
    ? "Unbillable"
    : refusal._tag

/**
 * What the console says about one refusal: what was refused, why, what still works, and the way
 * out. The command allowance counts usage units, in which a command weighs `unitsPerCommand` and a
 * read one, so it is quoted in whole commands, rounded down; usage is not, because reads spend the
 * same units and a count of commands used would not add up to it.
 */
export const quotaMessage = (refusal: QuotaRefusal): string =>
  Match.value(refusal).pipe(
    Match.tagsExhaustive({
      QuotaExceeded: ({ period, limitUnits, unitsPerCommand }) =>
        `This organization has used the ${formatCompact(Math.floor(limitUnits / unitsPerCommand))} commands its plan includes for ${formatPeriod(period)}, so new commands are refused until the month ends. Reads keep working; upgrading raises the allowance.`,
      SpendLimitExceeded: ({ period, limitCents }) =>
        `This command would take ${formatPeriod(period)}’s spend past the ${formatCurrency(dollars(limitCents))} spend limit, so it wasn’t run. Raise or remove the limit in Billing to continue.`,
      ConnectionLimitExceeded: ({ open, limit }) =>
        `This organization already has ${formatInteger(open)} of the ${formatInteger(limit)} live connections its plan allows. Try again when one closes, or upgrade for more.`,
      StorageQuotaExceeded: ({ usedBytes, limitBytes }) =>
        `This tenant stores ${formatGigabytes(usedBytes / 1e9)} of the ${formatGigabytes(limitBytes / 1e9)} its plan allows, so new commands are paused. Reads keep working; delete data or upgrade to resume.`,
      QuotaUnbound: ({ reason }) =>
        Match.value(reason).pipe(
          Match.when(
            "tenant",
            () =>
              "This deployment isn’t linked to an organization Akter can bill, so the command wasn’t run. Sending it again won’t help until it is; contact support.",
          ),
          Match.when(
            "account",
            () =>
              "Billing isn’t set up for this organization, so the command wasn’t run. Choose a plan in Billing, then send it as a new command.",
          ),
          Match.when(
            "plan",
            () =>
              "This organization’s plan isn’t recognised, so the command wasn’t run. Sending it again won’t help until the plan is fixed; contact support.",
          ),
          Match.exhaustive,
        ),
    }),
  )

const isUsageError = Schema.is(
  Schema.Union([
    QuotaExceeded,
    SpendLimitExceeded,
    ConnectionLimitExceeded,
    StorageQuotaExceeded,
    QuotaUnbound,
  ]),
)

const isQuotaReason = (
  reason: CommandRefused["reason"],
): reason is Extract<CommandRefused["reason"], { readonly _tag: QuotaKind }> =>
  usageKinds.some((quota) => quota === reason._tag)

/**
 * The plan refusal a decoded API error is, if it is one: one of the cloud API's usage errors, or a
 * `CommandRefused` whose typed reason is a plan refusal. Only errors the client decoded count; a
 * value that merely looks like one is not read.
 */
export const quotaRefusal = (cause: unknown): Option.Option<QuotaRefusal> => {
  if (isUsageError(cause)) return Option.some(cause)
  if (Schema.is(CommandRefused)(cause) && isQuotaReason(cause.reason))
    return Option.some(cause.reason)
  return Option.none()
}
