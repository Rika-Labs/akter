import * as Net from "node:net"
import { postgresState } from "alchemy/State/PostgresState"
import * as PgClient from "@effect/sql-pg/PgClient"
import { Config, Effect, Layer, Redacted } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"

/**
 * The stages a GitHub environment deploys keep their state in one dedicated PlanetScale Postgres
 * database: `prod` in the `production` environment's, and `preview` with every `pr-<n>` in the
 * `preview` environment's, which is what lets a pull request preview read the `preview` stage's
 * output. State holds generated secrets, so the two environments must not share a database.
 *
 * Alchemy serializes concurrent runs of a stage with a session advisory lock held on one reserved
 * connection that stays idle while images build. Hosted CI runners sit behind NAT that drops a TCP
 * flow after a few idle minutes, which kills that connection and with it the lock, so the pool's
 * sockets send TCP keepalives every 30 seconds.
 */
export const state = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.Redacted("ALCHEMY_STATE_DATABASE_URL")
    const { hostname, port } = new URL(Redacted.value(url))
    const client = yield* PgClient.make({
      url,
      stream: () =>
        Net.connect({
          host: hostname,
          port: port === "" ? 5432 : Number(port),
          noDelay: true,
          keepAlive: true,
          keepAliveInitialDelay: 30_000,
        }),
    })
    return postgresState({ client })
  }),
).pipe(Layer.provide(Reactivity.layer), Layer.orDie)
