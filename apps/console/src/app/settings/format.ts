import { formatCurrency } from "@akter/ui/geometry"
import { DateTime } from "effect"

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

const parts = (epochMillis: number): DateTime.DateTime.PartsWithWeekday =>
  DateTime.toPartsUtc(DateTime.makeUnsafe(epochMillis))

const pad = (value: number): string => String(value).padStart(2, "0")

/** The month name of a zero-based month index. */
const monthName = (index: number): string => months[index] ?? ""

/** `1_790_000_000_000` → `Oct 2, 14:02`, always in UTC so the same instant reads the same everywhere. */
export const formatInstant = (epochMillis: number): string => {
  const date = parts(epochMillis)
  return `${monthName(date.month - 1).slice(0, 3)} ${String(date.day)}, ${pad(date.hour)}:${pad(date.minute)}`
}

/** An instant as a UTC calendar date: `November 1, 2026`. */
export const formatDate = (epochMillis: number): string => {
  const date = parts(epochMillis)
  return `${monthName(date.month - 1)} ${String(date.day)}, ${String(date.year)}`
}

/** An instant's UTC month: `September 2026`. */
export const formatMonth = (epochMillis: number): string => {
  const date = parts(epochMillis)
  return `${monthName(date.month - 1)} ${String(date.year)}`
}

/** A billing period written `YYYY-MM` as `September 2026`; anything else is returned unchanged. */
export const formatPeriod = (period: string): string => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period)
  if (match === null) return period
  return `${monthName(Number(match[2]) - 1)} ${match[1] ?? ""}`
}

/** A calendar day written `YYYY-MM-DD` as `Sep 3`; anything else is returned unchanged. */
export const formatDay = (day: string): string => {
  const match = /^\d{4}-(0[1-9]|1[0-2])-(\d{2})$/.exec(day)
  if (match === null) return day
  return `${monthName(Number(match[1]) - 1).slice(0, 3)} ${String(Number(match[2]))}`
}

/** Whole cents as dollars. */
export const dollars = (cents: number): number => cents / 100

/** A card's expiry: `08 / 28`. */
export const formatExpiry = (expiry: { readonly month: number; readonly year: number }): string =>
  `${pad(expiry.month)} / ${pad(expiry.year % 100)}`

/** `owner` → `Owner`. */
export const titleCase = (value: string): string =>
  `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`

const gigabytes = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

/** Decimal gigabytes to two places at most: `0.5 GB`, `12.25 GB`; a trace above zero reads `<0.01 GB`. */
export const formatGigabytes = (value: number): string =>
  value > 0 && value < 0.01 ? "<0.01 GB" : `${gigabytes.format(value)} GB`

/**
 * Cents as dollars. Usage costs can be fractions of a cent, so a cost above zero that rounds to
 * nothing reads `<$0.01` rather than a misleading `$0.00`.
 */
export const formatCents = (cents: number): string =>
  cents > 0 && cents < 1 ? "<$0.01" : formatCurrency(dollars(cents))
