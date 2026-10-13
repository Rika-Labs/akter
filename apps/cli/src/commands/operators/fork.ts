import { pathToFileURL } from "node:url"
import { App, Forks, OperatorGrant, Store } from "@rikalabs/akter/server"
import type { MemberSchema } from "@rikalabs/akter"
import {
  Config,
  Console,
  Context,
  Effect,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
  Schema,
} from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { fail } from "../../failure.ts"

const optional = (name: string) => Flag.String(name).pipe(Flag.optional)
const positive = (name: string) =>
  Flag.Int(name).pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    Flag.optional,
  )

/** Offline operator authority comes from a separately authenticated grant, never an application caller. */
export const forkCommand = Command.make(
  "fork",
  {
    type: Argument.String("Type"),
    id: Argument.String("id"),
    app: Flag.String("app").pipe(Flag.withDefault("src/app.ts")),
    directory: optional("directory"),
    bucket: optional("bucket"),
    prefix: Flag.String("prefix").pipe(Flag.withDefault("")),
    endpoint: optional("endpoint"),
    toDirectory: optional("to-directory"),
    toPrefix: optional("to-prefix"),
    to: optional("to"),
    at: positive("at"),
    before: optional("before"),
    offset: positive("offset"),
    index: positive("index"),
    withWork: Flag.Boolean("with-work").pipe(Flag.withDefault(false)),
    jsonIds: Flag.Boolean("json-ids").pipe(Flag.withDefault(false)),
    tokenEnv: Flag.String("token-env").pipe(Flag.withDefault("AKTER_OPERATOR_TOKEN")),
  },
  (options) =>
    Effect.gen(function* () {
      if (Option.isSome(options.directory) === Option.isSome(options.bucket))
        return yield* fail({
          reason: "Target",
          message: "Choose exactly one of --directory and --bucket.",
          exitCode: 2,
        })
      const positions =
        Number(Option.isSome(options.at)) +
        Number(Option.isSome(options.before)) +
        Number(Option.isSome(options.offset))
      if (positions !== 1 || Option.isSome(options.offset) !== Option.isSome(options.index))
        return yield* fail({
          reason: "Position",
          message: "Choose --at, --before, or both --offset and --index.",
          exitCode: 2,
        })
      if (
        (Option.isSome(options.toDirectory) && Option.isSome(options.bucket)) ||
        (Option.isSome(options.toPrefix) && Option.isSome(options.directory))
      )
        return yield* fail({
          reason: "Target",
          message: "The fork target must use the source adapter.",
          exitCode: 2,
        })
      const before = Option.isSome(options.before) ? Date.parse(options.before.value) : undefined
      if (before !== undefined && !Number.isFinite(before))
        return yield* fail({
          reason: "Position",
          message: "--before must be an ISO instant.",
          exitCode: 2,
        })
      if (Option.isSome(options.endpoint)) {
        const url = yield* Effect.try(() => new URL(Option.getOrThrow(options.endpoint))).pipe(
          Effect.orElseSucceed(() => undefined),
        )
        if (
          url === undefined ||
          url.username !== "" ||
          url.password !== "" ||
          !["http:", "https:"].includes(url.protocol)
        )
          return yield* fail({
            reason: "Target",
            message: "The endpoint must be an HTTP URL without credentials.",
            exitCode: 2,
          })
      }
      const token = yield* Config.Redacted(options.tokenEnv).pipe(
        Effect.catch(() =>
          fail({
            reason: "OperatorCredential",
            message: "The operator token is missing.",
            exitCode: 2,
          }),
        ),
      )
      const path = yield* Path.Path
      const module = Schema.Struct({
        default: Schema.declare<import("@rikalabs/akter/server").App>(App.is),
        authorizeOperator: Schema.Unknown,
      })
      const loaded = yield* Effect.tryPromise(
        () => import(pathToFileURL(path.resolve(options.app)).href),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(module)),
        Effect.flatMap((loaded) =>
          Predicate.isFunction(loaded.authorizeOperator)
            ? Effect.succeed({
                ...loaded,
                authorizeOperator: loaded.authorizeOperator as (
                  token: string,
                ) => Effect.Effect<unknown>,
              })
            : fail({
                reason: "App",
                message: "The module must export an App and authorizeOperator(token) as an Effect.",
                exitCode: 2,
              }),
        ),
        Effect.catch(() =>
          fail({
            reason: "App",
            message: "The module must export an App and authorizeOperator(token) as an Effect.",
            exitCode: 2,
          }),
        ),
      )
      const app = loaded.default
      const actor = app.actors.find((candidate) => candidate.name === options.type)
      if (actor === undefined)
        return yield* fail({
          reason: "Actor",
          message: "The actor type is not declared by the application.",
          exitCode: 2,
        })
      const keySchema: MemberSchema = actor.key
      const key = Schema.toCodecJson(keySchema)
      const ids = yield* Effect.forEach([options.id, ...Option.toArray(options.to)], (value) =>
        (options.jsonIds
          ? Schema.decodeEffect(Schema.fromJsonString(key))(value)
          : Schema.decodeEffect(key)(value).pipe(
              Effect.catch(() => Schema.decodeEffect(Schema.fromJsonString(key))(value)),
            )
        ).pipe(
          Effect.flatMap(Schema.encodeEffect(key)),
          Effect.catchCause(() =>
            fail({
              reason: "Key",
              message: "An actor id does not match its key schema.",
              exitCode: 2,
            }),
          ),
        ),
      )
      const authorized = yield* Effect.try(() =>
        loaded.authorizeOperator(Redacted.value(token)),
      ).pipe(
        Effect.catch(() =>
          fail({
            reason: "OperatorCredential",
            message: "Operator authentication was refused.",
            exitCode: 2,
          }),
        ),
      )
      if (!Effect.isEffect(authorized))
        return yield* fail({
          reason: "OperatorCredential",
          message: "Operator authentication must return an Effect.",
          exitCode: 2,
        })
      const grant = yield* authorized.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(OperatorGrant)),
        Effect.catchCause(() =>
          fail({
            reason: "OperatorCredential",
            message: "Operator authentication was refused.",
            exitCode: 2,
          }),
        ),
      )
      const sourceLayer = Option.isSome(options.directory)
        ? Store.fileSystem(options.directory.value)
        : Store.s3({
            bucket: Option.getOrThrow(options.bucket),
            prefix: options.prefix,
            endpoint: Option.getOrUndefined(options.endpoint),
          })
      const source = Context.get(
        yield* Layer.build(sourceLayer).pipe(
          Effect.catchCause(() =>
            fail({
              reason: "StoreUnavailable",
              message: "The source store could not be opened.",
              exitCode: 1,
            }),
          ),
        ),
        Store.Store,
      )
      const targetLayer = Option.isSome(options.toDirectory)
        ? Store.fileSystem(options.toDirectory.value, { shards: source.meta.shards })
        : Option.isSome(options.toPrefix)
          ? Store.s3({
              bucket: Option.getOrThrow(options.bucket),
              prefix: options.toPrefix.value,
              endpoint: Option.getOrUndefined(options.endpoint),
              shards: source.meta.shards,
            })
          : undefined
      const target =
        targetLayer === undefined
          ? source
          : Context.get(
              yield* Layer.build(targetLayer).pipe(
                Effect.catchCause(() =>
                  fail({
                    reason: "StoreUnavailable",
                    message: "The target store could not be opened.",
                    exitCode: 1,
                  }),
                ),
              ),
              Store.Store,
            )
      const crypto =
        globalThis.Bun === undefined
          ? (yield* Effect.promise(() => import("@effect/platform-node/NodeCrypto"))).layer
          : (yield* Effect.promise(() => import("@effect/platform-bun/BunCrypto"))).layer
      const services = yield* Layer.build(crypto)
      const result = yield* Forks.run(app, source, target, {
        actor,
        from: ids[0]!,
        to: ids[1],
        at: Option.isSome(options.at)
          ? { version: options.at.value }
          : before !== undefined
            ? { before }
            : {
                offset: Option.getOrThrow(options.offset),
                index: Option.getOrThrow(options.index),
              },
        grant,
        withWork: options.withWork,
      }).pipe(
        Effect.provideContext(services),
        Effect.catchCause(() =>
          fail({
            reason: "ForkRefused",
            message: "The fork was refused; no successful fork is claimed.",
            exitCode: 1,
          }),
        ),
      )
      yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result))
    }).pipe(Effect.scoped),
).pipe(Command.withDescription("Fork retained actor history as an authenticated operator"))
