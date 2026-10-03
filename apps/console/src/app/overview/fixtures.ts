import { hourLabels, seededSeries } from "../workspace/series.ts"
import { type DeploySummary, OverviewPage } from "./model.ts"

/** Recent deploys shared by the overview and the deployments list. Fixture data. */
export const recentDeploys: ReadonlyArray<DeploySummary> = [
  { commit: "a3f9c21", message: "Add refunds to Order", status: "Live", when: "2h" },
  { commit: "77be010", message: "Tune Cart idle timeout", status: "Drained", when: "1d" },
  { commit: "5d2e7c3", message: "Bump Effect", status: "Rolled back", when: "2d" },
  { commit: "1c0d4a8", message: "SupportRoom presence", status: "Drained", when: "3d" },
]

const throughput = seededSeries({ length: 96, base: 1180, volatility: 210, seed: 21 })

/**
 * Fixture overview for `storefront`: a day of commands per second sampled every 15 minutes, the
 * same window yesterday, and a turn-latency histogram. Illustrative test data, not measurements.
 */
export const overview: OverviewPage = OverviewPage.make({
  project: "storefront",
  stats: [
    {
      label: "Commands / s",
      value: "1,284",
      trend: seededSeries({ length: 40, base: 50, volatility: 18, seed: 3 }),
      stepped: false,
    },
    {
      label: "Awake actors",
      value: "48,210",
      trend: seededSeries({ length: 40, base: 40, volatility: 8, seed: 11 }),
      stepped: false,
    },
    {
      label: "Jobs in flight",
      value: "312",
      trend: seededSeries({ length: 40, base: 30, volatility: 10, seed: 5 }),
      stepped: false,
    },
    {
      label: "Dead letters",
      value: "3",
      trend: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 3, 3],
      stepped: true,
    },
  ],
  hours: hourLabels({ points: 96, end: 14 }),
  throughput,
  previous: seededSeries({ length: 96, base: 1020, volatility: 160, seed: 9 }),
  markers: [
    { index: 46, label: "77be010" },
    { index: 88, label: "a3f9c21" },
  ],
  health: [
    { label: "Runners", value: "6 of 6 healthy", healthy: true },
    { label: "Database", value: "Neki · 41% CPU", healthy: true },
    { label: "Mailbox depth", value: "max 4 · Cart/c_19af", healthy: true },
    { label: "Parked sockets", value: "12,904", healthy: true },
    { label: "Outbox lag", value: "p99 18 ms", healthy: true },
    { label: "Dead letters", value: "3 need a decision", healthy: false },
  ],
  latency: [
    { upper: 0.5, count: 410 },
    { upper: 1, count: 2_980 },
    { upper: 2, count: 8_840 },
    { upper: 3, count: 12_420 },
    { upper: 5, count: 9_610 },
    { upper: 8, count: 4_120 },
    { upper: 13, count: 1_830 },
    { upper: 21, count: 760 },
    { upper: 34, count: 310 },
    { upper: 55, count: 140 },
    { upper: 89, count: 52 },
    { upper: 144, count: 18 },
    { upper: 233, count: 6 },
  ],
  deploys: recentDeploys.slice(0, 3),
})
