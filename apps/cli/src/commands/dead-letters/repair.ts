import { Effect } from "effect"
import { UsageError } from "../workflows/check.ts"
import { operatorRequest, parseActor, parseOperatorFlags } from "../operator/request.ts"

export const USAGE = [
  'Usage: durable dead-letters retry <effectId> --actor <Type>/<id> --url <runner> --tenant <tenant> --reason "<why>" [--provider-checked] [--token-env <name>] [--json]',
  '       durable dead-letters discard <effectId> --actor <Type>/<id> --url <runner> --tenant <tenant> --reason "<why>" [--token-env <name>] [--json]',
].join("\n")

/** Parses the arguments after `dead-letters retry` or `dead-letters discard`. */
export const parseRepair = ({
  action,
  args,
}: {
  readonly action: "retry" | "discard"
  readonly args: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const flags = yield* parseOperatorFlags({
      args,
      valued: ["--actor", "--reason"],
      switches: action === "retry" ? ["--provider-checked"] : [],
    })

    const effectId = flags.positional[0]

    if (effectId === undefined || flags.positional.length > 1)
      return yield* UsageError.make({ message: "Name one effect id" })

    const actor = yield* parseActor(flags.flags.get("--actor"))
    const reason = flags.flags.get("--reason")

    if (flags.tenant === undefined)
      return yield* UsageError.make({ message: "--tenant is required" })

    if (reason === undefined || reason.length === 0 || reason.length > 500)
      return yield* UsageError.make({ message: "--reason is required, up to 500 characters" })

    return {
      ...flags,
      ...actor,
      action,
      effectId,
      reason,
      tenant: flags.tenant,
      providerChecked: flags.switches.has("--provider-checked"),
    }
  })

/** Retries or discards one dead letter; the runner records it in the operator audit log. */
export const repair = ({
  options,
  token,
}: {
  readonly options: Effect.Success<ReturnType<typeof parseRepair>>
  readonly token: string | undefined
}) =>
  operatorRequest({
    url: options.urls[0]!,
    path: `/operator/dead-letters/${encodeURIComponent(options.effectId)}/${options.action}`,
    token,
    body:
      options.action === "retry"
        ? {
            tenant: options.tenant,
            actorType: options.actorType,
            actorId: options.actorId,
            reason: options.reason,
            providerChecked: options.providerChecked,
          }
        : {
            tenant: options.tenant,
            actorType: options.actorType,
            actorId: options.actorId,
            reason: options.reason,
          },
  })
