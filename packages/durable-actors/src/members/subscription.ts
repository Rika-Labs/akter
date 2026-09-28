import { type DateTime, type Effect, Predicate, Schema } from "effect"
import { ActorRef } from "../identity/caller.ts"
import type { AnyCommand } from "./command.ts"
import type { EventClass } from "./event.ts"

/** What a subscription needs of its source: an actor definition's name and declared events. */
export interface SourceDefinition {
  readonly name: string
  readonly events: ReadonlyArray<EventClass>
}

/** One committed source event, as the subscriber's handler receives it. */
export interface DeliveredEvent<E> {
  readonly _tag: "Event"
  /** The subscription's tag. */
  readonly subscription: string
  /** The publisher. */
  readonly source: ActorRef
  /** The event's cursor in the publisher's stream. */
  readonly cursor: string
  readonly event: E
  /** The publisher's command that emitted it. */
  readonly commandId: string
  readonly timestamp: DateTime.Utc
}

/** Source history after `after` was pruned; the next delivery comes after `resumeAfter`. */
export interface DeliveredGap {
  readonly _tag: "RetentionGap"
  readonly subscription: string
  readonly source: ActorRef
  readonly after: string
  readonly resumeAfter: string
}

/** A dynamic subscription the source refused; it is no longer active. */
export interface DeliveredRejection {
  readonly _tag: "Rejected"
  readonly subscription: string
  readonly source: ActorRef
  readonly reason: "UnknownCursor"
  readonly cursor: string
}

/** One subscription delivery: a handler receives exactly one per turn. */
export type Delivery<E> = DeliveredEvent<E> | DeliveredGap | DeliveredRejection

const deliveryFields = { subscription: Schema.String, source: ActorRef }

/**
 * The input schema of a subscription handler: one delivery of `events` from
 * `source`. It names only the source and its classes, so the handler command
 * can be declared before the subscription that references it.
 */
export const Delivery = <
  const S extends SourceDefinition,
  const E extends ReadonlyArray<S["events"][number]>,
>(options: {
  readonly source: S
  readonly events: E
}) =>
  Schema.Union([
    Schema.TaggedStruct("Event", {
      ...deliveryFields,
      cursor: Schema.String,
      event: Schema.Union(options.events as E),
      commandId: Schema.String,
      timestamp: Schema.DateTimeUtc,
    }),
    Schema.TaggedStruct("RetentionGap", {
      ...deliveryFields,
      after: Schema.String,
      resumeAfter: Schema.String,
    }),
    Schema.TaggedStruct("Rejected", {
      ...deliveryFields,
      reason: Schema.Literal("UnknownCursor"),
      cursor: Schema.String,
    }),
  ])

// Declared as a method so a route of specific events still fits `AnySubscription`.
type RouteFunction<E> = { route(event: E, source: ActorRef): string }["route"]

/** A routed subscription's route: the subscriber's id for one event, or every event to the tenant's singleton. */
export type Route<E> = RouteFunction<E> | { readonly _tag: "Singleton" }

/**
 * A declared subscription of one subscriber type. `Routed` is true when it
 * has a `route`, so `turn.subscribe` accepts only dynamic ones.
 */
export interface Subscription<
  Tag extends string,
  E extends ReadonlyArray<EventClass>,
  Routed extends boolean,
  H extends AnyCommand = AnyCommand,
> {
  readonly kind: "subscription"
  readonly tag: Tag
  /** The source definition, typed loosely so a subscriber's type doesn't embed its source's. */
  readonly source: SourceDefinition
  readonly events: E
  readonly retired: ReadonlyArray<string>
  readonly handler: H
  readonly route: Route<E[number]["Type"]> | undefined
  readonly routed: Routed
}

export type AnySubscription = Subscription<string, ReadonlyArray<EventClass>, boolean>

/** A handler command whose input doesn't accept the subscription's deliveries fails to compile. */
type Accepting<H extends AnyCommand, E> = [Delivery<E>] extends [H["input"]["Type"]]
  ? unknown
  : {
      readonly "The handler's input must accept Actor.Delivery of the same source and events": never
    }

const SUBSCRIPTION_TAG = /^[A-Za-z][A-Za-z0-9]{0,79}$/

interface SubscriptionOptions<S extends SourceDefinition, E extends ReadonlyArray<EventClass>, H> {
  readonly source: S
  readonly events: E
  readonly handler: H
  /** Event tags this subscription once delivered; rows carrying them skip them. */
  readonly retired?: ReadonlyArray<string>
}

/**
 * Declares a subscription: every committed event of `events` from `source`
 * reaches `handler`, an internal command of the subscriber, as an ordinary
 * command turn. With `route` it is routed: every source of the type in the
 * tenant, to the subscriber `route` names. Without it, it is dynamic: only the
 * sources a subscriber's turn subscribes to.
 */
export interface SubscriptionFunction {
  <
    const Tag extends string,
    const S extends SourceDefinition,
    const E extends ReadonlyArray<S["events"][number]>,
    const H extends AnyCommand,
  >(
    tag: Tag,
    options: SubscriptionOptions<S, E, H & Accepting<H, E[number]["Type"]>> & {
      readonly route: Route<E[number]["Type"]>
    },
  ): Subscription<Tag, E, true, H>
  <
    const Tag extends string,
    const S extends SourceDefinition,
    const E extends ReadonlyArray<S["events"][number]>,
    const H extends AnyCommand,
  >(
    tag: Tag,
    options: SubscriptionOptions<S, E, H & Accepting<H, E[number]["Type"]>>,
  ): Subscription<Tag, E, false, H>
}

const subscription = ((
  tag: string,
  options: SubscriptionOptions<SourceDefinition, ReadonlyArray<EventClass>, AnyCommand> & {
    readonly route?: Route<never>
  },
): AnySubscription => {
  if (!SUBSCRIPTION_TAG.test(tag))
    throw new Error(
      `Subscription tag ${tag} must be 1-80 letters and digits, starting with a letter`,
    )

  if (options.events.length === 0) throw new Error(`Subscription ${tag} names no event`)

  const tags = new Set<string>()

  for (const event of options.events) {
    if (!options.source.events.includes(event))
      throw new Error(
        `Subscription ${tag}: ${options.source.name} does not declare event ${event.identifier}`,
      )

    if (tags.has(event.identifier))
      throw new Error(`Subscription ${tag} lists ${event.identifier} twice`)
    tags.add(event.identifier)
  }

  const retired = options.retired ?? []

  for (const old of retired)
    if (tags.has(old)) throw new Error(`Subscription ${tag} both delivers and retires ${old}`)

  if (options.handler.kind !== "command")
    throw new Error(`Subscription ${tag}'s handler must be a command`)

  const route = options.route

  if (
    route !== undefined &&
    !Predicate.isFunction(route) &&
    !Predicate.isTagged(route, "Singleton")
  )
    throw new Error(`Subscription ${tag}'s route is a function or Actor.singleton`)

  return {
    kind: "subscription",
    tag,
    source: options.source,
    events: options.events,
    retired,
    handler: options.handler,
    route,
    routed: route !== undefined,
  }
}) as SubscriptionFunction

/** `Actor.subscription`. */
export const SubscriptionMember = { make: subscription }

/** Where a new dynamic subscription starts: after its registration, from the first retained event, or after a cursor. */
export type SubscribeFrom = "now" | "start" | (string & {})

/** The part of a command turn that subscribes to and unsubscribes from sources; see `X.Turn`. */
export interface SubscribeContext<Subs extends AnySubscription> {
  /**
   * Starts following `id` through the dynamic subscription `subscription`
   * when this turn commits; a declared failure or rollback discards it.
   * `from` defaults to `"now"`: events committed after the registration
   * reaches the source.
   */
  readonly subscribe: (
    subscription: Extract<Subs, { readonly routed: false }>,
    id: string,
    options?: { readonly from?: SubscribeFrom },
  ) => Effect.Effect<void>
  /** Stops following `id` when this turn commits; no later delivery of it runs the handler. */
  readonly unsubscribe: (
    subscription: Extract<Subs, { readonly routed: false }>,
    id: string,
  ) => Effect.Effect<void>
}
