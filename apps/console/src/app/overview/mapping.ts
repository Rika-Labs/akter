import type { Overview, SeriesPoint, SeriesWindow, TurnLatency } from "@akter/cloud-api"
import { formatDuration, formatInteger } from "@akter/ui/geometry"
import { DateTime } from "effect"
import { shortCommit, toDeployRecord } from "../deployments/mapping.ts"
import { type LatencyDistribution, OverviewPage } from "./model.ts"
import { hourLabel } from "./time.ts"

/** Database CPU at or above this share of capacity is flagged. */
export const databaseCpuLimit = 85

/** An outbox whose 99th-percentile lag reaches this many milliseconds is flagged. */
export const outboxLagLimitMs = 1000

/** A mailbox this deep or deeper is flagged. */
export const mailboxDepthLimit = 1000

const byTime = (left: SeriesPoint, right: SeriesPoint): number =>
  DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at)

/** A series oldest first, as the charts draw it. */
export const orderedSeries = (series: ReadonlyArray<SeriesPoint>): ReadonlyArray<SeriesPoint> =>
  [...series].sort(byTime)

/**
 * The index of the point nearest each deployment that landed inside the series, so a chart can
 * mark it. A deployment before the first point or after the last is outside the window and has no
 * marker.
 */
export const deployMarkers =
  (deployments: Overview["recentDeployments"]) =>
  (series: ReadonlyArray<SeriesPoint>): ReadonlyArray<{ index: number; label: string }> => {
    const first = series[0]
    const last = series.at(-1)
    if (first === undefined || last === undefined) return []
    const start = DateTime.toEpochMillis(first.at)
    const end = DateTime.toEpochMillis(last.at)
    return (deployments ?? []).flatMap((deployment) => {
      const at = DateTime.toEpochMillis(deployment.createdAt)
      if (at < start || at > end) return []
      const distances = series.map((point) => Math.abs(DateTime.toEpochMillis(point.at) - at))
      const nearest = distances.indexOf(Math.min(...distances))
      return [{ index: nearest, label: shortCommit(deployment.commitSha) }]
    })
  }

/**
 * The turn latency of every actor type, added up bucket by bucket. The API reports one histogram
 * per actor type, so the project's distribution exists only when every type counted the same
 * window into the same bounds; otherwise there is nothing honest to add and it is `undefined`. The
 * last bucket has a null bound and is written as slower than the bound before it. No percentile is
 * derived, because percentiles of separate histograms cannot be combined.
 */
export const toLatencyDistribution =
  (window: SeriesWindow) =>
  (latencies: ReadonlyArray<TurnLatency>): LatencyDistribution | undefined => {
    const [first] = latencies
    if (first === undefined) return { window, total: 0, bars: [] }
    const bounds = first.buckets.map((bucket) => bucket.upToMs)
    const comparable = latencies.every(
      (latency) =>
        latency.window === window &&
        latency.buckets.length === bounds.length &&
        latency.buckets.every((bucket, index) => bucket.upToMs === bounds[index]),
    )
    if (!comparable) return undefined
    const counts = bounds.map((_, index) =>
      latencies.reduce((sum, latency) => sum + (latency.buckets[index]?.count ?? 0), 0),
    )
    return {
      window,
      total: counts.reduce((sum, count) => sum + count, 0),
      bars: bounds.map((bound, index) => {
        const previous = index === 0 ? null : bounds[index - 1]
        const label =
          bound !== null
            ? previous === null || previous === undefined
              ? `≤ ${formatDuration(bound)}`
              : `${String(previous)}–${String(bound)} ms`
            : previous === null || previous === undefined
              ? "All turns"
              : `> ${formatDuration(previous)}`
        return { label, count: counts[index] ?? 0, tail: bound === null }
      }),
    }
  }

/**
 * The overview the runtime API reports, drawn as the console's page. The API has no yesterday
 * comparison, no history behind the awake, in-flight or dead-letter counts, and no database vendor
 * in its health report, so those parts of the page are empty or plain.
 */
export const toOverviewPage =
  (now: DateTime.Utc) =>
  (
    input: Readonly<{
      project: string
      overview: Overview
      distribution?: LatencyDistribution | undefined
    }>,
  ): OverviewPage => {
    const { overview } = input
    const throughput = orderedSeries(overview.throughput ?? [])
    const p99 = orderedSeries(overview.p99 ?? [])
    const deadLetters = overview.deadLettersByJobType.reduce((sum, type) => sum + type.count, 0)
    const { health } = overview
    const mailbox = health.maxMailbox
    const unknown = (label: string) => ({ label, value: "—", healthy: true })
    return OverviewPage.make({
      project: input.project,
      stats: [
        {
          label: "Commands / s",
          value: overview.commands === null ? "—" : formatInteger(overview.commands.perSecond),
          trend: orderedSeries(overview.commands?.series24h ?? []).map((point) => point.value),
          stepped: false,
        },
        {
          label: "Awake actors",
          value: overview.actors.awake === null ? "—" : formatInteger(overview.actors.awake),
          trend: [],
          stepped: false,
        },
        {
          label: "Jobs in flight",
          value: formatInteger(overview.jobs.inFlight),
          trend: [],
          stepped: false,
        },
        { label: "Dead letters", value: formatInteger(deadLetters), trend: [], stepped: true },
      ],
      hours: throughput.map((point) => hourLabel(point.at)),
      throughput: throughput.map((point) => point.value),
      previous: [],
      markers: deployMarkers(overview.recentDeployments)(throughput),
      health: [
        health.runners === null
          ? unknown("Runners")
          : {
              label: "Runners",
              value: `${formatInteger(health.runners.healthy)} of ${formatInteger(health.runners.total)} healthy`,
              healthy: health.runners.healthy === health.runners.total,
            },
        health.databaseCpuPercent === null
          ? unknown("Database")
          : {
              label: "Database",
              value: `${String(Math.round(health.databaseCpuPercent))}% CPU`,
              healthy: health.databaseCpuPercent < databaseCpuLimit,
            },
        mailbox === null
          ? unknown("Mailbox depth")
          : {
              label: "Mailbox depth",
              value:
                mailbox.actor === null
                  ? `max ${formatInteger(mailbox.depth)}`
                  : `max ${formatInteger(mailbox.depth)} · ${mailbox.actor}`,
              healthy: mailbox.depth < mailboxDepthLimit,
            },
        health.parkedSockets === null
          ? unknown("Parked sockets")
          : { label: "Parked sockets", value: formatInteger(health.parkedSockets), healthy: true },
        health.outboxLagP99Ms === null
          ? unknown("Outbox lag")
          : {
              label: "Outbox lag",
              value: `p99 ${formatDuration(health.outboxLagP99Ms)}`,
              healthy: health.outboxLagP99Ms < outboxLagLimitMs,
            },
        {
          label: "Dead letters",
          value: deadLetters === 0 ? "none" : `${formatInteger(deadLetters)} need a decision`,
          healthy: deadLetters === 0,
        },
      ],
      latency: {
        p50: overview.commands?.p50Ms ?? null,
        p99: overview.commands?.p99Ms ?? null,
        hours: p99.map((point) => hourLabel(point.at)),
        p99Series: p99.map((point) => point.value),
      },
      distribution: input.distribution,
      deploys: (overview.recentDeployments ?? []).slice(0, 3).map((deployment) => {
        const record = toDeployRecord(now)(deployment)
        return {
          id: record.id,
          commit: record.commit,
          message: record.message,
          status: record.status,
          when: record.when,
        }
      }),
    })
  }
