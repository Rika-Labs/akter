import type { ActorInspector } from "@akter/cloud-api"
import { DateTime, Option } from "effect"
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

const receipt: ActorInspector["receipts"][number] = {
  commandId: "cmd_1",
  command: "Increment",
  result: "Success",
  caller: null,
  at: null,
  expiresAt: DateTime.makeUnsafe("2026-10-05T12:00:00.000Z"),
  replayed: false,
}

/** The inspector as the API answers it today: every field the runner does not report is null. */
const unreported: ActorInspector = {
  address: "Counter/hits",
  state: { count: 3 },
  turn: null,
  tables: null,
  receipts: [receipt],
  events: [
    {
      name: "Incremented",
      cursor: "3",
      emittedAt: DateTime.makeUnsafe("2026-10-04T12:00:00.000Z"),
      subscribers: null,
    },
  ],
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

const user = (subject: string) => ({ kind: "user" as const, subject, source: null })

const receipts = Scene.role("table", { name: "Receipts" })

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
        receipts: unreported.receipts.map((receipt) => ({ ...receipt, commandId: full })),
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
      Scene.expect(Scene.role("table", { name: "Events" })).toContainText(
        "3Incremented10-04 12:00—",
      ),
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

  it("names whom each receipt ran as and when the runner stops answering retries from it", () =>
    scene(
      "/actors/Counter/hits?tab=receipts",
      toActorPage({
        ...unreported,
        receipts: [
          { ...receipt, commandId: "cmd_own", caller: user("user:usr_dallen") },
          { ...receipt, commandId: "cmd_other", caller: user("user:usr_lee") },
          { ...receipt, commandId: "cmd_key", caller: user("api-key:key_01J9ZK3QWX") },
          {
            ...receipt,
            commandId: "cmd_timer",
            caller: { kind: "system", subject: null, source: "timer" },
          },
          {
            ...receipt,
            commandId: "cmd_anon",
            caller: { kind: "anonymous", subject: null, source: null },
          },
        ],
      }),
      Scene.expect(receipts).toContainText("cmd_ownIncrementSuccessDallen Pyrah—10-05 12:00"),
      Scene.expect(receipts).toContainText("cmd_otherIncrementSuccessuser:usr_lee—"),
      Scene.expect(receipts).toContainText("cmd_keyIncrementSuccessAPI key …ZK3QWX—"),
      Scene.expect(Scene.title("api-key:key_01J9ZK3QWX")).toHaveText("API key …ZK3QWX"),
      Scene.expect(Scene.title("user:usr_dallen")).toHaveText("Dallen Pyrah"),
      Scene.expect(receipts).toContainText("cmd_timerIncrementSuccessSystem"),
      Scene.expect(receipts).toContainText("cmd_anonIncrementSuccessAnonymous"),
      Scene.expect(receipts).not.toContainText("null"),
    ))

  it("writes an undecodable caller as a dash rather than as null", () =>
    scene(
      "/actors/Counter/hits?tab=receipts",
      toActorPage(unreported),
      Scene.expect(receipts).toContainText("cmd_1IncrementSuccess——10-05 12:00"),
      Scene.expect(receipts).not.toContainText("null"),
      Scene.expect(receipts).not.toContainText("NaN"),
    ))

  it("puts the shortened command id and its caller under each timeline entry", () =>
    scene(
      "/actors/Counter/hits",
      toActorPage({
        ...unreported,
        timeline: [
          {
            at: DateTime.makeUnsafe("2026-10-04T12:00:01.000Z"),
            kind: "command",
            label: "Increment",
            detail: "v1.1791099825418.1791186225418.5979a62a-ca7e-48a3-82b3-fff071bcd715",
            caller: user("user:usr_dallen"),
          },
          {
            at: DateTime.makeUnsafe("2026-10-04T12:00:01.000Z"),
            kind: "event",
            label: "Incremented",
            detail: null,
            caller: null,
          },
        ],
      }),
      Scene.expect(Scene.text("5979a62a · Dallen Pyrah")).toExist(),
      Scene.expect(Scene.text("Activity isn’t reported")).toBeAbsent(),
      Scene.expect(Scene.text("null")).toBeAbsent(),
    ))

  it("says the timeline is empty rather than leaving the activity blank", () =>
    scene(
      "/actors/Counter/hits",
      toActorPage({ ...unreported, timeline: [] }),
      Scene.expect(Scene.text("Nothing has reached this actor’s timeline yet.")).toExist(),
      Scene.expect(Scene.text("Activity isn’t reported")).toBeAbsent(),
    ))

  it("shortens a runner-minted job id and keeps the full id in its title", () => {
    const full = "v1.1791125701166.1791215731166.f6f589c8-c515-4d13-a8b9-f2800b9d18c9"
    return scene(
      "/actors/Counter/hits?tab=jobs",
      toActorPage({
        ...unreported,
        jobs: [{ id: full, name: "Later", attempts: 0, status: "queued" }],
      }),
      Scene.expect(Scene.role("table", { name: "Jobs" })).toContainText("f6f589c8Later0Queued"),
      Scene.expect(Scene.title(full)).toHaveText("f6f589c8"),
    )
  })
})
