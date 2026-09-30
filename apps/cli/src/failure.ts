import { Console, Effect, Runtime, Schema } from "effect"

/** The arguments or the entry module cannot be used; the message says why. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

/**
 * A command ended unsuccessfully after printing why. It carries the process
 * exit status and is not printed again when the process ends.
 */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  exitCode: Schema.Int,
}) {
  override readonly [Runtime.errorReported] = false

  get [Runtime.errorExitCode]() {
    return this.exitCode
  }
}

/** Prints `failure.message` to stderr and ends the command with `failure.exitCode`, 2 unless given. */
export const fail = (failure: { readonly message: string; readonly exitCode?: number }) =>
  Console.error(failure.message).pipe(
    Effect.andThen(Effect.fail(CommandFailed.make({ exitCode: failure.exitCode ?? 2 }))),
  )
