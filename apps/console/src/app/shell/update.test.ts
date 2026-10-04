import { order } from "../actors/fixtures.ts"
import {
  CommandExpired,
  Conflict,
  ProjectId,
  QuotaUnbound,
  RunnerDefect,
  Unavailable,
} from "@akter/cloud-api"
import { Option } from "effect"
import type { Return } from "foldkit/update"
import * as Url from "foldkit/url"
import { describe, expect, it } from "vitest"
import { sendFailure } from "../commands/errors.ts"
import { CommandSucceeded } from "../commands/model.ts"
import { DeploymentPage } from "../deployments/model.ts"
import { emptySettings, type Billing } from "../settings/model.ts"
import { workspace } from "../workspace/fixtures.ts"
import {
  AnsweredCommand,
  ChangedDeployment,
  ChangedField,
  ChangedUrl,
  ChoseSetting,
  ClosedDialog,
  ConfirmedDialog,
  FailedCommand,
  FailedDeploymentChange,
  type Message,
  OpenedDialog,
  PreparedCommandId,
  SignedOut,
  SubmittedForm,
} from "./message.ts"
import { Dialog, type Model } from "./model.ts"
import { init, nextCommandId, resendRefused, update } from "./update.ts"

const billing: Billing = {
  plan: {
    id: "pro",
    name: "Pro",
    subscribed: "pro",
    paymentStatus: "active",
    basePriceCents: 2_500,
    provisional: true,
    renewsAt: null,
    monthToDateCents: 30_000,
  },
  card: null,
  billingEmail: null,
  spendLimit: { limitCents: null, currentCents: 30_000 },
  caps: [],
}

const onBilling = (): Model => {
  const url = Option.getOrThrow(Url.fromString("http://localhost/settings/billing"))
  return {
    ...init({ workspace, theme: "light" }, url).model,
    loading: false,
    page: Option.some({ ...emptySettings, billing }),
  }
}

/** The names of the Commands an update asks for. */
interface Requested {
  readonly commands?: ReadonlyArray<Readonly<{ name: string }>>
}

const commandNames = (result: Requested) => (result.commands ?? []).map((command) => command.name)

describe("spend limit", () => {
  it("holds a limit the estimate has already reached until it is saved explicitly", () => {
    const chosen = update(onBilling(), ChoseSetting({ key: "spendLimit", value: "30000" }))
    expect(chosen.model.choices["spendLimit"]).toBe("30000")
    expect(commandNames(chosen)).toEqual([])
    expect(commandNames(update(chosen.model, SubmittedForm({ form: "spend-limit" })))).toEqual([
      "Mutate",
    ])
  })

  it("saves a limit above the estimate straight away", () => {
    expect(
      commandNames(update(onBilling(), ChoseSetting({ key: "spendLimit", value: "30001" }))),
    ).toEqual(["Mutate"])
  })
})

type Stepped = Return<Model, Message>

const named = (result: Stepped, name: string) =>
  (result.commands ?? []).filter((command) => command.name === name)

const sentIds = (result: Stepped) =>
  named(result, "SendActorCommand").map((command) => command.args?.["commandId"])

const at = (path: string) => Option.getOrThrow(Url.fromString(`http://localhost${path}`))

const scope = { projectId: ProjectId.make("prj_1"), environment: "production" as const }

const dialogOpen = (): Model => ({
  ...init({ workspace, theme: "light" }, at("/actors/Order/ord-1")).model,
  loading: false,
  dialog: Option.some(Dialog.SendCommand({ address: "Order/ord-1", scope })),
  fields: { "command-name": "Refund", "command-payload": '{"amount":1}', "command-id": "" },
})

const step = (model: Model, message: Message) => update(model, message)

/** Confirms the dialog with a blank command ID and lets the console mint `minted` for it. */
const sendMinted = (model: Model, minted: string) => {
  const asked = step(model, ConfirmedDialog())
  expect(named(asked, "NewCommandId")).toHaveLength(1)
  return step(asked.model, PreparedCommandId({ session: model.commandSession, id: minted }))
}

const failWith = (model: Model, cause: unknown) => {
  const error = sendFailure({ address: "Order/ord-1", command: "Refund" })(cause)
  return step(
    model,
    FailedCommand({ session: model.commandSession, kind: error.kind, message: error.message }),
  ).model
}

describe("send command keys", () => {
  it("mints one key per submission and reuses it when the same submission is retried", () => {
    const first = sendMinted(dialogOpen(), "minted-1")
    expect(sentIds(first)).toEqual(["minted-1"])
    const lost = failWith(first.model, new TypeError("Failed to fetch"))
    const retried = step(lost, ConfirmedDialog())
    expect(named(retried, "NewCommandId")).toHaveLength(0)
    expect(sentIds(retried)).toEqual(["minted-1"])
    const unavailable = failWith(
      retried.model,
      Unavailable.make({
        message: "The deployment is temporarily unavailable",
        retryAfterSeconds: 1,
      }),
    )
    expect(resendRefused(unavailable)).toBe(false)
    expect(sentIds(step(unavailable, ConfirmedDialog()))).toEqual(["minted-1"])
  })

  const answered = (model: Model, id: string) =>
    step(
      model,
      AnsweredCommand({
        session: model.commandSession,
        answer: CommandSucceeded.make({ commandId: id, result: { balance: 1 }, replayed: false }),
      }),
    ).model

  const edit = (model: Model, name: string, value: string) =>
    step(model, ChangedField({ name, value })).model

  it("gives a changed command or payload a fresh key when it is sent, not when it is typed", () => {
    const sent = answered(sendMinted(dialogOpen(), "minted-1").model, "minted-1")
    expect(sentIds(step(sent, ConfirmedDialog()))).toEqual(["minted-1"])
    const edited = edit(sent, "command-payload", '{"amount":2}')
    expect(edited.fields["command-id"]).toBe("minted-1")
    expect(nextCommandId(edited)).toEqual(Option.none())
    const second = sendMinted(edited, "minted-2")
    expect(sentIds(second)).toEqual(["minted-2"])
    const renamed = edit(answered(second.model, "minted-2"), "command-name", "Charge")
    expect(sentIds(sendMinted(renamed, "minted-3"))).toEqual(["minted-3"])
  })

  it("reuses the key for a payload that was only reformatted or had its keys reordered", () => {
    const lost = failWith(
      sendMinted(
        {
          ...dialogOpen(),
          fields: { ...dialogOpen().fields, "command-payload": '{"a":1,"b":[2]}' },
        },
        "minted-1",
      ).model,
      new TypeError("Failed to fetch"),
    )
    const reformatted = edit(lost, "command-payload", '{\n  "b": [ 2 ],\n  "a": 1.0\n}')
    expect(sentIds(step(reformatted, ConfirmedDialog()))).toEqual(["minted-1"])
  })

  it("reuses the key for a payload that was changed and then changed back", () => {
    const lost = failWith(sendMinted(dialogOpen(), "minted-1").model, new TypeError("Failed"))
    const reverted = edit(
      edit(lost, "command-payload", '{"amount":99}'),
      "command-payload",
      '{ "amount": 1 }',
    )
    expect(sentIds(step(reverted, ConfirmedDialog()))).toEqual(["minted-1"])
    const renamedBack = edit(edit(lost, "command-name", "Charge"), "command-name", "Refund")
    expect(sentIds(step(renamedBack, ConfirmedDialog()))).toEqual(["minted-1"])
  })

  it("keeps a key the operator typed, so an edited payload reuses it deliberately", () => {
    const typed = { ...dialogOpen(), fields: { ...dialogOpen().fields, "command-id": "mine-1" } }
    const sent = step(typed, ConfirmedDialog())
    expect(sentIds(sent)).toEqual(["mine-1"])
    const edited = step(sent.model, ChangedField({ name: "command-payload", value: "2" })).model
    expect(edited.fields["command-id"]).toBe("mine-1")
  })

  it("never resends a submission after a runner defect, an expired key or a conflict", () => {
    for (const cause of [
      RunnerDefect.make({}),
      CommandExpired.make({ commandId: "minted-1" }),
      Conflict.make({ message: "The idempotency key was already used for another payload" }),
    ]) {
      const failed = failWith(sendMinted(dialogOpen(), "minted-1").model, cause)
      expect(resendRefused(failed)).toBe(true)
      expect(resendRefused(edit(failed, "command-payload", '{ "amount" : 1 }'))).toBe(true)
      expect(step(failed, ConfirmedDialog()).commands ?? []).toEqual([])
      const cleared = step(failed, ChangedField({ name: "command-id", value: "" })).model
      expect(resendRefused(cleared)).toBe(false)
      expect(named(step(cleared, ConfirmedDialog()), "NewCommandId")).toHaveLength(1)
    }
  })

  it("never resends a command the edge couldn't bill, for any of its reasons", () => {
    for (const reason of ["tenant", "account", "plan"] as const) {
      const failed = failWith(
        sendMinted(dialogOpen(), "minted-1").model,
        QuotaUnbound.make({ deployment: "dep_1", tenant: "acme", reason }),
      )
      expect(Option.map(failed.commandError, ({ kind }) => kind)).toEqual(
        Option.some("QuotaUnbound"),
      )
      expect(resendRefused(failed)).toBe(true)
      expect(step(failed, ConfirmedDialog()).commands ?? []).toEqual([])
      const cleared = step(failed, ChangedField({ name: "command-id", value: "" })).model
      expect(named(step(cleared, ConfirmedDialog()), "NewCommandId")).toHaveLength(1)
    }
  })

  it("starts every opened dialog without a key, so its first send mints one", () => {
    const reopened = step(
      { ...dialogOpen(), fields: { "command-id": "stale" } },
      OpenedDialog({ dialog: Dialog.SendCommand({ address: "Order/ord-2", scope }) }),
    )
    expect(reopened.model.fields["command-id"]).toBe("")
    expect(named(reopened, "NewCommandId")).toHaveLength(0)
  })
})

describe("inspector after a command", () => {
  const answered = (model: Model) =>
    step(
      sendMinted(model, "cmd_1").model,
      AnsweredCommand({
        session: model.commandSession,
        answer: CommandSucceeded.make({
          commandId: "cmd_1",
          result: { count: 6 },
          replayed: false,
        }),
      }),
    ).model

  it("reloads a live inspector when the dialog closes on a committed command", () => {
    const live = answered({ ...dialogOpen(), page: Option.some(order), pageSample: false })
    expect(named(step(live, ClosedDialog()), "LoadPage")).toHaveLength(1)
  })

  it("leaves a sample inspector and an unanswered dialog alone", () => {
    const sample = {
      ...answered({ ...dialogOpen(), page: Option.some(order), pageSample: false }),
      pageSample: true,
    }
    expect(named(step(sample, ClosedDialog()), "LoadPage")).toHaveLength(0)
    const unanswered = { ...dialogOpen(), page: Option.some(order), pageSample: false }
    expect(named(step(unanswered, ClosedDialog()), "LoadPage")).toHaveLength(0)
  })
})

const deploymentPage = DeploymentPage.make({
  deploy: {
    id: "dep_live",
    commit: "aaaaaaa",
    message: "Current release",
    author: "dallen",
    regions: ["us-east-1"],
    runners: 2,
    took: "40 s",
    status: "Live",
    when: "1h",
  },
  phases: [],
  runners: [],
  log: "",
  rollbackTargets: [],
  rolledBackFrom: null,
})

const onDeployment = (dialog: Dialog): Model => ({
  ...init({ workspace, theme: "light" }, at("/deployments/dep_live")).model,
  loading: false,
  page: Option.some(deploymentPage),
  dialog: Option.some(dialog),
})

const landed = ChangedDeployment({
  href: "/deployments/dep_new",
  title: "Rollback to bbbbbbb: Previous release",
  description: "Rolling out now.",
})

describe("rollback and redeploy", () => {
  it("sends one change however often it is confirmed while in flight", () => {
    const first = step(
      onDeployment(Dialog.RollBack({ id: "dep_old", commit: "bbbbbbb" })),
      ConfirmedDialog(),
    )
    expect(named(first, "Mutate")).toHaveLength(1)
    const again = step(
      {
        ...first.model,
        dialog: Option.some(Dialog.Redeploy({ id: "dep_live", commit: "aaaaaaa" })),
      },
      ConfirmedDialog(),
    )
    expect(named(again, "Mutate")).toHaveLength(0)
    const released = step(again.model, FailedDeploymentChange({ message: "Refused" })).model
    expect(released.changingDeployment).toEqual(Option.none())
    const retried = step(
      { ...released, dialog: Option.some(Dialog.RollBack({ id: "dep_old", commit: "bbbbbbb" })) },
      ConfirmedDialog(),
    )
    expect(named(retried, "Mutate")).toHaveLength(1)
  })

  it("opens the new deployment only while its page is still open, and shows its title as given", () => {
    const started = step(
      onDeployment(Dialog.RollBack({ id: "dep_old", commit: "bbbbbbb" })),
      ConfirmedDialog(),
    ).model
    const stayed = step(started, landed)
    expect(named(stayed, "PushUrl").map((command) => command.args?.["href"])).toEqual([
      "/deployments/dep_new",
    ])
    expect(stayed.model.toasts.at(-1)?.title).toBe("Rollback to bbbbbbb: Previous release")
    expect(stayed.model.changingDeployment).toEqual(Option.none())

    const listed = step(step(started, ChangedUrl({ url: at("/deployments") })).model, landed)
    expect(named(listed, "PushUrl")).toHaveLength(0)
    expect(named(listed, "LoadPage").map((command) => command.args?.["route"])).toEqual([
      listed.model.route,
    ])
    expect(
      named(step(step(started, ChangedUrl({ url: at("/") })).model, landed), "LoadPage"),
    ).toHaveLength(1)

    const moved = step(started, ChangedUrl({ url: at("/actors") })).model
    expect(moved.changingDeployment).toEqual(Option.some("dep_live"))
    const elsewhere = step(moved, landed)
    expect(named(elsewhere, "PushUrl")).toHaveLength(0)
    expect(named(elsewhere, "LoadPage")).toHaveLength(0)
    expect(elsewhere.model.toasts.at(-1)?.title).toBe("Rollback to bbbbbbb: Previous release")
    expect(elsewhere.model.changingDeployment).toEqual(Option.none())
  })

  it("releases a change that never answers when the session ends or the project changes", () => {
    const started = step(
      onDeployment(Dialog.RollBack({ id: "dep_old", commit: "bbbbbbb" })),
      ConfirmedDialog(),
    ).model
    expect(started.changingDeployment).toEqual(Option.some("dep_live"))
    expect(step(started, SignedOut()).model.changingDeployment).toEqual(Option.none())
    const switched = step(started, ChangedUrl({ url: at("/projects/another-project") })).model
    expect(switched.changingDeployment).toEqual(Option.none())
  })
})
