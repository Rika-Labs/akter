import { Option, Schema } from "effect"

/** What an operator may do; each action is granted separately. */
export const OperatorAction = Schema.Literals([
  "inspect",
  "export",
  "outcomes.read",
  "log.read",
  "snapshot.read",
  "fork",
  "replay",
  "delete",
  "audit.read",
  "retention.set",
])

/** One grantable operator action. */
export type OperatorAction = typeof OperatorAction.Type

/**
 * One action on one resource scope. `tenant` is a tenant id or `"*"` for
 * every tenant; an omitted field matches any value, and `commandId` narrows
 * `outcomes.read` to one stored outcome.
 */
export const Capability = Schema.Struct({
  action: OperatorAction,
  tenant: Schema.NonEmptyString,
  actorType: Schema.optionalKey(Schema.NonEmptyString),
  actorId: Schema.optionalKey(Schema.Json),
  commandId: Schema.optionalKey(Schema.NonEmptyString),
})

/** One capability of a grant. */
export type Capability = typeof Capability.Type

/** Who the operator is and every capability they hold. */
export const OperatorGrant = Schema.Struct({
  operator: Schema.NonEmptyString,
  capabilities: Schema.Array(Capability),
})

/** An operator's identity and capabilities. */
export type OperatorGrant = typeof OperatorGrant.Type

/** What one operator request touches; fields it doesn't name are tenant-wide. */
export interface Resource {
  readonly tenant: string
  readonly actorType?: string | undefined
  readonly actorId?: Schema.Json | undefined
  readonly commandId?: string | undefined
}

/**
 * A capability field left open matches anything; a set one must name the
 * resource's own value, so an actor-scoped grant never covers a tenant-wide read.
 */
const covers = (granted: string | undefined, requested: string | undefined) =>
  granted === undefined || granted === requested

/** The first capability of `grant` that allows `action` on `resource`. */
export const authorizing = ({
  grant,
  action,
  resource,
}: {
  readonly grant: OperatorGrant
  readonly action: OperatorAction
  readonly resource: Resource
}): Option.Option<Capability> =>
  Option.fromUndefinedOr(
    grant.capabilities.find(
      (capability) =>
        capability.action === action &&
        (capability.tenant === "*" || capability.tenant === resource.tenant) &&
        covers(capability.actorType, resource.actorType) &&
        (capability.actorId === undefined ||
          JSON.stringify(capability.actorId) === JSON.stringify(resource.actorId)) &&
        covers(capability.commandId, resource.commandId),
    ),
  )
