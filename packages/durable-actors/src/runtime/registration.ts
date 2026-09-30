import { Context, Crypto, Effect } from "effect"
import { Sharding } from "effect/unstable/cluster"
import { SqlClient, SqlError } from "effect/unstable/sql"
import type { ActorError } from "../errors/actor.ts"
import type { EffectRegistration, QueryRegistration, Registration } from "./members.ts"
import type { InternalActors } from "./actors.ts"
import { type AnyBlob, isContent } from "../members/blob.ts"
import type { PayloadDeclaration } from "../members/payload.ts"
import type { AnyOwnedTable } from "../tables/owned.ts"
import type { HeldActorType } from "./connections/holder.ts"
import type { Authorize, Owner } from "./connections/owner.ts"
import type { Transport } from "./connections/transport.ts"
import type { tenantContent } from "./content/store.ts"
import type { TurnGate } from "./drain.ts"
import { registerActor } from "./entity/register.ts"
import {
  findPayloadProblems,
  formatPayloadProblem,
  recordPayloadVersions,
} from "./payloads/versions.ts"
import { checkPlacement } from "./storage/placements.ts"
import type { SubscriptionRelay } from "./subscriptions/relay.ts"
import { DefectLog } from "./telemetry/defects.ts"
import { FrameworkClock } from "./turn/admission.ts"
import { OutboxRuntime, textArray } from "./turn/outbox.ts"
import { checkTables } from "./turn/rows.ts"
import { acceptWorkflows, formatIncompatibility } from "./workflows/compatibility.ts"
import { RECOVERY_MS } from "./workflows/engine.ts"

/** How long registering a source waits for the subscriber types routing from it to register. */
const ROUTED_SUBSCRIBER_WAIT_MS = 5000

/**
 * Registers actor, query, and effect layers with the runtime. Each
 * registration is refused unless its placement, tables, content, workflows,
 * payload versions, and routed subscriptions agree with the database and the
 * runtime's configuration; an accepted one is recorded for the relay, the
 * connection holder, and the sweeps, and forgotten when its layer's scope
 * closes.
 */
export const actorRegistration = ({
  registrations,
  queryRegistrations,
  effectRegistrations,
  residency,
  owners,
  heldTypes,
  heldType,
  sweepsWorkflows,
  checked,
  services,
  frameworkClock,
  content,
  retryWindowMs,
  tableRole,
  writerDeclarations,
  refreshPayloadWriters,
  subscriptions,
  transport,
  authorize,
  gate,
  writable,
  defectLog,
  outbox,
}: {
  readonly registrations: Map<string, Registration>
  readonly queryRegistrations: Map<string, QueryRegistration>
  readonly effectRegistrations: Map<string, EffectRegistration>
  readonly residency: Map<string, (entityId: string) => boolean>
  readonly owners: Map<string, Owner>
  readonly heldTypes: Map<string, HeldActorType>
  readonly heldType: (registration: Registration) => HeldActorType
  readonly sweepsWorkflows: Set<string>
  readonly checked: Set<AnyOwnedTable>
  readonly services: Context.Context<SqlClient.SqlClient | Crypto.Crypto | Sharding.Sharding>
  readonly frameworkClock: (typeof FrameworkClock)["Service"]
  readonly content: ReturnType<typeof tenantContent> | undefined
  readonly retryWindowMs: number
  readonly tableRole: string | undefined
  readonly writerDeclarations: Array<PayloadDeclaration>
  readonly refreshPayloadWriters: Effect.Effect<void, SqlError.SqlError>
  readonly subscriptions: SubscriptionRelay
  readonly transport: Transport
  readonly authorize: Authorize
  readonly gate: TurnGate
  readonly writable: Effect.Effect<void, ActorError>
  readonly defectLog: DefectLog["Service"]
  readonly outbox: (typeof OutboxRuntime)["Service"]
}): Pick<InternalActors["Service"], "register" | "registerQueries" | "registerEffects"> => {
  /**
   * Refuses a layer that can't read every payload version the database
   * may hold, as a placement or workflow mismatch is refused. `writes`
   * names the actor type whose turns the layer runs, for the removed-class check.
   */
  const checkPayloadVersions = Effect.fnUntraced(function* (
    name: string,
    declarations: ReadonlyArray<PayloadDeclaration>,
    writes?: { readonly actorType: string; readonly events: ReadonlyArray<string> },
  ) {
    const problems = yield* findPayloadProblems(
      declarations,
      writes === undefined ? [] : [writes],
    ).pipe(Effect.provideContext(services), Effect.orDie)

    if (problems.length > 0)
      return yield* Effect.die(
        new Error(
          [
            `Actor ${name} cannot read every stored payload version; deploy refused`,
            ...problems.map(formatPayloadProblem),
          ].join("\n"),
        ),
      )
  })

  const recordRouted = Effect.fnUntraced(function* (registration: Registration) {
    const sql = yield* SqlClient.SqlClient

    const routed = registration.subscriptions.filter((declared) => declared.routed !== undefined)

    for (const declared of routed)
      yield* sql`INSERT INTO actor_routed_subscriptions (source_type, subscriber_type, subscription)
        VALUES (${declared.sourceType}, ${registration.name}, ${declared.tag})
        ON CONFLICT DO NOTHING`

    yield* sql`DELETE FROM actor_routed_subscriptions
      WHERE subscriber_type = ${registration.name}
        AND NOT (source_type, subscription) IN (
          SELECT * FROM unnest(${textArray({ sql, values: routed.map((declared) => declared.sourceType) })},
            ${textArray({ sql, values: routed.map((declared) => declared.tag) })}))`
  })

  /**
   * A publishing turn creates a routed subscription's source-side rows
   * only from the routed declarations its runner registers, so a runner
   * that serves a source without a subscriber type routing from it would
   * lose those events silently. Registering the source fails instead.
   * Layers of one runtime register concurrently, so the subscriber gets
   * a short window to register first.
   */
  const requireRoutedSubscribers = Effect.fnUntraced(function* (sourceType: string) {
    const sql = yield* SqlClient.SqlClient

    const missing = Effect.map(
      sql<{ subscriber_type: string; subscription: string }>`
        SELECT subscriber_type, subscription FROM actor_routed_subscriptions
        WHERE source_type = ${sourceType}`,
      (rows) =>
        rows.filter(
          (row) => row.subscriber_type !== sourceType && !registrations.has(row.subscriber_type),
        ),
    )

    for (let waited = 0; waited < ROUTED_SUBSCRIBER_WAIT_MS; waited += 100) {
      if ((yield* missing).length === 0) return
      yield* Effect.sleep("100 millis")
    }

    const unregistered = yield* missing

    if (unregistered.length > 0)
      return yield* Effect.die(
        new Error(
          `Actor ${sourceType} is registered without the subscriber types that route from it (${unregistered
            .map((row) => `${row.subscriber_type}.${row.subscription}`)
            .join(", ")}); register their layers on every runner that serves ${sourceType}`,
        ),
      )
  })

  const declaresContent = (registration: { readonly blobs: ReadonlyArray<AnyBlob> }) =>
    registration.blobs.some(isContent)

  const requireContent = (name: string) =>
    content === undefined
      ? Effect.die(new Error(`Actor ${name} declares content; give the runtime content.keys`))
      : Effect.void

  const recordContentTurn = Effect.fnUntraced(function* (registration: Registration) {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO actor_content_types (actor_type, turn_ms)
      VALUES (${registration.name}, ${registration.policy.executionMs})
      ON CONFLICT (actor_type) DO UPDATE
      SET turn_ms = greatest(actor_content_types.turn_ms, EXCLUDED.turn_ms)`
  })

  return {
    register: Effect.fnUntraced(function* (registration: Registration) {
      if (registrations.has(registration.name))
        return yield* Effect.die(new Error(`Duplicate actor: ${registration.name}`))
      yield* checkPlacement(registration).pipe(Effect.provideContext(services), Effect.orDie)

      if (declaresContent(registration)) {
        yield* requireContent(registration.name)
        yield* recordContentTurn(registration).pipe(Effect.provideContext(services), Effect.orDie)
      }

      yield* checkTables(registration.name, registration.tables, tableRole).pipe(
        Effect.provideContext(services),
        Effect.orDie,
      )

      for (const table of registration.tables) checked.add(table)

      if (registration.workflows.size > 0 && registration.policy.keepWorkflowsMs < retryWindowMs)
        return yield* Effect.die(
          new Error(`Actor ${registration.name} keepWorkflows is shorter than the retry window`),
        )

      if (
        registration.workflows.size > 0 &&
        retryWindowMs - registration.policy.deliveryMs <= RECOVERY_MS
      )
        yield* Effect.logWarning(
          `Actor ${registration.name}: the retry window minus deliveryTimeout is at most the ${RECOVERY_MS / 1000}-second workflow recovery interval, so an activity whose runner dies fails with ActivityOutcomeUnknown instead of rerunning its actor calls`,
        )

      const { incompatibilities, retained } = yield* acceptWorkflows({
        name: registration.name,
        workflows: Array.from(registration.workflows.values(), ({ member }) => member),
      }).pipe(Effect.provideContext(services), Effect.orDie)

      if (incompatibilities.length > 0)
        return yield* Effect.die(
          new Error(
            [
              `Actor ${registration.name} workflows are incompatible with open executions; deploy refused`,
              ...incompatibilities.map(formatIncompatibility),
            ].join("\n"),
          ),
        )

      yield* checkPayloadVersions(registration.name, registration.payloads, {
        actorType: registration.name,
        events: registration.payloads
          .filter((declared) => declared.writes && declared.kind === "event")
          .map((declared) => declared.tag),
      })

      yield* recordPayloadVersions(registration.payloads).pipe(
        Effect.provideContext(services),
        Effect.provideService(FrameworkClock, frameworkClock),
        Effect.orDie,
      )

      for (const declared of registration.payloads)
        if (declared.writes) writerDeclarations.push(declared)
      yield* refreshPayloadWriters.pipe(Effect.orDie)

      yield* recordRouted(registration).pipe(Effect.provideContext(services), Effect.orDie)
      yield* requireRoutedSubscribers(registration.name).pipe(
        Effect.provideContext(services),
        Effect.orDie,
      )

      for (const declared of registration.subscriptions)
        if (declared.routed === undefined)
          yield* subscriptions
            .widen(registration.name, declared)
            .pipe(Effect.provideContext(services), Effect.orDie)

      registrations.set(registration.name, registration)

      if (registration.connections.size > 0 || registration.feeds.size > 0)
        heldTypes.set(registration.name, heldType(registration))

      if (retained) sweepsWorkflows.add(registration.name)

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          registrations.delete(registration.name)
          residency.delete(registration.name)
          owners.delete(registration.name)
          heldTypes.delete(registration.name)
          sweepsWorkflows.delete(registration.name)
        }),
      )

      const { isResident, owner } = yield* registerActor(
        registration,
        transport,
        authorize,
        gate,
        writable,
      ).pipe(
        Effect.provideService(DefectLog, defectLog),
        Effect.provideContext(services),
        Effect.provideService(OutboxRuntime, outbox),
      )

      residency.set(registration.name, isResident)
      owners.set(registration.name, owner)
    }),
    registerQueries: Effect.fnUntraced(function* (registration: QueryRegistration) {
      if (queryRegistrations.has(registration.name))
        return yield* Effect.die(new Error(`Duplicate query layer: ${registration.name}`))
      yield* checkPlacement(registration).pipe(Effect.provideContext(services), Effect.orDie)

      if (declaresContent(registration)) yield* requireContent(registration.name)

      yield* checkTables(registration.name, registration.tables, tableRole).pipe(
        Effect.provideContext(services),
        Effect.orDie,
      )

      for (const table of registration.tables) checked.add(table)
      yield* checkPayloadVersions(registration.name, registration.payloads)
      queryRegistrations.set(registration.name, registration)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          queryRegistrations.delete(registration.name)
        }),
      )
    }),
    registerEffects: Effect.fnUntraced(function* (registration: EffectRegistration) {
      if (effectRegistrations.has(registration.name))
        return yield* Effect.die(new Error(`Duplicate effect layer: ${registration.name}`))
      yield* checkPayloadVersions(registration.name, registration.payloads)
      effectRegistrations.set(registration.name, registration)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          effectRegistrations.delete(registration.name)
        }),
      )
    }),
  }
}
