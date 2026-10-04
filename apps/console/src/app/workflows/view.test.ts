import * as Scene from "foldkit/scene"
import { describe, it } from "vitest"
import { screenRoot, screenScene } from "../shell/testing.ts"
import { WorkflowsPage } from "./model.ts"
import { workflowsScreen } from "./view.ts"

const page = (schedulesSample: boolean) =>
  WorkflowsPage.make({
    running: 0,
    waitingOnEvents: 0,
    truncated: false,
    timers: 1,
    nextTimer: "4 m",
    nextSchedule: null,
    runs: [
      {
        id: "wf_1",
        workflow: "Fulfil",
        actorType: "Order",
        key: "ord_1",
        step: "—",
        waitingFor: "—",
        started: "2h",
        status: "Done",
      },
    ],
    schedules: [
      { name: "nightly", target: "Report/*", cron: "0 2 * * *", lastRun: "—", nextRun: "in 9 h" },
    ],
    schedulesSample,
  })

describe("workflows with sample schedules", () => {
  it("marks only the schedules sample and counts none of them in the live numbers", () =>
    screenScene(
      { path: "/workflows", screen: workflowsScreen, page: page(true) },
      Scene.expectAll(Scene.all.role("note")).toHaveCount(1),
      Scene.expect(Scene.role("region", { name: "Schedules" })).toContainText(
        "Sample data — this part isn’t connected yet.",
      ),
      Scene.expect(screenRoot).toContainText("Schedules—"),
      Scene.expect(screenRoot).not.toContainText("none scheduled"),
      Scene.expect(Scene.role("table", { name: "Workflows" })).toContainText(
        "FulfilOrder/ord_1——2hDone",
      ),
      Scene.expect(screenRoot).not.toContainText(/null|NaN|undefined/),
    ))

  it("shows live schedules without a notice", () =>
    screenScene(
      { path: "/workflows", screen: workflowsScreen, page: page(false) },
      Scene.expectAll(Scene.all.role("note")).toHaveCount(0),
      Scene.expect(screenRoot).toContainText("Schedules1none scheduled"),
    ))
})
