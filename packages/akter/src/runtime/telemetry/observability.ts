import { Effect, Exit, Layer, Tracer } from "effect"
import { DevTools } from "effect/devtools"
import { OtlpMetrics, OtlpSerialization, OtlpTracer, PrometheusMetrics } from "effect/observability"
import { FetchHttpClient } from "effect/http"
import { RuntimeControl } from "../drain.ts"

/** Minimal telemetry surfaces: OTLP export, Prometheus formatting and Effect DevTools tracing. */
export interface TelemetryOptions {
  readonly otlp?: { readonly baseUrl: string; readonly headers?: Readonly<Record<string, string>> }
  readonly devtools?: { readonly url?: string }
}

/** The Prometheus scrape body for stable Akter metrics in the current runtime context. */
export const prometheus = PrometheusMetrics.format

/** Monotonic runner-local totals, including released shards; reading neither seals nor resets them. */
export const usage = Effect.flatMap(RuntimeControl, (control) => control.usage)

/** Build optional telemetry layers without adding a second metrics or tracing implementation. */
export const layer = (options: TelemetryOptions): Layer.Layer<never, never, never> => {
  let exporting: Layer.Layer<never, never, never> = Layer.empty
  if (options.otlp !== undefined)
    exporting = Layer.mergeAll(
      OtlpMetrics.layer({
        url: `${options.otlp.baseUrl.replace(/\/$/u, "")}/v1/metrics`,
        headers: options.otlp.headers,
        resource: { serviceName: "akter" },
      }),
      OtlpTracer.layer({
        url: `${options.otlp.baseUrl.replace(/\/$/u, "")}/v1/traces`,
        headers: options.otlp.headers,
        resource: { serviceName: "akter" },
      }),
    ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
  if (options.devtools !== undefined)
    exporting = DevTools.layer(options.devtools.url).pipe(Layer.provide(exporting))
  return Layer.effect(Tracer.Tracer, Effect.map(Effect.tracer, redactingTracer)).pipe(
    Layer.provide(exporting),
  )
}

/** Exporters see metadata-only failures and no attributes, links or event payloads from application code. */
export const redactingTracer = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = tracer.span({ ...options, links: [] })
      span.attribute = () => {}
      const end = span.end.bind(span)
      span.end = (time, exit) => end(time, Exit.isSuccess(exit) ? Exit.void : Exit.fail("redacted"))
      const event = span.event.bind(span)
      span.event = (_, time) => event("event", time, {})
      span.addLinks = () => {}
      return span
    },
    context: tracer.context,
  })

/** Public runtime telemetry entry point. */
export const Telemetry = { layer, prometheus, usage }
