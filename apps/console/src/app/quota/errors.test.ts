import { CommandRefused, Forbidden, Unavailable } from "@akter/cloud-api"
import {
  ConnectionLimitExceeded,
  MailboxFull,
  QuotaExceeded,
  SpendLimitExceeded,
  StorageQuotaExceeded,
} from "@rikalabs/akter/client"
import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { consoleError } from "../api/client.ts"
import { isQuotaKind, quotaMessage, quotaRefusal } from "./errors.ts"

const generic = "We couldn’t reach Akter. Please try again."

/** The edge's envelope around a runner refusal, as `CommandRefused.reason` forwards it. */
const ActorError = Schema.TaggedStruct("ActorError", {
  reason: Schema.Json,
  isRetryable: Schema.Boolean,
})

const refusals = {
  command: QuotaExceeded.make({
    organizationId: "org_1",
    period: "2026-10",
    limitUnits: 5_000_000,
    usedUnits: 4_999_999,
    requestedUnits: 5,
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

  it("reads an API error with the framework's tag and payload as the same refusal", () => {
    const decoded = quotaRefusal(JSON.parse(JSON.stringify(refusals.spend)))
    expect(Option.map(decoded, quotaMessage)).toEqual(Option.some(quotaMessage(refusals.spend)))
  })

  it("reads a runner's refusal forwarded as CommandRefused as the plan refusal inside it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forwarded = (reason: Schema.Json) =>
          CommandRefused.make({
            commandId: "runner-id",
            reasonTag: "QuotaExceeded",
            reason: ActorError.make({ reason, isRetryable: false }),
          })
        const command = yield* Schema.encodeEffect(Schema.toCodecJson(QuotaExceeded))(
          refusals.command,
        )
        expect(consoleError(forwarded(command))).toMatchObject({
          kind: "QuotaExceeded",
          message: quotaMessage(refusals.command),
        })
        const full = yield* Schema.encodeEffect(Schema.toCodecJson(MailboxFull))(
          MailboxFull.make({}),
        )
        expect(quotaRefusal(forwarded(full))).toEqual(Option.none())
      }),
    ))

  it("never mistakes another error, or a quota tag without its payload, for a refusal", () => {
    expect(quotaRefusal(Forbidden.make({ message: "Owners only." }))).toEqual(Option.none())
    expect(quotaRefusal(JSON.parse('{"_tag":"SpendLimitExceeded","limitCents":"a lot"}'))).toEqual(
      Option.none(),
    )
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
