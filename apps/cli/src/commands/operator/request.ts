import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { parseFlags, UsageError } from "../../flags.ts"

/** The environment variable an operator command reads its bearer token from, unless `--token-env` names another. */
export const TOKEN_ENV = "DURABLE_OPERATOR_TOKEN"

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

/**
 * Parses `--url` (repeatable), `--tenant`, `--token-env`, `--json`, the
 * command's own `valued` flags and `switches`, and positional arguments.
 */
export const parseOperatorFlags = ({
  args,
  valued,
  switches,
  maxPositional,
}: {
  readonly args: ReadonlyArray<string>
  readonly valued: ReadonlyArray<string>
  readonly switches: ReadonlyArray<string>
  readonly maxPositional?: number
}) =>
  Effect.gen(function* () {
    const parsed = yield* parseFlags({
      args,
      valued: [...valued, "--url", "--tenant", "--token-env"],
      switches: [...switches, "--json"],
      maxPositional,
    })

    const urls = parsed.repeated("--url").map((url) => url.replace(/\/+$/, ""))

    if (urls.length === 0) return yield* UsageError.make({ message: "--url is required" })

    return {
      ...parsed,
      urls,
      tenant: parsed.flags.get("--tenant"),
      tokenEnv: parsed.flags.get("--token-env") ?? TOKEN_ENV,
      json: parsed.switches.has("--json"),
    }
  })

/** Splits `Room/r1` into its actor type and id; the id may itself contain `/`. */
export const parseActor = (value: string | undefined) =>
  Effect.gen(function* () {
    const slash = value?.indexOf("/") ?? -1

    if (value === undefined || slash <= 0 || slash === value.length - 1)
      return yield* UsageError.make({ message: "Name the actor as <Type>/<id>" })

    return { actorType: value.slice(0, slash), actorId: value.slice(slash + 1) }
  })

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
