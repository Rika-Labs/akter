import { KnownPlan, type OrganizationPlan, UnboundPlan, UnknownPlan } from "@akter/cloud-api"
import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import * as Scene from "foldkit/scene"
import * as Url from "foldkit/url"
import { describe, it } from "vitest"
import { InvitationPage } from "../auth/model.ts"
import { plansSlice } from "../settings/fixtures.ts"
import { emptySettings } from "../settings/model.ts"
import { workspace } from "../workspace/fixtures.ts"
import type { Message } from "./message.ts"
import type { Model } from "./model.ts"
import { init, update } from "./update.ts"
import { view } from "./view.ts"

const plans = plansSlice.plans ?? null

/** The catalog the settings page holds, with Team renamed so a title-cased id would show. */
const renamed =
  plans === null
    ? null
    : {
        ...plans,
        plans: plans.plans.map((offer) =>
          offer.id === "team" ? { ...offer, name: "Studio" } : offer,
        ),
      }

const at = (path: string, plan: OrganizationPlan | null, page: Model["page"]): Model => ({
  ...init(
    { workspace: { ...workspace, plan }, theme: "light" },
    Option.getOrThrow(Url.fromString(`http://localhost${path}`)),
  ).model,
  loading: false,
  page,
})

const shell = (model: Model, ...steps: ReadonlyArray<Scene.SceneStep<Model, Message, undefined>>) =>
  Scene.scene(
    {
      update: (current: Model, message: Message) => update(current, message),
      view: (current: Model, h: HtmlBuilder<Message>) => view(current, h),
    },
    Scene.given(model),
    ...steps,
  )

const account = Scene.role("button", { name: "Account: Dallen Pyrah" })
const switcher = Scene.selector("#project-menu")

describe("organization plan in the sidebar and the switcher", () => {
  it("names a known plan by its id until the catalog is loaded, then by its catalog name", () => {
    shell(
      at("/", KnownPlan.make({ id: "team" }), Option.none()),
      Scene.expect(account).toContainText("Acme · Team"),
      Scene.expect(switcher).toContainText("Acme · Team"),
    )
    shell(
      at(
        "/settings/billing",
        KnownPlan.make({ id: "team" }),
        Option.some({ ...emptySettings, plans: renamed }),
      ),
      Scene.expect(account).toContainText("Acme · Studio"),
    )
  })

  it("says an organization without a billing account has no billing, never Free", () => {
    shell(
      at("/", UnboundPlan.make({}), Option.none()),
      Scene.expect(account).toContainText("Acme · no billing"),
      Scene.expect(switcher).toContainText("Acme · no billing"),
      Scene.expect(switcher).not.toContainText("Free"),
    )
    shell(
      at("/settings/billing", UnboundPlan.make({}), Option.some({ ...emptySettings, plans })),
      Scene.expect(account).toContainText("Acme · no billing"),
      Scene.expect(account).not.toContainText("Free"),
    )
  })

  it("says a stored plan the pricing doesn't define isn't recognised, not its stored id", () =>
    shell(
      at("/", UnknownPlan.make({ id: "legacy" }), Option.none()),
      Scene.expect(account).toContainText("Acme · plan not recognised"),
      Scene.expect(switcher).toContainText("Acme · plan not recognised"),
      Scene.expect(account).not.toContainText("Legacy"),
      Scene.expect(account).not.toContainText("legacy"),
    ))

  it("names only the organization while there is no membership to have a plan", () =>
    shell(
      at("/", null, Option.none()),
      Scene.expect(account).toContainText("Acme"),
      Scene.expect(account).not.toContainText("·"),
    ))
})

describe("organization plan in an invitation", () => {
  const invitation = (plan: OrganizationPlan, catalog: InvitationPage["catalog"]) =>
    at(
      "/invitations/inv_1",
      null,
      Option.some(
        InvitationPage.make({
          id: "inv_1",
          organization: "Globex",
          members: 4,
          plan,
          catalog,
          inviter: "Ada",
          email: "lee@globex.dev",
          role: "Member",
        }),
      ),
    )

  it("names each plan state the way the sidebar does", () => {
    shell(
      invitation(KnownPlan.make({ id: "team" }), []),
      Scene.expect(Scene.text("4 members · Team")).toExist(),
    )
    shell(
      invitation(KnownPlan.make({ id: "team" }), [{ id: "team", name: "Studio" }]),
      Scene.expect(Scene.text("4 members · Studio")).toExist(),
    )
    shell(
      invitation(UnboundPlan.make({}), [{ id: "free", name: "Free" }]),
      Scene.expect(Scene.text("4 members · no billing")).toExist(),
    )
    shell(
      invitation(UnknownPlan.make({ id: "legacy" }), []),
      Scene.expect(Scene.text("4 members · plan not recognised")).toExist(),
    )
  })
})
