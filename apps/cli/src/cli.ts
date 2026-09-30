import { Effect, Runtime, Schema } from "effect"
import { CliError, Command } from "effect/unstable/cli"

import { version } from "../package.json" with { type: "json" }
import {
  backfillCommand,
  enforceCommand,
  observeCommand,
  planCommand,
  releaseCommand,
  statusCommand,
} from "./commands/adopt/run.ts"
import { discardCommand, retryCommand } from "./commands/dead-letters/repair.ts"
import { listCommand as defectsListCommand } from "./commands/defects/list.ts"
import { devCommand } from "./commands/dev/run.ts"
import { exportCommand } from "./commands/export/run.ts"
import { inspectCommand } from "./commands/inspect/show.ts"
import { checkCommand as payloadsCheckCommand, clearCommand } from "./commands/payloads/run.ts"
import { showCommand } from "./commands/receipts/show.ts"
import { listCommand as subscriptionsListCommand } from "./commands/subscriptions/list.ts"
import { skipCommand } from "./commands/subscriptions/skip.ts"
import { createCommand } from "./commands/tenants/create.ts"
import { checkCommand as workflowsCheckCommand } from "./commands/workflows/check.ts"
import { CommandFailed } from "./failure.ts"

const group = <const Subcommands extends ReadonlyArray<Command.Command.SubcommandEntry>>(
  name: string,
  description: string,
  subcommands: Subcommands,
) =>
  Command.make(name).pipe(
    Command.withDescription(description),
    Command.withSubcommands(subcommands),
  )

/** The `durable` command tree. */
export const durable = Command.make("durable").pipe(
  Command.withDescription("Develop, deploy, and operate durable actors"),
  Command.withSubcommands([
    {
      group: "Develop and deploy",
      commands: [
        devCommand,
        group("workflows", "Check workflow changes against open executions", [
          workflowsCheckCommand,
        ]),
        group("payloads", "Check and clear stored event and effect payload versions", [
          payloadsCheckCommand,
          clearCommand,
        ]),
        group(
          "adopt",
          "Adopt existing tables: plan, observe legacy writers, backfill, enforce, and check status",
          [
            planCommand,
            observeCommand,
            backfillCommand,
            enforceCommand,
            statusCommand,
            releaseCommand,
          ],
        ),
      ],
    },
    {
      group: "Operate a running deployment",
      commands: [
        group("defects", "Read recent defects from runners", [defectsListCommand]),
        inspectCommand,
        exportCommand,
        group("receipts", "Read stored command outcomes", [showCommand]),
        group("dead-letters", "Repair dead-lettered effects; the runner audits each repair", [
          retryCommand,
          discardCommand,
        ]),
        group("subscriptions", "List and skip stuck subscription rows", [
          subscriptionsListCommand,
          skipCommand,
        ]),
      ],
    },
    {
      group: "Control plane",
      commands: [group("tenants", "Manage the tenant directory", [createCommand])],
    },
  ]),
)

const isShowHelp = Schema.is(CliError.ShowHelp)

/**
 * Runs `durable` on `args`, the arguments after the program name. Invalid
 * arguments print help and the error, and end with exit status 2, the status
 * of every usage error; a command
 * group named alone prints its help and exits 0.
 */
export const run = (args: ReadonlyArray<string>) =>
  Command.runWith(durable, { version })(args).pipe(
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
