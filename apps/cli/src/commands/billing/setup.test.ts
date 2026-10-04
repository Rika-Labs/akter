import { StripeBillingLocal, defaultPricingConfig, stripeTiers } from "@akter/billing"
import { BunCrypto } from "@effect/platform-bun"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { runCli } from "../../testing.ts"
import { setupCatalog } from "./setup.ts"

describe("akter billing setup", () => {
  it("defaults to local mode and refuses to open a provider without its local database", () =>
    Effect.gen(function* () {
      const help = yield* runCli(["billing", "setup", "--help"])
      expect(help.exitCode).toBe(0)
      expect(help.stdout).toContain("--mode")
      expect(help.stdout).toContain("--database-url")
      const refused = yield* runCli(["billing", "setup"])
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain("Local billing setup requires --database-url")
    }).pipe(Effect.runPromise))

  it("reconciles a catalog twice without changing any product or price identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          StripeBillingLocal({
            tiers: stripeTiers(defaultPricingConfig),
            webhookSecret: Redacted.make("unused-local-setup-test-secret"),
          }).pipe(Layer.provide(Layer.mergeAll(PgliteClient.layer({}), BunCrypto.layer))),
        )
        const first = yield* setupCatalog.pipe(Effect.provideContext(context))
        const second = yield* setupCatalog.pipe(Effect.provideContext(context))
        expect(second).toEqual(first)
        expect(first.tiers.map(({ tierId }) => tierId)).toEqual(["pro", "team", "enterprise"])
        expect(first.tiers.every((tier) => tier.usage.length === 2)).toBe(true)
      }),
    ).pipe(Effect.runPromise))
})
