import { Command, Flag } from "effect/cli"
import {
  actorFlag,
  encodeJson,
  operatorCommand,
  operatorFlags,
  operatorRequest,
  reason,
  tenant,
} from "../operator/request.ts"

const flags = {
  source: actorFlag({
    name: "source",
    description: "The source actor whose events the row delivers, as <Type>/<id>",
  }),
  subscriber: actorFlag({
    name: "subscriber",
    description: "The subscribing actor, as <Type>/<id>",
  }),
  subscription: Flag.String("subscription").pipe(
    Flag.filter(
      (name) => name.length > 0,
      () => "a subscription name",
    ),
    Flag.withDescription("The subscription's name on the subscriber"),
  ),
  through: Flag.String("through").pipe(
    Flag.filter(
      (cursor) => /^[1-9][0-9]{0,17}$/.test(cursor),
      () => "a positive event cursor",
    ),
    Flag.withDescription("Skip every event up to and including this source event cursor"),
  ),
  tenant,
  reason,
  ...operatorFlags,
}

/** Parsed arguments of `subscriptions skip`. */
export type SkipOptions = Command.Command.Config.Infer<typeof flags>

/** Skips a stuck subscription row's events; the runner records it in the operator audit log. */
export const skip = ({
  options,
  token,
}: {
  readonly options: SkipOptions
  readonly token: string | undefined
}) =>
  operatorRequest({
    url: options.urls[0]!,
    path: "/operator/subscriptions/skip",
    token,
    body: {
      tenant: options.tenant,
      sourceType: options.source.actorType,
      sourceId: options.source.actorId,
      subscriberType: options.subscriber.actorType,
      subscription: options.subscription,
      subscriberId: options.subscriber.actorId,
      through: options.through,
      reason: options.reason,
    },
  })

/** `akter subscriptions skip`: skips a stuck row's events, printing the runner's JSON answer. */
export const skipCommand = Command.make("skip", flags, (options) =>
  operatorCommand({ options, request: skip, format: encodeJson }),
).pipe(
  Command.withDescription(
    "Skip a stuck subscription row's events through a cursor; the runner audits the skip",
  ),
)
