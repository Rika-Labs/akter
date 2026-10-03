import { Result, Schema } from "effect"
import type { Json } from "effect/Schema"

export interface Flag<A> {
  readonly schema: Schema.Codec<A, Json>
  readonly default: A
}

/** Defaults are validated at declaration time, including their JSON encoding. */
export const flag =
  <A>(schema: Schema.Codec<A, Json>) =>
  (defaultValue: A): Flag<A> => {
    Result.getOrThrow(
      Schema.decodeResult(Schema.Json)(
        Result.getOrThrow(Schema.encodeResult(schema)(defaultValue)),
      ),
    )
    return { schema, default: defaultValue }
  }

export type Registry = Readonly<Record<string, Flag<unknown>>>

export const Override = Schema.Struct({
  users: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  organizations: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  rollout: Schema.optional(
    Schema.Struct({
      percentage: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
      value: Schema.Json,
    }),
  ),
  value: Schema.optional(Schema.Json),
})

export type Override = typeof Override.Type

export const Snapshot = Schema.Record(Schema.String, Override)
export type Snapshot = typeof Snapshot.Type

export interface Target {
  readonly organizationId?: string
  readonly userId?: string
}

export class UnknownFlag extends Schema.TaggedError<UnknownFlag>()("UnknownFlag", {
  key: Schema.String,
}) {}

export class InvalidOverride extends Schema.TaggedError<InvalidOverride>()("InvalidOverride", {
  key: Schema.String,
}) {}

const declaration = (registry: Registry, key: string) => {
  if (!Object.hasOwn(registry, key)) throw UnknownFlag.make({ key })
  return registry[key]!
}

/** FNV-1a over UTF-16 code units keeps buckets identical in browsers and restarted servers. */
export const bucket =
  (key: string) =>
  (target: Target): number | undefined => {
    const identity =
      target.userId === undefined
        ? target.organizationId === undefined
          ? undefined
          : ["organization", target.organizationId]
        : ["user", target.userId]
    if (identity === undefined) return undefined
    const input = Result.getOrThrow(
      Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String)))([key, ...identity]),
    )
    let hash = 2166136261
    for (let i = 0; i < input.length; i++) {
      hash = Math.imul(hash ^ input.charCodeAt(i), 16777619) >>> 0
    }
    return hash % 10000
  }

/** Rejects malformed or schema-invalid values before they can replace a stored rule. */
export const validateOverride =
  (registry: Registry) =>
  (key: string, input: Override): Override => {
    const definition = declaration(registry, key)
    try {
      const rule = Result.getOrThrow(Schema.decodeResult(Override)(input))
      const values = [
        ...Object.values(rule.users ?? {}),
        ...Object.values(rule.organizations ?? {}),
      ]
      if (rule.rollout !== undefined) values.push(rule.rollout.value)
      if (rule.value !== undefined) values.push(rule.value)
      for (const value of values) Result.getOrThrow(Schema.decodeResult(definition.schema)(value))
      return rule
    } catch {
      throw InvalidOverride.make({ key })
    }
  }

/** User targeting wins over organization targeting, rollout, global value and default. */
export const evaluate =
  <R extends Registry>(registry: R) =>
  <K extends keyof R & string>(
    key: K,
    target: Target,
    snapshot: Snapshot = {},
  ): R[K]["default"] => {
    const definition = declaration(registry, key)
    if (!Object.hasOwn(snapshot, key)) return definition.default as R[K]["default"]
    const rule = validateOverride(registry)(key, snapshot[key]!)
    let value: Json | undefined
    if (target.userId !== undefined && Object.hasOwn(rule.users ?? {}, target.userId)) {
      value = rule.users![target.userId]
    } else if (
      target.organizationId !== undefined &&
      Object.hasOwn(rule.organizations ?? {}, target.organizationId)
    ) {
      value = rule.organizations![target.organizationId]
    } else {
      const assignment = bucket(key)(target)
      value =
        rule.rollout !== undefined &&
        assignment !== undefined &&
        assignment < rule.rollout.percentage * 100
          ? rule.rollout.value
          : rule.value
    }
    return (
      value === undefined
        ? definition.default
        : Result.getOrThrow(Schema.decodeResult(definition.schema)(value))
    ) as R[K]["default"]
  }
