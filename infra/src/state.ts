import { postgresState } from "alchemy/State/PostgresState"
import { Config } from "effect"

/**
 * The stages a GitHub environment deploys keep their state in one dedicated PlanetScale Postgres
 * database: `prod` in the `production` environment's, and `preview` with every `pr-<n>` in the
 * `preview` environment's, which is what lets a pull request preview read the `preview` stage's
 * output. State holds generated secrets, so the two environments must not share a database.
 * Alchemy serializes concurrent runs of a stage with an advisory lock in this database.
 */
export const state = postgresState({ url: Config.Redacted("ALCHEMY_STATE_DATABASE_URL") })
