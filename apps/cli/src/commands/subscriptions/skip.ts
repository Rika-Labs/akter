import { Effect } from "effect"
import { UsageError } from "../../flags.ts"
import { operatorRequest, parseActor, parseOperatorFlags } from "../operator/request.ts"

/** Usage text for `durable subscriptions`. */
export const USAGE =
  'Usage: durable subscriptions skip --source <Type>/<id> --subscriber <Type>/<id> --subscription <name> --through <cursor> --url <runner> --tenant <tenant> --reason "<why>" [--token-env <name>] [--json]'

/** Parses the arguments after `subscriptions skip`. */
export const parseSkip = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parsed = yield* parseOperatorFlags({
      args,
      valued: ["--source", "--subscriber", "--subscription", "--through", "--reason"],
      switches: [],
    })

    if (parsed.positional.length > 0)
      return yield* UsageError.make({ message: "skip takes flags only" })

    const source = yield* parseActor(parsed.flags.get("--source"))
    const subscriber = yield* parseActor(parsed.flags.get("--subscriber"))
    const subscription = parsed.flags.get("--subscription")
    const through = parsed.flags.get("--through")
    const reason = parsed.flags.get("--reason")

    if (parsed.tenant === undefined)
      return yield* UsageError.make({ message: "--tenant is required" })

    if (subscription === undefined || subscription.length === 0)
      return yield* UsageError.make({ message: "--subscription is required" })

    if (through === undefined || !/^[1-9][0-9]{0,17}$/.test(through))
      return yield* UsageError.make({ message: "--through is a positive event cursor" })

    if (reason === undefined || reason.length === 0 || reason.length > 500)
      return yield* UsageError.make({ message: "--reason is required, up to 500 characters" })

    return {
      ...parsed,
      tenant: parsed.tenant,
      sourceType: source.actorType,
      sourceId: source.actorId,
      subscriberType: subscriber.actorType,
      subscriberId: subscriber.actorId,
      subscription,
      through,
      reason,
    }
  })

/** Skips a stuck subscription row's events; the runner records it in the operator audit log. */
export const skip = ({
  options,
  token,
}: {
  readonly options: Effect.Success<ReturnType<typeof parseSkip>>
  readonly token: string | undefined
}) =>
  operatorRequest({
    url: options.urls[0]!,
    path: "/operator/subscriptions/skip",
    token,
    body: {
      tenant: options.tenant,
      sourceType: options.sourceType,
      sourceId: options.sourceId,
      subscriberType: options.subscriberType,
      subscription: options.subscription,
      subscriberId: options.subscriberId,
      through: options.through,
      reason: options.reason,
    },
  })
