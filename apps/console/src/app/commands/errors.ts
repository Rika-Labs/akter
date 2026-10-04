import { CommandRefused, NotFound, Unavailable } from "@akter/cloud-api"
import { Match, Predicate, Schema } from "effect"
import { ConsoleError, consoleError } from "../api/client.ts"
import { isQuotaKind, quotaMessage } from "../quota/errors.ts"

/**
 * The failures after which sending the same submission again cannot help: the key is bound to
 * other input, its retry window has closed or it is unusable, the runner hit a defect that must
 * never be retried, it refused for a reason the framework marks not retryable, or the edge has no
 * billing account or plan to bill the command to (`QuotaUnbound`, or `Unbillable` when only support
 * can fix it), which retrying doesn't change.
 * The dialog does not offer to resend that submission with the same command ID.
 */
const finalKinds: ReadonlyArray<string> = [
  "Conflict",
  "CommandExpired",
  "RunnerDefect",
  "InvalidCommandId",
  "CommandRefusedFinal",
  "QuotaUnbound",
  "Unbillable",
]

/** Whether a send that failed with `kind` may be retried with the same command ID. */
export const retryable = (kind: string): boolean => !finalKinds.includes(kind)

const sentence = (text: string): string => text.trim().replace(/\.$/, "")

/** The command a send addressed, so each failure can name what it refused. */
export interface Sent {
  readonly address: string
  readonly command: string
}

const absent = (sent: Sent): string =>
  `${sent.address} doesn’t exist yet, and ${sent.command} doesn’t create it. Send the command that creates this actor first.`

const conflictMessage =
  "This command ID was already used for a different command or payload, so nothing ran. Clear the Command ID to send this as a new command."

const expiredMessage =
  "This command ID’s retry window has closed, so Akter won’t run it again. Clear the Command ID to send it as a new command."

/** A refusal the framework marks retryable: the same command ID can be sent again safely. */
const busy = (sent: Sent, refusal: CommandRefused): ConsoleError =>
  ConsoleError.make({
    kind: "CommandRefused",
    message: `${sent.address} couldn’t take ${sent.command} right now (${refusal.reasonTag}), so nothing ran. Send again to retry with the same command ID; it runs at most once.`,
  })

/** A refusal the framework marks not retryable: sending the same submission again cannot help. */
const final = (sent: Sent, refusal: CommandRefused): ConsoleError =>
  ConsoleError.make({
    kind: "CommandRefusedFinal",
    message: `${sent.address} refused ${sent.command} (${refusal.reasonTag}), so nothing ran, and sending it again with this command ID won’t help. Clear the Command ID to send it as a new command.`,
  })

/**
 * What the dialog says about a runner's refusal, read from its typed reason. A plan refusal keeps
 * the console-wide quota wording and kind, so it links to Billing; a reason that means the key is
 * spent takes the same kind as the API's own error for it, so the dialog offers no resend; any other
 * reason is resendable exactly when the framework marks it retryable (`SessionEnded.isRetryable`,
 * `TransportError.retryable`, and `Unauthorized` only for `reauthorization_unavailable`).
 */
const refusalFailure = (sent: Sent, refusal: CommandRefused): ConsoleError =>
  Match.value(refusal.reason).pipe(
    Match.withReturnType<ConsoleError>(),
    Match.tag(
      "QuotaExceeded",
      "SpendLimitExceeded",
      "ConnectionLimitExceeded",
      "StorageQuotaExceeded",
      (reason) => ConsoleError.make({ kind: reason._tag, message: quotaMessage(reason) }),
    ),
    Match.tag("InvalidInput", ({ code }) =>
      ConsoleError.make({
        kind: "CommandRefused",
        message: `${sent.address} refused ${sent.command} before running it (InvalidInput: ${code}), so nothing ran. Change the command or payload and send it again. A command ID you typed stays bound to the input it was first sent with, so clear it too.`,
      }),
    ),
    Match.tag("InvalidCommandId", ({ code }) =>
      ConsoleError.make({
        kind: "InvalidCommandId",
        message: `Akter can’t use this command ID (${code}), so nothing ran. Clear the Command ID to send it as a new command.`,
      }),
    ),
    Match.tag("CommandConflict", () =>
      ConsoleError.make({ kind: "Conflict", message: conflictMessage }),
    ),
    Match.tag("CommandExpired", () =>
      ConsoleError.make({ kind: "CommandExpired", message: expiredMessage }),
    ),
    Match.tag("NotCreated", () => ConsoleError.make({ kind: "NotFound", message: absent(sent) })),
    Match.tag("Unauthorized", (reason) =>
      reason.code === "reauthorization_unavailable"
        ? busy(sent, refusal)
        : ConsoleError.make({
            kind: "CommandRefusedFinal",
            message: `${sent.address} refused ${sent.command} for this caller (Unauthorized: ${reason.code}), so nothing ran. Sending it again won’t help.`,
          }),
    ),
    Match.tag("SessionEnded", (reason) =>
      reason.isRetryable ? busy(sent, refusal) : final(sent, refusal),
    ),
    Match.tag("TransportError", (reason) =>
      reason.retryable ? busy(sent, refusal) : final(sent, refusal),
    ),
    Match.tag("ActorUnavailable", "Timeout", "MailboxFull", "RunnerAtCapacity", () =>
      busy(sent, refusal),
    ),
    Match.exhaustive,
  )

/**
 * What the send dialog says about a failed send, in words that name the next step. Plan refusals
 * keep the console-wide quota wording and its Billing link; anything not specific to sending falls
 * back to the console-wide reading of the error.
 */
export const sendFailure =
  (sent: Sent) =>
  (cause: unknown): ConsoleError => {
    if (Schema.is(CommandRefused)(cause)) return refusalFailure(sent, cause)
    const general = consoleError(cause)
    if (isQuotaKind(general.kind)) return general
    const failed = (message: string) => ConsoleError.make({ kind: general.kind, message })
    if (Predicate.isTagged(cause, "Conflict")) return failed(conflictMessage)
    if (Predicate.isTagged(cause, "CommandExpired")) return failed(expiredMessage)
    if (Predicate.isTagged(cause, "RunnerDefect"))
      return failed(
        "The runner hit an internal error while running this command. It wasn’t retried and can’t be resent with this command ID. Check the actor first; to send it again as a new command, clear the Command ID.",
      )
    if (Schema.is(Unavailable)(cause))
      return failed(
        `${sentence(cause.message)}. Nothing was lost: send again to retry with the same command ID, and it runs at most once.`,
      )
    if (Schema.is(NotFound)(cause)) {
      if (cause.resource === "actor") return failed(absent(sent))
      if (cause.resource === "command")
        return failed(`${sent.address} has no command named ${sent.command}.`)
      if (cause.resource === "live deployment")
        return failed("This environment has no live deployment to run the command.")
    }
    return general
  }
