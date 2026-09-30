import { Schema } from "effect"
import type { Request } from "../request.ts"
import { System } from "../../identity/caller.ts"

/**
 * Span names are public: dashboards, alerts, and `durable defects list` match
 * on them, so a rename is a breaking change. Every name is bounded by the
 * deployment's declarations, never by an actor id or command id; those are
 * attributes.
 */
export const SpanNames = {
  /** One command's admission on the runner that received it, from the receipt probe to the reply. */
  admission: "durable-actors.admission",
  /** One command turn on the actor's owner. */
  turn: (actor: string, command: string) => `durable-actors.${actor}/${command}`,
  /** One turn batch on the actor's owner: the commands that were waiting, run in one transaction. */
  batch: (actor: string) => `durable-actors.${actor}/batch`,
  /** The turn's commit group, from the first staged write to the `COMMIT` reply. */
  commit: "durable-actors.commit",
  /** One relay delivery of an intent, timer, or cron tick. */
  relayIntent: "durable-actors.relay.intent",
  /** One relay delivery pass over a claimed subscription row. */
  relaySubscription: "durable-actors.relay.subscription",
  /** One executor attempt of an effect. */
  effect: (actor: string, effect: string) => `durable-actors.effect/${actor}/${effect}`,
} as const

const isSystem = Schema.is(System)

/**
 * What started a turn: `command` for an external caller, or the System
 * source of a relay, workflow, or effect route delivery.
 */
export const triggerOf = (request: Request) =>
  request.external === true
    ? "command"
    : isSystem(request.caller)
      ? request.caller.source
      : "command"

/** Attributes every admission and turn span carries; none is a credential or payload. */
export const requestAttributes = (request: Request) => ({
  "actor.type": request.ref.actor,
  "actor.tenant": request.ref.tenant,
  "actor.id": request.ref.id,
  "command.name": request.command,
  "command.id": request.commandId,
  "caller.kind": request.caller._tag,
  "turn.trigger": triggerOf(request),
})
