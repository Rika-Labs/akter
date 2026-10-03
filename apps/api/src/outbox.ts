import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"

/** Local-only mailbox: verification and reset links are credentials and never belong in production logs. */
const mailbox = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* router.add(
      "GET",
      "/",
      Effect.gen(function* () {
        const messages = yield* sql<{
          id: string
          recipient: string
          subject: string
          body: string
          created_at: Date
        }>`SELECT id::text, recipient, subject, body, created_at FROM cloud_email_outbox ORDER BY id DESC LIMIT 100`
        return yield* HttpServerResponse.json(messages)
      }),
    )
  }),
)

if (import.meta.main)
  BunRuntime.runMain(
    Effect.gen(function* () {
      const production = yield* Config.Boolean("API_PRODUCTION").pipe(Config.withDefault(false))
      if (production)
        return yield* Effect.die(new Error("The email outbox must never run in production"))
      const url = yield* Config.Redacted("CONTROL_PLANE_DATABASE_URL")
      const port = yield* Config.Int("OUTBOX_PORT").pipe(Config.withDefault(3002))
      const hostname = yield* Config.String("OUTBOX_HOST").pipe(Config.withDefault("127.0.0.1"))
      return yield* Layer.launch(
        HttpRouter.serve(mailbox, { disableLogger: true }).pipe(
          Layer.provide(PgClient.layer({ url })),
          Layer.provide(BunHttpServer.layer({ port, hostname })),
        ),
      )
    }),
  )
