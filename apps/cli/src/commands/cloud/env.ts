import { EnvironmentName, EnvVariableName, ProjectId } from "@akter/cloud-api"
import { Config, Console, DateTime, Effect, FileSystem, Option, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { fail } from "../../failure.ts"
import { reportFailures, signedIn } from "./client.ts"

const scope = {
  project: Flag.String("project").pipe(
    Flag.withFallbackConfig(Config.String("AKTER_PROJECT")),
    Flag.withSchema(ProjectId),
  ),
  environment: Flag.Literals("env", EnvironmentName.literals).pipe(Flag.withDefault("production")),
}
const name = Argument.String("name").pipe(Argument.withSchema(EnvVariableName))

/** Secret input bypasses argument strings and terminal echo; the byte limit is enforced before concatenation. */
const input = (path: string | undefined, limit: number) =>
  Effect.gen(function* () {
    const tooLarge = () =>
      fail({
        reason: "EnvironmentInputTooLarge",
        message: `Environment input exceeds ${limit} bytes.`,
        exitCode: 2,
      })
    if (path !== undefined && path !== "-") {
      const fs = yield* FileSystem.FileSystem
      const stat = yield* fs.stat(path)
      if (Number(stat.size) > limit) return yield* tooLarge()
      const value = yield* fs.readFileString(path)
      if (new TextEncoder().encode(value).byteLength > limit) return yield* tooLarge()
      return value
    }
    const stdio = yield* Stdio.Stdio
    if (yield* stdio.stdinIsTerminal)
      return yield* fail({
        reason: "EnvironmentInputRequired",
        message:
          "Pipe the value on stdin or supply --file. Values are never accepted as command arguments.",
        exitCode: 2,
      })
    const collected = yield* stdio.stdin.pipe(
      Stream.runFoldEffect(
        () => ({ size: 0, chunks: new Array<Uint8Array>() }),
        (state, chunk) => {
          if (state.size + chunk.length > limit) return tooLarge()
          state.chunks.push(chunk)
          state.size += chunk.length
          return Effect.succeed(state)
        },
      ),
    )
    const bytes = new Uint8Array(collected.size)
    let offset = 0
    for (const chunk of collected.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return new TextDecoder().decode(bytes)
  })

const list = Command.make("list", scope, ({ project, environment }) =>
  Effect.gen(function* () {
    const { client } = yield* signedIn
    const variables = yield* client.environmentVariables.list({
      params: { projectId: project, environment },
    })
    for (const variable of variables)
      yield* Console.log(`${variable.name}\t${DateTime.formatIso(variable.updatedAt)}`)
  }).pipe(reportFailures),
).pipe(Command.withDescription("List variable names and update times; values cannot be read back"))

const set = Command.make(
  "set",
  { ...scope, name, file: Flag.File("file", { mustExist: true }).pipe(Flag.optional) },
  (options) =>
    Effect.gen(function* () {
      const { client } = yield* signedIn
      const value = yield* input(Option.getOrUndefined(options.file), 65536)
      yield* client.environmentVariables.set({
        params: {
          projectId: options.project,
          environment: options.environment,
          name: options.name,
        },
        payload: { value },
      })
      yield* Console.log(
        `Set ${options.name} in ${options.environment}. The value takes effect on the next deployment.`,
      )
    }).pipe(reportFailures),
).pipe(Command.withDescription("Set a write-only value from piped stdin or --file"))

const unset = Command.make("unset", { ...scope, name }, ({ project, environment, name }) =>
  Effect.gen(function* () {
    const { client } = yield* signedIn
    yield* client.environmentVariables.delete({ params: { projectId: project, environment, name } })
    yield* Console.log(
      `Unset ${name} in ${environment}. The change takes effect on the next deployment.`,
    )
  }).pipe(reportFailures),
).pipe(Command.withDescription("Remove an environment variable"))

const importVariables = Command.make(
  "import",
  { ...scope, file: Argument.String("file").pipe(Argument.withDefault("-")) },
  ({ project, environment, file }) =>
    Effect.gen(function* () {
      const { client } = yield* signedIn
      const content = yield* input(file, 1048576)
      const result = yield* client.environmentVariables.import({
        params: { projectId: project, environment },
        payload: { content },
      })
      yield* Console.log(
        `Imported ${result.created.length} new and ${result.updated.length} updated variables in ${environment}.`,
      )
    }).pipe(reportFailures),
).pipe(Command.withDescription("Import a dotenv file atomically; use - or no file for stdin"))

export const envCommand = Command.make("env").pipe(
  Command.withDescription("Manage encrypted, write-only Akter Cloud environment variables"),
  Command.withSubcommands([list, set, unset, importVariables]),
)
