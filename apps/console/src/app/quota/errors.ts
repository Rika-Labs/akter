import { formatCurrency, formatInteger } from "@akter/ui/geometry"
import {
  CommandRefused,
  ConnectionLimitExceeded,
  QuotaExceeded,
  SpendLimitExceeded,
  StorageQuotaExceeded,
} from "@akter/cloud-api"
import { Match, Option, Schema } from "effect"
import { dollars, formatGigabytes, formatPeriod } from "../settings/format.ts"

/**
 * A plan refusal of new work, with the framework's tags and fields: one of the cloud API's own
 * usage errors, or the same refusal a `CommandRefused` carries as its typed `reason`.
 */
export type QuotaRefusal =
  | QuotaExceeded
  | SpendLimitExceeded
  | ConnectionLimitExceeded
  | StorageQuotaExceeded
  | Extract<CommandRefused["reason"], { readonly _tag: QuotaKind }>

const quotaKinds = [
  "QuotaExceeded",
  "SpendLimitExceeded",
  "ConnectionLimitExceeded",
  "StorageQuotaExceeded",
] as const
type QuotaKind = (typeof quotaKinds)[number]

/** Whether an error kind is a plan refusal, which a plan or spend-limit change in Billing lifts. */
export const isQuotaKind = (kind: string): boolean => quotaKinds.some((quota) => quota === kind)

/** What the console says about one refusal: what was refused, why, what still works, and the way out. */
export const quotaMessage = (refusal: QuotaRefusal): string =>
  Match.value(refusal).pipe(
    Match.tagsExhaustive({
      QuotaExceeded: ({ period }) =>
        `This organization has used all the commands its plan includes for ${formatPeriod(period)}, so new commands are refused until the month ends. Reads keep working; upgrading raises the allowance.`,
      SpendLimitExceeded: ({ period, limitCents }) =>
        `This command would take ${formatPeriod(period)}’s spend past the ${formatCurrency(dollars(limitCents))} spend limit, so it wasn’t run. Raise or remove the limit in Billing to continue.`,
      ConnectionLimitExceeded: ({ open, limit }) =>
        `This organization already has ${formatInteger(open)} of the ${formatInteger(limit)} live connections its plan allows. Try again when one closes, or upgrade for more.`,
      StorageQuotaExceeded: ({ usedBytes, limitBytes }) =>
        `This tenant stores ${formatGigabytes(usedBytes / 1e9)} of the ${formatGigabytes(limitBytes / 1e9)} its plan allows, so new commands are paused. Reads keep working; delete data or upgrade to resume.`,
    }),
  )

const isUsageError = Schema.is(
  Schema.Union([QuotaExceeded, SpendLimitExceeded, ConnectionLimitExceeded, StorageQuotaExceeded]),
)

const isQuotaReason = (
  reason: CommandRefused["reason"],
): reason is Extract<CommandRefused["reason"], { readonly _tag: QuotaKind }> =>
  isQuotaKind(reason._tag)

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
