import { Data, Deferred, Duration, Effect, Latch } from "effect"
import type { Bucket } from "./bucket.ts"
import { StorageUnavailable } from "./errors.ts"

/** The bucket call a fault can intercept. */
export type OperationKind =
  | "get"
  | "head"
  | "create"
  | "put"
  | "list"
  | "delete"
  | "lease.read"
  | "lease.write"
  | "lease.list"
  | "lease.remove"

/** One bucket call as the fault plan sees it; `key` is the listed prefix or first deleted key. */
export interface Operation {
  readonly kind: OperationKind
  readonly key: string
}

/**
 * What happens to a matching call. `Delay` and `Hold` postpone it, on the
 * clock or until the injection is released, and then let later rules and the
 * bucket see it. `Unavailable` fails it before it reaches the bucket, as a 5xx
 * or a dropped request does. `LoseResponse` performs it and then fails, as a
 * response lost after the bucket applied the write does.
 */
export type Fault = Data.TaggedEnum<{
  Delay: { readonly duration: Duration.Input }
  Hold: {}
  Unavailable: { readonly status: number }
  LoseResponse: {}
}>

/** Constructors for {@link Fault}. */
export const Fault = Data.taggedEnum<Fault>()

/** A fault in the plan. */
export interface Injection {
  /** Completes when the fault first applies to a call. */
  readonly fired: Effect.Effect<void>
  /** Lets held calls continue and retires the fault. */
  readonly release: Effect.Effect<void>
}

interface Rule {
  readonly fault: Fault
  readonly match: (operation: Operation) => boolean
  remaining: number
  readonly fired: Deferred.Deferred<void>
  readonly gate: Latch.Latch
}

/**
 * A deterministic fault plan for one bucket: rules apply in the order they
 * were injected, each to the matching calls in call order, `times` times
 * (default once). Every call is recorded, in order, before any rule applies.
 */
export interface Faults {
  readonly inject: (
    fault: Fault,
    options?: { readonly match?: (operation: Operation) => boolean; readonly times?: number },
  ) => Effect.Effect<Injection>
  /** Holds every later call until released: the owner is paused. */
  readonly pause: Effect.Effect<Injection>
  readonly operations: Effect.Effect<ReadonlyArray<Operation>>
  readonly wrap: (bucket: Bucket) => Bucket
}

const unavailable = (operation: Operation, status: number, reason: string) =>
  StorageUnavailable.make({ operation: operation.kind, key: operation.key, status, reason })

/** A new, empty fault plan. */
const plan = (): Faults => {
  const rules: Array<Rule> = []
  const seen: Array<Operation> = []

  const intercept = <A>(
    operation: Operation,
    perform: Effect.Effect<A, StorageUnavailable>,
  ): Effect.Effect<A, StorageUnavailable> =>
    Effect.gen(function* () {
      seen.push(operation)
      for (const rule of rules) {
        if (rule.remaining <= 0 || !rule.match(operation)) continue
        rule.remaining -= 1
        yield* Deferred.succeed(rule.fired, undefined)
        yield* Fault.$match(rule.fault, {
          Delay: ({ duration }) => Effect.sleep(duration),
          Hold: () => rule.gate.await,
          Unavailable: ({ status }) =>
            Effect.fail(unavailable(operation, status, "injected server error")),
          LoseResponse: () =>
            Effect.andThen(
              perform,
              Effect.fail(unavailable(operation, 504, "injected lost response")),
            ),
        })
      }
      return yield* perform
    })

  const inject: Faults["inject"] = (fault, options = {}) =>
    Effect.gen(function* () {
      const rule: Rule = {
        fault,
        match: options.match ?? (() => true),
        remaining: options.times ?? 1,
        fired: yield* Deferred.make<void>(),
        gate: yield* Latch.make(false),
      }
      rules.push(rule)
      return {
        fired: Deferred.await(rule.fired),
        release: Effect.gen(function* () {
          rule.remaining = 0
          yield* rule.gate.open
        }),
      }
    })

  return {
    inject,
    pause: inject(Fault.Hold(), { times: Number.POSITIVE_INFINITY }),
    operations: Effect.sync(() => [...seen]),
    wrap: (bucket) => ({
      get: (key) => intercept({ kind: "get", key }, bucket.get(key)),
      head: (key) => intercept({ kind: "head", key }, bucket.head(key)),
      create: (key, body) => intercept({ kind: "create", key }, bucket.create(key, body)),
      put: (key, body) => intercept({ kind: "put", key }, bucket.put(key, body)),
      list: (prefix, options) =>
        intercept({ kind: "list", key: prefix }, bucket.list(prefix, options)),
      delete: (keys) => intercept({ kind: "delete", key: keys[0] ?? "" }, bucket.delete(keys)),
      leases: {
        read: (key) => intercept({ kind: "lease.read", key }, bucket.leases.read(key)),
        write: (key, body, condition) =>
          intercept({ kind: "lease.write", key }, bucket.leases.write(key, body, condition)),
        list: (prefix) =>
          intercept({ kind: "lease.list", key: prefix }, bucket.leases.list(prefix)),
        remove: (key) => intercept({ kind: "lease.remove", key }, bucket.leases.remove(key)),
      },
    }),
  }
}

/** Fault plans for tests and the simulator. */
export const Faults = { plan }
