/** One release note: when it shipped, what it was, and the changes grouped as the page prints them. */
export interface Entry {
  readonly date: string
  readonly version: string
  readonly title: string
  readonly summary: string
  readonly illustrated?: boolean
  readonly improvements: ReadonlyArray<string>
  readonly fixes: ReadonlyArray<string>
}

/** The changelog, newest first. */
export const entries: ReadonlyArray<Entry> = [
  {
    date: "2026-10-04",
    version: "0.1.0-alpha.1",
    title: "Akter 0.1 alpha",
    summary:
      "The first alpha is on npm, published by our release workflow. The CLI can now sign in and deploy to Akter Cloud, and Node joins Bun as a supported runtime.",
    illustrated: true,
    improvements: [
      "akter login, logout, whoami and deploy, built on effect/cli",
      "Node support alongside Bun",
      "Device login: approve the CLI from the browser after checking its code",
    ],
    fixes: [],
  },
  {
    date: "2026-10-04",
    version: "Cloud",
    title: "Live runtime telemetry",
    summary:
      "The console now streams commands as they commit, shows how long each receipt took, and lets you inspect any actor's live state.",
    improvements: [
      "Command stream and receipt timing",
      "Actor inspector reloads after a command",
      "Mutual TLS between runners",
    ],
    fixes: ["Quota refusals quote the whole command"],
  },
  {
    date: "2026-10-03",
    version: "Cloud",
    title: "Billing, quotas and spend caps",
    summary:
      "Usage is metered per committed command and billed through Stripe. Spend caps and the free cap apply at the edge.",
    improvements: ["Metering and invoices", "Spend caps with notices", "Usage page on real data"],
    fixes: [],
  },
  {
    date: "2026-10-03",
    version: "Cloud",
    title: "Deployments and rollbacks",
    summary:
      "Deploy from the CLI or on every push to main. Every deployment has its own page, and you can roll back in one click.",
    improvements: ["Redeploy and rollback", "Live command tail", "Activity and latency charts"],
    fixes: [],
  },
]
