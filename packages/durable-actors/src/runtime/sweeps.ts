import { Cause, Context, Crypto, Effect, Scope } from "effect"
import { Sharding } from "effect/unstable/cluster"
import { SqlClient, SqlError } from "effect/unstable/sql"
import type { Registration } from "../handles/actors.ts"
import type { tenantContent } from "./content/store.ts"
import { dropWriters } from "./payloads/versions.ts"
import { sweep } from "./storage/retention.ts"
import type { SubscriptionRelay } from "./subscriptions/relay.ts"
import { databaseSampler } from "./telemetry/sampler.ts"
import { FrameworkClock } from "./turn/admission.ts"
import { CleanupHooks } from "./turn/hooks.ts"

/** Shardings whose telemetry sampler is registered; Cluster allows one per name. */
const sampled = new WeakSet<Sharding.Sharding["Service"]>()

/** Pause between retention sweeps. */
const CLEANUP_INTERVAL = "1 minute"

/**
 * Starts the runtime's periodic background work in its scope: the payload
 * writer heartbeat every half window, retention and content cleanup every
 * minute when the cleanup hooks allow it, and the telemetry sampler as one
 * singleton per Sharding. The writer rows are dropped when the scope closes.
 * Returns the cleanup pass for callers that sweep on demand, the sweeping
 * fiber a drain interrupts, and one sampling pass.
 */
export const startSweeps = Effect.fnUntraced(function* ({
  registrations,
  sweepsWorkflows,
  retryWindowMs,
  subscriptions,
  content,
  services,
  frameworkClock,
  refreshPayloadWriters,
  writerWindowMs,
  runtimeId,
  sampleEveryMs,
  sharding,
  scope,
}: {
  readonly registrations: ReadonlyMap<string, Registration>
  readonly sweepsWorkflows: ReadonlySet<string>
  readonly retryWindowMs: number
  readonly subscriptions: SubscriptionRelay
  readonly content: ReturnType<typeof tenantContent> | undefined
  readonly services: Context.Context<SqlClient.SqlClient | Crypto.Crypto | Sharding.Sharding>
  readonly frameworkClock: (typeof FrameworkClock)["Service"]
  readonly refreshPayloadWriters: Effect.Effect<void, SqlError.SqlError>
  readonly writerWindowMs: number
  readonly runtimeId: string
  readonly sampleEveryMs: number
  readonly sharding: Sharding.Sharding["Service"]
  readonly scope: Scope.Scope
}) {
  const cleanupHooks = yield* CleanupHooks

  const cleanup = Effect.suspend(() =>
    refreshPayloadWriters.pipe(
      Effect.orDie,
      Effect.andThen(
        sweep(
          Array.from(registrations.values(), ({ name, policy }) => ({
            actorType: name,
            keepReceiptsMs: policy.keepReceiptsMs,
            keepEventsMs: policy.keepEventsMs,
            holdEventsMs: policy.holdEventsMs,
            deliveryMs: policy.deliveryMs,
            keepWorkflowsMs: policy.keepWorkflowsMs,
            workflows: sweepsWorkflows.has(name),
          })),
          retryWindowMs,
        ).pipe(
          Effect.tap(() =>
            Effect.forEach(
              [...registrations.values()],
              (registration) =>
                subscriptions.cleanupRemoved(
                  registration.name,
                  registration.subscriptions.map((declared) => declared.tag),
                ),
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.flatMap((swept) =>
        Effect.map(
          content === undefined ? Effect.succeed(0) : content.sweep(false),
          (contents) => ({ ...swept, contents }),
        ),
      ),
    ),
  ).pipe(
    Effect.provideContext(services),
    Effect.provideService(FrameworkClock, frameworkClock),
    Effect.provideService(CleanupHooks, cleanupHooks),
  )

  yield* Effect.sleep(writerWindowMs / 2).pipe(
    Effect.andThen(
      refreshPayloadWriters.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Payload writer refresh failed", cause),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkIn(scope),
  )

  yield* Effect.addFinalizer(() =>
    dropWriters(runtimeId).pipe(
      Effect.provideContext(services),
      Effect.catchCause((cause) => Effect.logWarning("Payload writer rows not dropped", cause)),
    ),
  )

  const sweeping = cleanupHooks.periodic
    ? yield* Effect.sleep(CLEANUP_INTERVAL).pipe(
        Effect.andThen(
          cleanup.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Retention cleanup failed", cause),
            ),
          ),
        ),
        Effect.forever,
        Effect.forkIn(scope),
      )
    : undefined

  const sampler = databaseSampler()

  const sample = Effect.suspend(() =>
    sampler(
      Array.from(registrations.values(), ({ name, policy }) => ({
        actorType: name,
        keepEventsMs: policy.keepEventsMs,
        holdEventsMs: policy.holdEventsMs,
      })),
    ),
  ).pipe(
    Effect.provideContext(services),
    Effect.provideService(FrameworkClock, frameworkClock),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Telemetry sampling failed", cause),
    ),
  )

  if (!sampled.has(sharding)) {
    sampled.add(sharding)
    yield* sharding.registerSingleton(
      "durable-actors/telemetry",
      Effect.sleep(sampleEveryMs).pipe(Effect.andThen(sample), Effect.forever),
    )
  }

  return { cleanup, sweeping, sample }
})
