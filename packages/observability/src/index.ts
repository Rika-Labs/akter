import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpTracer, OtlpLogger, OtlpSerialization } from "effect/unstable/observability"

// Dataset/token are provisioned by the Alchemy Axiom resources in infra.
// OTLP is a standard transport, not a second provider SDK or ingestion client.
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
