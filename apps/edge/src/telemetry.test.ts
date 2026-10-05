import { expect, it } from "vitest"
import { Context, Option, Tracer } from "effect"
import { redactSpans } from "./telemetry.ts"

const open = (kind: Tracer.SpanKind) =>
  redactSpans(Tracer.nativeTracer).span({
    name: "forward",
    parent: Option.none(),
    annotations: Context.empty(),
    links: [],
    startTime: 0n,
    kind,
    root: true,
    sampled: true,
  })

const record = (span: Tracer.Span) => {
  span.attribute("http.request.method", "GET")
  span.attribute("http.response.status_code", 200)
  span.attribute("url.full", "https://tenant.example.dev/orders/42?token=secret")
  span.attribute("url.query", "token=secret")
  span.attribute("url.path", "/orders/42")
  span.attribute("http.request.header.authorization", "Bearer secret")
  span.attribute("http.request.header.x-customer", "ada")
  span.attribute("http.response.header.set-cookie", "session=secret")
  span.attribute("client.address", "203.0.113.9")
  return Object.fromEntries(span.attributes)
}

it("keeps the method and status of a forwarded request and drops its URL query, headers and client address", () => {
  expect(record(open("client"))).toEqual({
    "http.request.method": "GET",
    "http.response.status_code": 200,
    "url.path": "/orders/42",
  })
})

it("also drops the path of a server span", () => {
  expect(record(open("server"))).toEqual({
    "http.request.method": "GET",
    "http.response.status_code": 200,
  })
})
