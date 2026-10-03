import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { sendEmail } from "@distilled.cloud/aws/sesv2"
import { Credentials } from "@distilled.cloud/aws/Credentials"
import { HttpClient } from "effect/http"

export class EmailError extends Schema.TaggedError<EmailError>()("EmailError", {}) {}

export interface Message {
  readonly to: string
  readonly subject: string
  readonly text: string
}

export class Email extends Context.Service<
  Email,
  {
    readonly send: (message: Message) => Effect.Effect<void, EmailError>
  }
>()("@akter/api/email") {}

export const localEmail = Layer.effect(
  Email,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(499500502)`
        yield* sql`CREATE TABLE IF NOT EXISTS cloud_email_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient text NOT NULL, subject text NOT NULL, body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`
      }),
    )
    return Email.of({
      send: (message) =>
        sql`INSERT INTO cloud_email_outbox (recipient, subject, body)
      VALUES (${message.to}, ${message.subject}, ${message.text})`.pipe(
          Effect.asVoid,
          Effect.mapError(() => EmailError.make({})),
        ),
    })
  }),
)

export const sesEmail = (from: string) =>
  Layer.effect(
    Email,
    Effect.gen(function* () {
      const context = yield* Effect.context<Credentials | HttpClient.HttpClient>()
      return Email.of({
        send: (message) =>
          sendEmail({
            FromEmailAddress: from,
            Destination: { ToAddresses: [message.to] },
            Content: {
              Simple: {
                Subject: { Data: message.subject },
                Body: { Text: { Data: message.text } },
              },
            },
          }).pipe(
            Effect.provideContext(context),
            Effect.asVoid,
            Effect.mapError(() => EmailError.make({})),
          ),
      })
    }),
  )
