import { formatCurrency, formatInteger } from "@akter/ui/geometry"
import {
  ConnectionLimitExceeded,
  QuotaExceeded,
  SpendLimitExceeded,
  StorageQuotaExceeded,
} from "@rikalabs/akter/client"
import { Match, Option, Schema } from "effect"
import { dollars, formatGigabytes, formatPeriod } from "../settings/format.ts"

/**
 * The refusals a hosted organization's plan causes when a new request is admitted, with the
 * framework's own tags and fields. They are decoded by shape, so an API error that carries the same
 * tag and payload reads exactly as the framework's error does.
 */
const QuotaRefusal = Schema.Union([
  Schema.TaggedStruct("QuotaExceeded", QuotaExceeded.fields),
  Schema.TaggedStruct("SpendLimitExceeded", SpendLimitExceeded.fields),
  Schema.TaggedStruct("ConnectionLimitExceeded", ConnectionLimitExceeded.fields),
  Schema.TaggedStruct("StorageQuotaExceeded", StorageQuotaExceeded.fields),
])
export type QuotaRefusal = typeof QuotaRefusal.Type

const quotaKinds: ReadonlyArray<string> = [
  "QuotaExceeded",
  "SpendLimitExceeded",
  "ConnectionLimitExceeded",
  "StorageQuotaExceeded",
]

/** Whether an error kind is a plan refusal, which a plan or spend-limit change in Billing lifts. */
export const isQuotaKind = (kind: string): boolean => quotaKinds.includes(kind)

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

/** The plan refusal an API error carries, if it is one. */
export const quotaRefusal = (cause: unknown): Option.Option<QuotaRefusal> =>
  Schema.decodeUnknownOption(QuotaRefusal)(cause)
