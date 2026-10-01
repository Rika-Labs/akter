import { Config, Effect, Option } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { conformance, describeConformance } from "../../conformance.ts"
import { postgresBackend } from "../postgres/database.ts"

/** The connection string of a Neki router; the Neki suite runs only when it is set. */
export const NEKI_URL_VARIABLE = "TEST_NEKI_DATABASE_URL"

/** Why the suite is skipped when no router is configured, as printed in the skipped suite's name. */
export const NEKI_SKIP_REASON = `${NEKI_URL_VARIABLE} is not set; Neki runs are Dallen's, in #66`

/**
 * The Neki backend: a Postgres-protocol router that places every framework
 * table by `routing_key`. It cannot create databases beside its own, so every
 * case that declares `requiresFreshDatabase` is reported as skipped by name.
 */
export const nekiBackend = (url: string) =>
  postgresBackend({ url: Effect.succeed(url), neki: true, freshDatabases: false })

/**
 * Runs every conformance group against the Neki router that
 * `TEST_NEKI_DATABASE_URL` names. With no router configured, every case is
 * registered as skipped under a suite name that says why, so a report never
 * shows one passing; with one, each case whose requirements the router lacks
 * is registered as skipped by name.
 *
 * The router needs a data topology that places every framework table by
 * `routing_key` before the suite starts.
 */
export const describeNeki = () => {
  const url = Option.getOrUndefined(
    Option.filter(
      Effect.runSync(Config.option(Config.String(NEKI_URL_VARIABLE))),
      (value) => value !== "",
    ),
  )

  if (url === undefined)
    return describe(`Neki durable turns (skipped: ${NEKI_SKIP_REASON})`, () => {
      for (const { name } of conformance) it.skip(name)
    })

  describeConformance({
    name: "Neki durable turns",
    backend: nekiBackend(url),
    registrar: { describe, it, beforeAll, afterAll, expect, skip: (name) => it.skip(name) },
  })
}
