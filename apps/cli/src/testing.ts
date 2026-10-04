import { BunServices } from "@effect/platform-bun"
import {
  Cause,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Predicate,
  Runtime,
  Schema,
} from "effect"
import { FetchHttpClient } from "effect/http"

import { run } from "./cli.ts"
import { type Credentials, saveCredentials } from "./commands/cloud/credentials.ts"
import { CommandFailed } from "./failure.ts"

/** What one `durable` invocation printed, and the exit status the bin would end with. */
export interface CliRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  /** The tag of the failure that ended the command: a `CliError` such as `MissingOption`, or a refusal such as `OperatorRefused`; empty on success. */
  readonly reason: string
}

/** How a test runs `durable`: `fetch` answers its HTTP requests and `env` replaces the environment it reads. */
export interface CliOptions {
  readonly fetch?: typeof fetch
  readonly env?: Record<string, string>
}

/**
 * Bun's services, as the bin provides them, with the test's `fetch` and
 * environment in place of the real ones.
 */
const services = (options: CliOptions) =>
  Layer.mergeAll(
    BunServices.layer,
    options.fetch === undefined
      ? FetchHttpClient.layer
      : FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.fetch)),
        ),
    options.env === undefined
      ? Layer.empty
      : ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env })),
  )

const start = (args: ReadonlyArray<string>, options: CliOptions) =>
  Effect.gen(function* () {
    const printed = { stdout: "", stderr: "" }

    const console: Console.Console = {
      ...globalThis.console,
      log: (...parts: ReadonlyArray<unknown>) => {
        printed.stdout += `${parts.join(" ")}\n`
      },
      error: (...parts: ReadonlyArray<unknown>) => {
        printed.stderr += `${parts.join(" ")}\n`
      },
    }

    const context = yield* Layer.build(services(options))

    const fiber = yield* run(args).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provideContext(context),
      Effect.exit,
      Effect.forkScoped,
    )

    return { printed, fiber }
  })

/**
 * Starts `durable` on `args` through `Command.runWith` in a scoped fiber, the
 * way the bin runs it. `printed` fills as the command prints, so a test can
 * watch a command that runs until interrupted, such as `dev`.
 */
export const startCli = (args: ReadonlyArray<string>) => start(args, {})

/** {@link startCli} with `options`, for a command a test must interact with while it runs, such as `login`. */
export const startCliWith = (options: CliOptions) => (args: ReadonlyArray<string>) =>
  start(args, options)

/**
 * Runs `durable` to completion with `options` and returns what it printed and
 * the exit status the bin would end with. A failure the bin would log
 * unreported is appended to `stderr`.
 */
export const runCliWith = (options: CliOptions) => (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { printed, fiber } = yield* start(args, options)
    const exit = yield* Fiber.join(fiber)
    let exitCode = 0

    Runtime.defaultTeardown(exit, (code) => {
      exitCode = code
    })

    const unreported =
      Exit.isFailure(exit) && Runtime.getErrorReported(Cause.squash(exit.cause))
        ? Cause.pretty(exit.cause)
        : ""

    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

    return {
      stdout: printed.stdout,
      stderr: `${printed.stderr}${unreported}`,
      exitCode,
      reason: Schema.is(CommandFailed)(failure)
        ? failure.reason
        : Predicate.hasProperty(failure, "_tag")
          ? String(failure._tag)
          : "",
    } satisfies CliRun
  }).pipe(Effect.scoped)

/** Runs `durable` on `args` to completion with the real environment; see {@link runCliWith}. */
export const runCli = runCliWith({})

/** One request a command sent through {@link recordingFetch}. */
export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string | null
  /** The request body as sent, empty for a GET. */
  readonly body: string
}

/** A `fetch` that answers every request with `answer` as JSON and records what it was sent. */
export const recordingFetch = (answer: Schema.Json) => {
  const requests: Array<RecordedRequest> = []

  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)

    return request.text().then((text) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: text,
      })

      return Response.json(answer)
    })
  }) as typeof globalThis.fetch

  return { fetch, requests }
}

/** One request sent through {@link scriptedFetch}, with its body's bytes as sent. */
export interface ScriptedRequest extends RecordedRequest {
  readonly bytes: Uint8Array
}

/**
 * A `fetch` that answers each request with `answer`, a stand-in for one
 * server's routes, and records what it was sent.
 */
export const scriptedFetch = (answer: (request: ScriptedRequest) => Response) => {
  const requests: Array<ScriptedRequest> = []

  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)

    return request.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer)
      const recorded = {
        method: request.method,
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: new TextDecoder().decode(bytes),
        bytes,
      }

      requests.push(recorded)

      return answer(recorded)
    })
  }) as typeof globalThis.fetch

  return { fetch, requests }
}

/**
 * A configuration directory, removed with the scope, holding `credentials`
 * as `durable login` stores them, or nothing; run commands with
 * `AKTER_CONFIG_DIR` set to it.
 */
export const configDirectory = (credentials?: Credentials) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = `${yield* fs.makeTempDirectoryScoped()}/akter`

    if (credentials !== undefined)
      yield* saveCredentials(credentials).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { AKTER_CONFIG_DIR: directory } }),
        ),
      )

    return directory
  })
