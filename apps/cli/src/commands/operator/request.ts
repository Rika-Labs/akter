import { Config, Console, Effect, Option, type PlatformError, Redacted, Schema } from "effect"
import { Argument, Flag } from "effect/cli"
import { HttpClient, HttpClientRequest } from "effect/http"
import { fail } from "../../failure.ts"

/** The environment variable an operator command reads its bearer token from, unless `--token-env` names another. */
export const TOKEN_ENV = "AKTER_OPERATOR_TOKEN"

/** No runner at `url` answered. */
export class RunnerUnreachable extends Schema.TaggedError<RunnerUnreachable>()(
  "RunnerUnreachable",
  { url: Schema.String, message: Schema.String },
) {}

/** The runner answered, but refused or found nothing; `body` is its JSON answer. */
export class OperatorRefused extends Schema.TaggedError<OperatorRefused>()("OperatorRefused", {
  status: Schema.Finite,
  body: Schema.String,
}) {}

/** Each runner's base URL without its trailing slash; `--url` repeats to name several runners. */
export const urls = Flag.String("url").pipe(
  Flag.atLeast(1),
  Flag.map((values) => values.map((value) => value.replace(/\/+$/, ""))),
  Flag.withDescription(
    "A runner's base URL; repeat to name several, a single-actor command uses the first",
  ),
)

/** The tenant an operator command acts in. */
export const tenant = Flag.String("tenant").pipe(
  Flag.withDescription("The tenant the request acts in"),
)

/** Flags every operator command takes besides its tenant. */
export const operatorFlags = {
  urls,
  tokenEnv: Flag.String("token-env").pipe(
    Flag.withDefault(TOKEN_ENV),
    Flag.withDescription(
      `The environment variable holding the operator bearer token (default ${TOKEN_ENV})`,
    ),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the runner's answer as JSON"),
  ),
}

/** Splits `Room/r1` into its actor type and id; the id may itself contain `/`. */
const splitActor = (value: string) => {
  const slash = value.indexOf("/")

  return slash <= 0 || slash === value.length - 1
    ? Option.none()
    : Option.some({ actorType: value.slice(0, slash), actorId: value.slice(slash + 1) })
}

const notAnActor = () => "an actor named as <Type>/<id>"

/** A positional actor named as `<Type>/<id>`. */
export const actorArgument = Argument.String("actor").pipe(
  Argument.filterMap(splitActor, notAnActor),
  Argument.withDescription("The actor, as <Type>/<id>"),
)

/** A flag naming an actor as `<Type>/<id>`. */
export const actorFlag = (flag: { readonly name: string; readonly description: string }) =>
  Flag.String(flag.name).pipe(
    Flag.filterMap(splitActor, notAnActor),
    Flag.withDescription(flag.description),
  )

/** Why an operator repairs something, as the operator audit log records it. */
export const reason = Flag.String("reason").pipe(
  Flag.filter(
    (value) => value.length > 0 && value.length <= 500,
    () => "a reason of 1 to 500 characters",
  ),
  Flag.withDescription("Why, recorded in the operator audit log (up to 500 characters)"),
)

/** The operator token, read from the named environment variable when it is set. */
export const operatorToken = (name: string) =>
  Effect.map(Config.option(Config.Redacted(name)), (token) =>
    Option.match(token, { onNone: () => undefined, onSome: (value) => Redacted.value(value) }),
  )

/** What an operator request can fail with. */
export type OperatorFailure =
  | RunnerUnreachable
  | OperatorRefused
  | Schema.SchemaError
  | PlatformError.PlatformError

/** An operator answer as JSON text, for commands whose answer has no other format. */
export const encodeJson = (answer: Schema.Json) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(answer).pipe(Effect.orDie)

/**
 * Runs one operator request and prints its answer: formatted, or JSON with
 * `--json`. A refusal exits 1; any other failure is a usage error.
 */
export const operatorCommand = <
  O extends { readonly tokenEnv: string; readonly json: boolean },
  R,
>({
  options,
  request,
  format,
}: {
  readonly options: O
  readonly request: (input: {
    readonly options: O
    readonly token: string | undefined
  }) => Effect.Effect<Schema.Json, OperatorFailure, R>
  readonly format: (answer: Schema.Json) => Effect.Effect<string, OperatorFailure>
}) =>
  Effect.gen(function* () {
    const token = yield* operatorToken(options.tokenEnv)
    const answer = yield* request({ options, token })

    yield* Console.log(options.json ? yield* encodeJson(answer) : yield* format(answer))
  }).pipe(
    Effect.catchTags({
      RunnerUnreachable: (error) =>
        fail({ reason: error._tag, message: `Cannot reach ${error.url}: ${error.message}` }),
      OperatorRefused: (error) =>
        fail({
          reason: error._tag,
          message: `Refused (${error.status}): ${error.body}`,
          exitCode: 1,
        }),
      ConfigError: (error) =>
        fail({ reason: error._tag, message: `Cannot read the operator token: ${error.message}` }),
      SchemaError: (error) =>
        fail({ reason: error._tag, message: `Unexpected answer: ${error.message}` }),
      PlatformError: (error) =>
        fail({ reason: error._tag, message: `Cannot write the file: ${error.message}` }),
    }),
  )

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** Sends one operator request and returns the runner's JSON answer, or why it refused. */
export const operatorRequest = Effect.fnUntraced(function* ({
  url,
  path,
  token,
  body,
}: {
  readonly url: string
  readonly path: string
  readonly token: string | undefined
  readonly body?: Schema.Json
}) {
  const client = yield* HttpClient.HttpClient

  const base =
    body === undefined
      ? HttpClientRequest.get(`${url}${path}`)
      : HttpClientRequest.post(`${url}${path}`)

  const request = (body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body)).pipe(
    token === undefined ? (same) => same : HttpClientRequest.bearerToken(token),
  )

  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError((error) => RunnerUnreachable.make({ url, message: error.message })))

  const text = yield* response.text.pipe(
    Effect.mapError((error) => RunnerUnreachable.make({ url, message: error.message })),
  )

  if (response.status >= 400)
    return yield* OperatorRefused.make({ status: response.status, body: text })

  return yield* decodeJson(text).pipe(
    Effect.mapError(() => RunnerUnreachable.make({ url, message: "the answer is not JSON" })),
  )
})
