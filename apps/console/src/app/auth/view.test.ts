import { Option } from "effect"
import * as Scene from "foldkit/scene"
import { afterEach, describe, it, vi } from "vitest"
import {
  DeviceDecided,
  DeviceEntry,
  DevicePage,
  type DeviceProblem,
  DeviceRefused,
  DeviceReview,
} from "../device/model.ts"
import type { Message } from "../shell/message.ts"
import type { Model } from "../shell/model.ts"
import { screenRoot, screenScene } from "../shell/testing.ts"
import { authScreen } from "./view.ts"

const entry = DevicePage.make({ step: DeviceEntry.make({}) })

const reviewed = DevicePage.make({
  step: DeviceReview.make({
    code: "WDJBMJHT",
    client: "Akter CLI",
    clientDetail: "The Akter command line on your computer",
    name: "Ada Lovelace",
    email: "ada@acme.dev",
    access: "All your organizations (3)",
  }),
})

const refusedFor = (problem: DeviceProblem) =>
  DevicePage.make({ step: DeviceRefused.make({ code: "WDJBMJHT", problem }) })

const shown = (
  path: string,
  page: DevicePage,
  ...steps: ReadonlyArray<Scene.SceneStep<Model, Message, undefined>>
) =>
  screenScene(
    { path, screen: authScreen, page: undefined, model: { page: Option.some(page) } },
    ...steps,
  )

describe("device page before a lookup", () => {
  it("fills the field from the link's code and offers no Approve until the code is looked up", () =>
    shown(
      "/device?user_code=WDJBMJHT",
      entry,
      Scene.expect(Scene.label("Code")).toHaveValue("WDJBMJHT"),
      Scene.expect(Scene.role("button", { name: "Continue" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Approve" })).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Deny" })).toBeAbsent(),
    ))
})

describe("device page after a lookup", () => {
  it("shows the looked-up code large, the client, the account and its whole access, then Approve and Deny", () =>
    shown(
      "/device?user_code=KPLQ7RST",
      reviewed,
      Scene.expect(Scene.role("heading", { name: "Authorize Akter CLI" })).toExist(),
      Scene.expect(Scene.text("The Akter command line on your computer")).toExist(),
      Scene.expect(Scene.text("Check this code matches the one in your terminal.")).toExist(),
      Scene.expect(Scene.selector("#device-user-code")).toHaveText("WDJB-MJHT"),
      Scene.expect(screenRoot).not.toContainText("KPLQ"),
      Scene.expect(Scene.text("Ada Lovelace")).toExist(),
      Scene.expect(Scene.text("ada@acme.dev")).toExist(),
      Scene.expect(Scene.text("All your organizations (3)")).toExist(),
      Scene.expect(Scene.text("Access")).toExist(),
      Scene.expect(Scene.text("Organization")).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Approve" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Deny" })).toExist(),
    ))

  it("tells the person to return to their terminal after approving", () =>
    shown(
      "/device",
      DevicePage.make({ step: DeviceDecided.make({ code: "WDJBMJHT", decision: "approved" }) }),
      Scene.expect(Scene.role("heading", { name: "You can return to your terminal" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Approve" })).toBeAbsent(),
    ))

  it("says the request was denied after denying", () =>
    shown(
      "/device",
      DevicePage.make({ step: DeviceDecided.make({ code: "WDJBMJHT", decision: "denied" }) }),
      Scene.expect(Scene.role("heading", { name: "Request denied" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Approve" })).toBeAbsent(),
    ))
})

describe("device page refusals", () => {
  const states: ReadonlyArray<readonly [DeviceProblem, string, string]> = [
    ["invalid", "This code isn’t valid", "Enter another code"],
    ["expired", "This code has expired", "Enter another code"],
    ["elsewhere", "This code belongs to another account", "Enter another code"],
    ["slowDown", "Too many attempts", "Try again"],
    ["unreachable", "We couldn’t reach Akter", "Try again"],
  ]

  it.each(states)(
    "shows %s as its own state with no Approve and no raw error",
    (problem, title, next) =>
      shown(
        "/device?user_code=WDJBMJHT",
        refusedFor(problem),
        Scene.expect(Scene.role("heading", { name: title })).toExist(),
        Scene.expect(Scene.role("button", { name: next })).toExist(),
        Scene.expect(Scene.role("button", { name: "Approve" })).toBeAbsent(),
        Scene.expect(Scene.role("button", { name: "Deny" })).toBeAbsent(),
        Scene.expect(screenRoot).not.toContainText(
          /WDJB|_|invalid_request|expired_token|undefined/,
        ),
      ),
  )
})

describe("social sign-in providers", () => {
  afterEach(() => vi.unstubAllEnvs())

  const provider = (provider: string) => Scene.role("button", { name: `Continue with ${provider}` })

  const shownAt = (
    path: string,
    ...steps: ReadonlyArray<Scene.SceneStep<Model, Message, undefined>>
  ) => screenScene({ path, screen: authScreen, page: undefined }, ...steps)

  it.each(["/sign-in", "/sign-up"])(
    "offers no provider on %s when the deployment names none, so no button can lead to a 404",
    (path) =>
      shownAt(
        path,
        Scene.expect(provider("GitHub")).toBeAbsent(),
        Scene.expect(provider("Google")).toBeAbsent(),
        Scene.expect(Scene.text("or")).toBeAbsent(),
        Scene.expect(Scene.role("button", { name: /^(Continue|Create account)$/ })).toExist(),
      ),
  )

  it("offers only the providers the deployment names", () => {
    vi.stubEnv("VITE_AUTH_PROVIDERS", "github")
    return shownAt(
      "/sign-in",
      Scene.expect(provider("GitHub")).toExist(),
      Scene.expect(provider("Google")).toBeAbsent(),
      Scene.expect(Scene.text("or")).toExist(),
    )
  })

  it("offers both, ignoring spaces and names it does not know", () => {
    vi.stubEnv("VITE_AUTH_PROVIDERS", "google, gitlab ,github")
    return shownAt(
      "/sign-up",
      Scene.expect(provider("GitHub")).toExist(),
      Scene.expect(provider("Google")).toExist(),
    )
  })
})
