import { pgTable, text } from "drizzle-orm/pg-core"
import { Cause, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { Headers, HttpRouter } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, Intent, Unauthorized, User } from "../../index.ts"
import type { InternalActors } from "../../handles/actors.ts"
import type { ContentStore } from "../../handles/content.ts"
import type { RuntimeControl } from "../../runtime/drain.ts"
import { childId, parseChildId } from "../../identity/child.ts"
import { deriveMintId } from "../../identity/mint.ts"
import { routingKey } from "../../runtime/storage/codec.ts"
import type { AuthRequest } from "../../serve/auth.ts"
import type { Group } from "../../tables/owned.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

const orderRows = Actor.table(pgTable("placement_orders", { id: text("id").primaryKey() }))

const shipmentRows = Actor.table(
  pgTable("placement_shipments", {
    id: text("id").primaryKey(),
    carrier: text("carrier").notNull(),
  }),
)

const placementDdl = [
  `CREATE TABLE IF NOT EXISTS placement_orders (
    routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL, id text NOT NULL,
    PRIMARY KEY (routing_key, tenant_id, actor_id, id))`,
  `CREATE TABLE IF NOT EXISTS placement_shipments (
    routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL, id text NOT NULL,
    carrier text NOT NULL, PRIMARY KEY (routing_key, tenant_id, actor_id, id))`,
  ...["placement_orders", "placement_shipments"].flatMap((table) => [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `DO $$ BEGIN
      CREATE POLICY durable_tenant ON ${table} AS PERMISSIVE FOR ALL TO public
        USING (tenant_id = current_setting('durable.tenant', true))
        WITH CHECK (tenant_id = current_setting('durable.tenant', true));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`,
  ]),
]

const labels = Actor.blob("placementLabels")

class Shipped extends Actor.Event<Shipped>()("PlacementShipped", { carrier: Schema.String }) {}

const Family = Schema.Struct({
  orders: Schema.Array(Schema.String),
  shipments: Schema.Array(Schema.String),
})

const OrderKey = Schema.String.check(Schema.isPattern(/^o-/))

const ShipmentKey = Schema.String.check(Schema.isPattern(/^s-/))

const Place = Actor.command("Place")

const Ship = Actor.command("Ship", {
  input: Schema.Struct({ shipment: Schema.String, carrier: Schema.String, later: Schema.Boolean }),
  output: Schema.String,
})

const MintParcel = Actor.command("MintParcel", { output: Schema.String })

const Acknowledge = Actor.command("Acknowledge", { input: Schema.String })

const Acknowledged = Actor.query("Acknowledged", { output: Schema.Array(Schema.String) })

const OrderFamily = Actor.command("OrderFamily", { output: Family })

const Order = Actor.make("PlacementOrder", {
  key: OrderKey,
  placement: "actor",
  state: Actor.state({
    acknowledged: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  tables: [orderRows],
  api: { Place, Ship, MintParcel, Acknowledge, Acknowledged, OrderFamily },
})

const Open = Actor.command("Open", { input: Schema.String })

const Report = Actor.command("Report", { input: Schema.String })

const Carrier = Actor.query("Carrier", { output: Schema.String })

const ShipmentFamily = Actor.query("ShipmentFamily", { output: Family })

const Shipment = Actor.make("PlacementShipment", {
  key: ShipmentKey,
  placement: { parent: Order },
  state: Actor.state({
    carrier: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
  events: [Shipped],
  tables: [shipmentRows],
  blobs: [labels],
  api: { Open, Report, Carrier, ShipmentFamily },
})

const Print = Actor.command("Print")

/** Two levels below its root order: a shipment's label. */
const Label = Actor.make("PlacementLabel", {
  key: Schema.NonEmptyString,
  placement: { parent: Shipment },
  state: Actor.state({
    printed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
  api: { Print },
})

const Title = Actor.query("Title", { output: Schema.String })

const MintStray = Actor.command("MintStray")

const Parcel = Actor.make("PlacementParcel", {
  placement: { parent: Order },
  state: Actor.state({ title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))) }),
  api: { Open, Title, MintStray },
  policy: { createdBy: Open },
})

const familyOf = Effect.fnUntraced(function* (group: Group) {
  const orders = yield* group((db) => db.select({ id: orderRows.id }).from(orderRows))

  const shipments = yield* group((db) =>
    db.select({ id: shipmentRows.id }).from(shipmentRows).orderBy(shipmentRows.id),
  )

  return { orders: orders.map(({ id }) => id), shipments: shipments.map(({ id }) => id) }
})

export const placementLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    for (const statement of placementDdl) yield* sql.unsafe(statement)

    return Layer.mergeAll(
      Order.toLayer(
        Effect.succeed({
          Place: Effect.fnUntraced(function* () {
            const turn = yield* Order.Turn
            yield* turn.rows(orderRows).insert({ id: turn.id })
          }),
          Ship: Effect.fnUntraced(function* ({ shipment, carrier, later }) {
            const turn = yield* Order.Turn
            const id = Shipment.idOf(turn.id, shipment)
            const open = (yield* Shipment.intents(id)).Open(carrier)
            yield* later ? open.pipe(Intent.after("1 hour")) : open

            return id
          }),
          MintParcel: Effect.fnUntraced(function* () {
            const id = yield* (yield* Order.Turn).mint(Parcel)
            yield* (yield* Parcel.intents(id)).Open("parcel")

            return id
          }),
          Acknowledge: Effect.fnUntraced(function* (shipment: string) {
            const turn = yield* Order.Turn
            yield* turn.state.set({ acknowledged: [...turn.state.acknowledged, shipment] })
          }),
          OrderFamily: Effect.fnUntraced(function* () {
            return yield* familyOf((yield* Order.Turn).group)
          }),
        }),
      ),
      Order.toQueryLayer(
        Effect.succeed({
          Acknowledged: Effect.fnUntraced(function* () {
            return (yield* Order.Read).state.acknowledged
          }),
        }),
      ),
      Shipment.toLayer(
        Effect.succeed({
          Open: Effect.fnUntraced(function* (carrier: string) {
            const turn = yield* Shipment.Turn
            yield* turn.state.set({ carrier })
            yield* turn.rows(shipmentRows).insert({ id: turn.id, carrier })
            yield* turn.emit(Shipped.make({ carrier }))
            yield* turn.blob(labels).set("label", new TextEncoder().encode(carrier))
          }),
          Report: Effect.fnUntraced(function* (order: string) {
            const turn = yield* Shipment.Turn
            yield* (yield* Order.intents(order)).Acknowledge(turn.id).pipe(Intent.after("1 hour"))
          }),
        }),
      ),
      Shipment.toQueryLayer(
        Effect.succeed({
          Carrier: Effect.fnUntraced(function* () {
            return (yield* Shipment.Read).state.carrier
          }),
          ShipmentFamily: Effect.fnUntraced(function* () {
            return yield* familyOf((yield* Shipment.Read).group)
          }),
        }),
      ),
      Label.toLayer(
        Effect.succeed({
          Print: Effect.fnUntraced(function* () {
            yield* (yield* Label.Turn).state.set({ printed: true })
          }),
        }),
      ),
      Parcel.toLayer(
        Effect.succeed({
          Open: Effect.fnUntraced(function* (title: string) {
            yield* (yield* Parcel.Turn).state.set({ title })
          }),
          MintStray: Effect.fnUntraced(function* () {
            yield* (yield* Parcel.Turn).mint(Parcel)
          }),
        }),
      ),
      Parcel.toQueryLayer(
        Effect.succeed({
          Title: Effect.fnUntraced(function* () {
            return (yield* Parcel.Read).state.title
          }),
        }),
      ),
    )
  }).pipe(Effect.orDie),
)

const shipment = (id: string) => Shipment.get(id as Parameters<typeof Shipment.get>[0])

const parcel = (id: string) => Parcel.get(id as Parameters<typeof Parcel.get>[0])

/** The message `make` throws, or "returned" when it does not throw. */
const thrown = (make: () => void) =>
  Result.match(
    Result.try(() => make()),
    { onSuccess: () => "returned", onFailure: (error) => String(error) },
  )

const defect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"

/** The routing keys stored for `ids` of `tenant` in every framework table. */
const storedKeys = Effect.fnUntraced(function* (tenant: string, ids: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient
  const found: Record<string, ReadonlyArray<string>> = {}

  for (const table of [
    "actor_generations",
    "actor_state",
    "actor_receipts",
    "actor_events",
    "actor_outbox",
    "actor_blobs",
    "placement_shipments",
  ]) {
    const rows = yield* sql<{ key: string }>`
      SELECT DISTINCT routing_key::text AS key FROM ${sql(table)}
      WHERE tenant_id = ${tenant} AND actor_id IN ${sql.in(ids)}`.pipe(Effect.orDie)

    found[table] = rows.map(({ key }) => key)
  }

  return found
})

const bearer = (request: AuthRequest) =>
  Option.match(Headers.get(request.headers, "authorization"), {
    onNone: () => Effect.fail(Unauthorized.make({ code: "missing_credentials" })),
    onSome: (header) => {
      const [tenant, subject] = header.replace(/^Bearer /, "").split(":")

      return Effect.succeed({ tenant: tenant!, caller: User.make({ subject: subject! }) })
    },
  })

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

const WireReason = Schema.Struct({
  reason: Schema.Struct({ _tag: Schema.String, code: Schema.optionalKey(Schema.String) }),
})

/** The wire failure reason of a reply body, as `tag` and `code`. */
const reasonOf = (body: Schema.Json | undefined) =>
  Schema.decodeUnknownEffect(WireReason)(body).pipe(
    Effect.orDie,
    Effect.map(({ reason }) => ({ tag: reason._tag, code: reason.code })),
  )

/** Serves the placement actors in memory and returns a request sender. */
const served = Effect.fnUntraced(function* (tenant: string) {
  const context = yield* Effect.context<InternalActors | RuntimeControl | ContentStore>()

  const web = HttpRouter.toWebHandler(
    Actor.serve({ actors: [Order, Shipment, Parcel], auth: Actor.auth.make(bearer) }).pipe(
      Layer.provide(Layer.succeedContext(context)),
    ),
    { disableLogger: true },
  )

  yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
  const actors = yield* Actors

  return (path: string, body?: Schema.Json) =>
    Effect.gen(function* () {
      const key = yield* actors.mintCommandId
      const encoded = body === undefined ? null : yield* encodeJson(body)

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://placement.test${path}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${tenant}:alice`,
              "idempotency-key": key,
              "content-type": "application/json",
            },
            body: encoded,
          }),
        ),
      )

      const text = yield* Effect.promise(() => response.text())

      return { status: response.status, body: text === "" ? undefined : yield* decodeJson(text) }
    }).pipe(Effect.orDie)
})

/** Placement cases: rows of a family share their root's routing key, family reads use one snapshot, and a build that changes placement is refused. */
export const placementConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "stores every framework and owned row of a child under its root's routing key",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* Order.get("o-stored")
          yield* order.Place()
          const id = yield* order.Ship({ shipment: "s-1", carrier: "ups", later: false })
          yield* test.advance(0)

          const child = yield* shipment(id)
          yield* child.Report(order.ref.id)
          const label = Label.idOf(Shipment.idOf("o-stored", "s-1"), "l-1")
          yield* (yield* Label.get(label)).Print()

          expect(id).toBe("c1.8.o-stored.s-1")
          expect(label).toBe("c1.17.c1.8.o-stored.s-1.l-1")
          expect(yield* child.Carrier()).toBe("ups")

          const root = String(routingKey({ ref: order.ref, placement: "actor" }))
          const found = yield* storedKeys(test.tenant, [order.ref.id, id, label])

          expect(found).toEqual({
            actor_generations: [root],
            actor_state: [root],
            actor_receipts: [root],
            actor_events: [root],
            actor_outbox: [root],
            actor_blobs: [root],
            placement_shipments: [root],
          })

          const sql = yield* SqlClient.SqlClient

          const recorded = yield* sql<{ actor_type: string; placement: string; parent: string }>`
            SELECT actor_type, placement, parent_type AS parent FROM actor_placements
            WHERE actor_type IN ('PlacementOrder', 'PlacementShipment', 'PlacementLabel')
            ORDER BY actor_type`.pipe(Effect.orDie)

          expect(recorded).toEqual([
            { actor_type: "PlacementLabel", placement: "parent", parent: "PlacementShipment" },
            { actor_type: "PlacementOrder", placement: "actor", parent: null },
            { actor_type: "PlacementShipment", placement: "parent", parent: "PlacementOrder" },
          ])
        }),
      ),
  },
  {
    name: "reads a parent and its children in one group snapshot and nothing beyond the family",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const first = yield* Order.get("o-family")
          const second = yield* Order.get("o-other")

          yield* first.Place()
          yield* second.Place()
          yield* first.Ship({ shipment: "s-1", carrier: "ups", later: false })
          yield* first.Ship({ shipment: "s-2", carrier: "dhl", later: false })
          yield* second.Ship({ shipment: "s-1", carrier: "fedex", later: false })
          yield* test.advance(0)

          const family = {
            orders: ["o-family"],
            shipments: ["c1.8.o-family.s-1", "c1.8.o-family.s-2"],
          }

          expect(yield* first.OrderFamily()).toEqual(family)
          expect(yield* (yield* shipment("c1.8.o-family.s-2")).ShipmentFamily()).toEqual(family)
          expect(yield* second.OrderFamily()).toEqual({
            orders: ["o-other"],
            shipments: ["c1.7.o-other.s-1"],
          })
        }),
      ),
  },
  {
    name: "refuses a build that changes a type's placement, encoding, or parent type",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const Ping = Actor.command("Ping")

          const deploy = (name: string, placement: "actor" | { readonly parent: typeof Order }) =>
            Layer.build(
              Actor.make(name, { key: Schema.NonEmptyString, placement, api: { Ping } }).toLayer(
                Effect.succeed({ Ping: () => Effect.void }),
              ),
            ).pipe(Effect.scoped, Effect.exit)

          const refused = "placement differs from the deployment; migrate explicitly"

          expect(defect(yield* deploy("PlacementMoved", { parent: Order }))).toBe("succeeded")
          expect(defect(yield* deploy("PlacementMoved", "actor"))).toContain(
            `Actor PlacementMoved ${refused}`,
          )

          const Other = Actor.make("PlacementOtherRoot", {
            key: OrderKey,
            placement: "actor",
            api: { Ping },
          })

          const moved = yield* Layer.build(
            Actor.make("PlacementMoved", {
              key: Schema.NonEmptyString,
              placement: { parent: Other },
              api: { Ping },
            }).toLayer(Effect.succeed({ Ping: () => Effect.void })),
          ).pipe(Effect.scoped, Effect.exit)

          expect(defect(moved)).toContain(`Actor PlacementMoved ${refused}`)

          yield* sql`UPDATE actor_placements SET encoding = 2
            WHERE actor_type = 'PlacementMoved'`.pipe(Effect.orDie)
          expect(defect(yield* deploy("PlacementMoved", { parent: Order }))).toContain(
            `Actor PlacementMoved ${refused}`,
          )
          yield* sql`UPDATE actor_placements SET encoding = 1
            WHERE actor_type = 'PlacementMoved'`.pipe(Effect.orDie)
          expect(defect(yield* deploy("PlacementMoved", { parent: Order }))).toBe("succeeded")

          expect(defect(yield* deploy("PlacementRootMoved", "actor"))).toBe("succeeded")

          const RootAsChild = Actor.make("PlacementRootMoved", {
            key: Schema.NonEmptyString,
            placement: { parent: Order },
            api: { Ping },
          })

          const grandchild = yield* Layer.build(
            Actor.make("PlacementUnderMovedRoot", {
              key: Schema.NonEmptyString,
              placement: { parent: RootAsChild },
              api: { Ping },
            }).toLayer(Effect.succeed({ Ping: () => Effect.void })),
          ).pipe(Effect.scoped, Effect.exit)

          expect(defect(grandchild)).toContain(`Actor PlacementRootMoved ${refused}`)
        }),
      ),
  },
  {
    name: "rejects a tenant-placed parent and chains deeper than four levels at Actor.make",
    run: ({ expect }) =>
      Effect.runPromise(
        Effect.sync(() => {
          const Ping = Actor.command("Ping")

          const Tenanted = Actor.make("PlacementTenanted", {
            key: Schema.NonEmptyString,
            api: { Ping },
          })

          expect(
            thrown(() =>
              Actor.make("PlacementOnTenant", {
                key: Schema.NonEmptyString,
                // @ts-expect-error a tenant-placed parent's children already share its shard
                placement: { parent: Tenanted },
                api: { Ping },
              }),
            ),
          ).toContain("PlacementOnTenant's parent PlacementTenanted is tenant-placed")

          const second = Actor.make("PlacementDepth2", {
            key: Schema.NonEmptyString,
            placement: { parent: Shipment },
            api: { Ping },
          })

          const third = Actor.make("PlacementDepth3", {
            key: Schema.NonEmptyString,
            placement: { parent: second },
            api: { Ping },
          })

          const fourth = Actor.make("PlacementDepth4", {
            key: Schema.NonEmptyString,
            placement: { parent: third },
            api: { Ping },
          })

          expect(
            thrown(() =>
              Actor.make("PlacementDepth5", {
                key: Schema.NonEmptyString,
                placement: { parent: fourth },
                api: { Ping },
              }),
            ),
          ).toContain("PlacementDepth5 would be 5 levels below its root; parent placement allows 4")

          expect(
            thrown(() =>
              Actor.make("PlacementUnkeyed", { placement: { parent: Order }, api: { Ping } }),
            ),
          ).toContain("Parent-placed PlacementUnkeyed needs a key or policy.createdBy")

          expect(
            thrown(() =>
              Actor.make("PlacementSingleton", {
                key: Actor.singleton,
                placement: { parent: Order },
                api: { Ping },
              }),
            ),
          ).toContain("Singleton PlacementSingleton cannot be parent-placed")

          expect(
            thrown(() =>
              Actor.make("PlacementOnPlainObject", {
                key: Schema.NonEmptyString,
                placement: { parent: { name: "PlacementOrder" } },
                api: { Ping },
              }),
            ),
          ).toContain("placement.parent takes an Actor.make definition")
        }),
      ),
  },
  {
    name: "mints a parent-placed child as c1 form whose createdBy proof verifies, and refuses X.create()",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* Order.get("o-mint")
          const commandId = yield* (yield* Actors).mintCommandId
          const id = yield* order.MintParcel().pipe(Actor.commandId(commandId))

          const local = yield* deriveMintId({
            parent: order.ref,
            commandId,
            ordinal: 0,
            child: "PlacementParcel",
          })

          expect(id).toBe(childId({ parent: "o-mint", local }))
          yield* test.advance(0)

          const child = yield* parcel(id)
          expect(yield* child.Title()).toBe("parcel")
          expect(
            yield* test.receiptsFor({ tenant: test.tenant, actor: "PlacementParcel", id }, "Open"),
          ).toBe(1)
          expect(yield* test.inspect(order.ref)).toMatchObject({ outbox: 0 })

          const unminted = childId({
            parent: "o-mint",
            local: yield* deriveMintId({
              parent: order.ref,
              commandId: "never-committed",
              ordinal: 0,
              child: "PlacementParcel",
            }),
          })

          expect(
            yield* parcel(unminted).pipe(
              Effect.flatMap((forged) => forged.Open("forged")),
              Effect.flip,
            ),
          ).toMatchObject({ reason: Unauthorized.make({ code: "access_denied" }) })

          const create = Effect.suspend((): Effect.Effect<unknown> =>
            // @ts-expect-error a parent-placed minted child is minted only by its parent
            Parcel.create(),
          )

          expect(defect(yield* Effect.exit(create))).toContain(
            "PlacementParcel is minted only by its parent PlacementOrder",
          )

          expect(defect(yield* child.MintStray().pipe(Effect.exit))).toContain(
            "turn.mint(PlacementParcel) needs a turn of its parent PlacementOrder",
          )
        }),
      ),
  },
  {
    name: "rejects a malformed child id or a parent part the parent's key refuses as InvalidInput before any turn",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const send = yield* served(test.tenant)

          const malformed = [
            "s-1",
            "c1.4.o-17",
            "c1.5.o-17.s-1",
            "c1.4.x-17.s-1",
            "c1.4.o-17.x-1",
            "c1.4.o-17.",
          ]

          for (const id of malformed) {
            const reply = yield* send(
              `/actors/PlacementShipment/${encodeURIComponent(id)}/Open`,
              "ups",
            )

            expect(reply.status).toBe(400)
            expect(yield* reasonOf(reply.body)).toEqual({ tag: "InvalidInput", code: "decode" })
            expect(Exit.isFailure(yield* Effect.exit(shipment(id)))).toBe(true)
          }

          const unminted = yield* send(
            `/actors/PlacementParcel/${encodeURIComponent("c1.4.o-17.p-1")}/Title`,
          )

          expect(unminted.status).toBe(400)
          expect(yield* reasonOf(unminted.body)).toEqual({ tag: "InvalidInput", code: "decode" })

          const sql = yield* SqlClient.SqlClient

          const touched = yield* sql<{ id: string }>`
            SELECT actor_id AS id FROM actor_generations
            WHERE tenant_id = ${test.tenant} AND actor_id IN ${sql.in(malformed)}`.pipe(
            Effect.orDie,
          )

          expect(touched).toEqual([])
        }),
      ),
  },
  {
    name: "delivers intents between a parent and its child as same-shard outbox rows",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const order = yield* Order.get("o-intents")
          const id = yield* order.Ship({ shipment: "s-1", carrier: "dhl", later: true })
          const root = String(routingKey({ ref: order.ref, placement: "actor" }))

          const rows = () =>
            sql<{ key: string; sender: string; target: string }>`
              SELECT routing_key::text AS key, actor_id AS sender, target_id AS target
              FROM actor_outbox WHERE tenant_id = ${test.tenant}
                AND (actor_id = ${order.ref.id} OR actor_id = ${id})`.pipe(Effect.orDie)

          expect(yield* rows()).toEqual([{ key: root, sender: "o-intents", target: id }])
          yield* test.advance("1 hour")

          const child = yield* shipment(id)
          expect(yield* child.Carrier()).toBe("dhl")

          yield* child.Report(order.ref.id)
          expect(yield* rows()).toEqual([{ key: root, sender: id, target: "o-intents" }])
          yield* test.advance("1 hour")
          expect(yield* order.Acknowledged()).toEqual([id])
          expect(yield* rows()).toEqual([])
          expect(parseChildId(id)).toEqual({ parent: "o-intents", local: "s-1" })
        }),
      ),
  },
  {
    name: "serves and routes a child id through the HTTP protocol",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const send = yield* served(test.tenant)
          const id = Shipment.idOf("o-served", "s-1")

          expect(
            yield* send(`/actors/PlacementShipment/${encodeURIComponent(id)}/Open`, "ups"),
          ).toMatchObject({ status: 204 })
          expect(
            yield* send(`/actors/PlacementShipment/${encodeURIComponent(id)}/Carrier`),
          ).toEqual({ status: 200, body: "ups" })
          expect(yield* send(`/actors/PlacementShipment/${id}/Carrier`)).toEqual({
            status: 200,
            body: "ups",
          })

          const minted = yield* send("/actors/PlacementOrder/o-served/MintParcel")
          expect(minted.status).toBe(200)

          const parcelId = yield* Schema.decodeUnknownEffect(Schema.String)(minted.body).pipe(
            Effect.orDie,
          )

          yield* test.advance(0)
          expect(
            yield* send(`/actors/PlacementParcel/${encodeURIComponent(parcelId)}/Title`),
          ).toEqual({ status: 200, body: "parcel" })
          expect(parseChildId(parcelId)?.parent).toBe("o-served")

          const forged = childId({
            parent: "o-served",
            local: parseChildId(parcelId)!.local.replace(/^./, (c) => (c === "0" ? "1" : "0")),
          })

          const refused = yield* send(
            `/actors/PlacementParcel/${encodeURIComponent(forged)}/Open`,
            "forged",
          )

          expect(yield* reasonOf(refused.body)).toEqual({
            tag: "Unauthorized",
            code: "access_denied",
          })
          expect(
            yield* test.receiptsFor(
              { tenant: test.tenant, actor: "PlacementParcel", id: forged },
              "Open",
            ),
          ).toBe(0)
        }),
      ),
  },
]
