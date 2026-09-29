#!/usr/bin/env bun
import { Database } from "@durable-actors/core/runtime"
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Clock, Config, Console, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"

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
import { USAGE, actorsOf, check, loadEntry, parseCheck } from "./commands/workflows/check.ts"

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

// Runs until interrupted: the entry's app and the inspector on one server.
const dev = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options = yield* parseDev(args)
    const module = yield* loadEntry(options.entry)
    const app = yield* appOf({ module, entry: options.entry })

    const database =
      options.databaseUrl === undefined
        ? Database.pglite(options.dataDir === undefined ? {} : { dataDir: options.dataDir })
        : Database.postgres({ url: Redacted.make(options.databaseUrl) })

    // Printed once the server listens, so `--port 0` reports the port it was given.
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
    const token = yield* Config.option(Config.Redacted(options.tokenEnv))
    const services = yield* Layer.build(FetchHttpClient.layer)

    const defects = yield* listDefects(
      options,
      Option.match(token, { onNone: () => undefined, onSome: (value) => Redacted.value(value) }),
    ).pipe(Effect.provideContext(services))

    yield* Console.log(formatDefects({ defects, json: options.json }))
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      UsageError: (error) => fail(`${error.message}\n${DEFECTS_USAGE}`),
      RunnerUnreachable: (error) => fail(`Cannot read defects from ${error.url}: ${error.message}`),
      ConfigError: (error) => fail(`Cannot read the operator token: ${error.message}`),
    }),
  )

// `durable login` and `durable deploy` join these under commands/.
const program = Effect.gen(function* () {
  const [group, command, ...args] = process.argv.slice(2)

  if (group === "dev") return yield* dev(process.argv.slice(3))

  if (group === "workflows" && command === "check") return yield* workflowsCheck(args)

  if (group === "defects" && command === "list") return yield* defectsList(args)

  return yield* fail(
    `Unknown command: ${[group, command].join(" ")}\n${DEV_USAGE}\n${USAGE}\n${DEFECTS_USAGE}`,
  )
})

BunRuntime.runMain(program)
