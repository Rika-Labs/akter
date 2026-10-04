import type { ActorInspector } from "@akter/cloud-api"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Scene from "foldkit/scene"
import * as Url from "foldkit/url"
import { describe, it } from "vitest"
import type { Message } from "../../shell/message.ts"
import type { Model } from "../../shell/model.ts"
import { init } from "../../shell/update.ts"
import { workspace } from "../../workspace/fixtures.ts"
import { toActorPage } from "../mapping.ts"
import type { ActorPage } from "../model.ts"
import { actorScreen } from "./view.ts"

/** The inspector as the API answers it today: every field the runner does not report is null. */
const unreported: ActorInspector = {
  address: "Counter/hits",
  state: { count: 3 },
  turn: null,
  tables: null,
  receipts: [
    { commandId: "cmd_1", command: "Increment", result: "Success", at: null, replayed: false },
  ],
  events: [{ name: "Incremented", cursor: "3", subscribers: null }],
  jobs: [],
  connections: { sockets: null, feedCursor: "3" },
  properties: {
    status: null,
    type: "Counter",
    generation: 1,
    runner: null,
    region: null,
    tenant: "org_live",
    mailboxDepth: null,
  },
  timeline: null,
}

const shell = (path: string): Model => {
  const url = Option.getOrThrow(Url.fromString(`http://localhost${path}`))
  return { ...init({ workspace, theme: "light" }, url).model, loading: false, pageSample: false }
}

const scene = (
  path: string,
  page: ActorPage,
  ...steps: ReadonlyArray<Scene.SceneStep<Model, Message, undefined>>
) =>
  Scene.scene(
    {
      update: (model: Model) => ({ model }),
      view: (model: Model, h: HtmlBuilder<Message>): Html => actorScreen({ h, model, page }).body,
    },
    Scene.given(shell(path)),
    ...steps,
  )

const properties = Scene.role("complementary", { name: "Properties" })

describe("actor inspector", () => {
  it("reads every count the runner does not report as a dash, never as zero", () =>
    scene(
      "/actors/Counter/hits",
      toActorPage(unreported),
      Scene.expect(properties).toHaveText(
        "Status—TypeCounterGeneration1Turn—Runner—Region—Tenantorg_liveMailbox—Sockets—",
      ),
      Scene.expect(Scene.text("Committed state")).toExist(),
      Scene.expect(Scene.text("Activity isn’t reported")).toExist(),
    ))

  it("keeps measured zeroes as zero beside the unreported dashes", () =>
    scene(
      "/actors/Counter/hits",
      { ...toActorPage(unreported), turn: 0, mailbox: 0 },
      Scene.expect(properties).toHaveText(
        "Status—TypeCounterGeneration1Turn0Runner—Region—Tenantorg_liveMailbox0Sockets—",
      ),
    ))

  it("says owned rows aren't reported instead of claiming the actor has none", () =>
    scene(
      "/actors/Counter/hits?tab=rows",
      toActorPage(unreported),
      Scene.expect(Scene.text("Owned rows aren’t reported")).toExist(),
      Scene.expect(Scene.text("No owned tables")).toBeAbsent(),
    ))

  it("shows a receipt's unrecorded time as a dash and its outcome as the runner names it", () =>
    scene(
      "/actors/Counter/hits?tab=receipts",
      toActorPage(unreported),
      Scene.expect(Scene.role("table", { name: "Receipts" })).toContainText(
        "cmd_1IncrementSuccess—",
      ),
    ))

  it("shortens a runner-minted receipt id and keeps the full id in its title", () => {
    const full = "v1.1791099825418.1791186225418.5979a62a-ca7e-48a3-82b3-fff071bcd715"
    return scene(
      "/actors/Counter/hits?tab=receipts",
      toActorPage({
        ...unreported,
        receipts: [{ ...unreported.receipts[0]!, commandId: full }],
      }),
      Scene.expect(Scene.role("table", { name: "Receipts" })).toContainText(
        "5979a62aIncrementSuccess—",
      ),
      Scene.expect(Scene.title(full)).toHaveText("5979a62a"),
    )
  })

  it("shows an event's unreported subscribers as a dash", () =>
    scene(
      "/actors/Counter/hits?tab=events",
      toActorPage(unreported),
      Scene.expect(Scene.role("table", { name: "Events" })).toContainText("3Incremented—"),
    ))

  it("reads unreported sockets as a dash beside the event feed cursor", () =>
    scene(
      "/actors/Counter/hits?tab=connections",
      toActorPage(unreported),
      Scene.expect(Scene.selector('[data-panel="connections"]')).toHaveText(
        "Sockets—Event feed cursor3",
      ),
    ))

  it("says an empty job list is empty", () =>
    scene(
      "/actors/Counter/hits?tab=jobs",
      toActorPage(unreported),
      Scene.expect(Scene.text("No pending or dead jobs")).toExist(),
    ))

  it("says an undecodable state is unreadable instead of showing it as null", () =>
    scene(
      "/actors/Counter/hits",
      toActorPage({ ...unreported, state: null }),
      Scene.expect(Scene.text("Committed state isn’t readable")).toExist(),
      Scene.expect(Scene.text("null")).toBeAbsent(),
    ))
})
