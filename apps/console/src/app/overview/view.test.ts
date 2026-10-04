import type { Overview } from "@akter/cloud-api"
import { DateTime } from "effect"
import * as Scene from "foldkit/scene"
import { describe, it } from "vitest"
import { screenRoot, screenScene } from "../shell/testing.ts"
import { distribution } from "./fixtures.ts"
import { toOverviewPage } from "./mapping.ts"
import type { OverviewPage } from "./model.ts"
import { overviewScreen } from "./view.ts"

const now = DateTime.makeUnsafe("2026-10-04T12:00:00.000Z")

/** The overview as the runners' durable views answer it: every unmeasured field null. */
const unmeasured: Overview = {
  commands: null,
  actors: { awake: null, total: 3 },
  jobs: { inFlight: 0, donePerHour: null },
  deadLettersByJobType: [],
  throughput: null,
  p99: null,
  health: {
    runners: null,
    databaseCpuPercent: null,
    maxMailbox: null,
    parkedSockets: null,
    outboxLagP99Ms: null,
    lastDeployAt: null,
  },
  recentDeployments: null,
}

const render = (page: OverviewPage, ...steps: Parameters<typeof screenScene>[1][]) =>
  screenScene({ path: "/", screen: overviewScreen, page }, ...steps)

describe("overview with unmeasured fields", () => {
  it("writes unmeasured numbers and health as dashes and never as null, NaN or zero", () =>
    render(
      toOverviewPage(now)({ project: "p", overview: unmeasured, distribution: undefined }),
      Scene.expect(Scene.role("region", { name: "Health" })).toHaveText(
        "HealthRunners—Database—Mailbox depth—Parked sockets—Outbox lag—Dead lettersnone",
      ),
      Scene.expect(screenRoot).toContainText("Commands / s—"),
      Scene.expect(screenRoot).toContainText("Awake actors—"),
      Scene.expect(screenRoot).not.toContainText(/null|NaN|undefined/),
    ))

  it("says once that each unreported chart and the deploys aren't reported", () =>
    render(
      toOverviewPage(now)({ project: "p", overview: unmeasured }),
      Scene.expect(Scene.role("region", { name: "Throughput" })).toContainText(
        "Throughput isn’t reported.",
      ),
      Scene.expect(Scene.role("region", { name: "Turn latency" })).toHaveText(
        "Turn latencylast 24 hoursTurn latency isn’t reported.",
      ),
      Scene.expect(Scene.role("region", { name: "Recent deploys" })).toContainText(
        "Recent deploys aren’t reported.",
      ),
      Scene.expect(Scene.role("img")).toBeAbsent(),
    ))

  it("marks only a sample distribution on a live page and fixes its window", () =>
    render(
      toOverviewPage(now)({
        project: "p",
        overview: unmeasured,
        distribution: distribution("24h"),
        distributionSample: true,
      }),
      Scene.expectAll(Scene.all.role("note")).toHaveCount(1),
      Scene.expect(Scene.role("region", { name: "Turn latency distribution" })).toContainText(
        "Sample data — this part isn’t connected yet.",
      ),
      Scene.expect(Scene.role("region", { name: "Health" })).not.toContainText("Sample"),
      Scene.expect(Scene.role("button", { name: "Time range: last 24 hours" })).toBeDisabled(),
    ))

  it("shows no sample notice when the distribution is live", () =>
    render(
      toOverviewPage(now)({
        project: "p",
        overview: unmeasured,
        distribution: distribution("24h"),
      }),
      Scene.expectAll(Scene.all.role("note")).toHaveCount(0),
      Scene.expect(Scene.role("button", { name: "Time range: last 24 hours" })).toBeEnabled(),
    ))
})
