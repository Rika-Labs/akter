import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpTracer, OtlpLogger, OtlpSerialization } from "effect/observability"

/**
 * Exports traces and logs to Axiom over OTLP when a token and dataset are
 * given; without a config it adds nothing. The dataset and token come from the
 * Axiom resources in `infra`.
 */
export const observabilityLayer = (config?: { token: string; dataset: string }) =>
  config !== undefined
    ? Layer.mergeAll(
        OtlpTracer.layer({
          url: "https://api.axiom.co/v1/traces",
          headers: { Authorization: `Bearer ${config.token}`, "X-Axiom-Dataset": config.dataset },
          resource: { serviceName: "project-api" },
        }),
        OtlpLogger.layer({
          url: "https://api.axiom.co/v1/logs",
          headers: { Authorization: `Bearer ${config.token}`, "X-Axiom-Dataset": config.dataset },
          resource: { serviceName: "project-api" },
          mergeWithExisting: true,
        }),
      ).pipe(Layer.provide(Layer.merge(FetchHttpClient.layer, OtlpSerialization.layerJson)))
    : Layer.empty
