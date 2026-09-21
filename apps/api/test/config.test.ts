import { describe, expect, it } from "vitest"
import { loadConfig } from "../src/config.ts"

const local = {
  DATABASE_URL: "postgres://test:test@localhost/test",
  APP_ORIGIN: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-only-secret-with-at-least-32-characters",
  EMAIL_MODE: "capture",
}

describe("configuration", () => {
  it("uses local capture and port 3001 only with explicit valid auth/database configuration", () => {
    expect(loadConfig(local)).toMatchObject({ port: 3001, emailMode: "capture", polar: undefined })
    expect(() => loadConfig({ ...local, BETTER_AUTH_SECRET: "short" })).toThrow(
      "Invalid API environment",
    )
    expect(() => loadConfig({ ...local, PORT: "65536" })).toThrow()
    expect(() => loadConfig({ ...local, APP_ORIGIN: "http://localhost:3000/path" })).toThrow()
  })
  it("fails closed for production email, partial Polar and partial Axiom configuration", () => {
    expect(() =>
      loadConfig({ ...local, NODE_ENV: "production", APP_ORIGIN: "https://example.com" }),
    ).toThrow("Production email")
    expect(() => loadConfig({ ...local, POLAR_ACCESS_TOKEN: "secret" })).toThrow("Polar requires")
    expect(() => loadConfig({ ...local, AXIOM_DATASET: "logs" })).toThrow("Axiom requires")
  })
})
