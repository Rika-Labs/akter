import {
  Cause,
  Clock,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Queue,
  Random,
  Result,
  Schema,
  Semaphore,
} from "effect"
import { SqlClient, Statement } from "effect/unstable/sql"
import type { ActorError } from "../../errors/actor.ts"
import { Outcome, Request } from "../request.ts"
import { type RegisteredJob } from "../members.ts"
import { progressPool } from "../jobs/progress.ts"
import {
  type CappedGroup,
  type ClaimedJob,
  groupLock,
  groupRow,
  jobAttempts,
} from "../jobs/attempt.ts"
import { CRON_PREFIX } from "../cron/key.ts"
import { type CronSchedule, cronTicks } from "../cron/schedule.ts"
import { TurnHooks } from "./hooks.ts"
import { count as tally, Metrics } from "../telemetry/metrics.ts"
import { SpanNames } from "../telemetry/spans.ts"
import { databaseTime, FrameworkClock } from "./admission.ts"
import { BUCKETS, CallerJson } from "./outbox.ts"
import type {
  Handoff,
  SubscriptionError,
  SubscriptionClaim,
  SubscriptionSlots,
  SubscriptionWork,
} from "../subscriptions/relay.ts"

/**
 * A drain whose deliveries keep staging due work after this many rounds, each
 * of which claimed every row then due, is a delivery loop.
 */
const DRAIN_ROUNDS = 100

/** The relay and executor pool settings of one runner, resolved from `Actors.layer`. */
export interface RelaySettings {
  /** Durable polling interval; each wait is jittered by ±10%. */
  readonly pollMs: number
  /** Intent rows claimed by one claim statement at most. */
  readonly passLimit: number
  /** Intents delivered at once on this runner. */
  readonly deliveryConcurrency: number
  /** How long a claimed intent stays out of every runner's scans. */
  readonly claimLeaseMs: () => number
  /** Cap on intent redelivery backoff. */
  readonly maxBackoffMs: number
  /** Job attempts running at once on this runner. */
  readonly executorConcurrency: number
  /** An attempt's claim; renewed every third of it while the attempt runs. */
  readonly executorLeaseMs: number
  /** How long after its due time a relay-written command id stays retryable. */
  readonly retryWindowMs: number
  /**
   * How often a running attempt renews its claim and checks for a
   * cancellation committed on another runner; at most a third of the lease.
   */
  readonly cancelCheckMs?: number | undefined
}

/** An executor this runner has, by actor type and job tag. */
interface LocalExecutor {
  readonly actor: string
  readonly job: string
  readonly registered: RegisteredJob
}

/**
 * The claim statement's result columns before its last three, in order: each
 * outbox column's source in the claimed row aliased `o`, and the value a
 * result row that claimed no outbox row carries in its place.
 */
const CLAIMED_COLUMNS = [
  ["kind", "o.kind", "NULL::text"],
  ["routing_key", "o.routing_key::text", "NULL::text"],
  ["intent_id", "o.intent_id", "NULL::text"],
  ["attempts", "o.attempts", "0"],
  ["last_error", "o.last_error", "NULL::text"],
  ["ambiguous", "o.ambiguous", "false"],
  ["tenant_id", "o.tenant_id", "NULL::text"],
  ["actor_type", "o.actor_type", "NULL::text"],
  ["actor_id", "o.actor_id", "NULL::text"],
  ["target_type", "o.target_type", "NULL::text"],
  ["target_id", "o.target_id", "NULL::text"],
  ["command", "o.command", "NULL::text"],
  ["payload", "o.payload", "NULL::text"],
  ["payload_version", "o.payload_version", "0"],
  ["caller", "o.caller", "NULL::text"],
  ["claimed_until", "o.due_at_ms::text", "NULL::text"],
  ["timer_key", "o.timer_key", "NULL::text"],
  ["scheduled_at", "o.scheduled_at_ms::text", "NULL::text"],
  ["cancelled", "o.cancelled_at_ms IS NOT NULL", "false"],
  ["maybe_applied", "o.maybe_applied", "false"],
] as const

/**
 * One row of the claim statement. An `intent` or `job` row is a claimed
 * outbox row; a `skipped-*` row claims nothing and reports a probe whose
 * candidates were all taken or locked; a `work` row carries claimed
 * subscription work in `work`.
 */
interface ClaimedRow extends ClaimedJob {
  readonly kind: "intent" | "job" | "skipped-intent" | "skipped-job" | "work"
  readonly target_type: string
  readonly target_id: string
  readonly timer_key: string | null
  readonly scheduled_at: string
  readonly candidates: number
  readonly work: string | null
}

/** The claimed columns of the outbox row aliased `o`. */
const claimedColumns = (sql: SqlClient.SqlClient) =>
  sql.literal(CLAIMED_COLUMNS.map(([name, source]) => `${source} AS ${name}`).join(", "))

/** The claimed columns of a result row that claimed no outbox row, with `kind` set. */
const unclaimedColumns = (sql: SqlClient.SqlClient, kind: string) =>
  sql`${kind}::text, ${sql.literal(
    CLAIMED_COLUMNS.slice(1)
      .map(([, , empty]) => empty)
      .join(", "),
  )}`

/**
 * The due-work probe: up to `limit` due rows of `kind` from one
 * `(bucket, kind, due_at_ms)` index range per bucket, so its cost follows due
 * rows of one kind, not stored actors or future timers. It takes no locks; a
 * claim locks only the rows it takes from it. `only` filters inside each
 * bucket's probe, so due rows the caller cannot claim never fill the
 * per-bucket limit ahead of rows it can.
 */
export const candidates = ({
  sql,
  kind,
  now,
  limit,
  only = sql.literal(""),
}: {
  readonly sql: SqlClient.SqlClient
  readonly kind: "intent" | "job" | "feed" | "control"
  readonly now: Statement.Fragment
  readonly limit: number
  readonly only?: Statement.Fragment
}) =>
  sql`SELECT o.routing_key, o.intent_id, o.actor_type, o.command
    FROM generate_series(${BUCKETS.first}::int, ${BUCKETS.last}::int) AS b(bucket)
    CROSS JOIN LATERAL (
      SELECT routing_key, intent_id, due_at_ms, actor_type, command FROM actor_outbox
      WHERE actor_outbox.bucket = b.bucket AND actor_outbox.kind = ${kind}
        AND actor_outbox.due_at_ms <= ${now} ${only}
      ORDER BY actor_outbox.due_at_ms LIMIT ${limit}
    ) o`

/** Intents to claim in one statement: up to `limit` free delivery slots. */
interface IntentClaim {
  readonly limit: number
  readonly leaseMs: number
  readonly maxBackoffMs: number
  /** Due candidates probed before locking; defaults to twice `limit`. */
  readonly probe?: number | undefined
  /** Actor types registered here; `$cron:` ticks of any other type are left for their runners. */
  readonly cronActors?: ReadonlyArray<string> | undefined
}

/** Jobs to claim in one statement: up to `permits`, only for local executors. */
interface JobClaim {
  readonly permits: number
  readonly leaseMs: number
  readonly executors: ReadonlyArray<LocalExecutor>
  /** Due candidates probed before locking; defaults to twice `permits`. */
  readonly probe?: number | undefined
}

/**
 * Claims due intents and due jobs in one autocommit statement. `now` is the
 * outbox clock: the database's statement start time plus the test offset,
 * which is never earlier than a row committed before the claim was sent. A
 * pass therefore costs one round trip whatever it claims.
 *
 * `SKIP LOCKED` passes over rows another runner is claiming, and each claim
 * moves the row's `due_at_ms` past its lease, so no runner scans it again
 * until the lease ends. An intent whose settle dies therefore waits
 * `max(lease, backoff(attempts))` instead of sorting ahead of newer work. A
 * job with no executor on this runner is never claimed here; it stays due for
 * a runner that has one. The two kinds never share a row, so the two updates
 * are disjoint. A kind that claims nothing although its probe found
 * candidates returns one `skipped-*` row with the candidate count, so the
 * relay can widen the next probe past rows other transactions hold locked.
 * Subscription work rides in the same statement, so a pass stays one round
 * trip.
 */
const claimDue = ({
  sql,
  now,
  intents,
  jobs,
  subscriptions,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: Statement.Fragment
  readonly intents?: IntentClaim | undefined
  readonly jobs?: JobClaim | undefined
  readonly subscriptions?: SubscriptionClaim | undefined
}) => {
  const parts: Array<Statement.Fragment> = []
  const results: Array<Statement.Fragment> = []

  if (intents !== undefined) {
    const { limit, leaseMs, maxBackoffMs, probe = 2 * limit, cronActors = [] } = intents
    const local = cronActors.length === 0 ? sql`` : sql` OR actor_type IN ${sql.in(cronActors)}`
    parts.push(sql`intent_candidates AS (
        ${candidates({
          sql,
          kind: "intent",
          now,
          limit: probe,
          only: sql`AND (timer_key IS NULL OR left(timer_key, 6) <> ${CRON_PREFIX}${local})`,
        })}
        ORDER BY o.due_at_ms LIMIT ${probe}
      ),
      intent_locked AS (
        SELECT o.routing_key, o.intent_id FROM actor_outbox o
        JOIN intent_candidates USING (routing_key, intent_id)
        WHERE o.kind = 'intent' AND o.due_at_ms <= ${now}
        ORDER BY o.due_at_ms LIMIT ${limit}
        FOR UPDATE OF o SKIP LOCKED
      ),
      intent_claimed AS (
        UPDATE actor_outbox o SET attempts = o.attempts + 1,
          due_at_ms = ${now} + greatest(${leaseMs}::bigint,
            least(1000 * power(2, least(o.attempts, 31)), ${maxBackoffMs}::bigint))::bigint
        FROM intent_locked c
        WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
        RETURNING ${claimedColumns(sql)},
          (SELECT count(*) FROM intent_candidates)::int AS candidates, false AS exhausted,
          NULL::text AS work
      )`)
    results.push(sql`SELECT * FROM intent_claimed`, skipped(sql, "intent"))
  }

  if (jobs !== undefined && jobs.executors.length > 0) {
    const { permits, leaseMs, executors, probe = 2 * permits } = jobs
    parts.push(sql`mine (actor_type, command, max_attempts) AS (
        VALUES ${sql.csv(
          executors.map(
            ({ actor, job, registered }) =>
              sql`(${actor}::text, ${job}::text, ${registered.attempts}::int)`,
          ),
        )}
      ),
      job_candidates AS (
        ${candidates({
          sql,
          kind: "job",
          now,
          limit: probe,
          only: sql.literal("AND (actor_type, command) IN (SELECT actor_type, command FROM mine)"),
        })}
        ORDER BY o.due_at_ms LIMIT ${probe}
      ),
      job_locked AS (
        SELECT o.routing_key, o.intent_id, o.attempts AS previous, m.max_attempts
        FROM actor_outbox o
        JOIN job_candidates USING (routing_key, intent_id)
        JOIN mine m ON m.actor_type = o.actor_type AND m.command = o.command
        WHERE o.kind = 'job' AND o.due_at_ms <= ${now}
        ORDER BY o.due_at_ms LIMIT ${permits}
        FOR UPDATE OF o SKIP LOCKED
      ),
      job_claimed AS (
        ${claimJobs(sql, now, leaseMs, sql`job_locked`, sql`(SELECT count(*) FROM job_candidates)::int`)}
      )`)
    results.push(sql`SELECT *, NULL::text AS work FROM job_claimed`, skipped(sql, "job"))
  }

  if (subscriptions !== undefined) {
    parts.push(...subscriptions.parts)

    for (const result of subscriptions.results)
      results.push(sql`SELECT ${unclaimedColumns(sql, "work")}, 0, false, claimed.work
        FROM (${result}) AS claimed`)
  }

  if (results.length === 0) return Effect.succeed([] as ReadonlyArray<ClaimedRow>)

  return sql<ClaimedRow>`WITH ${sql.csv(parts)}
    ${sql.join(" UNION ALL ", false)(results)}`
}

/**
 * Claims the job rows `locked` names. A cancelled row is claimed only to be
 * settled, so it keeps its attempts; any other row starts its next attempt
 * and runs, unless its last attempt already ended without an outcome or an
 * attempt's failure was final, either of which exhausts it. `maybe_applied`
 * then covers every attempt before this one. RETURNING sees the updated row,
 * so exhaustion is judged on the attempts before this claim.
 */
const claimJobs = (
  sql: SqlClient.SqlClient,
  now: Statement.Fragment,
  leaseMs: number,
  locked: Statement.Fragment,
  candidateCount: Statement.Fragment,
) => {
  const attempting = sql`o.cancelled_at_ms IS NULL AND o.attempts < c.max_attempts
    AND NOT o.final_failure`

  return sql`UPDATE actor_outbox o SET
      due_at_ms = ${now} + ${leaseMs}::bigint,
      attempts = CASE WHEN ${attempting} THEN o.attempts + 1 ELSE o.attempts END,
      ambiguous = CASE WHEN ${attempting} THEN true ELSE o.ambiguous END,
      maybe_applied = CASE WHEN ${attempting}
        THEN o.maybe_applied OR (o.attempts > 0 AND o.ambiguous) ELSE o.maybe_applied END,
      last_error = CASE WHEN ${attempting}
        THEN 'Attempt ' || (o.attempts + 1) || ' ended without reporting an outcome'
        ELSE o.last_error END,
      running = ${attempting},
      waiting = false
    FROM ${locked} c
    WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
    RETURNING ${claimedColumns(sql)}, ${candidateCount} AS candidates,
      o.cancelled_at_ms IS NULL
        AND (c.previous >= c.max_attempts OR o.final_failure) AS exhausted`
}

/** A due group, with the due rows the probe read: at `limit` or more it may have hidden others. */
interface DueGroup extends CappedGroup {
  readonly due_rows: number
}

/**
 * The actors with due rows of capped jobs this runner executes, oldest first;
 * at most `limit`. Like the uncapped probe, it reads one index range per
 * bucket and takes no locks.
 */
const cappedGroups = ({
  sql,
  now,
  executors,
  limit,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: Statement.Fragment
  readonly executors: ReadonlyArray<LocalExecutor>
  readonly limit: number
}) =>
  sql<DueGroup>`WITH mine (actor_type, command) AS (
      VALUES ${sql.csv(executors.map(({ actor, job }) => sql`(${actor}::text, ${job}::text)`))}
    ),
    due AS (
      ${candidates({
        sql,
        kind: "job",
        now,
        limit,
        only: sql.literal("AND (actor_type, command) IN (SELECT actor_type, command FROM mine)"),
      })}
    )
    SELECT o.routing_key::text AS routing_key, o.tenant_id, o.actor_type, o.actor_id, o.command,
      (SELECT count(*) FROM due)::int AS due_rows
    FROM actor_outbox o JOIN due USING (routing_key, intent_id)
    GROUP BY o.routing_key, o.tenant_id, o.actor_type, o.actor_id, o.command
    ORDER BY min(o.due_at_ms) LIMIT ${limit}`

/**
 * Claims one capped group's jobs in its own transaction, under the group's
 * advisory lock, so claims on every runner see each other's running rows. It
 * settles cancelled rows whose attempt ended, starts the oldest rows by
 * `(ready_at_ms, intent_id)` while fewer than `cap` attempts hold a live
 * lease, and moves the group's other due rows out of the due range as
 * waiting, so they never fill a probe ahead of other actors' work. A waiting
 * row becomes due again when an attempt of its group settles, or after one
 * lease.
 *
 * An attempt renews, backs off, and settles its own row without the group's
 * lock, so before it counts live leases the claim waits for those writes on
 * the group's running rows. Otherwise `SKIP LOCKED` would pass over an older
 * row whose lost lease is being renewed and start a younger one, and the
 * renewal would then leave two attempts holding leases under a cap of one.
 */
export const claimCapped = ({
  sql,
  now,
  group,
  cap,
  maxAttempts,
  permits,
  leaseMs,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: Statement.Fragment
  readonly group: CappedGroup
  readonly cap: number
  readonly maxAttempts: number
  readonly permits: number
  readonly leaseMs: number
}) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* groupLock({ sql, group })
      const inGroup = groupRow({ sql, group })
      yield* sql`SELECT 1 FROM actor_outbox o WHERE ${inGroup} AND o.running FOR UPDATE OF o`

      return yield* sql<ClaimedRow>`WITH live AS (
          SELECT count(*)::int AS n FROM actor_outbox o
          WHERE ${inGroup} AND o.running AND o.due_at_ms > ${now}
        ),
        settle AS (
          SELECT o.routing_key, o.intent_id, o.attempts AS previous, ${maxAttempts}::int AS max_attempts
          FROM actor_outbox o
          WHERE ${inGroup} AND o.cancelled_at_ms IS NOT NULL AND o.due_at_ms <= ${now}
          ORDER BY o.due_at_ms, o.intent_id
          LIMIT ${permits}::int
          FOR UPDATE OF o SKIP LOCKED
        ),
        next AS (
          SELECT o.routing_key, o.intent_id, o.attempts AS previous, ${maxAttempts}::int AS max_attempts
          FROM actor_outbox o
          WHERE ${inGroup} AND o.cancelled_at_ms IS NULL
            AND (o.due_at_ms <= ${now} OR (o.waiting AND NOT o.running))
          ORDER BY o.ready_at_ms, o.intent_id
          LIMIT greatest(0, least(${cap}::int - (SELECT n FROM live),
            ${permits}::int - (SELECT count(*)::int FROM settle)))
          FOR UPDATE OF o SKIP LOCKED
        ),
        locked AS (SELECT * FROM settle UNION ALL SELECT * FROM next),
        claimed AS (${claimJobs(sql, now, leaseMs, sql`locked`, sql`0`)}),
        deferred AS (
          UPDATE actor_outbox o SET waiting = true, running = false,
            due_at_ms = ${now} + ${leaseMs}::bigint
          WHERE ${inGroup} AND o.cancelled_at_ms IS NULL AND o.due_at_ms <= ${now}
            AND o.intent_id NOT IN (SELECT intent_id FROM next)
            AND o.intent_id IN (
              SELECT o.intent_id FROM actor_outbox o
              WHERE ${inGroup} AND o.cancelled_at_ms IS NULL AND o.due_at_ms <= ${now}
              FOR UPDATE OF o SKIP LOCKED
            )
          RETURNING 1
        )
        SELECT * FROM claimed`
    }),
  )

/** One row reporting `kind`'s candidates when its claim took none of them. */
const skipped = (sql: SqlClient.SqlClient, kind: "intent" | "job") => {
  const claimed = sql.literal(`${kind}_claimed`)
  const found = sql.literal(`${kind}_candidates`)

  return sql`SELECT ${unclaimedColumns(sql, `skipped-${kind}`)},
      (SELECT count(*) FROM ${found})::int, false, NULL::text
    WHERE NOT EXISTS (SELECT 1 FROM ${claimed}) AND EXISTS (SELECT 1 FROM ${found})`
}

/** The outbox clock inside a statement: its start time on the database plus the test offset. */
export const outboxNow = ({
  sql,
  offsetMillis,
}: {
  readonly sql: SqlClient.SqlClient
  readonly offsetMillis: number
}) =>
  sql`(floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint + ${offsetMillis}::bigint)`

/** The intent half of `claimDue` at a fixed `now`, as a statement to inspect. */
export const claimIntents = ({
  sql,
  now,
  ...intents
}: IntentClaim & { readonly sql: SqlClient.SqlClient; readonly now: number }) =>
  claimDue({
    sql,
    now: sql`${now}::bigint`,
    intents,
  }) as Statement.Statement<ClaimedRow>

/** The widest probe, as a multiple of twice the free capacity. */
const MAX_WIDEN = 64

/** Logs a non-interrupt failure of the work under `message` and completes with `void`; an interruption stays one. */
const logFailure =
  (message: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
    Effect.catchCause(self, (cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError(message, cause),
    )

/**
 * One family of claimed work on this runner: its running fibers, how many may
 * run at once, and what its last claim saw. A claim takes at most `free` rows
 * of the family, so no claimed row waits locally while its lease runs down.
 * When the last claim saw more due candidates than it took, each finishing
 * fiber wakes the relay to claim again instead of waiting for the poll; when
 * it also left room, which happens when other transactions hold the earliest
 * rows locked, the next probe doubles, up to `MAX_WIDEN`.
 */
const lane = Effect.fnUntraced(function* (capacity: number, wake: Effect.Effect<void>) {
  const fibers = yield* FiberSet.make<unknown, unknown>()
  let more = false
  let widen = 1

  return {
    fibers,
    /** Rows a claim may take now. */
    free: Effect.map(FiberSet.size(fibers), (running) => capacity - running),
    /** The probe size for `free` rows. */
    probe: (free: number) => 2 * free * widen,
    get more() {
      return more
    },
    /** Records what a claim of up to `free` rows took and how many due candidates it found. */
    claimed: (free: number, taken: number, found: number) => {
      more = taken > 0 && found > taken
      widen = taken < free && found > taken ? Math.min(widen * 2, MAX_WIDEN) : 1
    },
    /** Records whether a claim may have left due rows of the family behind. */
    backlog: (left: boolean) => {
      more = left
    },
    /** Runs `work` on the family; its end wakes the relay when rows were left due. */
    start: <A, E, R>(work: Effect.Effect<A, E, R>) =>
      FiberSet.run(
        fibers,
        work.pipe(Effect.ensuring(Effect.suspend(() => (more ? wake : Effect.void)))),
      ).pipe(Effect.asVoid),
  }
})

/**
 * The outbox relay of one runner among any number sharing the database. Each
 * pass claims, for every family of work (intents, job attempts, and feed,
 * control, and subscription work), only as many rows as the family has free
 * fibers, then starts each one at once. A pass runs uninterruptibly under a
 * lock, so every row a claim returns reaches a fiber that can release it.
 * When both capped and uncapped jobs are due, passes alternate which claims
 * first, so a steady stream of either can't take every permit.
 *
 * An intent is delivered as a direct command whose command id is the intent
 * id, and its row is deleted only after the receiver's receipt has committed.
 * A crash leaves the claim in place until its lease ends; any runner then
 * redelivers, and the receipt deduplicates. A row that cannot form a request,
 * a delivery that fails, and a defect outcome back off and retry with no retry
 * limit; the logged warning and `attempts` are the operator signal. A declared
 * failure is a committed receipt, so only a missing receipt retries. An
 * interrupted delivery makes its row due at once.
 *
 * A job attempt runs on its own family and settles its row itself; see
 * `jobAttempts`. A running attempt is registered before the pass releases its
 * lock and until its outcome is written, so every clock jump after the claim
 * moves its lease; a local cancellation signals running attempts directly.
 *
 * Subscription work runs in its own families, so a subscription backlog never
 * delays intents, timers, or jobs; expansion work starts the rows it leased
 * without a claim pass; `schedules` names the cron actors whose ticks this
 * runner claims. The returned handle: `run` loops passes on a jittered poll
 * and `wake`; `drain` waits for in-flight work, which may stage more, then
 * claims again until a claim finds nothing while nothing was running (work
 * runs only on fibers a pass starts, so none running means nothing can stage
 * rows after that claim read), failing if deliveries keep staging due work,
 * and counting toward that limit only rounds that drained every due row;
 * `stop` ends claims and interrupts deliveries at once, since a delivery only
 * waits on a turn its receiver's owner finishes or rolls back on its own, and
 * the receiver's receipt answers a redelivery of work that did commit;
 * `interruptAttempts` interrupts running attempts and returns how many,
 * leaving their claims and `ambiguous` marks because the provider may have
 * applied the call, so another runner takes the job over once the lease ends;
 * `attemptsIdle` waits for attempts to end; `extendLeases` moves running
 * attempts' leases with a jump of the outbox clock, as the renewals during
 * that time would have, holding the pass lock so no claim reads the clock
 * between the moved leases and the jump; `cancelled` makes running attempts
 * check for cancellation now. Closing the scope stops further claims, after
 * taking the lock so a pass in progress hands its rows to fibers first and
 * they are interrupted and released.
 */
export const outboxRelay = Effect.fnUntraced(function* (
  deliver: (request: Request) => Effect.Effect<Outcome, ActorError>,
  executors: () => ReadonlyArray<LocalExecutor>,
  settings: RelaySettings,
  subscriptions?: {
    /** Feed, control, and subscription-delivery slots, each; separate from intent slots. */
    readonly concurrency: number
    readonly claim: (slots: SubscriptionSlots) => SubscriptionClaim | undefined
    readonly decode: (work: string) => Effect.Effect<SubscriptionWork>
    readonly run: (
      work: SubscriptionWork,
      handoff: Handoff,
    ) => Effect.Effect<void, SubscriptionError>
  },
  schedules: () => ReadonlyMap<string, CronSchedule> = () => new Map(),
) {
  const sql = yield* SqlClient.SqlClient
  const services = yield* Effect.context<SqlClient.SqlClient>()
  const lock = Semaphore.makeUnsafe(1)
  const signals = yield* Queue.sliding<void>(1)
  const wakeRelay = Queue.offer(signals, undefined).pipe(Effect.asVoid)
  const workConcurrency = subscriptions?.concurrency ?? 0

  const lanes = {
    intents: yield* lane(settings.deliveryConcurrency, wakeRelay),
    jobs: yield* lane(settings.executorConcurrency, wakeRelay),
    feed: yield* lane(workConcurrency, wakeRelay),
    control: yield* lane(workConcurrency, wakeRelay),
    subscription: yield* lane(workConcurrency, wakeRelay),
  }

  const hooks = yield* TurnHooks
  let cancelChecks = Deferred.makeUnsafe<void>()

  const renewEveryMs = Math.min(
    settings.cancelCheckMs ?? settings.executorLeaseMs / 3,
    settings.executorLeaseMs / 3,
  )

  const attempt = yield* jobAttempts({
    progress: yield* progressPool(),
    leaseMs: settings.executorLeaseMs,
    renewEveryMs,
    wake: wakeRelay,
  })

  const ticks = cronTicks({
    sql,
    crypto: yield* Crypto.Crypto,
    schedules,
    retryWindowMs: settings.retryWindowMs,
  })

  const startWork = (work: SubscriptionWork): Effect.Effect<void> =>
    subscriptions === undefined
      ? Effect.void
      : lanes[work.kind].start(
          subscriptions.run(work, handoff).pipe(logFailure("Subscription relay work failed")),
        )

  const handoff: Handoff = { free: lanes.subscription.free, start: startWork }
  let cappedTurn = false
  let stopping = false

  const running = new Map<
    string,
    {
      readonly routingKey: bigint
      readonly attempt: number
      readonly lease: { until: number }
    }
  >()

  const backoffMs = (attempts: number) =>
    Math.min(1000 * 2 ** Math.max(attempts - 1, 0), settings.maxBackoffMs)

  const requestOf = (row: ClaimedRow) =>
    Schema.decodeEffect(CallerJson)(row.caller).pipe(
      Effect.flatMap((caller) =>
        Schema.decodeEffect(Request)({
          ref: { tenant: row.tenant_id, actor: row.target_type, id: row.target_id },
          caller,
          command: row.command,
          commandId: row.intent_id,
          payload: row.payload,
        }),
      ),
    )

  const deliverIntent = Effect.fnUntraced(function* (row: ClaimedRow) {
    const routingKey = BigInt(row.routing_key)

    const claim = sql`routing_key = ${routingKey} AND intent_id = ${row.intent_id}
      AND kind = 'intent' AND due_at_ms = ${BigInt(row.claimed_until)}`

    const retryLater = (reason: string, cause: unknown) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Outbox delivery failed; retrying with backoff", cause).pipe(
          Effect.annotateLogs({
            actor: row.target_type,
            id: row.target_id,
            tenant: row.tenant_id,
            command: row.command,
            commandId: row.intent_id,
            reason,
          }),
        )
        yield* sql`UPDATE actor_outbox SET due_at_ms = ${(yield* databaseTime) + backoffMs(row.attempts)}
          WHERE ${claim}`
        yield* tally(Metrics.relayRetried, { kind: "intent" }, 1)
      })

    return yield* Effect.gen(function* () {
      const tick = ticks.isTick(row)
      const route = tick ? yield* ticks.settleUnfired(row, claim, backoffMs(row.attempts)) : row

      if (route === undefined) return

      const decoded = yield* requestOf({ ...row, ...route }).pipe(Effect.result)

      if (Result.isFailure(decoded)) return yield* retryLater("UnreadableRow", decoded.failure)

      const request = decoded.success
      yield* hooks.at("afterClaim", request)

      const delivered = yield* deliver(request).pipe(Effect.result)

      if (Result.isFailure(delivered))
        return yield* retryLater(delivered.failure.reason._tag, delivered.failure)

      if (Outcome.guards.Defect(delivered.success))
        return yield* retryLater("Defect", delivered.success.cause)

      yield* hooks.at("beforeOutboxDelete", request)

      if (tick) yield* ticks.settleFired(row, claim)
      else yield* sql`DELETE FROM actor_outbox WHERE ${claim}`

      yield* tally(Metrics.relayDelivered, { kind: "intent" }, 1)
    }).pipe(
      Effect.withSpan(
        SpanNames.relayIntent,
        {
          kind: "producer",
          attributes: {
            "actor.type": row.target_type,
            "actor.tenant": row.tenant_id,
            "actor.id": row.target_id,
            "command.name": row.command,
            "command.id": row.intent_id,
            "relay.attempt": row.attempts,
            "relay.timer": row.timer_key !== null,
          },
        },
        { captureStackTrace: false },
      ),
      Effect.onInterrupt(() =>
        databaseTime.pipe(
          Effect.flatMap((at) => sql`UPDATE actor_outbox SET due_at_ms = ${at} WHERE ${claim}`),
          Effect.ignore,
        ),
      ),
    )
  })

  const cancelled = Effect.sync(() => {
    const previous = cancelChecks
    cancelChecks = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(previous, Exit.void)
  })

  const all = Object.values(lanes)
  const interruptible = all.filter((family) => family !== lanes.jobs)

  const inFlight = Effect.map(
    Effect.forEach(all, (family) => FiberSet.size(family.fibers)),
    (sizes) => sizes.reduce((sum, size) => sum + size, 0),
  )

  const pass = lock
    .withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (stopping) return { claimed: 0, backlog: false, quiet: true }

          const quiet = (yield* inFlight) === 0
          const slots = Math.min(yield* lanes.intents.free, settings.passLimit)
          const local = executors()
          const uncapped = local.filter(({ registered }) => registered.perActor === undefined)
          const capped = local.filter(({ registered }) => registered.perActor !== undefined)
          const permits = yield* lanes.jobs.free
          const claimedAt = yield* Clock.currentTimeNanos
          const claimSignal = cancelChecks
          const clock = yield* FrameworkClock

          const workSlots =
            subscriptions === undefined
              ? undefined
              : {
                  feed: yield* lanes.feed.free,
                  control: yield* lanes.control.free,
                  subscription: yield* lanes.subscription.free,
                }

          const now = outboxNow({ sql, offsetMillis: clock.offsetMillis() })

          const claimGroups = (limit: number) =>
            Effect.gen(function* () {
              const claimed: Array<ClaimedRow> = []
              const groups = yield* cappedGroups({ sql, now, executors: capped, limit })

              for (const group of groups) {
                const left = limit - claimed.length

                if (left <= 0) break

                const { registered } = capped.find(
                  ({ actor, job }) => actor === group.actor_type && job === group.command,
                )!

                claimed.push(
                  ...(yield* claimCapped({
                    sql,
                    now,
                    group,
                    cap: registered.perActor!,
                    maxAttempts: registered.attempts,
                    permits: left,
                    leaseMs: settings.executorLeaseMs,
                  })),
                )
              }

              const backlog = groups.length === limit || (groups[0]?.due_rows ?? 0) >= limit

              return { claimed, backlog }
            })

          const cappedFirst = capped.length > 0 && uncapped.length > 0 && cappedTurn

          if (capped.length > 0 && uncapped.length > 0) cappedTurn = !cappedTurn

          const early =
            cappedFirst && permits > 0
              ? yield* claimGroups(permits)
              : { claimed: [], backlog: false }

          const uncappedPermits = permits - early.claimed.length

          const rows = yield* claimDue({
            sql,
            now,
            intents:
              slots > 0
                ? {
                    limit: slots,
                    leaseMs: settings.claimLeaseMs(),
                    maxBackoffMs: settings.maxBackoffMs,
                    probe: lanes.intents.probe(slots),
                    cronActors: [...schedules().keys()],
                  }
                : undefined,
            jobs:
              uncappedPermits > 0 && uncapped.length > 0
                ? {
                    permits: uncappedPermits,
                    leaseMs: settings.executorLeaseMs,
                    executors: uncapped,
                    probe: lanes.jobs.probe(uncappedPermits),
                  }
                : undefined,
            subscriptions: workSlots === undefined ? undefined : subscriptions!.claim(workSlots),
          })

          const found = (kind: "intent" | "job", taken: ReadonlyArray<ClaimedRow>) =>
            (taken[0] ?? rows.find((row) => row.kind === `skipped-${kind}`))?.candidates ?? 0

          const intents = rows.filter((row) => row.kind === "intent")
          const uncappedRows = rows.filter((row) => row.kind === "job")

          const late =
            !cappedFirst && capped.length > 0 && uncappedPermits - uncappedRows.length > 0
              ? yield* claimGroups(uncappedPermits - uncappedRows.length)
              : { claimed: [], backlog: false }

          const jobs = [...early.claimed, ...uncappedRows, ...late.claimed]

          if (slots > 0) lanes.intents.claimed(slots, intents.length, found("intent", intents))

          if (permits > 0 && local.length > 0) {
            lanes.jobs.claimed(uncappedPermits, uncappedRows.length, found("job", uncappedRows))

            if (early.backlog || late.backlog) lanes.jobs.backlog(true)
          }

          let claimedWork = 0

          if (subscriptions !== undefined && workSlots !== undefined) {
            const work = yield* Effect.forEach(
              rows.filter((row) => row.kind === "work"),
              (row) => subscriptions.decode(row.work!),
            )

            claimedWork = work.length

            for (const kind of ["feed", "control", "subscription"] as const) {
              const taken = work.filter((item) => item.kind === kind).length

              lanes[kind].backlog(workSlots[kind] > 0 && taken >= workSlots[kind])
            }

            for (const item of work) yield* startWork(item)
          }

          for (const row of intents)
            yield* lanes.intents.start(
              deliverIntent(row).pipe(logFailure("Outbox relay crashed settling a row")),
            )

          for (const row of jobs) {
            const registered = local.find(
              ({ actor, job }) => actor === row.actor_type && job === row.command,
            )!.registered

            const lease = { until: Number(row.claimed_until) }

            running.set(row.intent_id, {
              routingKey: BigInt(row.routing_key),
              attempt: row.attempts,
              lease,
            })

            yield* lanes.jobs.start(
              attempt(row, registered, {
                at: claimedAt,
                signal: claimSignal,
                next: () => cancelChecks,
                lease,
              }).pipe(
                Effect.ensuring(Effect.sync(() => running.delete(row.intent_id))),
                logFailure("Job attempt crashed before it settled"),
              ),
            )
          }

          return {
            claimed: intents.length + jobs.length + claimedWork,
            backlog: all.some((family) => family.more),
            quiet,
          }
        }),
      ),
    )
    .pipe(Effect.provideContext(services))

  const run = Effect.gen(function* () {
    while (true) {
      const jitter = 0.9 + 0.2 * (yield* Random.next)
      yield* Queue.take(signals).pipe(Effect.timeoutOption(settings.pollMs * jitter))
      yield* pass.pipe(logFailure("Outbox relay pass failed"))
    }
  })

  const idle = Effect.forEach(all, (family) => FiberSet.awaitEmpty(family.fibers), {
    discard: true,
  })

  const drain = Effect.gen(function* () {
    for (let rounds = 0; rounds < DRAIN_ROUNDS;) {
      yield* idle
      const { claimed, backlog, quiet } = yield* pass

      if (claimed === 0 && quiet) return

      if (claimed > 0 && !backlog) rounds++
    }

    return yield* Effect.die(new Error("Outbox did not settle; intents keep producing due work"))
  }).pipe(Effect.orDie)

  const halt = lock.withPermit(
    Effect.sync(() => {
      stopping = true
    }),
  )

  yield* Effect.addFinalizer(() => halt)

  const extendLeases = (millis: number, jump: Effect.Effect<void>) =>
    lock
      .withPermit(
        Effect.forEach(
          [...running],
          ([intentId, { routingKey, attempt: current, lease }]) =>
            sql`UPDATE actor_outbox SET due_at_ms = due_at_ms + ${millis}
            WHERE routing_key = ${routingKey} AND intent_id = ${intentId}
              AND kind = 'job' AND attempts = ${current}`.pipe(
              Effect.tap(
                Effect.sync(() => {
                  lease.until += millis
                }),
              ),
            ),
          { discard: true },
        ).pipe(Effect.andThen(jump)),
      )
      .pipe(Effect.orDie)

  const stop = Effect.andThen(
    halt,
    Effect.forEach(interruptible, (family) => FiberSet.clear(family.fibers), { discard: true }),
  )

  const interruptAttempts = Effect.flatMap(FiberSet.size(lanes.jobs.fibers), (count) =>
    FiberSet.clear(lanes.jobs.fibers).pipe(Effect.as(count)),
  )

  return {
    run,
    drain,
    stop,
    attemptsIdle: FiberSet.awaitEmpty(lanes.jobs.fibers),
    interruptAttempts,
    extendLeases,
    wake: wakeRelay,
    cancelled,
  }
})
