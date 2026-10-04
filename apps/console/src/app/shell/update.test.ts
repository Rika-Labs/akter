import { CommandExpired, Conflict, ProjectId, RunnerDefect, Unavailable } from "@akter/cloud-api"
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
  ConfirmedDialog,
  FailedCommand,
  FailedDeploymentChange,
  type Message,
  OpenedDialog,
  PreparedCommandId,
  SubmittedForm,
} from "./message.ts"
import { Dialog, type Model } from "./model.ts"
import { init, resendRefused, update } from "./update.ts"

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

  it("gives a changed command or payload a fresh key, even after a replayed success", () => {
    const first = sendMinted(dialogOpen(), "minted-1")
    const answered = step(
      first.model,
      AnsweredCommand({
        session: first.model.commandSession,
        answer: CommandSucceeded.make({
          commandId: "minted-1",
          result: { balance: 1 },
          replayed: false,
        }),
      }),
    ).model
    expect(sentIds(step(answered, ConfirmedDialog()))).toEqual(["minted-1"])
    const edited = step(
      answered,
      ChangedField({ name: "command-payload", value: '{"amount":2}' }),
    ).model
    expect(edited.fields["command-id"]).toBe("")
    const second = sendMinted(edited, "minted-2")
    expect(sentIds(second)).toEqual(["minted-2"])
    const renamed = step(second.model, ChangedField({ name: "command-name", value: "Charge" }))
    expect(renamed.model.fields["command-id"]).toBe("")
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
      expect(step(failed, ConfirmedDialog()).commands ?? []).toEqual([])
      const cleared = step(failed, ChangedField({ name: "command-id", value: "" })).model
      expect(resendRefused(cleared)).toBe(false)
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

    const moved = step(started, ChangedUrl({ url: at("/actors") })).model
    expect(moved.changingDeployment).toEqual(Option.some("dep_live"))
    const elsewhere = step(moved, landed)
    expect(named(elsewhere, "PushUrl")).toHaveLength(0)
    expect(elsewhere.model.toasts.at(-1)?.title).toBe("Rollback to bbbbbbb: Previous release")
    expect(elsewhere.model.changingDeployment).toEqual(Option.none())
  })
})
