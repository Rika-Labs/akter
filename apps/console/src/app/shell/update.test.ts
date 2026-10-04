import { Option } from "effect"
import * as Url from "foldkit/url"
import { describe, expect, it } from "vitest"
import { emptySettings, type Billing } from "../settings/model.ts"
import { workspace } from "../workspace/fixtures.ts"
import { ChoseSetting, SubmittedForm } from "./message.ts"
import type { Model } from "./model.ts"
import { init, update } from "./update.ts"

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
