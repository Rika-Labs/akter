import { seededSeries } from "../workspace/series.ts"
import { JobsPage } from "./model.ts"

/** Fixture jobs for `storefront`. Illustrative test data. */
export const jobs: JobsPage = JobsPage.make({
  queued: 88,
  running: 312,
  retrying: 17,
  deadLetters: [
    {
      id: "job_31c",
      job: "Charge",
      actorType: "Order",
      key: "ord_7c10",
      attempts: 8,
      error: "card_declined (provider 402)",
      since: "41m",
    },
    {
      id: "job_31f",
      job: "Charge",
      actorType: "Order",
      key: "ord_7c55",
      attempts: 8,
      error: "timeout after 30 s",
      since: "38m",
    },
    {
      id: "job_2aa",
      job: "SendEmail",
      actorType: "Customer",
      key: "cu_118",
      attempts: 5,
      error: "mailbox unavailable (550)",
      since: "2h",
    },
  ],
  types: [
    { name: "Charge", done: 18_204, retried: 311, dead: 2, p99: "1.8 s" },
    { name: "SendEmail", done: 40_119, retried: 92, dead: 1, p99: "640 ms" },
    { name: "CallModel", done: 9_840, retried: 210, dead: 0, p99: "6.1 s" },
    { name: "Reindex", done: 1_002, retried: 0, dead: 0, p99: "4.2 s" },
  ],
  minutes: Array.from({ length: 48 }, (_, index) =>
    index === 47 ? "now" : `${String(47 - index)} min ago`,
  ),
  throughput: seededSeries({ length: 48, base: 40, volatility: 14, seed: 31 }).map((value) =>
    Math.round(value),
  ),
})
