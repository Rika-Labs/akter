import { Database } from "@rikalabs/akter/runtime"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { createEmail } from "@distilled.cloud/resend"
import type { Credentials } from "@distilled.cloud/resend/Credentials"
import type { HttpClient } from "effect/http"

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
    yield* Database.schemaChange(
      sql`CREATE TABLE IF NOT EXISTS cloud_email_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient text NOT NULL, subject text NOT NULL, body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
      499500502,
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

/**
 * Sends each message through Resend from `from`, which must be on a domain
 * verified in Resend. A failure carries nothing the provider said, because
 * its answer can echo the message and a message can hold a sign-in link.
 */
export const resendEmail = (from: string) =>
  Layer.effect(
    Email,
    Effect.gen(function* () {
      const context = yield* Effect.context<Credentials | HttpClient.HttpClient>()
      return Email.of({
        send: (message) =>
          createEmail({
            from,
            to: message.to,
            subject: message.subject,
            text: message.text,
          }).pipe(
            Effect.provideContext(context),
            Effect.asVoid,
            Effect.mapError(() => EmailError.make({})),
          ),
      })
    }),
  )
