import { ProjectId } from "@akter/cloud-api"
import { Option } from "effect"
import { expect, it } from "vitest"
import { CommandsPage } from "../commands/model.ts"
import { JobsPage } from "../jobs/model.ts"
import { emptySettings } from "../settings/model.ts"
import { sampleActor } from "../actors/fixtures.ts"
import { Action, canMutate, canSendCommand } from "./action.ts"

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

it("sends commands from a sample page only when an inspector holds a real command scope", () => {
  const actor = sampleActor({ actorType: "Counter", key: "hits" })
  const scope = { projectId: ProjectId.make("prj_1"), environment: "production" } as const
  expect(
    canSendCommand({ page: Option.some({ ...actor, commandScope: scope }), sample: true }),
  ).toBe(true)
  expect(canSendCommand({ page: Option.some(actor), sample: true })).toBe(false)
  expect(
    canSendCommand({
      page: Option.some(CommandsPage.make({ types: [], recent: [] })),
      sample: true,
    }),
  ).toBe(false)
  expect(canSendCommand({ page: Option.none(), sample: false })).toBe(true)
})

it("refuses dead-letter actions on a live jobs page whose source cannot resolve them", () => {
  const jobs = (resolvable: boolean) =>
    Option.some(
      JobsPage.make({
        queued: 0,
        running: null,
        retrying: 0,
        deadLetters: [],
        resolvable,
        types: [],
        labels: [],
        throughput: null,
      }),
    )
  for (const action of [
    Action.RetryDeadLetters({ ids: ["dl_1"] }),
    Action.DiscardDeadLetter({ id: "dl_1" }),
  ]) {
    expect(canMutate({ page: jobs(false), sample: false, loading: false, action })).toBe(false)
    expect(canMutate({ page: jobs(true), sample: false, loading: false, action })).toBe(true)
  }
})
