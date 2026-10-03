import { type DeployRecord, DeploymentPage } from "./model.ts"

const both = ["us-east-1", "eu-west-1"]

/** Fixture deploy history for `storefront`. Illustrative test data. */
export const deploys: ReadonlyArray<DeployRecord> = [
  {
    commit: "a3f9c21",
    message: "Add refunds to Order",
    author: "dallen",
    regions: both,
    runners: 6,
    took: "41 s",
    status: "Live",
    when: "2h",
  },
  {
    commit: "77be010",
    message: "Tune Cart idle timeout",
    author: "dallen",
    regions: both,
    runners: 6,
    took: "38 s",
    status: "Drained",
    when: "1d",
  },
  {
    commit: "5d2e7c3",
    message: "Bump Effect",
    author: "maya",
    regions: both,
    runners: 6,
    took: "—",
    status: "Rolled back",
    when: "2d",
  },
  {
    commit: "1c0d4a8",
    message: "SupportRoom presence",
    author: "maya",
    regions: ["us-east-1"],
    runners: 4,
    took: "36 s",
    status: "Drained",
    when: "3d",
  },
  {
    commit: "e91f6b2",
    message: "Initial deploy",
    author: "dallen",
    regions: ["us-east-1"],
    runners: 4,
    took: "52 s",
    status: "Drained",
    when: "6d",
  },
]

/** The detail of a deploy; every fixture deploy reuses the live deploy's rollout. */
export const deploymentOf = (deploy: DeployRecord): DeploymentPage =>
  DeploymentPage.make({
    deploy,
    phases: [
      { id: "build", label: "Build", detail: "bun install, typecheck", start: 0, end: 12 },
      { id: "migrate", label: "Migrate", detail: "1 table created", start: 12, end: 15 },
      {
        id: "start",
        label: "Start runners",
        detail: `${String(deploy.runners)} of ${String(deploy.runners)} healthy`,
        start: 15,
        end: 24,
      },
      {
        id: "move",
        label: "Move actors",
        detail: "48,210 moved, none dropped",
        start: 22,
        end: 36,
      },
      {
        id: "drain",
        label: "Drain previous",
        detail: "0 in-flight turns lost",
        start: 34,
        end: 41,
      },
    ],
    shift: { start: 22, end: 36, moved: 48_210 },
    liveAt: 41,
    runners: [
      { id: "r1", region: "us-east-1", actors: 9_880, cpu: "38%", healthy: true },
      { id: "r2", region: "us-east-1", actors: 10_112, cpu: "41%", healthy: true },
      { id: "r3", region: "us-east-1", actors: 9_640, cpu: "36%", healthy: true },
      { id: "r4", region: "eu-west-1", actors: 6_201, cpu: "22%", healthy: true },
      { id: "r5", region: "eu-west-1", actors: 6_077, cpu: "21%", healthy: true },
      { id: "r6", region: "eu-west-1", actors: 6_300, cpu: "24%", healthy: true },
    ].slice(0, deploy.runners),
    log: [
      "$ bun install            ok  2.1 s",
      "$ bun run typecheck      ok  4.8 s",
      "$ akter contracts diff   ok  Order: +Refund (command)",
      "$ akter migrate          ok  order_refunds created",
      `$ start runners          ok  ${String(deploy.runners)} / ${String(deploy.runners)} ready`,
      "$ move actors            ok  48,210 moved",
      "$ drain 77be010          ok  0 in-flight turns lost",
    ].join("\n"),
  })
