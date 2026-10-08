import { Deferred, Effect, Exit } from "effect"
import { ActorTest } from "../../../../packages/akter/src/testing/actor-test.ts"
import type {
  ConformanceCase,
  ConformanceEnvironment,
  ConformanceServices,
} from "../conformance.ts"
import { mintSuite, mintWorkload, planAcrossShard } from "./mint.ts"
import { placementWorkload } from "./placement.ts"
import { type RecordedStatement, scopeOf, statementLog, type StatementScope } from "./statements.ts"

/**
 * Drives a turn, a wake, a due-work scan, and the parent families of the
 * placement fixtures, and returns every statement the runtime compiled while it
 * did. The suite's runtime stops meanwhile: the first runtime creates the
 * actors, and a second one wakes them from storage, so the recorder sits on
 * runtimes of this case alone. The suite's runtime is running again on return.
 * Start-up runs its own migrations and registry reads, so recording starts
 * only once a runtime has finished starting.
 */
const frameworkStatements = (environment: ConformanceEnvironment) =>
  Effect.gen(function* () {
    const log = statementLog()

    const on = (effect: Effect.Effect<void, never, ConformanceServices>, record: boolean) =>
      Effect.acquireUseRelease(
        Effect.sync(() => environment.build({ observe: log.observe })),
        (runtime) =>
          Effect.promise(() => runtime.runPromise(Effect.void)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                log.recording = record
              }),
            ),
            Effect.andThen(Effect.promise(() => runtime.runPromise(Effect.scoped(effect)))),
            Effect.ensuring(
              Effect.sync(() => {
                log.recording = false
              }),
            ),
          ),
        (runtime) => Effect.promise(() => runtime.dispose()),
      )

    yield* environment.stop
    yield* on(placementWorkload.create, false)

    yield* on(
      Effect.gen(function* () {
        yield* placementWorkload.wake
        yield* mintWorkload
        yield* (yield* ActorTest).advance("2 hours")
      }),
      true,
    ).pipe(Effect.ensuring(environment.restart))

    return Array.from(log.seen.values())
  })

const byScope = (statements: ReadonlyArray<RecordedStatement>) => {
  const scopes: Record<StatementScope, Array<RecordedStatement>> = {
    "table-free": [],
    keyed: [],
    scan: [],
    registry: [],
    unkeyed: [],
  }

  for (const statement of statements) scopes[scopeOf(statement.sql)].push(statement)

  return scopes
}

/**
 * Cases that each framework statement names its ownership key or scan range. The
 * minted-child case records only the trace of the child's delivery, and holds
 * that delivery at `afterClaim` until a statement of another trace, such as
 * the relay's poll pass, has run beside it, so every run checks the turn's
 * own statements whatever else the runner does meanwhile.
 */
export const singleShardConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "single-shard: a minted child's first turn touches only its own routing key, not its parent's outbox",
    run: ({ expect, environment, fixtureOf }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const log = statementLog()
          const beside = Deferred.makeUnsafe<void>()
          const fixture = fixtureOf(mintSuite)
          let child: Effect.Success<ReturnType<typeof planAcrossShard>> | undefined

          yield* environment.stop
          yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              environment.build({
                observe: (statement, span) => {
                  log.observe(statement, span)

                  if (log.elsewhere > 0) Deferred.doneUnsafe(beside, Exit.void)
                },
              }),
            ),
            (runtime) =>
              Effect.promise(() =>
                runtime.runPromise(
                  Effect.gen(function* () {
                    child = yield* planAcrossShard("child-statements")
                    fixture.onTurn = (point, request, trace) => {
                      if (request.ref.id !== child!.ref.id) return
                      if (point === "beforeOutboxDelete") log.recording = false
                      if (point !== "afterClaim") return

                      log.trace = trace
                      log.recording = true

                      return Deferred.await(beside)
                    }
                    yield* (yield* ActorTest).advance("1 minute")
                  }),
                ),
              ),
            (runtime) =>
              Effect.promise(() => runtime.dispose()).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    fixture.onTurn = undefined
                    log.recording = false
                  }),
                ),
              ),
          ).pipe(Effect.ensuring(environment.restart))

          const statements = Array.from(log.seen.values())
          const scopes = byScope(statements)
          expect(scopes.keyed.length > 0).toBe(true)
          expect(scopes.unkeyed).toEqual([])
          expect(scopes.scan).toEqual([])
          expect(scopes.registry).toEqual([])
          expect(
            scopes.keyed
              .filter(
                ({ params }) => !params.some((value) => String(value) === String(child!.childKey)),
              )
              .map(({ sql }) => sql),
          ).toEqual([])
          expect(
            statements
              .filter(({ params }) =>
                params.some((value) => String(value) === String(child!.parentKey)),
              )
              .map(({ sql }) => sql),
          ).toEqual([])
          expect(statements.filter(({ sql }) => /\bactor_outbox\b/.test(sql))).toEqual([])
        }),
      ),
  },
  {
    name: "single-shard: every framework statement of a turn, a wake, and a due-work scan names its routing key or its bucket range",
    run: ({ expect, environment }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const scopes = byScope(yield* frameworkStatements(environment))

          expect(scopes.keyed.length > 10).toBe(true)
          expect(scopes.scan.length).toBe(2)

          expect(
            scopes.scan.every(({ sql }) => /generate_series\(\$\d+::int, \$\d+::int\)/.test(sql)),
          ).toBe(true)

          expect(scopes.unkeyed.map(({ sql }) => sql)).toEqual([])
        }),
      ),
  },
]
