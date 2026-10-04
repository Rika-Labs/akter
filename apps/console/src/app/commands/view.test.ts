import type { CommandLogEntry } from "@akter/cloud-api"
import * as Scene from "foldkit/scene"
import { describe, it } from "vitest"
import { screenRoot, screenScene } from "../shell/testing.ts"
import { toRecentTurns } from "./mapping.ts"
import { CommandsPage } from "./model.ts"
import { commandsScreen } from "./view.ts"

const full = "v1.1791099825418.1791186225418.5979a62a-ca7e-48a3-82b3-fff071bcd715"

/** Two committed commands as the log reads them from receipts: no time, duration or payload. */
const entries: ReadonlyArray<CommandLogEntry> = [
  {
    commandId: full,
    at: null,
    durationMs: null,
    address: "Counter/hits",
    command: "Increment",
    caller: { kind: "user", subject: "user:usr_dallen", source: null },
    payloadPreview: null,
    outcome: "ok",
    errorTag: null,
  },
  {
    commandId: "cmd_2",
    at: null,
    durationMs: null,
    address: "Counter/hits",
    command: "Reset",
    caller: null,
    payloadPreview: null,
    outcome: "error",
    errorTag: "Locked",
  },
]

const recent = toRecentTurns(entries)

describe("command log with unrecorded fields", () => {
  it("writes the unrecorded time and duration as dashes beside the short id and the caller", () =>
    screenScene(
      {
        path: "/commands",
        screen: commandsScreen,
        page: CommandsPage.make({ types: ["Counter"], recent }),
        model: {
          tail: { entries: recent, paused: false, filter: "all", next: recent.length },
          tailStatus: "idle",
        },
      },
      Scene.expect(Scene.role("table", { name: "Committed turns, newest first" })).toContainText(
        "—5979a62a—Counter/hitsIncrementDallen Pyrahok",
      ),
      Scene.expect(Scene.role("table", { name: "Committed turns, newest first" })).toContainText(
        "—cmd_2—Counter/hitsReset—Locked",
      ),
      Scene.expect(Scene.title(full)).toHaveText("5979a62a"),
      Scene.expect(Scene.title("user:usr_dallen")).toHaveText("Dallen Pyrah"),
      Scene.expect(screenRoot).not.toContainText(/null|NaN|undefined/),
    ))
})
