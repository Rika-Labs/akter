import { Command, Argument } from "effect/cli"
import {
  actorArgument,
  encodeJson,
  operatorCommand,
  operatorFlags,
  operatorRequest,
  tenant,
} from "../operator/request.ts"

const flags = {
  actor: actorArgument,
  commandId: Argument.String("commandId").pipe(
    Argument.withDescription("The command id whose stored outcome to show"),
  ),
  tenant,
  ...operatorFlags,
}

/** Parsed arguments of `receipts show`. */
export type ShowOptions = Command.Command.Config.Infer<typeof flags>

/** Reads one stored outcome; the runner never runs the command to answer. */
export const showReceipt = ({
  options,
  token,
}: {
  readonly options: ShowOptions
  readonly token: string | undefined
}) =>
  operatorRequest({
    url: options.urls[0]!,
    path: `/operator/receipts/${encodeURIComponent(options.actor.actorType)}/${encodeURIComponent(options.actor.actorId)}/${encodeURIComponent(options.commandId)}?${new URLSearchParams({ tenant: options.tenant })}`,
    token,
  })

/** `akter receipts show <Type>/<id> <commandId>`: one stored outcome, as JSON. */
export const showCommand = Command.make("show", flags, (options) =>
  operatorCommand({ options, request: showReceipt, format: encodeJson }),
).pipe(
  Command.withDescription(
    "Print one receipt's stored outcome as JSON; the runner never runs the command to answer",
  ),
)
