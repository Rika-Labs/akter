import {
  Cause,
  Crypto,
  type Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Schedule,
  Schema,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../index.ts"
import type { VersionRange } from "../../members/workflow.ts"
import {
  acceptWorkflows,
  checkWorkflows,
  declaredOf,
} from "../../runtime/workflows/compatibility.ts"
import { manifestOf, toJson } from "../../runtime/workflows/manifest.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster, type RunnerServices } from "../cluster.ts"
import type { ConformanceCase, ConformanceDatabase } from "../conformance.ts"

interface Variant {
  readonly versions?: Readonly<Record<string, VersionRange>>
  /** The name of the step after the sleep; `null` removes it. */
  readonly label?: string | null
  readonly reserve?: typeof Schema.String | typeof Schema.NonEmptyString
  /** A step the body never reaches. */
  readonly extra?: string
  readonly id?: typeof Schema.String | typeof Schema.NonEmptyString
  readonly labelled?: typeof Schema.String | typeof Schema.NonEmptyString
  /** A second sleep after the label step. */
  readonly rest?: boolean
}

/** One deployment of the `Versioned` actor type: reserve, sleep, then label. */
const deployment = (variant: Variant) => {
  const Order = Actor.workflow("Order", {
    payload: { id: variant.id ?? Schema.String },
    success: Schema.String,
    key: ({ id }) => id,
    versions: variant.versions ?? {},
  })

  const Reserve = Order.step("reserve", {
    payload: Schema.String,
    success: variant.reserve ?? Schema.String,
  })

  const Pause = Order.sleep("pause")
  const label = variant.label === undefined ? "label" : variant.label

  const Label =
    label === null
      ? undefined
      : Order.step(label, { payload: Schema.String, success: variant.labelled ?? Schema.String })

  const Rest = variant.rest === true ? Order.sleep("rest") : undefined

  if (variant.extra !== undefined)
    Order.step(variant.extra, { payload: Schema.String, success: Schema.String })

  const Versioned = Actor.make("Versioned", { key: Schema.String, api: { Order } })

  const layer = Versioned.toLayer(
    Effect.succeed({
      Order: Effect.fnUntraced(function* (input: { readonly id: string }) {
        const wf = yield* Versioned.Workflow
        const reserved = yield* Reserve.run(input.id, (id) => Effect.succeed(`r-${id}`))
        yield* Pause("1 minute")
        const fraud = yield* wf.version("fraud")

        const labelled =
          Label === undefined
            ? reserved
            : yield* Label.run(reserved, (value) => Effect.succeed(`${value}:${label}`))

        if (Rest !== undefined) yield* Rest("1 minute")

        return `${labelled}:v${fraud}`
      }),
    }),
  )

  return {
    Versioned,
    Order,
    layer,
    start: (id: string) =>
      Versioned.get(id).pipe(
        Effect.flatMap((handle) => handle.Order({ id })),
        Effect.map((run) => run.executionId),
      ),
    result: (executionId: string) =>
      Versioned.run(Order, executionId).pipe(Effect.flatMap((run) => run.result)),
  }
}

const Base = deployment({})

const BaseAgain = deployment({})

const Removed = deployment({ label: null })

const Renamed = deployment({ label: "label-v2" })

const Audited = deployment({ extra: "audit" })

const Retyped = deployment({ reserve: Schema.NonEmptyString })

const Reinput = deployment({ id: Schema.NonEmptyString })

const Marked = deployment({ versions: { fraud: { current: 1, min: 0 } } })

const MarkedNext = deployment({ versions: { fraud: { current: 2, min: 1 } } })

const MarkedLater = deployment({ versions: { fraud: { current: 3, min: 2 } } })

const Rested = deployment({ rest: true })

const MarkedCurrent = deployment({ versions: { fraud: { current: 2, min: 0 } } })

const BriefRun = Actor.workflow("Run", { success: Schema.String })

/** Keeps finished executions for `keep`, against the cases' 60-second retry window. */
const brief = (keep: Duration.Input) => {
  const Brief = Actor.make("Brief", {
    key: Schema.String,
    api: { Run: BriefRun },
    policy: { keepWorkflows: keep },
  })

  return Brief.toLayer(Effect.succeed({ Run: () => Effect.succeed("ran") }))
}

const RestedRelabelled = deployment({ rest: true, labelled: Schema.NonEmptyString })

const Probe = Actor.command("Probe")

const Unworkflowed = Actor.make("Versioned", { key: Schema.String, api: { Probe } })

const UnworkflowedLive = Unworkflowed.toLayer(Effect.succeed({ Probe: () => Effect.void }))

/** Runs `body` on a fresh runtime of `actors` against `database`, then stops it. */
/** Every deployment of a case serves the same tenant, as one application would. */
const TENANT = "5f0c1e2a-7b3d-4c8e-9a61-2d4f6b8e0c13"

type Deployed = Layer.Success<ReturnType<typeof ActorTest.layer>>

const deploy = <A, E, LE>(
  database: ConformanceDatabase,
  actors: Layer.Layer<never, LE, Deployed>,
  body: Effect.Effect<A, E, Deployed | Crypto.Crypto>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        ManagedRuntime.make(
          actors.pipe(
            Layer.provideMerge(
              ActorTest.layer({
                database,
                retryWindowMs: 60_000,
              }),
            ),
            Layer.provideMerge(Layer.succeed(Crypto.Crypto, crypto)),
          ),
        ),
      ),
      (runtime) => Effect.promise(() => runtime.dispose()),
    )

    return yield* Effect.promise(() =>
      runtime.runPromiseExit(body.pipe(Actor.tenant(TENANT))),
    ).pipe(Effect.flatten)
  }).pipe(Effect.scoped)

/** The startup failure of a runtime of `actors`, pretty-printed; dies if it starts. */
const refusal = <LE>(database: ConformanceDatabase, actors: Layer.Layer<never, LE, Deployed>) =>
  deploy(database, actors, Effect.void).pipe(
    Effect.exit,
    Effect.flatMap((exit) =>
      Exit.isFailure(exit)
        ? Effect.succeed(Cause.pretty(exit.cause))
        : Effect.die(new Error("The deployment started")),
    ),
  )

const status = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql<{ status: string }>`SELECT status FROM actor_workflow_executions
      WHERE execution_id = ${executionId}`

    return rows[0]?.status
  }).pipe(Effect.orDie)

const suspended = (executionId: string) =>
  status(executionId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: (held) => held === "suspended",
    }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error("Timed out waiting for the execution to suspend")),
    }),
    Effect.asVoid,
  )

/** Starts `id` and returns its execution id once it sleeps. */
const sleeping = (target: ReturnType<typeof deployment>, id: string) =>
  Effect.gen(function* () {
    const executionId = yield* target.start(id)
    yield* suspended(executionId)

    return executionId
  })

/** Past the sleep and any recovery timer a runner that could not resume it armed. */
const finish = (target: ReturnType<typeof deployment>, executionId: string) =>
  Effect.gen(function* () {
    yield* ActorTest.use((test) => test.advance("2 minutes"))

    return yield* target.result(executionId)
  })

const manifests = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return yield* sql<{ manifest_hash: string; accepted_at_ms: string }>`
    SELECT manifest_hash, accepted_at_ms::text AS accepted_at_ms FROM actor_workflow_manifests
    WHERE actor_type = 'Versioned' ORDER BY accepted_at_ms`
}).pipe(Effect.orDie)

const hashOf = (target: ReturnType<typeof deployment>) =>
  manifestOf("Versioned", target.Order).pipe(Effect.map(({ hash }) => hash))

const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

/**
 * A rolling deploy on two runners: runner 0 serves `next`, runner 1 still
 * serves `old`. An execution `next` started resumes on `old`, which leaves
 * it suspended, and then on `next` again, which finishes it.
 */
const rollingDeploy = (options: {
  readonly name: string
  readonly old: ReturnType<typeof deployment>
  readonly next: ReturnType<typeof deployment>
  readonly result: (id: string) => string
}): ConformanceCase => ({
  requiresIndependentConnections: true,
  timeoutMs: 150_000,
  name: options.name,
  run: ({ expect, environment }) =>
    environment.run(
      Effect.gen(function* () {
        const { old, next } = options
        const database = yield* environment.freshDatabase

        const context = yield* Layer.build(
          ActorTest.cluster({
            database,
            runners: 2,
            shardLockExpiration: "3 seconds",
            actors: Layer.empty,
            runnerActors: (runner) =>
              (runner === 0 ? next.layer : old.layer) as Layer.Layer<never, never, RunnerServices>,
          }),
        )

        yield* Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          let id = ""

          for (let candidate = 0; id === ""; candidate++) {
            const ref = (yield* on(0, next.Versioned.get(`rolling-${candidate}`))).ref

            if ((yield* cluster.owner(ref)) === 0) id = `rolling-${candidate}`
          }

          const executionId = yield* on(0, sleeping(next, id))
          const ref = (yield* on(0, next.Versioned.get(id))).ref
          yield* cluster.kill(0)
          yield* cluster.ready

          yield* on(
            1,
            Effect.gen(function* () {
              const test = yield* ActorTest
              yield* test.advance("61 seconds")

              yield* test.receiptsFor(ref, "$workflow/resume").pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("50 millis"),
                  until: (count) => count > 0,
                }),
                Effect.timeoutOrElse({
                  duration: "30 seconds",
                  orElse: () => Effect.die(new Error("The older runner never received the resume")),
                }),
              )

              yield* Effect.sleep("500 millis")
              expect(yield* status(executionId)).toBe("suspended")
            }),
          )

          yield* cluster.restart(0)
          yield* cluster.kill(1)
          yield* cluster.ready

          expect(yield* on(0, finish(next, executionId))).toBe(options.result(id))
        }).pipe(Effect.provideContext(context))
      }),
    ),
})

/** Workflow-version cases: executions suspend on runners that lack their steps or marker range and resume on a compatible one, and startup refuses retention below the retry window. */
export const workflowVersionsConformance: ReadonlyArray<ConformanceCase> = [
  rollingDeploy({
    name: "workflow versions: suspends an execution with an unregistered step on an older runner and resumes it on a compatible runner (rolling deploy)",
    old: Base,
    next: Audited,
    result: (id) => `r-${id}:label:v0`,
  }),
  rollingDeploy({
    name: "workflow versions: suspends an execution whose marker is outside an older runner's min..current and resumes it on a compatible runner (rolling deploy)",
    old: Marked,
    next: MarkedCurrent,
    result: (id) => `r-${id}:label:v2`,
  }),
  {
    name: "workflows: refuses startup when keepWorkflows is below the retry window",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          expect(yield* refusal(yield* environment.freshDatabase, brief("59 seconds"))).toContain(
            "Actor Brief keepWorkflows is shorter than the retry window",
          )
          expect(
            yield* deploy(yield* environment.freshDatabase, brief("60 seconds"), Effect.void),
          ).toBe(undefined)
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: records markers at start and reads 0 for executions older than the marker, across a restart",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const old = yield* deploy(database, Base.layer, sleeping(Base, "old"))

          yield* deploy(
            database,
            Marked.layer,
            Effect.gen(function* () {
              const fresh = yield* sleeping(Marked, "fresh")
              const sql = yield* SqlClient.SqlClient

              const markers = yield* sql<{
                version: number
              }>`SELECT version FROM actor_workflow_step
                WHERE execution_id = ${fresh} AND kind = 'version' AND step = 'fraud'`.pipe(
                Effect.orDie,
              )

              expect(markers).toEqual([{ version: 1 }])
              expect(yield* finish(Marked, old)).toBe("r-old:label:v0")
              expect(yield* Marked.result(fresh)).toBe("r-fresh:label:v1")
            }),
          )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: refuses startup when a step in an open execution's start manifest is removed or renamed",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const open = yield* deploy(database, Base.layer, sleeping(Base, "o"))

          const removed = yield* refusal(database, Removed.layer)
          expect(removed).toContain("deploy refused")
          expect(removed).toContain(`Versioned/Order  step "label" removed  1 open execution`)
          expect(yield* refusal(database, Renamed.layer)).toContain(`step "label" removed`)

          expect(yield* deploy(database, Base.layer, finish(Base, open))).toBe("r-o:label:v0")
          yield* deploy(database, Removed.layer, Effect.void)
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: refuses startup when a marker leaves min..current",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          yield* deploy(database, Marked.layer, sleeping(Marked, "o"))

          expect(yield* refusal(database, MarkedLater.layer)).toContain(
            `Versioned/Order  marker "fraud" 1 outside 2..3  1 open execution`,
          )
          expect(yield* refusal(database, Base.layer)).toContain(`marker "fraud" removed`)
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: refuses startup when min rises above 0 while an execution predates the marker",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          yield* deploy(database, Base.layer, sleeping(Base, "o"))

          expect(yield* refusal(database, MarkedNext.layer)).toContain(
            `marker "fraud" min 1 > 0 for executions that predate it  1 open execution`,
          )
          yield* deploy(database, Marked.layer, Effect.void)
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: refuses startup when a workflow member is removed",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          yield* deploy(database, Base.layer, sleeping(Base, "o"))

          expect(yield* refusal(database, UnworkflowedLive)).toContain(
            "Versioned/Order  workflow removed  1 open execution",
          )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: refuses startup when a recorded step's result schema changes",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          yield* deploy(database, Base.layer, sleeping(Base, "o"))

          expect(yield* refusal(database, Retyped.layer)).toContain(
            `step "reserve" result schema changed  1 open execution`,
          )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: refuses startup when the workflow payload schema changes",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          yield* deploy(database, Base.layer, sleeping(Base, "o"))

          expect(yield* refusal(database, Reinput.layer)).toContain(
            `payload schema changed  1 open execution`,
          )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: refuses startup when an open execution's start manifest is missing",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const open = yield* deploy(
            database,
            Base.layer,
            Effect.gen(function* () {
              const executionId = yield* sleeping(Base, "o")
              const sql = yield* SqlClient.SqlClient
              yield* sql`DELETE FROM actor_workflow_manifests WHERE actor_type = 'Versioned'`.pipe(
                Effect.orDie,
              )

              return executionId
            }),
          )

          expect(yield* refusal(database, Audited.layer)).toContain(
            `start manifest missing  1 open execution`,
          )
          expect(
            yield* deploy(
              database,
              Base.layer,
              Effect.gen(function* () {
                expect(yield* checkWorkflows([Base.Versioned])).toEqual([])

                return yield* finish(Base, open)
              }),
            ),
          ).toBe("r-o:label:v0")
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: accepts renaming a step's TypeScript value without changing its name, and skips the full check when the manifest is unchanged",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const open = yield* deploy(database, Base.layer, sleeping(Base, "o"))
          const before = yield* deploy(database, Base.layer, manifests)

          yield* deploy(
            database,
            BaseAgain.layer,
            Effect.gen(function* () {
              expect(yield* manifests).toEqual(before)

              expect(
                yield* acceptWorkflows(declaredOf(BaseAgain.Versioned)).pipe(Effect.orDie),
              ).toEqual({ checked: false, incompatibilities: [], retained: true })
              expect(yield* finish(BaseAgain, open)).toBe("r-o:label:v0")
            }),
          )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: an unchanged startup still checks executions an older runner started since",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          yield* deploy(database, Base.layer, Effect.void)
          yield* deploy(database, Removed.layer, Effect.void)

          yield* deploy(
            database,
            Removed.layer,
            Effect.gen(function* () {
              const executionId = yield* sleeping(Removed, "o")
              const sql = yield* SqlClient.SqlClient
              const { manifest, hash } = yield* manifestOf("Versioned", Base.Order)

              yield* sql`INSERT INTO actor_workflow_manifests
                (actor_type, workflow, manifest_hash, manifest, accepted_at_ms)
                VALUES ('Versioned', 'Order', ${hash}, ${toJson(manifest)}::jsonb, 0)
                ON CONFLICT DO NOTHING`.pipe(Effect.orDie)
              yield* sql`UPDATE actor_workflow_executions SET manifest_hash = ${hash}
                WHERE execution_id = ${executionId}`.pipe(Effect.orDie)
            }),
          )

          expect(yield* refusal(database, Removed.layer)).toContain(
            `Versioned/Order  step "label" removed  1 open execution`,
          )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: a step a newer deployment settles under its changed result schema doesn't strand the execution",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const open = yield* deploy(database, Rested.layer, sleeping(Rested, "o"))

          yield* deploy(
            database,
            RestedRelabelled.layer,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* ActorTest.use((test) => test.advance("2 minutes"))

              yield* sql<{ manifest_hash: string }>`SELECT x.manifest_hash
                FROM actor_workflow_executions x JOIN actor_workflow_step s
                  ON s.routing_key = x.routing_key AND s.execution_id = x.execution_id
                WHERE x.execution_id = ${open} AND s.step = 'label' AND s.exit IS NOT NULL`.pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("25 millis"),
                  until: (rows) => rows.length > 0,
                }),
                Effect.timeoutOrElse({
                  duration: "30 seconds",
                  orElse: () => Effect.die(new Error("Timed out waiting for the label step")),
                }),
                Effect.orDie,
              )
              yield* suspended(open)
            }),
          )

          expect(
            yield* deploy(
              database,
              RestedRelabelled.layer,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient

                const [row] = yield* sql<{ manifest_hash: string }>`SELECT manifest_hash
                  FROM actor_workflow_executions WHERE execution_id = ${open}`.pipe(Effect.orDie)

                expect(row?.manifest_hash).toBe(yield* hashOf(RestedRelabelled))
                expect(yield* checkWorkflows([RestedRelabelled.Versioned])).toEqual([])
                expect(
                  (yield* checkWorkflows([Rested.Versioned])).map(({ problem }) => problem),
                ).toEqual([`step "label" result schema changed`])
                yield* ActorTest.use((test) => test.advance("2 minutes"))

                return yield* finish(RestedRelabelled, open)
              }),
            ),
          ).toBe("r-o:label:v0")
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: refuses a rollback that strands newer executions",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          yield* deploy(database, Marked.layer, Effect.void)
          const open = yield* deploy(database, MarkedNext.layer, sleeping(MarkedNext, "o"))

          expect(yield* refusal(database, Marked.layer)).toContain(
            `marker "fraud" 2 outside 0..1  1 open execution`,
          )
          expect(yield* deploy(database, MarkedNext.layer, finish(MarkedNext, open))).toBe(
            "r-o:label:v2",
          )
          yield* deploy(database, Marked.layer, Effect.void)
          const accepted = yield* deploy(database, Marked.layer, manifests)
          expect(accepted.at(-1)?.manifest_hash).toBe(yield* hashOf(Marked))
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: a runner lacking a start-manifest step leaves the execution suspended for a runner that has it",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const open = yield* deploy(
            database,
            Base.layer,
            Effect.gen(function* () {
              const executionId = yield* sleeping(Base, "o")
              const sql = yield* SqlClient.SqlClient
              const { manifest, hash } = yield* manifestOf("Versioned", Audited.Order)

              yield* sql`INSERT INTO actor_workflow_manifests
                (actor_type, workflow, manifest_hash, manifest, accepted_at_ms)
                VALUES ('Versioned', 'Order', ${hash}, ${toJson(manifest)}::jsonb, 0)`.pipe(
                Effect.orDie,
              )
              yield* sql`UPDATE actor_workflow_executions SET manifest_hash = ${hash}
                WHERE execution_id = ${executionId}`.pipe(Effect.orDie)

              yield* ActorTest.use((test) => test.advance("61 seconds"))
              yield* Effect.sleep("200 millis")
              expect(yield* status(executionId)).toBe("suspended")
              const polled = yield* (yield* Base.Versioned.run(Base.Order, executionId)).poll
              expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended")

              return executionId
            }),
          )

          expect(yield* deploy(database, Audited.layer, finish(Audited, open))).toBe("r-o:label:v0")
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: a runner of an older deployment leaves an execution a newer deployment started with a changed result schema suspended",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const open = yield* deploy(
            database,
            Base.layer,
            Effect.gen(function* () {
              const executionId = yield* sleeping(Base, "o")
              const sql = yield* SqlClient.SqlClient
              const { manifest, hash } = yield* manifestOf("Versioned", Retyped.Order)

              yield* sql`INSERT INTO actor_workflow_manifests
                (actor_type, workflow, manifest_hash, manifest, accepted_at_ms)
                SELECT 'Versioned', 'Order', ${hash}, ${toJson(manifest)}::jsonb, max(accepted_at_ms) + 1
                FROM actor_workflow_manifests WHERE actor_type = 'Versioned'`.pipe(Effect.orDie)
              yield* sql`UPDATE actor_workflow_executions SET manifest_hash = ${hash}
                WHERE execution_id = ${executionId}`.pipe(Effect.orDie)

              yield* ActorTest.use((test) => test.advance("61 seconds"))
              yield* Effect.sleep("200 millis")
              expect(yield* status(executionId)).toBe("suspended")

              return executionId
            }),
          )

          expect(yield* deploy(database, Retyped.layer, finish(Retyped, open))).toBe("r-o:label:v0")
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: a runner of an older deployment doesn't settle a step a newer deployment's start manifest retyped, even before it ran",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const newer = yield* hashOf(RestedRelabelled)

          const open = yield* deploy(
            database,
            Rested.layer,
            Effect.gen(function* () {
              const executionId = yield* sleeping(Rested, "o")
              const sql = yield* SqlClient.SqlClient
              const { manifest } = yield* manifestOf("Versioned", RestedRelabelled.Order)

              yield* sql`INSERT INTO actor_workflow_manifests
                (actor_type, workflow, manifest_hash, manifest, accepted_at_ms)
                SELECT 'Versioned', 'Order', ${newer}, ${toJson(manifest)}::jsonb, max(accepted_at_ms) + 1
                FROM actor_workflow_manifests WHERE actor_type = 'Versioned'`.pipe(Effect.orDie)
              yield* sql`UPDATE actor_workflow_executions SET manifest_hash = ${newer}
                WHERE execution_id = ${executionId}`.pipe(Effect.orDie)

              yield* ActorTest.use((test) => test.advance("61 seconds"))
              yield* Effect.sleep("200 millis")
              expect(yield* status(executionId)).toBe("suspended")

              const [row] = yield* sql<{ manifest_hash: string; label: number }>`SELECT
                x.manifest_hash, (SELECT count(*)::int FROM actor_workflow_step s
                  WHERE s.execution_id = x.execution_id AND s.step = 'label') AS label
                FROM actor_workflow_executions x WHERE x.execution_id = ${executionId}`.pipe(
                Effect.orDie,
              )

              expect(row).toEqual({ manifest_hash: newer, label: 0 })

              return executionId
            }),
          )

          expect(
            yield* deploy(
              database,
              RestedRelabelled.layer,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                yield* ActorTest.use((test) => test.advance("2 minutes"))

                yield* sql`SELECT 1 FROM actor_workflow_step
                  WHERE execution_id = ${open} AND step = 'label' AND exit IS NOT NULL`.pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("25 millis"),
                    until: (rows) => rows.length > 0,
                  }),
                  Effect.timeoutOrElse({
                    duration: "30 seconds",
                    orElse: () => Effect.die(new Error("Timed out waiting for the label step")),
                  }),
                  Effect.orDie,
                )
                yield* suspended(open)

                return yield* finish(RestedRelabelled, open)
              }),
            ),
          ).toBe("r-o:label:v0")
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: a start restores its start manifest when retention pruned it under a still-serving runner",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const base = yield* hashOf(Base)

          yield* deploy(
            database,
            Base.layer,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`DELETE FROM actor_workflow_manifests WHERE actor_type = 'Versioned'`.pipe(
                Effect.orDie,
              )
              yield* sleeping(Base, "o")
              expect(yield* manifests).toEqual([{ manifest_hash: base, accepted_at_ms: "0" }])
            }),
          )

          expect(
            yield* deploy(database, Audited.layer, checkWorkflows([Audited.Versioned])),
          ).toEqual([])
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: retention still prunes finished executions after an actor type drops its last workflow",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          yield* deploy(
            database,
            Base.layer,
            Effect.gen(function* () {
              expect(yield* finish(Base, yield* sleeping(Base, "o"))).toBe("r-o:label:v0")
            }),
          )

          const executions = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            const [row] = yield* sql<{ count: number }>`SELECT count(*)::integer AS count
              FROM actor_workflow_executions WHERE actor_type = 'Versioned'`

            return row!.count
          }).pipe(Effect.orDie)

          for (const sweeps of [false, true])
            yield* deploy(
              database,
              UnworkflowedLive,
              Effect.gen(function* () {
                const test = yield* ActorTest
                expect(yield* executions).toBe(1)

                if (!sweeps) return
                yield* test.advance("8 days")
                expect((yield* test.cleanup).workflows).toBe(1)
                expect(yield* executions).toBe(0)
              }),
            )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: retention keeps a manifest while an open execution started under it or it is the latest",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const open = yield* deploy(database, Base.layer, sleeping(Base, "o"))
          const base = yield* hashOf(Base)
          const audited = yield* hashOf(Audited)

          yield* deploy(
            database,
            Audited.layer,
            Effect.gen(function* () {
              const test = yield* ActorTest
              yield* test.cleanup
              expect((yield* manifests).map((row) => row.manifest_hash)).toEqual([base, audited])
              expect(yield* finish(Audited, open)).toBe("r-o:label:v0")
              yield* test.cleanup
              expect((yield* manifests).map((row) => row.manifest_hash)).toEqual([audited])
            }),
          )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    name: "workflow versions: the deploy check compares every actor type in the database, read-only",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          yield* deploy(database, Base.layer, sleeping(Base, "o"))

          yield* deploy(
            database,
            Base.layer,
            Effect.gen(function* () {
              expect(yield* checkWorkflows([Base.Versioned]).pipe(Effect.orDie)).toEqual([])

              const removed = yield* checkWorkflows([Removed.Versioned]).pipe(Effect.orDie)
              expect(removed.map(({ problem, open }) => ({ problem, open }))).toEqual([
                { problem: `step "label" removed`, open: 1 },
              ])

              const gone = yield* checkWorkflows([]).pipe(Effect.orDie)
              expect(gone.map(({ actorType, problem }) => `${actorType}: ${problem}`)).toEqual([
                "Versioned: actor type removed",
              ])
              expect((yield* manifests).map((row) => row.manifest_hash)).toEqual([
                yield* hashOf(Base),
              ])
            }),
          )
        }),
      ),
  },
]
