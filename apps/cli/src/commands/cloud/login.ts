import { Clock, Config, Console, Data, Duration, Effect, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { fail } from "../../failure.ts"
import { cloudClient, DEFAULT_API_URL, reportFailures } from "./client.ts"
import { controlPlaneUrl, saveCredentials } from "./credentials.ts"

/** The client id the control plane's device authorization grant accepts from this CLI. */
export const CLIENT_ID = "akter-cli"

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

const DeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Finite,
  interval: Schema.Finite,
})

const DeviceToken = Schema.Struct({ access_token: Schema.String })

const DeviceError = Schema.Struct({ error: Schema.String })

/** A user code as people read and type it: an eight-character code split `XXXX-XXXX`. */
const displayCode = (code: string) =>
  code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code

/** The browser approval was denied. */
export class LoginDenied extends Schema.TaggedError<LoginDenied>()("LoginDenied", {}) {}

/** The code expired before anyone approved it. */
export class LoginExpired extends Schema.TaggedError<LoginExpired>()("LoginExpired", {}) {}

/** The control plane refused the device authorization grant for a reason this CLI does not expect. */
export class LoginRefused extends Schema.TaggedError<LoginRefused>()("LoginRefused", {
  status: Schema.Int,
  error: Schema.String,
}) {}

/** The answer to one poll of the token endpoint. */
type Poll = Data.TaggedEnum<{
  Granted: { readonly token: string }
  Pending: {}
  SlowDown: {}
}>

const Poll = Data.taggedEnum<Poll>()

const flags = {
  apiUrl: Flag.String("api-url").pipe(
    Flag.withFallbackConfig(Config.String("AKTER_API_URL")),
    Flag.withDefault(DEFAULT_API_URL),
    Flag.filterMap(controlPlaneUrl, () => "an https URL, or http on a loopback host"),
    Flag.withDescription(
      `The control plane to sign in to (default AKTER_API_URL, then ${DEFAULT_API_URL})`,
    ),
  ),
}

const post = (url: string, body: Schema.Json) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body)),
  )

const refusal = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(DeviceError)(response).pipe(
    Effect.orElseSucceed(() => ({ error: `HTTP ${response.status}` })),
  )

/**
 * Signs in through Better Auth's device authorization grant: asks for a
 * code, prints where to approve it, and polls at the interval the control
 * plane names, five seconds slower after each `slow_down`, until the
 * approval yields a session token, is denied, or expires.
 */
const deviceLogin = (apiUrl: string) =>
  Effect.gen(function* () {
    const started = yield* post(`${apiUrl}/auth/device/code`, { client_id: CLIENT_ID })

    if (started.status !== 200) {
      const { error } = yield* refusal(started)

      return yield* LoginRefused.make({ status: started.status, error })
    }

    const code = yield* HttpClientResponse.schemaBodyJson(DeviceCode)(started)

    yield* Console.log(
      `To sign in, open ${code.verification_uri}\nand enter the code ${displayCode(code.user_code)}. Waiting for approval…`,
    )

    const poll = Effect.gen(function* () {
      const response = yield* post(`${apiUrl}/auth/device/token`, {
        grant_type: DEVICE_GRANT,
        device_code: code.device_code,
        client_id: CLIENT_ID,
      })

      if (response.status === 200)
        return Poll.Granted({
          token: (yield* HttpClientResponse.schemaBodyJson(DeviceToken)(response)).access_token,
        })

      const { error } = yield* refusal(response)

      if (error === "authorization_pending") return Poll.Pending()
      if (error === "slow_down") return Poll.SlowDown()
      if (error === "access_denied") return yield* LoginDenied.make({})
      if (error === "expired_token") return yield* LoginExpired.make({})

      return yield* LoginRefused.make({ status: response.status, error })
    })

    const deadline = (yield* Clock.currentTimeMillis) + code.expires_in * 1000
    let interval = Duration.seconds(code.interval)

    while ((yield* Clock.currentTimeMillis) < deadline) {
      yield* Effect.sleep(interval)

      const answer = yield* poll

      if (Poll.$is("Granted")(answer)) return answer.token
      if (Poll.$is("SlowDown")(answer)) interval = Duration.sum(interval, Duration.seconds(5))
    }

    return yield* LoginExpired.make({})
  })

/**
 * Signs `token` out at its control plane, best effort: a session the CLI
 * could not finish setting up is not left valid behind it.
 */
const revoke = (apiUrl: string, token: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.post(`${apiUrl}/auth/sign-out`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      ),
    ),
    Effect.ignore,
  )

/** `akter login`: signs in to a control plane and stores the session for later hosted commands. */
export const loginCommand = Command.make("login", flags, ({ apiUrl }) =>
  Effect.gen(function* () {
    const token = yield* deviceLogin(apiUrl)
    const client = yield* cloudClient({ apiUrl, token, email: "" })
    const me = yield* client.account.me().pipe(Effect.tapError(() => revoke(apiUrl, token)))
    const email = me.user?.email ?? ""
    const file = yield* saveCredentials({ apiUrl, token, email })

    yield* Console.log(`Logged in to ${apiUrl} as ${email}. Credentials saved to ${file}.`)
  }).pipe(
    Effect.catchTags({
      LoginDenied: () =>
        fail({
          reason: "LoginDenied",
          message: "The sign-in was denied in the browser. Nothing was saved.",
          exitCode: 1,
        }),
      LoginExpired: () =>
        fail({
          reason: "LoginExpired",
          message: "The sign-in code expired before it was approved. Run `akter login` again.",
          exitCode: 1,
        }),
      LoginRefused: (error) =>
        fail({
          reason: "LoginRefused",
          message: `The control plane refused the sign-in: ${error.error} (${error.status})`,
          exitCode: 1,
        }),
    }),
    reportFailures,
  ),
).pipe(
  Command.withDescription(
    "Sign in to Akter Cloud through the browser and store the session for deploy",
  ),
)
