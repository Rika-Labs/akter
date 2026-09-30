import { Effect, Schema } from "effect"

/** The arguments could not be parsed; the message says why. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

/** A command line split into valued flags, switches, and positional arguments. */
export interface ParsedFlags {
  /** The last value given for each valued flag. */
  readonly flags: ReadonlyMap<string, string>
  /** Every value given for a repeatable flag, in order. */
  readonly repeated: (flag: string) => ReadonlyArray<string>
  readonly switches: ReadonlySet<string>
  readonly positional: ReadonlyArray<string>
}

/**
 * Parses `args` against the command's `valued` flags, which take the next
 * argument as their value, and its `switches`. Any other `--` argument, or a
 * positional argument past `maxPositional`, is a usage error.
 */
export const parseFlags = ({
  args,
  valued,
  switches: known = [],
  maxPositional = Infinity,
}: {
  readonly args: ReadonlyArray<string>
  readonly valued: ReadonlyArray<string>
  readonly switches?: ReadonlyArray<string>
  readonly maxPositional?: number
}) =>
  Effect.gen(function* () {
    const values = new Map<string, Array<string>>()
    const switches = new Set<string>()
    const positional: Array<string> = []

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!

      if (!arg.startsWith("--")) {
        if (positional.length === maxPositional)
          return yield* UsageError.make({ message: `Unknown argument: ${arg}` })

        positional.push(arg)
        continue
      }

      if (known.includes(arg)) {
        switches.add(arg)
        continue
      }

      if (!valued.includes(arg))
        return yield* UsageError.make({ message: `Unknown argument: ${arg}` })

      const value = args[++index]

      if (value === undefined) return yield* UsageError.make({ message: `${arg} needs a value` })

      values.set(arg, [...(values.get(arg) ?? []), value])
    }

    return {
      flags: new Map([...values].map(([flag, given]) => [flag, given.at(-1)!])),
      repeated: (flag) => values.get(flag) ?? [],
      switches,
      positional,
    } satisfies ParsedFlags
  })
