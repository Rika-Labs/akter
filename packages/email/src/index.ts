import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { createEmail } from "@distilled.cloud/resend"
import { Credentials, fromApiKey } from "@distilled.cloud/resend/Credentials"

/** A plain-text email. */
export interface Message {
  readonly to: string
  readonly subject: string
  readonly text: string
}

const MessageJson = Schema.fromJsonString(
  Schema.Struct({ to: Schema.String, subject: Schema.String, text: Schema.String }),
)

/** Sending failed; `cause` is the provider or filesystem error. */
export class EmailError extends Schema.TaggedError<EmailError>()("EmailError", {
  cause: Schema.Defect(),
}) {}

/** Sends email; fails with `EmailError`. */
export class Email extends Context.Service<
  Email,
  { send(message: Message): Effect.Effect<void, EmailError> }
>()("@durable-actors/email/Email") {}

/**
 * `Email` that writes each message as `<uuid>.json` in `directory` (created
 * with mode 0700, files 0600) instead of sending it, for development and
 * tests.
 */
export const captureLayer = (directory: string) =>
  Layer.effect(
    Email,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const crypto = yield* Crypto.Crypto

      return {
        send: Effect.fn("Email.capture")(
          function* (message: Message) {
            const id = yield* crypto.randomUUIDv4
            const content = yield* Schema.encodeEffect(MessageJson)(message)
            yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
            yield* fs.writeFileString(path.join(directory, `${id}.json`), content, {
              mode: 0o600,
              flag: "wx",
            })
          },
          Effect.mapError((cause) => EmailError.make({ cause })),
        ),
      }
    }),
  )

/** Resend API key and the sender address. */
export interface ResendConfig {
  readonly apiKey: string
  readonly from: string
}

/** `Email` that sends through Resend. */
export const resendLayer = (config: ResendConfig) =>
  Layer.effect(
    Email,
    Effect.gen(function* () {
      const context = yield* Effect.context<Credentials | HttpClient.HttpClient>()

      return {
        send: Effect.fn("Email.send")(function* (message: Message) {
          yield* createEmail({ from: config.from, ...message }).pipe(
            Effect.provideContext(context),
            Effect.mapError((cause) => EmailError.make({ cause })),
          )
        }),
      }
    }),
  ).pipe(Layer.provide(Layer.merge(fromApiKey({ apiKey: config.apiKey }), FetchHttpClient.layer)))
