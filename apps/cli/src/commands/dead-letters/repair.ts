import { Argument, Command, Flag } from "effect/unstable/cli"
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
  effectId: Argument.String("effectId").pipe(
    Argument.withDescription("The dead-lettered effect's id"),
  ),
  actor: actorFlag({
    name: "actor",
    description: "The actor that performed the effect, as <Type>/<id>",
  }),
  tenant,
  reason,
  ...operatorFlags,
}

/** Parsed arguments of `dead-letters retry` or `dead-letters discard`. */
export type RepairOptions = Command.Command.Config.Infer<typeof flags> & {
  readonly action: "retry" | "discard"
  readonly providerChecked: boolean
}

/** Retries or discards one dead letter; the runner records it in the operator audit log. */
export const repair = ({
  options,
  token,
}: {
  readonly options: RepairOptions
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
            actorType: options.actor.actorType,
            actorId: options.actor.actorId,
            reason: options.reason,
            providerChecked: options.providerChecked,
          }
        : {
            tenant: options.tenant,
            actorType: options.actor.actorType,
            actorId: options.actor.actorId,
            reason: options.reason,
          },
  })

/** `durable dead-letters retry <effectId>`: runs a dead-lettered effect again, printing the runner's JSON answer. */
export const retryCommand = Command.make(
  "retry",
  {
    ...flags,
    providerChecked: Flag.Boolean("provider-checked").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Confirm the provider never applied an ambiguous attempt, so running it again is safe",
      ),
    ),
  },
  (options) =>
    operatorCommand({
      options: { ...options, action: "retry" as const },
      request: repair,
      format: encodeJson,
    }),
).pipe(Command.withDescription("Run a dead-lettered effect again"))

/** `durable dead-letters discard <effectId>`: settles a dead letter without running it, printing the runner's JSON answer. */
export const discardCommand = Command.make("discard", flags, (options) =>
  operatorCommand({
    options: { ...options, action: "discard" as const, providerChecked: false },
    request: repair,
    format: encodeJson,
  }),
).pipe(Command.withDescription("Settle a dead-lettered effect without running it"))
