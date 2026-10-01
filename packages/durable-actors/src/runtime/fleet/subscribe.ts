import { Clock, Effect, Schema, Stream, SubscriptionRef } from "effect"
import { SqlClient } from "effect/sql"
import {
  ActorError,
  ActorUnavailable,
  InvalidInput,
  RunnerAtCapacity,
  Unauthorized,
} from "../../errors/actor.ts"
import { ActorRef, type Caller } from "../../identity/caller.ts"
import type { AccessRequest } from "../../policies/access.ts"
import { inTenant } from "../database/tenancy.ts"
import type { WatchResult } from "../members.ts"
import { FleetHooks, type ResolvedView } from "./maintainer.ts"
import { FLEET_PAGE_LIMIT } from "../../client/fleet-page.ts"

/** One subscription to a fleet view, for the caller's own tenant. */
export interface FleetRequest {
  readonly view: string
  readonly caller: Caller
  readonly tenant: string
  /** Equality filters on group columns by key, compared with each column's text form. */
  readonly filter: Readonly<Record<string, string>>
  readonly limit: number
  /** The credential's expiry in epoch milliseconds, which ends the subscription. */
  readonly expiresAt: number | undefined
}

/** The most subscriptions one view has on one runner. */
export const FLEET_SUBSCRIPTIONS = 1000

/** How often a runner reads the state of each view it has subscribers of. */
const POLL_INTERVAL = "1 second"

interface ViewState {
  readonly status: string
  readonly applied: string | null
}

const PageRow = Schema.Struct({
  status: Schema.String,
  as_of: Schema.NullOr(Schema.String),
  rows: Schema.String,
})

const decodeRows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
)

const encodeResult = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      value: Schema.Struct({
        asOf: Schema.NullOr(Schema.String),
        stale: Schema.Boolean,
        rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
      }),
    }),
  ),
)

const encodeContent = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      stale: Schema.Boolean,
      rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
)

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`

const denied = (code: "access_denied" | "expired") =>
  ActorError.make({ reason: Unauthorized.make({ code }) })

/**
 * The fleet subscriptions of one runner. A view with subscribers has one
 * poller, which reads its `status` and `applied_lsn` once a second however
 * many subscribe; a subscription reruns its page query only when that state
 * changed, and sends a page only when its rows or staleness differ from the
 * last one it sent. `asOf` alone moving on is not sent: a lower `asOf` only
 * proves less, never something false.
 * A subscription is authorized when it opens (`kind: "fleet"`, `command` the
 * view) and again every `reauthorizeMs` of the source's actor type
 * (`kind: "reauthorize"`, `of: "fleet"`), and ends at the credential's
 * expiry. Its `ref` names the caller's tenant and the view's source actor
 * type, with the view as its id, because a fleet read spans every actor of
 * the type. The page query runs in a tenant transaction, as the tenant role
 * when row-level security is on.
 */
export const fleetSubscriptions = Effect.fnUntraced(function* (options: {
  readonly views: ReadonlyArray<ResolvedView>
  readonly role: string | undefined
  readonly permitted: (request: AccessRequest) => Effect.Effect<boolean>
  readonly reauthorizeMs: (actorType: string) => number
}) {
  const sql = yield* SqlClient.SqlClient
  const scope = yield* Effect.scope
  const hooks = yield* FleetHooks

  const pollers = new Map<
    string,
    { readonly state: SubscriptionRef.SubscriptionRef<ViewState | undefined>; subscribers: number }
  >()

  for (const resolved of options.views) {
    const name = resolved.view.name
    const state = yield* SubscriptionRef.make<ViewState | undefined>(undefined)
    const poller = { state, subscribers: 0 }
    pollers.set(name, poller)

    const poll = Effect.gen(function* () {
      if (poller.subscribers === 0) return

      yield* hooks.poll(name)

      const [row] = yield* sql<{ status: string; applied: string | null }>`
        SELECT status, applied_lsn::text AS applied FROM actor_fleet_views WHERE view_name = ${name}`

      if (row !== undefined) yield* SubscriptionRef.set(state, row)
    })

    yield* poll.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Fleet view poll failed", cause)),
      Effect.andThen(Effect.sleep(POLL_INTERVAL)),
      Effect.forever,
      Effect.forkIn(scope),
    )
  }

  const page = (resolved: ResolvedView, request: FleetRequest) => {
    const { view } = resolved
    const derived = `${identifier(resolved.derivedSchema)}.${identifier(view.tableName.split(".").at(-1)!)}`
    const keys = view.groupBy as ReadonlyArray<string>

    const columns = [
      ...keys.map(
        (key, index) => `d.${identifier(view.groupColumns[index]!)} AS ${identifier(key)}`,
      ),
      ...view.aggregates.map(({ key }) => `d.${identifier(key)}`),
    ]

    const filters = Object.entries(request.filter)
    const order = keys.map((key) => `r.${identifier(key)}`).join(", ")

    const conditions = filters.map(
      ([key], index) =>
        `AND d.${identifier(view.groupColumns[keys.indexOf(key)]!)}::text = $${index + 3}`,
    )

    const statement = `SELECT v.status, v.applied_lsn::text AS as_of,
        coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY ${order})::text FROM (
          SELECT ${columns.join(", ")} FROM ${derived} d
          WHERE d.tenant_id = $2 ${conditions.join(" ")}
          ORDER BY ${keys.map((_, index) => `d.${identifier(view.groupColumns[index]!)}`).join(", ")}
          LIMIT ${request.limit}) r), '[]') AS rows
      FROM actor_fleet_views v WHERE v.view_name = $1`

    return hooks.page(view.name).pipe(
      Effect.andThen(
        sql.unsafe<typeof PageRow.Encoded>(statement, [
          view.name,
          request.tenant,
          ...filters.map(([, value]) => value),
        ]),
      ),
      inTenant({ sql, role: options.role, tenant: request.tenant }),
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
      ),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(PageRow)(rows[0]).pipe(
          Effect.flatMap((row) =>
            Effect.map(decodeRows(row.rows), (decoded) => ({
              asOf: row.as_of,
              stale: row.status !== "ready",
              rows: decoded,
            })),
          ),
          Effect.flatMap((result) =>
            Effect.all({
              value: encodeResult({ value: result }),
              content: encodeContent({ stale: result.stale, rows: result.rows }),
            }),
          ),
          Effect.orDie,
        ),
      ),
    )
  }

  const subscribe = Effect.fnUntraced(function* (request: FleetRequest) {
    const resolved = options.views.find(({ view }) => view.name === request.view)
    const poller = pollers.get(request.view)

    if (resolved === undefined || poller === undefined)
      return yield* ActorError.make({ reason: InvalidInput.make({ code: "unknown_route" }) })

    const keys: ReadonlyArray<string> = resolved.view.groupBy

    for (const key of Object.keys(request.filter))
      if (!keys.includes(key))
        return yield* ActorError.make({ reason: InvalidInput.make({ code: "decode" }) })

    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > FLEET_PAGE_LIMIT)
      return yield* ActorError.make({ reason: InvalidInput.make({ code: "decode" }) })

    const actorType = resolved.view.source.owner ?? resolved.view.source.name

    const asked = {
      caller: request.caller,
      ref: ActorRef.make({ tenant: request.tenant, actor: actorType, id: request.view }),
      command: request.view,
    }

    const access = (kind: "fleet" | "reauthorize") =>
      options.permitted(kind === "fleet" ? { ...asked, kind } : { ...asked, kind, of: "fleet" })

    if (!(yield* access("fleet"))) return yield* denied("access_denied")

    if (request.expiresAt !== undefined && (yield* Clock.currentTimeMillis) >= request.expiresAt)
      return yield* denied("expired")

    if (poller.subscribers >= FLEET_SUBSCRIPTIONS)
      return yield* ActorError.make({ reason: RunnerAtCapacity.make({}) })

    const run = (value: string): WatchResult => ({ version: undefined, value })

    const pages = SubscriptionRef.changes(poller.state).pipe(
      Stream.changesWith((a, b) => a?.status === b?.status && a?.applied === b?.applied),
      Stream.mapEffect(() => page(resolved, request)),
      Stream.changesWith((a, b) => a.content === b.content),
      Stream.map(({ value }): WatchResult => run(value)),
    )

    const reauthorizeMs = options.reauthorizeMs(actorType)

    const watchdog = Effect.gen(function* () {
      while (true) {
        const now = yield* Clock.currentTimeMillis

        const wait =
          request.expiresAt === undefined
            ? reauthorizeMs
            : Math.min(reauthorizeMs, Math.max(0, request.expiresAt - now))

        yield* Effect.sleep(wait)

        if (
          request.expiresAt !== undefined &&
          (yield* Clock.currentTimeMillis) >= request.expiresAt
        )
          return yield* denied("expired")

        if (!(yield* access("reauthorize"))) return yield* denied("access_denied")
      }
    })

    const counted = Effect.acquireRelease(
      Effect.sync(() => {
        poller.subscribers += 1
      }),
      () =>
        Effect.sync(() => {
          poller.subscribers -= 1
        }),
    )

    return Stream.unwrap(Effect.as(counted, pages)).pipe(
      Stream.merge(Stream.fromEffect(watchdog), { haltStrategy: "either" }),
    )
  })

  return subscribe
})

export type FleetSubscribe = Effect.Success<ReturnType<typeof fleetSubscriptions>>
