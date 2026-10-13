import { Config, Console, Effect, Option, Redacted, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { OperatorRequest } from "@rikalabs/akter/server"
import { fail } from "../failure.ts"

const common = {
  url: Flag.String("url").pipe(Flag.withDefault("http://127.0.0.1:8080")),
  tenant: Flag.String("tenant").pipe(Flag.withDefault("default")),
  reason: Flag.String("reason").pipe(Flag.withDefault("operator inspection")),
  tokenEnv: Flag.String("token-env").pipe(Flag.withDefault("AKTER_OPERATOR_TOKEN")),
}
interface Options {
  readonly url: string
  readonly tenant: string
  readonly reason: string
  readonly tokenEnv: string
}

/** Sends a separate operator credential, never a cloud login or application token. */
const request = (options: Options, body: Omit<OperatorRequest, "tenant" | "reason">) =>
  Effect.gen(function* () {
    const url = yield* Effect.try(() => new URL(options.url)).pipe(
      Effect.catch(() => fail({ reason: "OperatorRefused", message: "Invalid operator URL." })),
    )
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      return yield* fail({
        reason: "OperatorRefused",
        message:
          "Operator URL requires HTTPS or loopback HTTP, without credentials or query parameters.",
      })
    const token = yield* Config.Redacted(options.tokenEnv).pipe(Config.option)
    if (Option.isNone(token) || Redacted.value(token.value).length === 0)
      return yield* fail({
        reason: "OperatorRefused",
        message: `Set ${options.tokenEnv} to an operator credential.`,
      })
    const payload = { ...body, tenant: options.tenant, reason: options.reason }
    const call = HttpClientRequest.post(`${url.href.replace(/\/$/u, "")}/operator`).pipe(
      HttpClientRequest.bearerToken(Redacted.value(token.value)),
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(HttpClient.execute),
      Effect.timeout("30 seconds"),
    )
    const response = yield* call.pipe(
      Effect.catch(() =>
        fail({ reason: "OperatorRefused", message: "Operator endpoint unavailable.", exitCode: 1 }),
      ),
    )
    if (response.status !== 200)
      return yield* fail({
        reason: "OperatorRefused",
        message: `Operator request refused (${response.status}).`,
        exitCode: 1,
      })
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      Effect.catch(() =>
        fail({ reason: "OperatorRefused", message: "Invalid operator response.", exitCode: 1 }),
      ),
    )
  })

const output = (options: Options, body: Omit<OperatorRequest, "tenant" | "reason">) =>
  Effect.flatMap(request(options, body), (response) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(response).pipe(
      Effect.orDie,
      Effect.flatMap(Console.log),
    ),
  )

const shardTarget = Argument.Int("shard").pipe(
  Argument.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
)
const actor = Command.make(
  "actor",
  {
    ...common,
    actorType: Argument.String("type"),
    actorId: Argument.String("id"),
    idJson: Flag.Boolean("id-json").pipe(Flag.withDefault(false)),
  },
  ({ actorType, actorId, idJson, ...options }) =>
    Effect.gen(function* () {
      const id = idJson
        ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(actorId).pipe(
            Effect.catch(() =>
              fail({ reason: "OperatorRefused", message: "Invalid JSON actor id." }),
            ),
          )
        : actorId
      return yield* output(options, { operation: "inspect", target: { actorType, actorId: id } })
    }),
)
const shard = Command.make("shard", { ...common, shard: shardTarget }, ({ shard, ...options }) =>
  output(options, { operation: "inspect", target: { shard } }),
)

/** Actor and shard inspection have separate scopes, and every response is audited by the runner. */
export const inspectCommand = Command.make("inspect").pipe(
  Command.withDescription("Inspect durable actors or shards with a separate operator credential"),
  Command.withSubcommands([actor, shard]),
)

const logOptions = {
  ...common,
  shard: shardTarget,
  from: Flag.Int("from").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    Flag.withDefault(0),
  ),
}
const log = (options: Options & { readonly shard: number; readonly from: number }) =>
  Effect.gen(function* () {
    const response = yield* request(options, {
      operation: "log",
      target: { shard: options.shard },
      from: options.from,
    })
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ head: Schema.Int, entries: Schema.Array(Schema.Json) }),
    )(response).pipe(
      Effect.catch(() =>
        fail({ reason: "OperatorRefused", message: "Invalid log response.", exitCode: 1 }),
      ),
    )
    for (const entry of decoded.entries)
      yield* Console.log(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(entry).pipe(Effect.orDie),
      )
    return decoded.head
  })
const tail = Command.make(
  "tail",
  { ...logOptions, follow: Flag.Boolean("follow").pipe(Flag.withDefault(false)) },
  (options) =>
    Effect.gen(function* () {
      let from = options.from
      while (true) {
        from = yield* log({ ...options, from })
        if (!options.follow) return
        yield* Effect.sleep("1 second")
      }
    }),
)
const exportLog = Command.make("export", logOptions, (options) => Effect.asVoid(log(options)))

/** Log payload values require `log.read`; output is NDJSON, distinct from hosted process logs. */
export const logCommand = Command.make("log").pipe(
  Command.withDescription("Tail or export retained shard entries as NDJSON"),
  Command.withSubcommands([tail, exportLog]),
)
export const snapshotCommand = Command.make(
  "snapshot",
  { ...common, shard: shardTarget },
  ({ shard, ...options }) => output(options, { operation: "snapshot", target: { shard } }),
).pipe(Command.withDescription("Read a checkpoint and its pages with snapshot.read"))
export const replayCommand = Command.make(
  "replay",
  {
    ...common,
    shard: shardTarget,
    current: Flag.Boolean("current").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Explicitly opt into the current build; recorded effects must still match",
      ),
    ),
  },
  ({ shard, current, ...options }) =>
    output(options, {
      operation: "replay",
      target: { shard },
      replay: current ? "current" : "matching",
    }),
).pipe(Command.withDescription("Recover a refused shard with build-matched replay"))
