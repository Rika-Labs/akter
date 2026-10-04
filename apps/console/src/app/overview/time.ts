import type { SeriesWindow } from "@akter/cloud-api"
import { DateTime } from "effect"

const secondsBetween = (from: DateTime.Utc, to: DateTime.Utc): number =>
  Math.max(0, Math.floor((DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from)) / 1000))

/** How long ago `at` was, as the console writes it: `now`, `4s`, `14m`, `2h`, `3d`. */
export const ago =
  (now: DateTime.Utc) =>
  (at: DateTime.Utc): string => {
    const elapsed = secondsBetween(at, now)
    if (elapsed < 5) return "now"
    if (elapsed < 60) return `${String(elapsed)}s`
    if (elapsed < 3600) return `${String(Math.floor(elapsed / 60))}m`
    if (elapsed < 86_400) return `${String(Math.floor(elapsed / 3600))}h`
    return `${String(Math.floor(elapsed / 86_400))}d`
  }

/** How far away `at` is: `in 21 s`, `in 6 min`, `in 9 h`, `in 2 d`; an instant already past reads `in 0 s`. */
export const until =
  (now: DateTime.Utc) =>
  (at: DateTime.Utc): string => {
    const remaining = secondsBetween(now, at)
    if (remaining < 60) return `in ${String(remaining)} s`
    if (remaining < 3600) return `in ${String(Math.floor(remaining / 60))} min`
    if (remaining < 86_400) return `in ${String(Math.floor(remaining / 3600))} h`
    return `in ${String(Math.floor(remaining / 86_400))} d`
  }

/** The UTC time of day, `14:02:11`. Charts and logs use UTC so the same instant reads the same everywhere. */
export const clock = (at: DateTime.Utc): string => DateTime.formatIso(at).slice(11, 19)

/** The UTC time of day to the millisecond, `14:02:16.998`. */
export const clockMillis = (at: DateTime.Utc): string => DateTime.formatIso(at).slice(11, 23)

/** The UTC month, day, hour and minute, `10-05 14:00`, for instants that may be days away. */
export const dayClock = (at: DateTime.Utc): string =>
  DateTime.formatIso(at).slice(5, 16).replace("T", " ")

/** The UTC hour and minute, `14:00`, for chart axes. */
export const hourLabel = (at: DateTime.Utc): string => DateTime.formatIso(at).slice(11, 16)

/** The windows a series can cover, shortest first, as the API names them. */
export const seriesWindows: ReadonlyArray<SeriesWindow> = ["1h", "24h", "7d"]

/** A window in words for headings and menus: `last hour`, `last 24 hours`, `last 7 days`. */
export const windowName: Readonly<Record<SeriesWindow, string>> = {
  "1h": "last hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
}

/** The seconds a window reaches back. */
export const windowSeconds: Readonly<Record<SeriesWindow, number>> = {
  "1h": 3600,
  "24h": 86_400,
  "7d": 604_800,
}

/** A chart axis label in UTC: the time of day within a day, the date and time across days. */
export const seriesLabel =
  (window: SeriesWindow) =>
  (at: DateTime.Utc): string =>
    window === "7d" ? dayClock(at) : hourLabel(at)

/** Splits an actor address `Type/key` at its first slash; keys may contain slashes. */
export const splitAddress = (address: string) => {
  const slash = address.indexOf("/")
  return { actorType: address.slice(0, slash), key: address.slice(slash + 1) }
}
