import * as Scene from "foldkit/scene"
import { describe, it } from "vitest"
import { screenRoot, screenScene } from "../shell/testing.ts"
import { JobsPage } from "./model.ts"
import { jobsScreen } from "./view.ts"

const page = (resolvable: boolean) =>
  JobsPage.make({
    queued: 0,
    running: null,
    retrying: 1,
    deadLetters: [
      {
        id: "dl_1",
        jobId: "job_1",
        job: "Charge",
        actorType: "Order",
        key: "ord_1",
        attempts: 3,
        error: "declined",
        since: "4m",
      },
    ],
    resolvable,
    types: [{ name: "Charge", done: null, retried: 1, dead: 1, p99: "—" }],
    labels: [],
    throughput: null,
  })

describe("jobs with unmeasured fields", () => {
  it("writes unreported running jobs and totals as dashes and the missing throughput once", () =>
    screenScene(
      { path: "/jobs", screen: jobsScreen, page: page(false) },
      Scene.expect(screenRoot).toContainText("Running—"),
      Scene.expect(Scene.role("table", { name: "Jobs by type" })).toContainText("Charge—11—"),
      Scene.expect(Scene.role("region", { name: "Throughput" })).toHaveText(
        "Throughputjobs doneJob throughput isn’t reported.",
      ),
      Scene.expect(screenRoot).not.toContainText(/null|NaN|undefined/),
    ))

  it("keeps live dead letters read-only with one quiet reason when they can't be resolved", () =>
    screenScene(
      { path: "/jobs", screen: jobsScreen, page: page(false) },
      Scene.expect(Scene.role("button", { name: "Retry job_1" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Discard job_1" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Retry all" })).toBeDisabled(),
      Scene.expect(Scene.text("Retry and discard aren’t available yet.")).toExist(),
      Scene.expect(Scene.role("link", { name: "Order/ord_1" })).toExist(),
      Scene.expectAll(Scene.all.role("note")).toHaveCount(0),
    ))

  it("offers retry and discard without the reason when the source resolves dead letters", () =>
    screenScene(
      { path: "/jobs", screen: jobsScreen, page: page(true) },
      Scene.expect(Scene.role("button", { name: "Retry job_1" })).toBeEnabled(),
      Scene.expect(Scene.text("Retry and discard aren’t available yet.")).toBeAbsent(),
    ))
})
