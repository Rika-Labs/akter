import { ProjectId } from "@akter/cloud-api"
import { SpendLimitExceeded, StorageQuotaExceeded } from "@rikalabs/akter/client"
import { Option } from "effect"
import * as Scene from "foldkit/scene"
import type { HtmlBuilder } from "foldkit/html"
import * as Url from "foldkit/url"
import { describe, it } from "vitest"
import { consoleError } from "../api/client.ts"
import { workspace } from "../workspace/fixtures.ts"
import { FailedCommand, type Message } from "./message.ts"
import { Dialog, type Model } from "./model.ts"
import { init, update } from "./update.ts"
import { view } from "./view.ts"

const sending = (): Model => {
  const url = Option.getOrThrow(Url.fromString("http://localhost/actors/Order/ord-1"))
  const { model } = init({ workspace, theme: "light" }, url)
  return {
    ...model,
    loading: false,
    sendingCommand: true,
    dialog: Option.some(
      Dialog.SendCommand({
        address: "Order/ord-1",
        scope: { projectId: ProjectId.make("prj_1"), environment: "production" },
      }),
    ),
  }
}

const failed = (cause: unknown): Model => {
  const error = consoleError(cause)
  const model = sending()
  return update(
    model,
    FailedCommand({ session: model.commandSession, kind: error.kind, message: error.message }),
  ).model
}

describe("send command dialog", () => {
  it("explains a quota refusal in place and links to Billing", () =>
    Scene.scene(
      {
        update: (model: Model, message: Message) => update(model, message),
        view: (model: Model, h: HtmlBuilder<Message>) => view(model, h),
      },
      Scene.given(
        failed(
          StorageQuotaExceeded.make({
            organizationId: "org_1",
            deployment: "dep_1",
            tenant: "tenant_1",
            limitBytes: 500_000_000,
            usedBytes: 500_000_000,
          }),
        ),
      ),
      Scene.expect(Scene.role("alert")).toContainText(
        "This tenant stores 0.5 GB of the 0.5 GB its plan allows, so new commands are paused.",
      ),
      Scene.expect(Scene.role("alert")).not.toContainText("couldn’t reach Akter"),
      Scene.expect(Scene.role("link", { name: "Open Billing" })).toHaveAttr(
        "href",
        "/settings/billing",
      ),
    ))

  it("keeps a spend-limit refusal specific to the limit that was hit", () =>
    Scene.scene(
      {
        update: (model: Model, message: Message) => update(model, message),
        view: (model: Model, h: HtmlBuilder<Message>) => view(model, h),
      },
      Scene.given(
        failed(
          SpendLimitExceeded.make({
            organizationId: "org_1",
            period: "2026-10",
            limitCents: 50_000,
            projectedCents: 50_020,
          }),
        ),
      ),
      Scene.expect(Scene.role("alert")).toContainText(
        "past the $500.00 spend limit, so it wasn’t run",
      ),
      Scene.expect(Scene.role("link", { name: "Open Billing" })).toExist(),
    ))

  it("adds no Billing link to an error a plan change cannot fix", () =>
    Scene.scene(
      {
        update: (model: Model, message: Message) => update(model, message),
        view: (model: Model, h: HtmlBuilder<Message>) => view(model, h),
      },
      Scene.given(failed(new Error("socket hang up"))),
      Scene.expect(Scene.role("alert")).toHaveText("We couldn’t reach Akter. Please try again."),
      Scene.expect(Scene.role("link", { name: "Open Billing" })).toBeAbsent(),
    ))
})
