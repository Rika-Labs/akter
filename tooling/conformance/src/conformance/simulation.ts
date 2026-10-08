import { Console, Effect, Layer, Schema } from "effect"
import { Actor } from "../../../../packages/akter/src/index.ts"
import { ActorTest } from "../../../../packages/akter/src/testing/actor-test.ts"
import { clusterLayer, ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment, ConformanceExpect } from "../conformance.ts"
import {
  simulateCluster,
  clusterSimulationSeeds,
  type ClusterSimulationOptions,
} from "../simulate-cluster.ts"

const Add = Actor.command("Add", { payload: Schema.Int, success: Schema.Int })

const Credit = Actor.command("Credit", { payload: Schema.Int })

const Pay = Actor.command("Pay", {
  payload: Schema.Struct({ to: Schema.String, amount: Schema.Int }),
})

const total = Actor.state({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) })

const Tally = Actor.make("SimClusterTally", { key: Schema.String, state: total, api: { Add } })

const Wallet = Actor.make("SimClusterWallet", {
  key: Schema.String,
  state: total,
  api: {},
  internal: { Credit },
})

const Payer = Actor.make("SimClusterPayer", { key: Schema.String, api: { Pay } })

export const simulationActors = Layer.mergeAll(
  Tally.toLayer(
    Effect.succeed({
      Add: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Tally.Turn
        yield* turn.state.set({ total: turn.state.total + amount })

        return turn.state.total
      }),
    }),
  ),
  Wallet.toLayer(
    Effect.succeed({
      Credit: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Wallet.Turn
        yield* turn.state.set({ total: turn.state.total + amount })
      }),
    }),
  ),
  Payer.toLayer(
    Effect.succeed({
      Pay: Effect.fnUntraced(function* ({ to, amount }) {
        yield* (yield* Wallet.intents(to)).Credit(amount)
      }),
    }),
  ),
)

/**
 * Direct adds and relayed payments on a few actors, sent through `commands`
 * commands of a seeded cluster simulation, then the totals each actor holds
 * against the sums the script sent. Actor names carry `tag`, so scripts of
 * several runs share a cluster without sharing state.
 */
export const clusterScript = ({
  expect,
  options,
  commands,
  tag = options.seed,
}: {
  readonly expect: ConformanceExpect
  readonly options: Omit<ClusterSimulationOptions, "commands">
  readonly commands: number
  readonly tag?: string
}) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    const expected = new Map<string, number>()

    const report = yield* simulateCluster({ ...options, commands }, (sim) =>
      Effect.gen(function* () {
        for (let index = 0; index < commands; index++) {
          const amount = yield* sim.int(1, 9)
          const name = `${tag}-${yield* sim.pick(["a", "b", "c"])}`

          if ((yield* sim.int(0, 1)) === 0) {
            const reply = yield* sim.command(
              `add ${name}`,
              Tally.get(name).pipe(Effect.flatMap((tally) => tally.Add(amount))),
            )

            expected.set(`tally:${name}`, (expected.get(`tally:${name}`) ?? 0) + amount)
            expect(reply).toBe(expected.get(`tally:${name}`))
          } else {
            yield* sim.command(
              `pay ${name}`,
              Payer.get(`${tag}-payer`).pipe(
                Effect.flatMap((payer) => payer.Pay({ to: name, amount })),
              ),
            )

            expected.set(`wallet:${name}`, (expected.get(`wallet:${name}`) ?? 0) + amount)
          }
        }
      }),
    )

    const held = new Map<string, unknown>()

    for (const key of expected.keys()) {
      const [kind, name] = key.split(":") as [string, string]

      held.set(
        key,
        (yield* cluster.on(0)(
          Effect.gen(function* () {
            const test = yield* ActorTest
            const handle = kind === "tally" ? yield* Tally.get(name) : yield* Wallet.get(name)

            return yield* test.inspect(handle.ref)
          }),
        )).state,
      )
    }

    return { report, expected, held }
  })

const clusterOn = <A, E>(
  environment: ConformanceEnvironment,
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  Effect.gen(function* () {
    const database = yield* environment.freshDatabase

    const context = yield* Layer.build(
      clusterLayer({
        database,
        runners: 3,
        shardLockExpiration: "3 seconds",
        actors: simulationActors,
        relay: { poll: "100 millis" },
      }),
    )

    return yield* body.pipe(Effect.provideContext(context))
  }).pipe(Effect.scoped)

const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  body: Effect.Effect<A, E, ActorCluster>,
) => environment.run(clusterOn(environment, body))

export const sums = (expected: ReadonlyMap<string, number>) =>
  new Map(Array.from(expected, ([key, sum]) => [key, { total: sum }]))

/**
 * Each seed gets a cluster of its own: settling moves the runners' clocks, and
 * a runner restarted by one seed's kill would start the next one behind them.
 * The seeded case logs each seed's schedule tagged `CLUSTER_SIMULATION`, so a
 * night's schedules can be read from its log.
 */
export const simulationConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "keeps receipts and outbox delivery exactly once across seeded runner kills, lost heartbeats, crashes, and lost connections on three runners",
    requiresIndependentConnections: true,
    timeoutMs: 1_800_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          for (const seed of yield* clusterSimulationSeeds)
            yield* clusterOn(
              environment,
              Effect.gen(function* () {
                const { report, expected, held } = yield* clusterScript({
                  expect,
                  options: {
                    seed: `c${seed}`,
                    faults: [
                      "crashBeforeCommit",
                      "crashAfterCommit",
                      "dropReply",
                      "runnerKill",
                      "heartbeatLoss",
                      "connectionLoss",
                    ],
                  },
                  commands: 8,
                })

                yield* Console.error(
                  `CLUSTER_SIMULATION seed=${seed} ${report.steps
                    .map(
                      ({ fault, point, landed }) => `${fault}${landed ? "+landed" : ""}@${point}`,
                    )
                    .join(" ")}`,
                )
                expect(report.steps.length).toBe(8)
                expect(held).toEqual(sums(expected))
              }),
            )
        }),
      ),
  },
  {
    name: "reruns a seed on three runners to the same fault schedule and outcome",
    requiresIndependentConnections: true,
    timeoutMs: 300_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        Effect.gen(function* () {
          const options = {
            seed: "repeat",
            faults: ["crashBeforeCommit", "crashAfterCommit", "dropReply", "connectionLoss"],
            faultRate: 0.8,
          } as const

          const first = yield* clusterScript({ expect, options, commands: 6, tag: "first" })
          const second = yield* clusterScript({ expect, options, commands: 6, tag: "second" })

          const schedule = (run: typeof first) =>
            run.report.steps.map(({ label, fault, runner, point, landed }) => [
              label.split(" ")[0],
              fault,
              runner,
              point,
              landed,
            ])

          expect(schedule(second)).toEqual(schedule(first))
          expect(first.report.steps.some(({ fault }) => fault === "connectionLoss")).toBe(true)

          expect(Array.from(second.expected.values())).toEqual(Array.from(first.expected.values()))
          expect(second.held).toEqual(sums(second.expected))
        }),
      ),
  },
  {
    name: "dies with the seed when a cluster program sends no command",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        Effect.gen(function* () {
          const failure = yield* simulateCluster(
            { seed: "empty", faults: ["runnerKill"] },
            () => Effect.void,
          ).pipe(Effect.exit)

          expect(String(failure)).toContain("Simulation failed with seed empty")
          expect(String(failure)).toContain("the program sent no command")
        }),
      ),
  },
  {
    name: "refuses a primary failover without a primary to fail over or a command count",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        Effect.gen(function* () {
          const unwired = yield* simulateCluster(
            { seed: "failover", faults: ["primaryFailover"], commands: 1 },
            () => Effect.void,
          ).pipe(Effect.exit)

          expect(String(unwired)).toContain("primaryFailover needs the primary option")

          const uncounted = yield* simulateCluster(
            { seed: "failover", faults: ["primaryFailover"], primary: Effect.void },
            () => Effect.void,
          ).pipe(Effect.exit)

          expect(String(uncounted)).toContain("primaryFailover needs the number of commands")
        }),
      ),
  },
]
