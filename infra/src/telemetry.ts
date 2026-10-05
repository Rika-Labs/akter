import * as Axiom from "alchemy/Axiom"
import { adopt } from "alchemy/AdoptPolicy"
import * as Output from "alchemy/Output"
import { retain } from "alchemy/RemovalPolicy"
import { Config, Effect, Redacted } from "effect"
import type { Deployment } from "./config.ts"

/**
 * Axiom's free Personal plan allows three datasets and three monitors for the whole
 * organization, so every stage ingests into these two and tells itself apart by the
 * `deployment.environment` resource attribute.
 */
export const datasets = { traces: "akter-traces", logs: "akter-logs" }

/**
 * The two datasets every stage ingests into, retained so that destroying a stage cannot take them
 * from the others. `prod` and the `preview` stage both declare them and adopt whatever exists,
 * so neither depends on the other having been deployed first.
 */
export const sharedDatasets = Effect.gen(function* () {
  const traces = yield* Axiom.Dataset("Traces", {
    name: datasets.traces,
    kind: "otel:traces:v1",
  }).pipe(adopt(true), retain())
  yield* Axiom.Dataset("Logs", { name: datasets.logs, kind: "otel:logs:v1" }).pipe(
    adopt(true),
    retain(),
  )
  return { traces }
})

/**
 * The ingest token of a stage, deleted with the stage. `prod` also owns the one error monitor,
 * which watches only its own environment: previews are expected to break. Axiom validates a
 * monitor's fields against the dataset when the monitor is created, and a dataset that has not
 * yet received a span with those attributes has no such fields, so the query reads them with
 * `column_ifexists`.
 */
export const telemetry = (deployment: Deployment) =>
  Effect.gen(function* () {
    const { layout } = deployment
    if (layout.kind === "prod") {
      const { traces } = yield* sharedDatasets
      yield* Axiom.Monitor("ServiceErrors", {
        name: "akter-errors",
        type: "Threshold",
        aplQuery: traces.name.pipe(
          Output.map(
            (name) =>
              `['${name}'] | where column_ifexists('status.code', '') == 'ERROR' | where column_ifexists('resource.deployment.environment', '') == '${layout.stage}' | summarize count()`,
          ),
        ),
        operator: "Above",
        threshold: 0,
        intervalMinutes: 5,
        rangeMinutes: 5,
        alertOnNoData: false,
        resolvable: true,
        notifierIds: [yield* Config.String("AXIOM_NOTIFIER_ID")],
      })
    }
    const ingest = yield* Axiom.ApiToken("TelemetryIngest", {
      name: `akter-${layout.stage}-ingest`,
      datasetCapabilities: {
        [datasets.traces]: { ingest: ["create"] },
        [datasets.logs]: { ingest: ["create"] },
      },
    })
    const headers = (dataset: string) =>
      ingest.token.pipe(
        Output.map((token) =>
          Redacted.make(
            `Authorization=Bearer%20${Redacted.value(token)},x-axiom-dataset=${dataset}`,
          ),
        ),
      )
    return {
      token: ingest.token,
      traceHeaders: headers(datasets.traces),
      logHeaders: headers(datasets.logs),
    }
  })
