import type { PgliteClient } from "@effect/sql-pglite"
import { Context, Crypto, Deferred, Effect, Layer, Redacted, Schema, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  Anonymous,
  type ActorRef,
  type Caller,
  CurrentCaller,
  Tenant,
  System,
  principal,
} from "../identity/caller.ts"
import { SystemHandle, type GetOptions } from "../actor/definition.ts"
import type { Actors } from "../handles/actors.ts"
import { Database, layer as runtimeLayer, type Options } from "../runtime/layer.ts"
import { RetryTurn, TurnHooks, type TurnPoint } from "../runtime/turn/hooks.ts"

export interface Inspection {
  readonly generation: string | undefined
  readonly state: Schema.JsonObject["Type"]
  readonly receipts: number
}

interface TestDefinition<H> {
  readonly [SystemHandle]: (
    id: string,
    caller: typeof System.Type,
    options?: GetOptions,
  ) => Effect.Effect<H, never, Actors>
}

export class ActorTest extends Context.Service<
  ActorTest,
  {
    readonly tenant: string
    readonly actor: <H extends { readonly ref: ActorRef }>(
      definition: {
        readonly [SystemHandle]: (
          id: string,
          caller: typeof System.Type,
          options?: GetOptions,
        ) => Effect.Effect<H, never, Actors>
      },
      id?: string,
    ) => Effect.Effect<
      { readonly system: H; readonly inspect: Effect.Effect<Inspection> },
      never,
      Actors
    >
    readonly inspect: (ref: ActorRef) => Effect.Effect<Inspection>
    readonly crashNext: (point: TurnPoint) => Effect.Effect<void>
    readonly pauseNext: (point: TurnPoint) => Effect.Effect<{
      readonly reached: Effect.Effect<void>
      readonly release: Effect.Effect<void>
    }>
    readonly invalidate: (ref: ActorRef) => Effect.Effect<void>
  }
>()("durable-actors/testing/actor-test/ActorTest") {
  static readonly layer = (options: {
    /**
     * Postgres connection string or a PGlite client config. Omitted, a fresh
     * in-memory PGlite database is created per layer build; `dataDir` retains
     * a database across builds. PGlite is single-process and supplies no
     * independent-connection behavior.
     */
    readonly database?: Redacted.Redacted<string> | PgliteClient.PgliteClientConfig
    readonly as?: Caller
    readonly authorize?: Options["authorize"]
    readonly retryWindowMs?: number
  }) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto
        const tenant = yield* crypto.randomUUIDv4.pipe(Effect.orDie)
        const faults = new Map<TurnPoint, Array<Effect.Effect<void>>>()

        const hooks = Layer.succeed(TurnHooks, {
          at: (point) => Effect.suspend(() => faults.get(point)?.shift() ?? Effect.void),
        })

        const addFault = (point: TurnPoint, fault: Effect.Effect<void>) =>
          Effect.sync(() => {
            const queue = faults.get(point) ?? []
            queue.push(fault)
            faults.set(point, queue)
          })

        const test = Layer.effect(
          ActorTest,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            const service: ActorTest["Service"] = ActorTest.of({
              tenant,
              actor: Effect.fnUntraced(function* <H extends { readonly ref: ActorRef }>(
                definition: TestDefinition<H>,
                id = "singleton",
              ) {
                const as = options.as ?? Anonymous.make({})

                const caller = Schema.is(System)(as)
                  ? as
                  : System.make({
                      source: "actor",
                      onBehalfOf: Option.getOrUndefined(principal(as)),
                    })

                const system = yield* definition[SystemHandle](id, caller, { tenant })

                return { system, inspect: service.inspect(system.ref) }
              }),
              crashNext: (point) =>
                addFault(point, Effect.die(RetryTurn.make({ message: `Injected ${point} crash` }))),
              pauseNext: Effect.fnUntraced(function* (point: TurnPoint) {
                const reached = yield* Deferred.make<void>()
                const release = yield* Deferred.make<void>()
                yield* addFault(
                  point,
                  Deferred.succeed(reached, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                )

                return {
                  reached: Deferred.await(reached),
                  release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
                }
              }),
              inspect: Effect.fnUntraced(function* (ref: ActorRef) {
                const generations = yield* sql<{
                  generation: string
                }>`SELECT generation::text AS generation FROM actor_generations
            WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

                const state = yield* sql<{
                  key: string
                  value: string
                }>`SELECT key, value::text AS value FROM actor_state
            WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

                const receipts = yield* sql<{
                  count: number
                }>`SELECT count(*)::integer AS count FROM actor_receipts
            WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

                return {
                  generation: generations[0]?.generation,
                  state: Object.fromEntries(
                    yield* Effect.forEach(
                      state,
                      Effect.fnUntraced(function* ({ key, value }) {
                        return [
                          key,
                          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
                            value,
                          ).pipe(Effect.orDie),
                        ]
                      }),
                    ),
                  ),
                  receipts: receipts[0]!.count,
                }
              }, Effect.orDie),
              invalidate: Effect.fnUntraced(function* (ref: ActorRef) {
                yield* sql`UPDATE actor_generations SET generation = generation + 1
            WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`
              }, Effect.orDie),
            })

            return service
          }),
        )

        return Layer.mergeAll(
          test,
          runtimeLayer({
            authorize: options.authorize ?? (() => Effect.succeed(true)),
            retryWindowMs: options.retryWindowMs,
          }),
          Layer.succeed(CurrentCaller, options.as ?? Anonymous.make({})),
          Layer.succeed(Tenant, tenant),
        ).pipe(
          Layer.provide(hooks),
          Layer.provideMerge(
            options.database !== undefined && Redacted.isRedacted(options.database)
              ? Database.postgres({ url: options.database, maxConnections: 10 })
              : Database.pglite(options.database),
          ),
        )
      }),
    )
}
