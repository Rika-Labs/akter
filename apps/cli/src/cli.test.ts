import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { version } from "../package.json" with { type: "json" }
import { runCli } from "./testing.ts"

describe("akter", () => {
  it("prints every command group in --help, and each command's flags with their descriptions", () =>
    Effect.gen(function* () {
      const root = yield* runCli(["--help"])

      expect(root.exitCode).toBe(0)
      expect(root.stdout).toContain("USAGE\n  akter <subcommand> [flags]")

      for (const command of [
        "login",
        "logout",
        "whoami",
        "deploy",
        "env",
        "keys",
        "logs",
        "storage",
        "inspect",
        "log",
        "snapshot",
        "replay",
        "dev",
        "fork",
      ])
        expect(root.stdout).toMatch(new RegExp(`^  ${command} +\\S`, "m"))

      expect(root.stdout).not.toMatch(/^  (tenants|billing|operator) +\S/m)

      const create = yield* runCli(["keys", "create", "--help"])

      expect(create.exitCode).toBe(0)
      expect(create.stdout).toContain("akter keys create [flags] <name>")

      for (const flag of ["--project", "--env", "--tenant"])
        expect(create.stdout).toMatch(new RegExp(`^  ${flag}( \\w+)? +\\S`, "m"))

      const check = yield* runCli(["storage", "check", "--help"])

      expect(check.exitCode).toBe(0)
      expect(check.stdout).toContain("akter storage check [flags]")

      for (const flag of [
        "--bucket",
        "--endpoint",
        "--region",
        "--prefix",
        "--directory",
        "--json",
      ])
        expect(check.stdout).toMatch(new RegExp(`^  ${flag}( \\w+)? +\\S`, "m"))

      expect(check.stdout).not.toMatch(/--(secret|access-key|token|password)/)

      const group = yield* runCli(["keys"])

      expect(group.exitCode).toBe(0)
      expect(group.stdout).toMatch(/^ {2}create +\S/m)
      expect(group.stdout).toMatch(/^ {2}revoke +\S/m)
    }).pipe(Effect.runPromise))

  it("prints its version and shell completions", () =>
    Effect.gen(function* () {
      expect(yield* runCli(["--version"])).toEqual({
        stdout: `akter v${version}\n`,
        stderr: "",
        exitCode: 0,
        reason: "",
      })

      const completions = yield* runCli(["--completions", "bash"])

      expect(completions.exitCode).toBe(0)
      expect(completions.stdout).toContain("akter")
      expect(completions.stdout).toContain("keys")
    }).pipe(Effect.runPromise))

  it("refuses an unknown flag, a missing required flag, an invalid integer, and an unknown command with help and exit 2", () =>
    Effect.gen(function* () {
      for (const [args, reason, error] of [
        [["logs", "--project", "p", "--bogus"], "UnrecognizedOption", "Unrecognized flag: --bogus"],
        [
          ["logs", "--project", "p", "--limit", "many"],
          "InvalidValue",
          'Invalid value for flag --limit: "many"',
        ],
        [
          ["keys", "revoke", "--project", "p"],
          "MissingArgument",
          "Missing required argument: keyId",
        ],
        [["launch"], "UnknownSubcommand", 'Unknown subcommand "launch"'],
        [["billing", "setup"], "UnknownSubcommand", 'Unknown subcommand "billing"'],
        [["tenants", "create"], "UnknownSubcommand", 'Unknown subcommand "tenants"'],
        [["deploy"], "MissingOption", "Missing required flag: --project"],
        [["inspect", "Room/r1"], "UnknownSubcommand", 'Unknown subcommand "Room/r1"'],
        [["adopt", "plan"], "UnknownSubcommand", 'Unknown subcommand "adopt"'],
      ] as const) {
        const refused = yield* runCli(args)

        expect(refused).toMatchObject({ exitCode: 2, reason })
        expect(refused.stderr).toContain(error)
        expect(refused.stdout).toContain("USAGE")
      }
    }).pipe(Effect.runPromise))
})
