import { Config, Effect, Option } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type ConformanceGroup, conformanceGroups, describeConformance } from "../../conformance.ts"
import { postgresBackend } from "../postgres/database.ts"
import { nekiGroups } from "./groups.ts"

/** The connection string of a Neki router; the Neki suite runs only when it is set. */
export const NEKI_URL_VARIABLE = "TEST_NEKI_DATABASE_URL"

/** Why the suite is skipped when no router is configured, as printed in the skipped suite's name. */
export const NEKI_SKIP_REASON = `${NEKI_URL_VARIABLE} is not set; Neki runs are Dallen's, in #66`

/** Why a group is not run on Neki, as printed after each skipped case's name. */
export const NEKI_NO_FRESH_DATABASE = "needs a fresh database, which the Neki backend cannot create"

/**
 * Runs the conformance groups of `nekiGroups` against the Neki router that
 * `TEST_NEKI_DATABASE_URL` names. With no router configured, every case is
 * registered as skipped under a suite name that says why, so a report never
 * shows one passing; with one, the groups the suite cannot run are registered
 * as skipped by name with their reason.
 *
 * The router needs a data topology that places every framework table by
 * `routing_key` before the suite starts.
 */
export const describeNeki = () => {
  const running = new Set<ConformanceGroup>(nekiGroups)
  const groups = Object.keys(conformanceGroups) as Array<ConformanceGroup>

  const url = Option.getOrUndefined(
    Option.filter(
      Effect.runSync(Config.option(Config.String(NEKI_URL_VARIABLE))),
      (value) => value !== "",
    ),
  )

  if (url === undefined)
    return describe(`Neki durable turns (skipped: ${NEKI_SKIP_REASON})`, () => {
      for (const { name } of groups.flatMap((group) => conformanceGroups[group])) it.skip(name)
    })

  describeConformance({
    name: "Neki durable turns",
    backend: postgresBackend({ url: Effect.succeed(url), neki: true }),
    registrar: { describe, it, beforeAll, afterAll, expect, skip: (name) => it.skip(name) },
    cases: groups
      .filter((group) => running.has(group))
      .flatMap((group) => conformanceGroups[group]),
  })

  describe(`Neki durable turns not run (${NEKI_NO_FRESH_DATABASE})`, () => {
    for (const { name } of groups
      .filter((group) => !running.has(group))
      .flatMap((group) => conformanceGroups[group]))
      it.skip(name)
  })
}
