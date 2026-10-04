import { CommandRefused, NotFound, Unavailable } from "@akter/cloud-api"
import { Option, Predicate, Schema } from "effect"
import { ConsoleError, consoleError } from "../api/client.ts"
import { isQuotaKind } from "../quota/errors.ts"

/**
 * The failures after which sending the same submission again cannot help: the key is bound to
 * other input, its retry window has closed, or the runner hit a defect that must never be retried.
 * The dialog does not offer to resend that submission with the same command ID.
 */
const finalKinds: ReadonlyArray<string> = ["Conflict", "CommandExpired", "RunnerDefect"]

/** Whether a send that failed with `kind` may be retried with the same command ID. */
export const retryable = (kind: string): boolean => !finalKinds.includes(kind)

const RefusalCode = Schema.Struct({ reason: Schema.Struct({ code: Schema.String }) })

const sentence = (text: string): string => text.trim().replace(/\.$/, "")

/** The command a send addressed, so each failure can name what it refused. */
export interface Sent {
  readonly address: string
  readonly command: string
}

/**
 * What the send dialog says about a failed send, in words that name the next step. Plan refusals
 * keep the console-wide quota wording and its Billing link; anything not specific to sending falls
 * back to the console-wide reading of the error.
 */
export const sendFailure =
  (sent: Sent) =>
  (cause: unknown): ConsoleError => {
    const general = consoleError(cause)
    if (isQuotaKind(general.kind)) return general
    const failed = (message: string) => ConsoleError.make({ kind: general.kind, message })
    if (Predicate.isTagged(cause, "Conflict"))
      return failed(
        "This command ID was already used for a different command or payload, so nothing ran. Clear the Command ID to send this as a new command.",
      )
    if (Predicate.isTagged(cause, "CommandExpired"))
      return failed(
        "This command ID’s retry window has closed, so Akter won’t run it again. Clear the Command ID to send it as a new command.",
      )
    if (Predicate.isTagged(cause, "RunnerDefect"))
      return failed(
        "The runner hit an internal error while running this command. It wasn’t retried and can’t be resent with this command ID. Check the actor first; to send it again as a new command, clear the Command ID.",
      )
    if (Schema.is(CommandRefused)(cause)) {
      const code = Option.match(Schema.decodeUnknownOption(RefusalCode)(cause.reason), {
        onNone: () => "",
        onSome: ({ reason }) => `: ${reason.code}`,
      })
      return ConsoleError.make({
        kind: "CommandRefused",
        message: `${sent.address} refused ${sent.command} before running it (${cause.reasonTag}${code}), so nothing ran. Change the command or payload and send it again. A command ID you typed stays bound to the input it was first sent with, so clear it too.`,
      })
    }
    if (Schema.is(Unavailable)(cause))
      return failed(
        `${sentence(cause.message)}. Nothing was lost: send again to retry with the same command ID, and it runs at most once.`,
      )
    if (Schema.is(NotFound)(cause)) {
      if (cause.resource === "actor")
        return failed(
          `${sent.address} doesn’t exist yet, and ${sent.command} doesn’t create it. Send the command that creates this actor first.`,
        )
      if (cause.resource === "command")
        return failed(`${sent.address} has no command named ${sent.command}.`)
      if (cause.resource === "live deployment")
        return failed("This environment has no live deployment to run the command.")
    }
    return general
  }
