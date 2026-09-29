#!/usr/bin/env bun
import { Database } from "@durable-actors/core/runtime"
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Clock, Config, Console, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, type HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"

import {
  INSPECTOR_PATH,
  USAGE as DEV_USAGE,
  appOf,
  devRoutes,
  parseDev,
} from "./commands/dev/run.ts"
import {
  USAGE as DEFECTS_USAGE,
  formatDefects,
  listDefects,
  parseList,
} from "./commands/defects/list.ts"
import { USAGE as REPAIR_USAGE, parseRepair, repair } from "./commands/dead-letters/repair.ts"
import {
  USAGE as INSPECT_USAGE,
  formatInspection,
  inspect,
  parseInspect,
} from "./commands/inspect/show.ts"
import type { OperatorRefused, RunnerUnreachable } from "./commands/operator/request.ts"
import { USAGE as SKIP_USAGE, parseSkip, skip } from "./commands/subscriptions/skip.ts"
import { USAGE as RECEIPTS_USAGE, parseShow, showReceipt } from "./commands/receipts/show.ts"
import {
  type UsageError,
  USAGE,
  actorsOf,
  check,
  loadEntry,
  parseCheck,
} from "./commands/workflows/check.ts"
import { USAGE as PAYLOADS_USAGE, parsePayloads, payloads } from "./commands/payloads/run.ts"
import {
  USAGE as TENANTS_USAGE,
  controlPlane,
  create as createTenant,
  parseCreate,
} from "./commands/tenants/create.ts"

const fail = (message: string) =>
  Console.error(message).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 2
      }),
    ),
  )

const workflowsCheck = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options = yield* parseCheck(args)
    const module = yield* loadEntry(options.entry)
    const actors = yield* actorsOf({ module, entry: options.entry })

    const services = yield* Layer.build(
      Database.postgres({ url: Redacted.make(options.databaseUrl) }).pipe(
        Layer.provideMerge(BunCrypto.layer),
      ),
    )

    const { output, exitCode } = yield* check({ actors, json: options.json }).pipe(
      Effect.provideContext(services),
    )

    yield* Console.log(output)
    yield* Effect.sync(() => {
      process.exitCode = exitCode
    })
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      SqlError: (error) => fail(`Cannot read workflow state: ${error.message}`),
      UsageError: (error) => fail(`${error.message}\n${USAGE}`),
    }),
  )

const payloadsCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options = yield* parsePayloads(args)
    const module = yield* loadEntry(options.entry)
    const actors = yield* actorsOf({ module, entry: options.entry })

    const services = yield* Layer.build(
      Database.postgres({ url: Redacted.make(options.databaseUrl) }).pipe(
        Layer.provideMerge(BunCrypto.layer),
      ),
    )

    const { output, exitCode } = yield* payloads({
      command: options.command,
      actors,
      json: options.json,
    }).pipe(Effect.provideContext(services))

    yield* Console.log(output)
    yield* Effect.sync(() => {
      process.exitCode = exitCode
    })
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      SqlError: (error) => fail(`Cannot read payload versions: ${error.message}`),
      UsageError: (error) => fail(`${error.message}\n${PAYLOADS_USAGE}`),
    }),
  )

/**
 * Runs until interrupted: the entry's app and the inspector on one server. The
 * banner prints once the server listens, so `--port 0` reports the port the
 * server was given.
 */
const dev = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options = yield* parseDev(args)
    const module = yield* loadEntry(options.entry)
    const app = yield* appOf({ module, entry: options.entry })

    const database =
      options.databaseUrl === undefined
        ? Database.pglite(options.dataDir === undefined ? {} : { dataDir: options.dataDir })
        : Database.postgres({ url: Redacted.make(options.databaseUrl) })

    const banner = Layer.effectDiscard(
      HttpServer.addressFormattedWith((origin) =>
        Console.log(
          [
            `durable dev: ${options.entry} on ${options.databaseUrl === undefined ? `PGlite (${options.dataDir ?? "in memory"})` : "Postgres"}`,
            `  app        ${origin}`,
            `  inspector  ${origin}${INSPECTOR_PATH} (tenant ${options.tenant})`,
          ].join("\n"),
        ),
      ),
    )

    return Layer.mergeAll(
      HttpRouter.serve(devRoutes({ app, tenant: options.tenant })),
      banner,
    ).pipe(
      Layer.provide(BunHttpServer.layer({ port: options.port, hostname: options.hostname })),
      Layer.provide(database),
      Layer.provide(BunCrypto.layer),
    )
  }).pipe(
    Effect.flatMap(Layer.launch),
    Effect.catchTag("UsageError", (error) => fail(`${error.message}\n${DEV_USAGE}`)),
  )

const defectsList = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options = yield* parseList({ args, nowMs: yield* Clock.currentTimeMillis })
    const token = yield* operatorToken(options.tokenEnv)
    const services = yield* Layer.build(FetchHttpClient.layer)
    const defects = yield* listDefects(options, token).pipe(Effect.provideContext(services))

    yield* Console.log(formatDefects({ defects, json: options.json }))
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      UsageError: (error) => fail(`${error.message}\n${DEFECTS_USAGE}`),
      RunnerUnreachable: (error) => fail(`Cannot read defects from ${error.url}: ${error.message}`),
      ConfigError: (error) => fail(`Cannot read the operator token: ${error.message}`),
    }),
  )

/**
 * The operator token, read from the named environment variable when it is set.
 */
const operatorToken = (name: string) =>
  Effect.map(Config.option(Config.Redacted(name)), (token) =>
    Option.match(token, { onNone: () => undefined, onSome: (value) => Redacted.value(value) }),
  )

type OperatorFailure = UsageError | RunnerUnreachable | OperatorRefused | Schema.SchemaError

/**
 * Runs one operator request and prints its answer: formatted, or JSON with
 * `--json`.
 */
const operatorCommand = <O extends { readonly tokenEnv: string; readonly json: boolean }>(
  usage: string,
  parse: Effect.Effect<O, UsageError>,
  run: (request: {
    readonly options: O
    readonly token: string | undefined
  }) => Effect.Effect<Schema.Json, OperatorFailure, HttpClient.HttpClient>,
  format: (answer: Schema.Json) => Effect.Effect<string, OperatorFailure>,
) =>
  Effect.gen(function* () {
    const options = yield* parse
    const token = yield* operatorToken(options.tokenEnv)
    const services = yield* Layer.build(FetchHttpClient.layer)
    const answer = yield* run({ options, token }).pipe(Effect.provideContext(services))

    yield* Console.log(options.json ? yield* encodeJson(answer) : yield* format(answer))
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      UsageError: (error) => fail(`${error.message}\n${usage}`),
      RunnerUnreachable: (error) => fail(`Cannot reach ${error.url}: ${error.message}`),
      OperatorRefused: (error) =>
        Console.error(`Refused (${error.status}): ${error.body}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1
            }),
          ),
        ),
      ConfigError: (error) => fail(`Cannot read the operator token: ${error.message}`),
      SchemaError: (error) => fail(`Unexpected answer: ${error.message}`),
    }),
  )

const encodeJson = (answer: Schema.Json) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(answer).pipe(Effect.orDie)

const tenantsCreate = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options = yield* parseCreate(args)
    const services = yield* Layer.build(controlPlane(options.databaseUrl))

    yield* Console.log(yield* createTenant(options).pipe(Effect.provideContext(services)))
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      UsageError: (error) => fail(`${error.message}\n${TENANTS_USAGE}`),
      ActorError: (error) => fail(`durable tenants create failed: ${error.reason._tag}`),
    }),
  )

const program = Effect.gen(function* () {
  const [group, command, ...args] = process.argv.slice(2)

  if (group === "dev") return yield* dev(process.argv.slice(3))

  if (group === "workflows" && command === "check") return yield* workflowsCheck(args)

  if (group === "defects" && command === "list") return yield* defectsList(args)

  if (group === "payloads") return yield* payloadsCommand(process.argv.slice(3))

  if (group === "tenants" && command === "create") return yield* tenantsCreate(args)

  if (group === "inspect")
    return yield* operatorCommand(
      INSPECT_USAGE,
      parseInspect(process.argv.slice(3)),
      inspect,
      formatInspection,
    )

  if (group === "receipts" && command === "show")
    return yield* operatorCommand(RECEIPTS_USAGE, parseShow(args), showReceipt, encodeJson)

  if (group === "dead-letters" && (command === "retry" || command === "discard"))
    return yield* operatorCommand(
      REPAIR_USAGE,
      parseRepair({ action: command, args }),
      repair,
      encodeJson,
    )

  if (group === "subscriptions" && command === "skip")
    return yield* operatorCommand(SKIP_USAGE, parseSkip(args), skip, encodeJson)

  return yield* fail(
    [
      `Unknown command: ${[group, command].join(" ")}`,
      DEV_USAGE,
      USAGE,
      DEFECTS_USAGE,
      PAYLOADS_USAGE,
      INSPECT_USAGE,
      RECEIPTS_USAGE,
      REPAIR_USAGE,
      SKIP_USAGE,
      TENANTS_USAGE,
    ].join("\n"),
  )
})

BunRuntime.runMain(program)
