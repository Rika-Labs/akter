import {
  CommandRefused,
  ConnectionLimitExceeded,
  Forbidden,
  NotFound,
  NotFoundResource,
  QuotaExceeded,
  SpendLimitExceeded,
  StorageQuotaExceeded,
  Unavailable,
} from "@akter/cloud-api"
import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { consoleError } from "../api/client.ts"
import { isQuotaKind, quotaMessage, quotaRefusal } from "./errors.ts"

const generic = "We couldn’t reach Akter. Please try again."

const refusals = {
  command: QuotaExceeded.make({
    organizationId: "org_1",
    period: "2026-10",
    limitUnits: 5_000_000,
    usedUnits: 4_999_999,
    requestedUnits: 5,
    unitsPerCommand: 5,
    retryAfterMs: 86_400_000,
  }),
  spend: SpendLimitExceeded.make({
    organizationId: "org_1",
    period: "2026-10",
    limitCents: 12_500,
    projectedCents: 12_501,
  }),
  connection: ConnectionLimitExceeded.make({
    organizationId: "org_1",
    kind: "socket",
    limit: 100,
    open: 100,
  }),
  storage: StorageQuotaExceeded.make({
    organizationId: "org_1",
    deployment: "dep_1",
    tenant: "tenant_1",
    limitBytes: 500_000_000,
    usedBytes: 512_340_000,
  }),
}

/** A `CommandRefused` as the API client decodes it from the wire, with its reason typed. */
const refused = (body: string) =>
  Effect.runSync(Schema.decodeEffect(Schema.fromJsonString(CommandRefused))(body))

describe("quota refusals", () => {
  it("names each cap with its own figures and what still works", () => {
    expect(consoleError(refusals.command)).toMatchObject({
      kind: "QuotaExceeded",
      message:
        "This organization has used all the commands its plan includes for October 2026, so new commands are refused until the month ends. Reads keep working; upgrading raises the allowance.",
    })
    expect(consoleError(refusals.spend)).toMatchObject({
      kind: "SpendLimitExceeded",
      message:
        "This command would take October 2026’s spend past the $125.00 spend limit, so it wasn’t run. Raise or remove the limit in Billing to continue.",
    })
    expect(consoleError(refusals.connection)).toMatchObject({
      kind: "ConnectionLimitExceeded",
      message:
        "This organization already has 100 of the 100 live connections its plan allows. Try again when one closes, or upgrade for more.",
    })
    expect(consoleError(refusals.storage)).toMatchObject({
      kind: "StorageQuotaExceeded",
      message:
        "This tenant stores 0.51 GB of the 0.5 GB its plan allows, so new commands are paused. Reads keep working; delete data or upgrade to resume.",
    })
  })

  it("reads a CommandRefused whose typed reason is a plan refusal as that refusal", () => {
    const forwarded = refused(
      '{"_tag":"CommandRefused","commandId":"runner-id","reasonTag":"StorageQuotaExceeded","reason":{"_tag":"StorageQuotaExceeded","organizationId":"org_1","deployment":"dep_1","tenant":"tenant_1","limitBytes":500000000,"usedBytes":512340000}}',
    )
    expect(consoleError(forwarded)).toMatchObject({
      kind: "StorageQuotaExceeded",
      message: quotaMessage(refusals.storage),
    })
    expect(
      quotaRefusal(
        refused(
          '{"_tag":"CommandRefused","commandId":"runner-id","reasonTag":"MailboxFull","reason":{"_tag":"MailboxFull"}}',
        ),
      ),
    ).toEqual(Option.none())
  })

  it("reads only errors the client decoded, never a value shaped like one", () => {
    const undecoded = (body: string) =>
      Effect.runSync(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(body))
    expect(
      quotaRefusal(
        undecoded(
          '{"_tag":"SpendLimitExceeded","organizationId":"org_1","period":"2026-10","limitCents":12500,"projectedCents":12501}',
        ),
      ),
    ).toEqual(Option.none())
    expect(
      quotaRefusal(
        undecoded(
          '{"_tag":"CommandRefused","commandId":"c","reasonTag":"QuotaExceeded","reason":{"_tag":"QuotaExceeded","organizationId":"org_1","period":"2026-10","limitUnits":5,"usedUnits":5,"requestedUnits":5,"unitsPerCommand":5,"retryAfterMs":1}}',
        ),
      ),
    ).toEqual(Option.none())
    expect(quotaRefusal(Forbidden.make({ message: "Owners only." }))).toEqual(Option.none())
    expect(consoleError(Unavailable.make({ message: "Down", retryAfterSeconds: 1 })).message).toBe(
      generic,
    )
    expect(consoleError(Forbidden.make({ message: "Owners only." })).kind).toBe("Forbidden")
  })

  it("links to Billing only for the kinds a plan or limit change lifts", () => {
    expect(Object.values(refusals).map((refusal) => isQuotaKind(refusal._tag))).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(["Forbidden", "Conflict", "Unavailable", "CommandFailed"].some(isQuotaKind)).toBe(false)
  })
})

describe("missing resources", () => {
  it("words every resource the contract can report missing, each differently", () => {
    const messages = NotFoundResource.literals.map(
      (resource) => consoleError(NotFound.make({ resource, id: "x" })).message,
    )
    expect(new Set(messages).size).toBe(NotFoundResource.literals.length)
    expect(consoleError(NotFound.make({ resource: "live deployment", id: "prj_1/prod" }))).toEqual(
      expect.objectContaining({
        kind: "NotFound",
        message: "This environment has no live deployment yet.",
      }),
    )
    expect(consoleError(NotFound.make({ resource: "project", id: "prj_1" })).message).toBe(
      "This project doesn’t exist or you no longer have access to it.",
    )
  })
})
