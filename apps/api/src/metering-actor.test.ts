import {
  BillingProviderError,
  type UsageEvent,
  StripeBilling,
  type UsageReceipt,
} from "@akter/billing"
import { BunCrypto } from "@effect/platform-bun"
import { Actor, User } from "@rikalabs/akter"
import { ActorTest } from "@rikalabs/akter/testing"
import {
  Config,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import {
  CustomerUnbound,
  EventConflict,
  HourOpen,
  TenantUnbound,
  UsageActor,
  UsageActorLive,
  type MeterEvent,
  usageKey,
} from "./metering-actor.ts"

/** A fresh database on the server at TEST_DATABASE_URL, dropped with the scope. */
const database = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `api_metering_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

const time = { now: 1_800_000_000_000 }

/** The provider's side: what it was sent, and how it answers. */
const provider = {
  sent: [] as Array<ReadonlyArray<UsageEvent>>,
  mode: "accept" as "accept" | "retryable" | "rejected" | "lose",
}

const unused = Effect.die("not used by metering tests")

const FakeBilling = Layer.succeed(
  StripeBilling,
  StripeBilling.of({
    ensureCatalog: unused,
    ensureCustomer: () => unused,
    startCheckout: () => unused,
    openPortal: () => unused,
    changeSubscription: () => unused,
    reconcileSubscription: () => unused,
    billingDetails: () => unused,
    paymentMethod: () => unused,
    invoices: () => unused,
    recordUsage: (events) =>
      Effect.suspend((): Effect.Effect<UsageReceipt, BillingProviderError> => {
        provider.sent.push(events)

        if (provider.mode === "retryable" || provider.mode === "rejected")
          return Effect.fail(
            BillingProviderError.make({
              operation: "recordUsage",
              message: "provider refused",
              retryable: provider.mode === "retryable",
            }),
          )

        return Effect.succeed({ identifiers: [], batches: 1 })
      }),
    verifyWebhook: () => unused,
  }),
)

class DatabaseUrl extends Context.Service<DatabaseUrl, Redacted.Redacted<string>>()(
  "@akter/api/metering-actor.test/DatabaseUrl",
) {}

const live = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* database

    return Layer.mergeAll(
      UsageActorLive({ clock: Effect.sync(() => time.now) }),
      Layer.succeed(DatabaseUrl, url),
    ).pipe(Layer.provide(FakeBilling), Layer.provideMerge(ActorTest.layer({ database: url })))
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

afterEach(() => {
  provider.mode = "accept"
  provider.sent.length = 0
  time.now = 1_800_000_000_000
})

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

const hourOf = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso))

const OCTOBER = hourOf("2026-10-01T00:00:00Z")

const HOUR = 3_600_000

const request = (
  eventId: string,
  hour: number,
  fields: Partial<Extract<typeof MeterEvent.Type, { kind: "command" | "read" }>> = {},
): typeof MeterEvent.Type => ({
  kind: "command",
  eventId,
  actorType: "Room",
  actorId: "r1",
  commandId: `cmd-${eventId}`,
  requestToken: null,
  hour,
  ...fields,
})

const storage = (
  eventId: string,
  hour: number,
  storageByteHours: number,
): typeof MeterEvent.Type => ({
  kind: "storage",
  eventId,
  hour,
  storageByteHours,
})

const sql = SqlClient.SqlClient

const bind = (deployment: string, tenant: string, organizationId: string, projectId: string) =>
  Effect.gen(function* () {
    const client = yield* sql

    yield* client`
      INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id)
      VALUES (${deployment}, ${tenant}, ${organizationId}, ${projectId})
      ON CONFLICT (deployment_id, tenant) DO UPDATE
      SET organization_id = excluded.organization_id, project_id = excluded.project_id
    `
  }).pipe(Effect.orDie)

const customer = (organizationId: string, customerId: string) =>
  Effect.gen(function* () {
    const client = yield* sql

    yield* client`
      INSERT INTO cloud_billing_account (organization_id, customer_id)
      VALUES (${organizationId}, ${customerId})
      ON CONFLICT (organization_id) DO UPDATE SET customer_id = excluded.customer_id
    `
  }).pipe(Effect.orDie)

const reserve = (
  organizationId: string,
  period: string,
  deployment: string,
  tenant: string,
  actorType: string,
  actorId: string,
  key: string,
  kind: "command" | "read",
) =>
  Effect.gen(function* () {
    const client = yield* sql
    const units = kind === "command" ? 5 : 1
    const identity = yield* json([deployment, tenant, actorType, actorId, key]).pipe(Effect.orDie)

    yield* client`
      INSERT INTO cloud_usage_account (organization_id, period, reserved_units)
      VALUES (${organizationId}, ${period}, ${units})
      ON CONFLICT (organization_id, period)
      DO UPDATE SET reserved_units = cloud_usage_account.reserved_units + ${units}
    `
    yield* client`
      INSERT INTO cloud_usage_reservation (identity, organization_id, project_id, period,
        deployment_id, tenant, actor_type, actor_id, command_id, kind, units)
      VALUES (${identity}, ${organizationId}, 'p', ${period}, ${deployment}, ${tenant},
        ${actorType}, ${actorId}, ${key}, ${kind}, ${units})
    `

    return identity
  }).pipe(Effect.orDie)

interface AccountRow {
  readonly period: string
  readonly command_units: number
  readonly reserved_units: number
  readonly storage_gb_months: number
}

const accountRows = (organizationId: string) =>
  Effect.gen(function* () {
    const client = yield* sql

    return yield* client<AccountRow>`
      SELECT period, command_units::float8 AS command_units, reserved_units::float8 AS reserved_units,
        storage_gb_months FROM cloud_usage_account
      WHERE organization_id = ${organizationId} ORDER BY period
    `
  }).pipe(Effect.orDie)

interface HourRow {
  readonly tenant: string
  readonly project_id: string
  readonly hour: number
  readonly command_count: number
  readonly read_count: number
  readonly storage_byte_hours: number
  readonly sealed: boolean
  readonly sent: boolean
}

const hourRows = (organizationId: string) =>
  Effect.gen(function* () {
    const client = yield* sql

    return yield* client<HourRow>`
      SELECT tenant, project_id, (extract(epoch FROM hour) * 1000)::float8 AS hour,
        command_count::int AS command_count, read_count::int AS read_count, storage_byte_hours,
        sealed, sent
      FROM cloud_usage_hour WHERE organization_id = ${organizationId}
      ORDER BY tenant, project_id, hour
    `
  }).pipe(Effect.orDie)

const evidence = (key: string) =>
  Effect.gen(function* () {
    const client = yield* sql

    return yield* client<{
      readonly event_id: string
      readonly late: boolean
      readonly organization_id: string
      readonly project_id: string
    }>`
      SELECT event_id, late, organization_id, project_id FROM cloud_meter_evidence
      WHERE actor_id = ${key} ORDER BY event_id
    `
  }).pipe(Effect.orDie)

const reservationState = (identity: string) =>
  Effect.gen(function* () {
    const client = yield* sql
    const [row] = yield* client<{ readonly state: string }>`
      SELECT state FROM cloud_usage_reservation WHERE identity = ${identity}
    `

    return row?.state
  }).pipe(Effect.orDie)

const usage = (deployment: string, tenant: string) =>
  Effect.gen(function* () {
    const key = yield* usageKey(deployment, tenant)
    const actor = yield* UsageActor.get(key)
    const test = yield* ActorTest

    return { key, actor, test }
  })

const exhaust = ActorTest.use((test) =>
  Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], () => test.advance("3 hours"), {
    discard: true,
  }),
)

const json = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Finite]))),
)

describe("UsageActor import", () => {
  it("counts each event once into its project's hour and its organization's month, settling reservations in their own period", () =>
    run(
      Effect.gen(function* () {
        yield* bind("dep-a", "t1", "org-a", "proj-1")
        yield* bind("dep-a", "t2", "org-a", "proj-2")
        yield* bind("dep-a", "t3", "org-b", "proj-3")
        const { actor, key } = yield* usage("dep-a", "t1")
        const other = yield* usage("dep-a", "t2")
        const outsider = yield* usage("dep-a", "t3")

        const commandReservation = yield* reserve(
          "org-a",
          "2026-09",
          "dep-a",
          "t1",
          "Room",
          "r1",
          "cmd-c1",
          "command",
        )
        const readReservation = yield* reserve(
          "org-a",
          "2026-09",
          "dep-a",
          "t1",
          "Room",
          "r1",
          "tok-1",
          "read",
        )
        const unused = yield* reserve(
          "org-a",
          "2026-09",
          "dep-a",
          "t1",
          "Room",
          "r1",
          "cmd-never",
          "command",
        )

        const result = yield* actor.Import({
          events: [
            request("c1", OCTOBER, { commandId: "cmd-c1" }),
            request("r1", OCTOBER, { kind: "read", commandId: null, requestToken: "tok-1" }),
            request("internal", OCTOBER, { commandId: "job-route" }),
          ],
        })

        expect(result).toEqual({ imported: 3, duplicates: 0, late: [] })
        yield* other.actor.Import({ events: [request("c2", OCTOBER, { actorId: "r2" })] })
        yield* outsider.actor.Import({ events: [request("c3", OCTOBER + HOUR)] })

        expect(yield* accountRows("org-a")).toEqual([
          { period: "2026-09", command_units: 0, reserved_units: 5, storage_gb_months: 0 },
          { period: "2026-10", command_units: 16, reserved_units: 0, storage_gb_months: 0 },
        ])
        expect(yield* reservationState(commandReservation)).toBe("committed")
        expect(yield* reservationState(readReservation)).toBe("committed")
        expect(yield* reservationState(unused)).toBe("reserved")

        expect(yield* hourRows("org-a")).toEqual([
          {
            tenant: "t1",
            project_id: "proj-1",
            hour: OCTOBER,
            command_count: 2,
            read_count: 1,
            storage_byte_hours: 0,
            sealed: false,
            sent: false,
          },
          {
            tenant: "t2",
            project_id: "proj-2",
            hour: OCTOBER,
            command_count: 1,
            read_count: 0,
            storage_byte_hours: 0,
            sealed: false,
            sent: false,
          },
        ])
        expect(yield* hourRows("org-b")).toEqual([
          {
            tenant: "t3",
            project_id: "proj-3",
            hour: OCTOBER + HOUR,
            command_count: 1,
            read_count: 0,
            storage_byte_hours: 0,
            sealed: false,
            sent: false,
          },
        ])
        expect(yield* accountRows("org-b")).toEqual([
          { period: "2026-10", command_units: 5, reserved_units: 0, storage_gb_months: 0 },
        ])
        expect(
          (yield* evidence(key)).map((row) => [row.event_id, row.organization_id, row.project_id]),
        ).toEqual([
          ["c1", "org-a", "proj-1"],
          ["internal", "org-a", "proj-1"],
          ["r1", "org-a", "proj-1"],
        ])
      }),
    ))

  it("adds a storage sample as gigabyte-months of the month's actual hours, and binds a wildcard tenant", () =>
    run(
      Effect.gen(function* () {
        yield* bind("dep-star", "*", "org-star", "proj-star")
        yield* bind("dep-star", "special", "org-special", "proj-special")
        const { actor } = yield* usage("dep-star", "anything")
        const special = yield* usage("dep-star", "special")
        const february = hourOf("2027-02-10T00:00:00Z")

        yield* actor.Import({ events: [storage("s1", february, 4_000_000_000 * 10)] })
        yield* special.actor.Import({ events: [request("sp", february)] })

        expect(yield* accountRows("org-star")).toEqual([
          { period: "2027-02", command_units: 0, reserved_units: 0, storage_gb_months: 40 / 672 },
        ])
        expect((yield* hourRows("org-star"))[0]).toMatchObject({
          project_id: "proj-star",
          storage_byte_hours: 40_000_000_000,
        })
        expect(yield* hourRows("org-special")).toHaveLength(1)
      }),
    ))

  it("imports repeated and overlapping batches once, and undoes a batch that contradicts an earlier event", () =>
    run(
      Effect.gen(function* () {
        yield* bind("dep-dup", "t", "org-dup", "proj-dup")
        const { actor } = yield* usage("dep-dup", "t")

        expect(
          yield* actor.Import({
            events: [request("a", OCTOBER), request("b", OCTOBER), request("c", OCTOBER)],
          }),
        ).toEqual({ imported: 3, duplicates: 0, late: [] })
        expect(
          yield* actor.Import({
            events: [
              request("b", OCTOBER),
              request("c", OCTOBER),
              request("d", OCTOBER),
              request("d", OCTOBER),
            ],
          }),
        ).toEqual({ imported: 1, duplicates: 3, late: [] })
        expect((yield* accountRows("org-dup"))[0]?.command_units).toBe(20)
      }),
    ))

  it("rejects an event id reused with another payload and leaves the whole batch unapplied", () =>
    run(
      Effect.gen(function* () {
        yield* bind("dep-conflict", "t", "org-conflict", "proj-conflict")
        const { actor, key } = yield* usage("dep-conflict", "t")

        yield* actor.Import({ events: [request("a", OCTOBER)] })

        const refused = yield* actor
          .Import({ events: [request("fresh", OCTOBER), request("a", OCTOBER + HOUR)] })
          .pipe(Effect.exit)

        expect(refused).toEqual(Exit.fail(EventConflict.make({ eventId: "a" })))
        expect((yield* evidence(key)).map((row) => row.event_id)).toEqual(["a"])
        expect((yield* accountRows("org-conflict"))[0]?.command_units).toBe(5)
        expect((yield* hourRows("org-conflict")).map((row) => row.command_count)).toEqual([1])
      }),
    ))

  it("refuses a tenant with no allocation, and keeps imported usage with the organization it was bound to", () =>
    run(
      Effect.gen(function* () {
        const { actor, key } = yield* usage("dep-move", "t")

        expect(yield* actor.Import({ events: [request("x", OCTOBER)] }).pipe(Effect.exit)).toEqual(
          Exit.fail(TenantUnbound.make({ deployment: "dep-move", tenant: "t" })),
        )
        expect(yield* evidence(key)).toEqual([])

        yield* bind("dep-move", "t", "org-old", "proj-old")
        yield* actor.Import({ events: [request("first", OCTOBER)] })
        yield* bind("dep-move", "t", "org-new", "proj-new")
        yield* actor.Import({ events: [request("second", OCTOBER)] })

        expect((yield* evidence(key)).map((row) => [row.event_id, row.organization_id])).toEqual([
          ["first", "org-old"],
          ["second", "org-new"],
        ])
        expect((yield* accountRows("org-old"))[0]?.command_units).toBe(5)
        expect((yield* accountRows("org-new"))[0]?.command_units).toBe(5)
      }),
    ))

  it("commits the evidence, counters, account and reservation settlement with the receipt, or none of them", () =>
    run(
      Effect.gen(function* () {
        yield* bind("dep-atomic", "t", "org-atomic", "proj-atomic")
        const { actor, key, test } = yield* usage("dep-atomic", "t")
        const client = yield* sql
        const identity = yield* reserve(
          "org-atomic",
          "2026-10",
          "dep-atomic",
          "t",
          "Room",
          "r1",
          "cmd-held",
          "command",
        )

        yield* actor.Import({ events: [request("warm", OCTOBER)] })
        const before = (yield* test.inspect(actor.ref)).receipts

        yield* client`ALTER TABLE cloud_usage_account
          ADD CONSTRAINT refuse_units CHECK (command_units <> 10)`.pipe(Effect.orDie)

        const refused = yield* actor
          .Import({ events: [request("held", OCTOBER, { commandId: "cmd-held" })] })
          .pipe(Effect.exit)

        yield* client`ALTER TABLE cloud_usage_account DROP CONSTRAINT refuse_units`.pipe(
          Effect.orDie,
        )

        expect(Exit.isFailure(refused)).toBe(true)
        expect((yield* evidence(key)).map((row) => row.event_id)).toEqual(["warm"])
        expect((yield* hourRows("org-atomic"))[0]?.command_count).toBe(1)
        expect(yield* reservationState(identity)).toBe("reserved")
        expect((yield* accountRows("org-atomic"))[0]).toMatchObject({
          command_units: 5,
          reserved_units: 5,
        })
        expect((yield* test.inspect(actor.ref)).receipts).toBe(before)

        yield* test.crashNext("beforeCommit")
        yield* actor.Import({ events: [request("held", OCTOBER, { commandId: "cmd-held" })] })

        expect((yield* accountRows("org-atomic"))[0]).toMatchObject({
          command_units: 10,
          reserved_units: 0,
        })
        expect(yield* reservationState(identity)).toBe("committed")
        expect((yield* test.inspect(actor.ref)).receipts).toBe(before + 1)
      }),
    ))

  it("settles reservations of opposite months concurrently without deadlocking, and counts every unit once", () =>
    run(
      Effect.gen(function* () {
        yield* bind("dep-cross", "a", "org-cross", "proj-a")
        yield* bind("dep-cross", "b", "org-cross", "proj-b")
        const client = yield* sql
        const first = yield* usage("dep-cross", "a")
        const second = yield* usage("dep-cross", "b")
        const SEPTEMBER = hourOf("2026-09-15T00:00:00Z")
        const rounds = 12

        const identities: Array<string> = []

        for (let round = 0; round < rounds; round += 1) {
          identities.push(
            yield* reserve(
              "org-cross",
              "2026-09",
              "dep-cross",
              "a",
              "Room",
              "r1",
              `old-${round}`,
              "command",
            ),
            yield* reserve(
              "org-cross",
              "2026-10",
              "dep-cross",
              "b",
              "Room",
              "r1",
              `new-${round}`,
              "command",
            ),
          )
        }

        const edgeRelease = (identity: string, period: string) =>
          client
            .withTransaction(
              Effect.gen(function* () {
                yield* client`SELECT 1 FROM cloud_usage_account
                  WHERE organization_id = 'org-cross' AND period = ${period} FOR UPDATE`
                yield* client`SELECT state FROM cloud_usage_reservation WHERE identity = ${identity}`
              }),
            )
            .pipe(Effect.orDie)

        yield* Effect.all(
          Array.from({ length: rounds }, (_, round) => [
            first.actor.Import({
              events: [request(`a-${round}`, OCTOBER, { commandId: `old-${round}` })],
            }),
            second.actor.Import({
              events: [request(`b-${round}`, SEPTEMBER, { commandId: `new-${round}` })],
            }),
            edgeRelease(identities[round * 2] ?? "", "2026-09"),
            edgeRelease(identities[round * 2 + 1] ?? "", "2026-10"),
          ]).flat(),
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("20 seconds"))

        expect(yield* accountRows("org-cross")).toEqual([
          { period: "2026-09", command_units: rounds * 5, reserved_units: 0, storage_gb_months: 0 },
          { period: "2026-10", command_units: rounds * 5, reserved_units: 0, storage_gb_months: 0 },
        ])

        for (const identity of identities)
          expect(yield* reservationState(identity)).toBe("committed")
      }),
    ))

  it("takes calls from the system only", () =>
    run(
      Effect.gen(function* () {
        yield* bind("dep-auth", "t", "org-auth", "proj-auth")
        const { key } = yield* usage("dep-auth", "t")

        const refused = yield* Effect.flatMap(UsageActor.get(key), (actor) =>
          actor.Import({ events: [request("x", OCTOBER)] }),
        ).pipe(Actor.as(User.make({ subject: "someone" })), Effect.exit)

        expect(Exit.isFailure(refused)).toBe(true)
        expect(yield* evidence(key)).toEqual([])
      }),
    ))
})

describe("UsageActor seal and flush", () => {
  const setup = (name: string) =>
    Effect.gen(function* () {
      yield* bind(`dep-${name}`, "t", `org-${name}`, `proj-${name}`)
      yield* customer(`org-${name}`, `cus_${name}`)

      return yield* usage(`dep-${name}`, "t")
    })

  it("refuses to seal an hour the source is not complete through, and an organization with no customer", () =>
    run(
      Effect.gen(function* () {
        yield* bind("dep-open", "t", "org-open", "proj-open")
        const { actor } = yield* usage("dep-open", "t")

        yield* actor.Import({ events: [request("a", OCTOBER)] })

        expect(
          yield* actor
            .Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR - 1 })
            .pipe(Effect.exit),
        ).toEqual(Exit.fail(HourOpen.make({ hour: OCTOBER, completeThrough: OCTOBER + HOUR - 1 })))
        expect(
          yield* actor.Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR }).pipe(Effect.exit),
        ).toEqual(Exit.fail(CustomerUnbound.make({ organizationId: "org-open" })))
        expect((yield* actor.GetHour({ hour: OCTOBER })).sealed).toBe(false)
        expect((yield* hourRows("org-open"))[0]).toMatchObject({ sealed: false })

        yield* customer("org-open", "cus_open")
        yield* actor.Import({ events: [request("b", OCTOBER)] })
        expect(yield* actor.Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR })).toEqual({
          status: "sealed",
          queued: 1,
        })
        yield* (yield* ActorTest).advance(0)
        provider.sent.length = 0
      }),
    ))

  it("seals an hour into immutable gross values, sends them under deterministic identifiers, and sets late events aside", () =>
    run(
      Effect.gen(function* () {
        const { actor, key, test } = yield* setup("seal")
        const held = yield* reserve(
          "org-seal",
          "2026-10",
          "dep-seal",
          "t",
          "Room",
          "r1",
          "cmd-late",
          "command",
        )

        yield* actor.Import({
          events: [
            request("c1", OCTOBER),
            request("c2", OCTOBER),
            request("c3", OCTOBER),
            request("r1", OCTOBER, { kind: "read", commandId: null, requestToken: "tok" }),
            request("r2", OCTOBER, { kind: "read", commandId: null, requestToken: "tok2" }),
            storage("s", OCTOBER, 7_200_000_000_000),
          ],
        })

        expect(yield* actor.Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR })).toEqual({
          status: "sealed",
          queued: 1,
        })
        yield* test.advance(0)

        const hourKey = yield* json(["dep-seal", "t", OCTOBER]).pipe(Effect.orDie)

        expect(provider.sent).toHaveLength(1)
        expect(
          provider.sent[0]?.map(({ meter, customerId, key: usageKey, value, occurredAt }) => ({
            meter,
            customerId,
            key: usageKey,
            value,
            occurredAt: DateTime.toEpochMillis(occurredAt),
          })),
        ).toEqual([
          {
            meter: "commands",
            customerId: "cus_seal",
            key: hourKey,
            value: 17 / 5,
            occurredAt: OCTOBER,
          },
          {
            meter: "storageGb",
            customerId: "cus_seal",
            key: hourKey,
            value: 7200 / 744,
            occurredAt: OCTOBER,
          },
        ])
        expect(yield* actor.GetHour({ hour: OCTOBER })).toEqual({
          sealed: true,
          exports: [
            { organizationId: "org-seal", meter: "commands", value: 17 / 5, status: "accepted" },
            {
              organizationId: "org-seal",
              meter: "storageGb",
              value: 7200 / 744,
              status: "accepted",
            },
          ],
        })
        expect((yield* hourRows("org-seal"))[0]).toMatchObject({ sealed: true, sent: true })

        expect(yield* actor.Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR })).toEqual({
          status: "already_sealed",
          queued: 0,
        })

        const before = (yield* accountRows("org-seal"))[0]
        const late = yield* actor.Import({
          events: [
            request("late", OCTOBER, { commandId: "cmd-late" }),
            request("next", OCTOBER + HOUR),
          ],
        })

        expect(late).toEqual({ imported: 1, duplicates: 0, late: ["late"] })
        expect(
          yield* actor.Import({ events: [request("late", OCTOBER, { commandId: "cmd-late" })] }),
        ).toEqual({ imported: 0, duplicates: 1, late: [] })
        expect((yield* accountRows("org-seal"))[0]).toMatchObject({
          command_units: (before?.command_units ?? 0) + 5,
        })
        expect((yield* hourRows("org-seal")).map((row) => [row.hour, row.command_count])).toEqual([
          [OCTOBER, 3],
          [OCTOBER + HOUR, 1],
        ])
        expect(yield* reservationState(held)).toBe("reserved")
        expect((yield* evidence(key)).find((row) => row.event_id === "late")?.late).toBe(true)
        yield* test.advance("1 hour")
        expect(provider.sent).toHaveLength(1)
      }),
    ))

  it("sends the same identifiers again after a lost provider answer and records one acceptance", () =>
    run(
      Effect.gen(function* () {
        const { actor, test } = yield* setup("lost")

        yield* actor.Import({ events: [request("c1", OCTOBER), request("c2", OCTOBER)] })
        yield* test.crashNext("afterExecute")
        yield* actor.Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR })
        yield* test.advance(0)

        expect((yield* actor.GetHour({ hour: OCTOBER })).exports[0]?.status).toBe("pending")

        yield* test.advance("1 minute")

        expect(provider.sent).toHaveLength(2)
        expect(
          provider.sent[1]?.map(({ meter, customerId, key, value }) => [
            meter,
            customerId,
            key,
            value,
          ]),
        ).toEqual(
          provider.sent[0]?.map(({ meter, customerId, key, value }) => [
            meter,
            customerId,
            key,
            value,
          ]),
        )
        expect((yield* actor.GetHour({ hour: OCTOBER })).exports).toEqual([
          { organizationId: "org-lost", meter: "commands", value: 2, status: "accepted" },
        ])
        expect(yield* test.receiptsFor(actor.ref, "FlushResolved")).toBe(1)
        expect(yield* test.inspect(actor.ref)).toMatchObject({ jobs: 0, outbox: 0 })
        expect((yield* hourRows("org-lost"))[0]).toMatchObject({ sealed: true, sent: true })
      }),
    ))

  it("never resends after the provider's window: the export waits for reconciliation instead", () =>
    run(
      Effect.gen(function* () {
        const { actor, test } = yield* setup("late")

        yield* actor.Import({ events: [request("c1", OCTOBER)] })
        provider.mode = "retryable"
        yield* actor.Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR })
        yield* test.advance(0)
        yield* test.advance("1 minute")

        const attempts = provider.sent.length

        expect(attempts).toBeGreaterThanOrEqual(1)
        expect((yield* actor.GetHour({ hour: OCTOBER })).exports[0]?.status).toBe("pending")

        time.now += 24 * HOUR
        provider.mode = "accept"
        yield* exhaust

        expect(provider.sent).toHaveLength(attempts)
        expect((yield* actor.GetHour({ hour: OCTOBER })).exports).toEqual([
          {
            organizationId: "org-late",
            meter: "commands",
            value: 1,
            status: "needs_reconciliation",
          },
        ])
        expect((yield* hourRows("org-late"))[0]).toMatchObject({ sealed: true, sent: false })
      }),
    ))

  it("keeps resending within the window after retries run out, and quarantines a rejection retrying cannot fix", () =>
    run(
      Effect.gen(function* () {
        const { actor, test } = yield* setup("outage")

        yield* actor.Import({ events: [request("c1", OCTOBER)] })
        provider.mode = "retryable"
        yield* actor.Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR })
        yield* exhaust

        expect(provider.sent.length).toBeGreaterThan(11)
        expect((yield* actor.GetHour({ hour: OCTOBER })).exports[0]?.status).toBe("pending")

        provider.mode = "accept"
        yield* exhaust
        expect((yield* actor.GetHour({ hour: OCTOBER })).exports[0]?.status).toBe("accepted")

        const second = yield* setup("reject")
        yield* second.actor.Import({ events: [request("c1", OCTOBER)] })
        provider.mode = "rejected"
        const calls = provider.sent.length
        yield* second.actor.Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR })
        yield* test.advance(0)

        expect(provider.sent).toHaveLength(calls + 1)
        expect((yield* second.actor.GetHour({ hour: OCTOBER })).exports[0]?.status).toBe(
          "needs_reconciliation",
        )
      }),
    ))

  it("splits more than a hundred exports into provider batches of at most a hundred", () =>
    run(
      Effect.gen(function* () {
        const { actor, test } = yield* usage("dep-many", "t")
        const organizations = 60

        for (let index = 0; index < organizations; index += 1) {
          yield* bind("dep-many", "t", `org-many-${index}`, "p")
          yield* customer(`org-many-${index}`, `cus_many_${index}`)
          yield* actor.Import({
            events: [request(`e${index}`, OCTOBER), storage(`s${index}`, OCTOBER, 1_000_000_000)],
          })
        }

        expect(yield* actor.Seal({ hour: OCTOBER, completeThrough: OCTOBER + HOUR })).toEqual({
          status: "sealed",
          queued: 2,
        })
        yield* test.advance(0)

        expect(provider.sent.map((batch) => batch.length).sort((a, b) => a - b)).toEqual([20, 100])
        expect(
          (yield* actor.GetHour({ hour: OCTOBER })).exports.every(
            (row) => row.status === "accepted",
          ),
        ).toBe(true)
      }),
    ))
})
