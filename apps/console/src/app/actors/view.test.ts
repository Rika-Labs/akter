import { DateTime } from "effect"
import * as Scene from "foldkit/scene"
import { describe, it } from "vitest"
import { screenRoot, screenScene } from "../shell/testing.ts"
import { typeActivity } from "./fixtures.ts"
import { toActorInstance } from "./mapping.ts"
import { ActorsPage, ActorTypePage, type ActorTypeSummary } from "./model.ts"
import { actorTypeScreen } from "./type/view.ts"
import { actorsScreen } from "./view.ts"

const now = DateTime.makeUnsafe("2026-10-04T12:00:00.000Z")

/** An actor type as the runners' durable views report it: only its name and instance count. */
const counter: ActorTypeSummary = {
  name: "Counter",
  commands: null,
  instances: 3,
  awake: null,
  commandsPerSecond: null,
  p99Ms: null,
  maxMailbox: null,
}

const typePage = (activitySample: boolean) =>
  ActorTypePage.make({
    commandScope: undefined,
    summary: counter,
    instances: [
      toActorInstance(now)({
        key: "hits",
        status: null,
        lastCommand: null,
        lastActivityAt: null,
        generation: 4,
      }),
    ],
    activity: typeActivity("24h")(counter),
    activitySample,
  })

describe("actor types with unmeasured fields", () => {
  it("writes unreported commands, awake actors, rates and latency as dashes", () =>
    screenScene(
      { path: "/actors", screen: actorsScreen, page: ActorsPage.make({ types: [counter] }) },
      Scene.expect(Scene.role("table", { name: "Actor types" })).toContainText("Counter—3———"),
      Scene.expect(screenRoot).toContainText("Awake—"),
      Scene.expect(screenRoot).toContainText("Commands / s—"),
      Scene.expect(screenRoot).not.toContainText(/null|NaN|undefined|%/),
    ))

  it("counts awake actors when every type reports them and keeps a measured zero", () =>
    screenScene(
      {
        path: "/actors",
        screen: actorsScreen,
        page: ActorsPage.make({
          types: [
            { ...counter, awake: 0, commandsPerSecond: 0, p99Ms: 4 },
            { ...counter, name: "Order", awake: 3, commandsPerSecond: 2, p99Ms: 9 },
          ],
        }),
      },
      Scene.expect(screenRoot).toContainText("Awake3"),
      Scene.expect(screenRoot).toContainText("Commands / s2"),
      Scene.expect(Scene.role("table", { name: "Actor types" })).toContainText("Counter—300—"),
    ))
})

describe("actor type with unmeasured fields", () => {
  it("writes an unreported status, last command and turn as dashes, never as asleep", () =>
    screenScene(
      { path: "/actors/Counter", screen: actorTypeScreen, page: typePage(false) },
      Scene.expect(Scene.role("table", { name: "Counter instances" })).toContainText("hits—4——"),
      Scene.expect(Scene.role("table", { name: "Counter instances" })).not.toContainText("Asleep"),
      Scene.expect(Scene.text("Accepts", { exact: false })).toBeAbsent(),
      Scene.expect(screenRoot).not.toContainText(/null|NaN|undefined/),
    ))

  it("marks sample activity once, fixes its window and lends no trend to the live rate", () =>
    screenScene(
      { path: "/actors/Counter", screen: actorTypeScreen, page: typePage(true) },
      Scene.expectAll(Scene.all.role("note")).toHaveCount(1),
      Scene.expect(Scene.role("note")).toHaveText("Sample data — this part isn’t connected yet."),
      Scene.expect(Scene.role("button", { name: "Time range: last 24 hours" })).toBeDisabled(),
      Scene.expect(Scene.role("table", { name: "Counter instances" })).toContainText("hits"),
    ))
})
