import { Effect } from "effect"
import { UsageError } from "../../flags.ts"
import { operatorRequest, parseActor, parseOperatorFlags } from "../operator/request.ts"

/** Usage text for `durable receipts`. */
export const USAGE =
  "Usage: durable receipts show <Type>/<id> <commandId> --url <runner> --tenant <tenant> [--token-env <name>] [--json]"

/** Parses the arguments after `receipts show`. */
export const parseShow = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const flags = yield* parseOperatorFlags({ args, valued: [], switches: [] })
    const actor = yield* parseActor(flags.positional[0])
    const commandId = flags.positional[1]

    if (commandId === undefined || flags.positional.length > 2)
      return yield* UsageError.make({ message: "Name one command id after the actor" })

    if (flags.tenant === undefined)
      return yield* UsageError.make({ message: "--tenant is required" })

    return { ...flags, ...actor, tenant: flags.tenant, commandId }
  })

/** Reads one stored outcome; the runner never runs the command to answer. */
export const showReceipt = ({
  options,
  token,
}: {
  readonly options: Effect.Success<ReturnType<typeof parseShow>>
  readonly token: string | undefined
}) =>
  operatorRequest({
    url: options.urls[0]!,
    path: `/operator/receipts/${encodeURIComponent(options.actorType)}/${encodeURIComponent(options.actorId)}/${encodeURIComponent(options.commandId)}?${new URLSearchParams({ tenant: options.tenant })}`,
    token,
  })
