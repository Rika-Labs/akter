import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { version } from "../package.json" with { type: "json" }
import { runCli } from "./testing.ts"

describe("durable", () => {
  it("prints every command group in --help, and each command's flags with their descriptions", () =>
    Effect.gen(function* () {
      const root = yield* runCli(["--help"])

      expect(root.exitCode).toBe(0)
      expect(root.stdout).toContain("USAGE\n  durable <subcommand> [flags]")

      for (const command of [
        "dev",
        "workflows",
        "payloads",
        "defects",
        "inspect",
        "export",
        "receipts",
        "dead-letters",
        "subscriptions",
        "tenants",
      ])
        expect(root.stdout).toMatch(new RegExp(`^  ${command} +\\S`, "m"))

      const retry = yield* runCli(["dead-letters", "retry", "--help"])

      expect(retry.exitCode).toBe(0)
      expect(retry.stdout).toContain("durable dead-letters retry [flags] <effectId>")

      for (const flag of [
        "--actor",
        "--tenant",
        "--reason",
        "--url",
        "--token-env",
        "--json",
        "--provider-checked",
      ])
        expect(retry.stdout).toMatch(new RegExp(`^  ${flag}( \\w+)? +\\S`, "m"))

      const group = yield* runCli(["subscriptions"])

      expect(group.exitCode).toBe(0)
      expect(group.stdout).toMatch(/^ {2}list +\S/m)
      expect(group.stdout).toMatch(/^ {2}skip +\S/m)
    }).pipe(Effect.runPromise))

  it("prints its version and shell completions", () =>
    Effect.gen(function* () {
      expect(yield* runCli(["--version"])).toEqual({
        stdout: `durable v${version}\n`,
        stderr: "",
        exitCode: 0,
        reason: "",
      })

      const completions = yield* runCli(["--completions", "bash"])

      expect(completions.exitCode).toBe(0)
      expect(completions.stdout).toContain("durable")
      expect(completions.stdout).toContain("dead-letters")
    }).pipe(Effect.runPromise))

  it("refuses an unknown flag, a missing required flag, an invalid integer, and an unknown command with help and exit 2", () =>
    Effect.gen(function* () {
      for (const [args, reason, error] of [
        [
          ["inspect", "Room/r1", "--url", "u", "--tenant", "t", "--bogus"],
          "UnrecognizedOption",
          "Unrecognized flag: --bogus",
        ],
        [
          ["export", "Room/r1", "--url", "u", "--output", "f.seed"],
          "MissingOption",
          "Missing required flag: --tenant",
        ],
        [
          ["inspect", "Room/r1", "--url", "u", "--tenant", "t", "--receipts", "many"],
          "InvalidValue",
          'Invalid value for flag --receipts: "many"',
        ],
        [
          ["inspect", "--url", "u", "--tenant", "t"],
          "MissingArgument",
          "Missing required argument: actor",
        ],
        [["deploy"], "UnknownSubcommand", 'Unknown subcommand "deploy"'],
      ] as const) {
        const refused = yield* runCli(args)

        expect(refused).toMatchObject({ exitCode: 2, reason })
        expect(refused.stderr).toContain(error)
        expect(refused.stdout).toContain("USAGE")
      }
    }).pipe(Effect.runPromise))
})
