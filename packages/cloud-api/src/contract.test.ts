import { OpenApi } from "effect/http-api"
import { describe, expect, it } from "vitest"

import { Authentication } from "./auth.ts"
import { CloudApi } from "./contract.ts"

const endpoints = Object.values(CloudApi.groups).flatMap((group) =>
  Object.values(group.endpoints).map((endpoint) => ({ group: group.identifier, endpoint })),
)

const spec = OpenApi.fromApi(CloudApi)

const methods = ["get", "post", "put", "patch", "delete"] as const

const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  methods.flatMap((method) => {
    const operation = item[method]
    return operation === undefined ? [] : [{ path, method, operation }]
  }),
)

describe("CloudApi", () => {
  it("declares every console group once", () => {
    expect(Object.keys(CloudApi.groups).toSorted()).toEqual(
      [
        "account",
        "apiKeys",
        "audit",
        "billing",
        "deployments",
        "domains",
        "environmentVariables",
        "integrations",
        "invitations",
        "members",
        "organizations",
        "projects",
        "regions",
        "runtime",
        "usage",
      ].toSorted(),
    )
  })

  it("serves every endpoint under /api, none outside it", () => {
    const outside = endpoints.filter(({ endpoint }) => endpoint.path.startsWith("/api/") === false)
    expect(outside).toEqual([])
  })

  it("never declares the same method and path twice", () => {
    const keys = endpoints.map(({ endpoint }) => `${endpoint.method} ${endpoint.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("requires Authentication on every endpoint, so no route can run anonymously", () => {
    const open = endpoints.filter(
      ({ endpoint }) =>
        ![...endpoint.middlewares].some((middleware) => middleware === Authentication),
    )
    expect(open).toEqual([])
  })

  it("makes Authentication a security middleware over session cookies, the x-api-key header and a bearer session token", () => {
    expect(Object.keys(Authentication.security).toSorted()).toEqual([
      "apiKey",
      "bearer",
      "secureSession",
      "session",
    ])
    expect(Object.keys(spec.components.securitySchemes).toSorted()).toEqual([
      "apiKey",
      "bearer",
      "secureSession",
      "session",
    ])
    expect(spec.components.securitySchemes["bearer"]).toMatchObject({
      type: "http",
      scheme: "Bearer",
    })
    expect(spec.components.securitySchemes["apiKey"]).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    })
    expect(spec.components.securitySchemes["secureSession"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "__Secure-better-auth.session_token",
    })
  })

  it("lists every endpoint in OpenAPI with the typed error statuses", () => {
    expect(operations).toHaveLength(endpoints.length)
    for (const { operation } of operations) {
      const statuses = Object.keys(operation.responses)
      expect(statuses).toContain("401")
      expect(statuses).toContain("501")
    }
  })

  it("exposes only the environment variable names, never a value, in its read paths", () => {
    const read = operations.find(
      ({ method, path }) =>
        method === "get" &&
        path === "/api/projects/{projectId}/environments/{environment}/variables",
    )
    const body = JSON.stringify(read?.operation.responses["200"])
    expect(body).toContain("usedBy")
    expect(body).not.toContain('"value"')
  })

  it("streams the live command tail as server-sent events", () => {
    const stream = operations.find(({ path }) => path.endsWith("/runtime/commands/stream"))
    expect(Object.keys(stream?.operation.responses["200"]?.content ?? {})).toEqual([
      "text/event-stream",
    ])
  })

  it("keeps API key secrets out of every response except the create-key response", () => {
    const leaking = operations
      .filter(({ operation }) => JSON.stringify(operation.responses).includes('"secret"'))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
    expect(leaking).toEqual(["POST /api/organizations/{organizationId}/api-keys"])
  })
})
