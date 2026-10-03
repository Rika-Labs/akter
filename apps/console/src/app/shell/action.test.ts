import { Option } from "effect"
import { expect, it } from "vitest"
import { CommandsPage } from "../commands/model.ts"
import { emptySettings } from "../settings/model.ts"
import { Action, canMutate } from "./action.ts"

it("blocks sample actions at dispatch while preserving live actions on mixed-source settings pages", () => {
  const page = Option.some({ ...emptySettings, sampleSections: ["endpoints"] as const })
  expect(
    canMutate({
      page,
      sample: true,
      loading: false,
      action: Action.CreateKey({ name: "ci", permission: "read", projectScoped: true }),
    }),
  ).toBe(true)
  expect(
    canMutate({
      page: Option.some({ ...emptySettings, sampleSections: ["keys"] as const }),
      sample: true,
      loading: false,
      action: Action.RevokeKey({ id: "sample-key", name: "ci" }),
    }),
  ).toBe(false)
  expect(
    canMutate({
      page: Option.some(CommandsPage.make({ types: [], recent: [] })),
      sample: true,
      loading: false,
      action: Action.RetryDeadLetters({ ids: ["sample-id"] }),
    }),
  ).toBe(false)
  expect(
    canMutate({
      page,
      sample: false,
      loading: true,
      action: Action.DeleteProject({ slug: "project" }),
    }),
  ).toBe(false)
})
