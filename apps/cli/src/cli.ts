import { Effect, Runtime, Schema } from "effect"
import { CliError, Command } from "effect/cli"

import { version } from "../package.json" with { type: "json" }
import { CommandFailed } from "./failure.ts"
import { deployCommand } from "./commands/cloud/deploy.ts"
import { loginCommand } from "./commands/cloud/login.ts"
import { logoutCommand } from "./commands/cloud/logout.ts"
import { whoamiCommand } from "./commands/cloud/whoami.ts"

import { envCommand } from "./commands/cloud/env.ts"
import { logsCommand } from "./commands/cloud/logs.ts"
import { keysCommand } from "./commands/cloud/keys.ts"

/** The `akter` command tree. */
export const akter = Command.make("akter").pipe(
  Command.withDescription("Sign in to Akter Cloud, deploy, and manage environments"),
  Command.withSubcommands([
    {
      group: "Akter Cloud",
      commands: [
        loginCommand,
        logoutCommand,
        whoamiCommand,
        deployCommand,
        envCommand,
        keysCommand,
        logsCommand,
      ],
    },
  ]),
)

const isShowHelp = Schema.is(CliError.ShowHelp)

/**
 * Runs `akter` on `args`, the arguments after the program name. Invalid
 * arguments print help and the error, and end with exit status 2, the status
 * of every usage error; a command
 * group named alone prints its help and exits 0.
 */
export const run = (args: ReadonlyArray<string>) =>
  Command.runWith(akter, { version })(args).pipe(
    Effect.catchIf(
      (error): error is CliError.CliError =>
        CliError.isCliError(error) && Runtime.getErrorExitCode(error) !== 0,
      (error) =>
        Effect.fail(
          CommandFailed.make({
            exitCode: 2,
            reason: isShowHelp(error) ? (error.errors[0]?._tag ?? "ShowHelp") : error._tag,
          }),
        ),
    ),
  )
