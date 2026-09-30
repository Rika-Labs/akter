import { Effect, Layer, Schedule, Schema, type Scope } from "effect"
import { Actor, Actors, Intent } from "../../index.ts"
import { type ActorError, CommandExpired } from "../../errors/actor.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { RuntimeControl } from "../../runtime/drain.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster, type RunnerServices } from "../cluster.ts"
import type {
  ConformanceCase,
  ConformanceDatabase,
  ConformanceEnvironment,
  ConformanceServices,
  ConformanceSuite,
} from "../conformance.ts"

export interface RestoreFixture {
  /** `Deposit` handler runs, in every history. */
  deposits: number
  /** `Receive` handler runs, in every history. */
  receives: number
  /** Every executor attempt of `Charge`, in every history, with its idempotency key. */
  readonly charges: Array<{ readonly effectId: string; readonly attempt: number }>
  /** While set, a `Charge` provider call never returns, as one in flight at a backup does. */
  hold: boolean
  /** Handler runs of each deployed version in the rolling-deploy case. */
  readonly versions: { v1: number; v2: number; receives: number }
}

export const restoreFixture = (): RestoreFixture => ({
  deposits: 0,
  receives: 0,
  charges: [],
  hold: false,
  versions: { v1: 0, v2: 0, receives: 0 },
})

const Charge = Actor.job("Charge", {
  payload: { amount: Schema.Int },
  success: Schema.Int,
})

const Deposit = Actor.command("Deposit", { payload: Schema.Int, success: Schema.Int })

const Transfer = Actor.command("Transfer", {
  payload: Schema.Struct({ to: Schema.String, amount: Schema.Int }),
})

const Bill = Actor.command("Bill", { payload: Schema.Int })

const Receive = Actor.command("Receive", { payload: Schema.Int })

const Charged = Actor.command("Charged", { payload: Schema.Int })

const Vault = Actor.make("Vault", {
  key: Schema.String,
  state: Actor.state({
    total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    charged: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  jobs: { Charge: { job: Charge, retry: { times: 3 }, onSuccess: Charged } },
  api: { Deposit, Transfer, Bill },
  internal: { Receive, Charged },
})

export const restoreLayer = (fixture: RestoreFixture) =>
  Layer.mergeAll(
    Vault.toLayer(
      Effect.succeed({
        Deposit: Effect.fnUntraced(function* (amount: number) {
          const turn = yield* Vault.Turn
          fixture.deposits += 1
          yield* turn.state.set({ total: turn.state.total + amount })

          return turn.state.total
        }),
        Transfer: Effect.fnUntraced(function* ({ to, amount }) {
          yield* Vault.Turn
          yield* (yield* Vault.intents(to)).Receive(amount).pipe(Intent.after("1 minute"))
        }),
        Bill: Effect.fnUntraced(function* (amount: number) {
          yield* (yield* Vault.Turn).enqueue(Charge.make({ amount }))
        }),
        Receive: Effect.fnUntraced(function* (amount: number) {
          const turn = yield* Vault.Turn
          fixture.receives += 1
          yield* turn.state.set({ total: turn.state.total + amount })
        }),
        Charged: Effect.fnUntraced(function* (amount: number) {
          const turn = yield* Vault.Turn
          yield* turn.state.set({ charged: turn.state.charged + amount })
        }),
      }),
    ),
    Vault.toJobLayer(
      Effect.succeed({
        Charge: Effect.fnUntraced(function* ({ amount }) {
          const exec = yield* Vault.Executor
          fixture.charges.push({ effectId: exec.jobId, attempt: exec.attempt })

          if (fixture.hold) return yield* Effect.never

          return amount
        }),
      }),
    ),
  )

/**
 * Runs `body` with the shared runtime stopped, as a restore needs every
 * runtime of the deployment stopped; the shared runtime restarts after.
 */
const offline = <A, E>(
  environment: ConformanceEnvironment,
  body: Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(environment.stop, () => environment.restart)

      return yield* body
    }).pipe(Effect.scoped),
  )

/** Runs `effect` in one runtime of its own on `database`, then stops that runtime. */
const session = <A, E>(
  environment: ConformanceEnvironment,
  database: ConformanceDatabase | undefined,
  effect: Effect.Effect<A, E, ConformanceServices | Scope.Scope>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => environment.build(database === undefined ? undefined : { database })),
    (runtime) => Effect.promise(() => runtime.runPromise(Effect.scoped(effect))),
    (runtime) => Effect.promise(() => runtime.dispose()),
  )

const vaultOf = (tenant: string, id: string) => Vault.get(id).pipe(Actor.tenant(tenant))

const Add = Actor.command("Add", { payload: Schema.Int, success: Schema.Int })

const Forward = Actor.command("Forward", {
  payload: Schema.Struct({ to: Schema.String, amount: Schema.Int }),
})

const Credit = Actor.command("Credit", { payload: Schema.Int })

const Account = Actor.make("RollingAccount", {
  key: Schema.String,
  state: Actor.state({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Add, Forward },
  internal: { Credit },
  policy: { keepReceipts: "1 day" },
})

const accountVersion = (fixture: RestoreFixture, version: "v1" | "v2") =>
  Account.toLayer(
    Effect.succeed({
      Add: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Account.Turn
        fixture.versions[version] += 1
        yield* turn.state.set({ total: turn.state.total + amount })

        return turn.state.total
      }),
      Forward: Effect.fnUntraced(function* ({ to, amount }) {
        yield* Account.Turn
        yield* (yield* Account.intents(to)).Credit(amount).pipe(Intent.after("2 seconds"))
      }),
      Credit: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Account.Turn
        fixture.versions.receives += 1
        yield* turn.state.set({ total: turn.state.total + amount })
      }),
    }),
  ) as Layer.Layer<never, never, RunnerServices>

/**
 * The vault commands the online-backup drills issue, against the default
 * tenant or against `tenant` when a runtime restored from a backup reads a
 * vault the backed-up runtime wrote.
 */
export const vaults = {
  deposit: (
    id: string,
    amount: number,
    options?: { readonly tenant?: string; readonly commandId?: string },
  ): Effect.Effect<number, ActorError, Actors> =>
    (options?.tenant === undefined ? Vault.get(id) : vaultOf(options.tenant, id)).pipe(
      Effect.flatMap((vault) =>
        options?.commandId === undefined
          ? vault.Deposit(amount)
          : vault.Deposit(amount).pipe(Actor.commandId(options.commandId)),
      ),
    ),
  transfer: (id: string, to: string, amount: number): Effect.Effect<void, ActorError, Actors> =>
    Vault.get(id).pipe(Effect.flatMap((vault) => vault.Transfer({ to, amount }))),
  ref: (tenant: string, id: string): Effect.Effect<ActorRef, ActorError, Actors> =>
    vaultOf(tenant, id).pipe(Effect.map((vault) => vault.ref)),
}

const RETRY_WINDOW_MS = 60_000

/** Restore cases: a backup neither reopens expired command ids nor drops pending intents and effects. */
export const restoreConformance: ReadonlyArray<ConformanceCase<RestoreFixture>> = [
  {
    name: "restores a backup without reopening expired command ids or dropping pending intents",
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture }) =>
      offline(
        environment,
        Effect.gen(function* () {
          const backedUp = yield* session(
            environment,
            undefined,
            Effect.gen(function* () {
              const test = yield* ActorTest
              const vault = yield* Vault.get("restore-expiry")
              const id = yield* (yield* Actors).mintCommandId
              expect(yield* vault.Deposit(5).pipe(Actor.commandId(id))).toBe(5)
              yield* vault.Transfer({ to: "restore-expiry-to", amount: 7 })

              return {
                tenant: test.tenant,
                id,
                generation: (yield* test.inspect(vault.ref)).generation,
              }
            }),
          )

          const snapshot = yield* environment.snapshot

          const lost = yield* session(
            environment,
            undefined,
            Effect.gen(function* () {
              const test = yield* ActorTest
              const vault = yield* vaultOf(backedUp.tenant, "restore-expiry")
              const id = yield* (yield* Actors).mintCommandId
              expect(yield* vault.Deposit(4).pipe(Actor.commandId(id))).toBe(9)
              yield* test.advance("2 minutes")
              const to = yield* vaultOf(backedUp.tenant, "restore-expiry-to")
              expect(yield* test.inspect(to.ref)).toMatchObject({ state: { total: 7 } })

              return id
            }),
          )

          const deposits = fixture.deposits
          const receives = fixture.receives

          yield* session(
            environment,
            snapshot,
            Effect.gen(function* () {
              const test = yield* ActorTest
              const vault = yield* vaultOf(backedUp.tenant, "restore-expiry")
              const to = yield* vaultOf(backedUp.tenant, "restore-expiry-to")

              expect(yield* test.inspect(vault.ref)).toMatchObject({
                generation: backedUp.generation,
                state: { total: 5 },
                receipts: 2,
                outbox: 1,
              })

              yield* test.advance("2 minutes")
              expect(fixture.receives - receives).toBe(1)
              expect(yield* test.inspect(to.ref)).toMatchObject({
                state: { total: 7 },
                receipts: 1,
              })
              expect(yield* test.inspect(vault.ref)).toMatchObject({ outbox: 0 })

              expect(
                (yield* vault.Deposit(5).pipe(Actor.commandId(backedUp.id), Effect.flip)).reason,
              ).toBeInstanceOf(CommandExpired)
              expect(
                (yield* vault.Deposit(4).pipe(Actor.commandId(lost), Effect.flip)).reason,
              ).toBeInstanceOf(CommandExpired)
              expect(fixture.deposits).toBe(deposits)

              yield* test.advance("2 minutes")
              expect(fixture.receives - receives).toBe(1)

              expect(yield* vault.Deposit(1)).toBe(6)
              expect(
                Number((yield* test.inspect(vault.ref)).generation) > Number(backedUp.generation),
              ).toBe(true)
            }),
          )
        }),
      ),
  },
  {
    name: "replays a receipt the backup holds and runs an unexpired command the backup lost once",
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture }) =>
      offline(
        environment,
        Effect.gen(function* () {
          const backedUp = yield* session(
            environment,
            undefined,
            Effect.gen(function* () {
              const vault = yield* Vault.get("restore-replay")
              const id = yield* (yield* Actors).mintCommandId
              expect(yield* vault.Deposit(3).pipe(Actor.commandId(id))).toBe(3)

              return { tenant: (yield* ActorTest).tenant, id }
            }),
          )

          const snapshot = yield* environment.snapshot

          const lost = yield* session(
            environment,
            undefined,
            Effect.gen(function* () {
              const vault = yield* vaultOf(backedUp.tenant, "restore-replay")
              const id = yield* (yield* Actors).mintCommandId
              expect(yield* vault.Deposit(4).pipe(Actor.commandId(id))).toBe(7)

              return id
            }),
          )

          const deposits = fixture.deposits

          yield* session(
            environment,
            snapshot,
            Effect.gen(function* () {
              const test = yield* ActorTest
              const vault = yield* vaultOf(backedUp.tenant, "restore-replay")
              expect(yield* vault.Deposit(3).pipe(Actor.commandId(backedUp.id))).toBe(3)
              expect(fixture.deposits).toBe(deposits)

              expect(yield* vault.Deposit(4).pipe(Actor.commandId(lost))).toBe(7)
              expect(yield* vault.Deposit(4).pipe(Actor.commandId(lost))).toBe(7)
              expect(fixture.deposits - deposits).toBe(1)
              expect(yield* test.inspect(vault.ref)).toMatchObject({
                state: { total: 7 },
                receipts: 2,
              })
            }),
          )
        }),
      ),
  },
  {
    name: "retries an effect in flight at the backup with its idempotency key after restore, and routes its result once",
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture }) =>
      offline(
        environment,
        Effect.gen(function* () {
          const charges = fixture.charges
          const since = (index: number) => charges.slice(index)
          let before = charges.length

          fixture.hold = true

          const tenant = yield* session(
            environment,
            undefined,
            Effect.gen(function* () {
              const vault = yield* Vault.get("restore-effect")
              yield* vault.Bill(9)

              yield* Effect.sync(() => charges.length - before).pipe(
                Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (n) => n > 0 }),
                Effect.timeoutOrElse({
                  duration: "10 seconds",
                  orElse: () => Effect.die(new Error("The effect never started")),
                }),
              )

              return (yield* ActorTest).tenant
            }),
          ).pipe(Effect.ensuring(Effect.sync(() => (fixture.hold = false))))

          const [first] = since(before)
          const snapshot = yield* environment.snapshot

          before = charges.length
          yield* session(
            environment,
            undefined,
            Effect.gen(function* () {
              const test = yield* ActorTest
              const vault = yield* vaultOf(tenant, "restore-effect")
              yield* test.advance("2 minutes")
              expect(yield* test.inspect(vault.ref)).toMatchObject({
                state: { charged: 9 },
                effects: 0,
              })
            }),
          )
          const [afterBackup] = since(before)

          before = charges.length
          yield* session(
            environment,
            snapshot,
            Effect.gen(function* () {
              const test = yield* ActorTest
              const vault = yield* vaultOf(tenant, "restore-effect")
              const restored = yield* test.inspect(vault.ref)
              expect(restored.state).toEqual({})
              expect(restored.effects).toBe(1)
              yield* test.advance("2 minutes")
              expect(yield* test.inspect(vault.ref)).toMatchObject({
                state: { charged: 9 },
                effects: 0,
              })
              expect(yield* test.receiptsFor(vault.ref, "Charged")).toBe(1)
              yield* test.advance("2 minutes")
              expect(yield* test.receiptsFor(vault.ref, "Charged")).toBe(1)
            }),
          )
          const retried = since(before)

          expect(first?.attempt).toBe(1)
          expect(afterBackup).toEqual({ effectId: first?.effectId, attempt: 2 })
          expect(retried).toEqual([{ effectId: first?.effectId, attempt: 2 }])
        }),
      ),
  },
  {
    name: "keeps receipt replay, expiry, and pending intents across two runtime versions behind one database during a rolling deploy",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const versions: Array<"v1" | "v2"> = ["v1", "v1"]

          const context = yield* Layer.build(
            ActorTest.cluster({
              database: yield* environment.freshDatabase,
              runners: 2,
              shardLockExpiration: "3 seconds",
              retryWindowMs: RETRY_WINDOW_MS,
              actors: Layer.empty,
              runnerActors: (runner) => accountVersion(fixture, versions[runner]!),
            }),
          )

          yield* Effect.gen(function* () {
            const cluster = yield* ActorCluster

            const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
              cluster.on(runner)(effect)

            const runs = () => fixture.versions.v1 + fixture.versions.v2
            const { v1, v2, receives } = fixture.versions

            yield* cluster.ready
            let id = ""

            for (let candidate = 0; id === ""; candidate++) {
              const ref = (yield* on(0, Account.get(`rolling-${candidate}`))).ref

              if ((yield* cluster.owner(ref)) === 0) id = `rolling-${candidate}`
            }

            const add = (runner: number, amount: number, commandId?: string) =>
              on(
                runner,
                Account.get(id).pipe(
                  Effect.flatMap((account) =>
                    commandId === undefined
                      ? account.Add(amount)
                      : account.Add(amount).pipe(Actor.commandId(commandId)),
                  ),
                ),
              )

            /**
             * Moves `runner` to v2 as a deploy does, draining it before it
             * stops. A drain releases the deliveries its relay claimed; a
             * killed runner would hold each claim for the whole claim lease,
             * longer than this case waits for the old version's intent.
             */
            const roll = (runner: number) =>
              Effect.gen(function* () {
                expect(
                  yield* on(
                    runner,
                    RuntimeControl.use((control) => control.drain({ deadline: "10 seconds" })),
                  ),
                ).toEqual({ outcome: "clean", interruptedTurns: 0, interruptedEffects: 0 })
                versions[runner] = "v2"
                yield* cluster.restart(runner)
                yield* cluster.ready
              })

            const commandId = yield* on(
              0,
              Actors.use((actors) => actors.mintCommandId),
            )

            expect(yield* add(0, 5, commandId)).toBe(5)
            expect(fixture.versions.v1 - v1).toBe(1)
            yield* on(
              0,
              Account.get(id).pipe(
                Effect.flatMap((account) => account.Forward({ to: `${id}-to`, amount: 2 })),
              ),
            )

            yield* roll(0)
            expect(yield* add(0, 5, commandId)).toBe(5)
            expect(yield* add(1, 5, commandId)).toBe(5)
            expect(yield* add(0, 1)).toBe(6)

            yield* roll(1)
            expect(yield* add(1, 5, commandId)).toBe(5)
            expect(yield* add(1, 1)).toBe(7)
            expect(runs() - v1 - v2).toBe(3)
            expect(fixture.versions.v2 - v2 > 0).toBe(true)

            yield* Effect.sync(() => fixture.versions.receives - receives).pipe(
              Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (n) => n > 0 }),
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () => Effect.die(new Error("The old version's intent was never delivered")),
              }),
            )

            for (const runner of [0, 1])
              yield* on(
                runner,
                ActorTest.use((test) => test.advance("2 minutes")),
              )
            expect((yield* add(0, 5, commandId).pipe(Effect.flip)).reason).toBeInstanceOf(
              CommandExpired,
            )
            expect((yield* add(1, 5, commandId).pipe(Effect.flip)).reason).toBeInstanceOf(
              CommandExpired,
            )

            yield* on(
              1,
              ActorTest.use((test) => test.advance("2 days").pipe(Effect.andThen(test.cleanup))),
            )
            const ref = (yield* on(0, Account.get(id))).ref
            expect(
              yield* on(
                0,
                ActorTest.use((test) => test.receiptsFor(ref, "Add")),
              ),
            ).toBe(0)
            expect((yield* add(0, 5, commandId).pipe(Effect.flip)).reason).toBeInstanceOf(
              CommandExpired,
            )
            expect((yield* add(1, 5, commandId).pipe(Effect.flip)).reason).toBeInstanceOf(
              CommandExpired,
            )
            expect(runs() - v1 - v2).toBe(3)
            yield* Effect.sleep("500 millis")
            expect(fixture.versions.receives - receives).toBe(1)
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
]

/** Restore actors. */
export const restoreSuite: ConformanceSuite<RestoreFixture> = {
  fixture: restoreFixture,
  layer: restoreLayer,
}
