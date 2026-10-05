import { Effect, Layer, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability"

const redactedAttribute = (kind: Tracer.SpanKind, key: string) =>
  key.startsWith("http.request.header.") ||
  key.startsWith("http.response.header.") ||
  key === "url.full" ||
  key === "url.query" ||
  key === "client.address" ||
  (kind === "server" && key === "url.path")

/**
 * Wraps a tracer so its spans never record what Effect's HTTP tracing puts on them by default:
 * the request URL's path and query on server spans, the full and query URL of any span, every
 * request and response header, and the client address. Better Auth carries verification and
 * password-reset tokens in both the path and the query, and the forwarded requests of the edge
 * carry customer URLs, so a span keeps only the method, the matched route, the status and the
 * timing.
 */
export const redactSpans = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) => {
      const span = tracer.span(options)
      const record = span.attribute.bind(span)
      span.attribute = (key, value) => {
        if (!redactedAttribute(options.kind, key)) record(key, value)
      }
      return span
    },
    context: tracer.context,
  })

/**
 * Exports spans and logs over OTLP/HTTP protobuf as the standard `OTEL_*` variables direct:
 * `OTEL_TRACES_EXPORTER` and `OTEL_LOGS_EXPORTER` must name `otlp` for a signal to be sent,
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and the per-signal `OTEL_EXPORTER_OTLP_*_HEADERS` locate and
 * authenticate it, and `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` name the resource. A
 * signal whose exporter is not `otlp` stays on Effect's defaults, so a process without the
 * variables sends nothing. The exporter drops a failed batch and disables itself for a minute,
 * logging only at debug level, so a rejected token is invisible from the process alone.
 */
export const TelemetryLive = Layer.mergeAll(
  Layer.effect(
    Tracer.Tracer,
    Effect.map(Effect.service(Tracer.Tracer), (tracer) =>
      tracer === Tracer.nativeTracer ? tracer : redactSpans(tracer),
    ),
  ).pipe(Layer.provide(OtlpTracer.layerFromConfig())),
  OtlpLogger.layerFromConfig(),
).pipe(Layer.provide(OtlpSerialization.layerProtobuf), Layer.provide(FetchHttpClient.layer))
