import { fromApiKey } from "@distilled.cloud/resend/Credentials"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer, type Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Email, EmailError, resendEmail } from "./email.ts"

const key = "re_email_test_key_never_used"

const message = {
  to: "ada@example.com",
  subject: "Sign in to Akter",
  text: "Open https://api.akter.dev/verify?token=single-use-secret-token",
}

const harness = (reply: { readonly status: number; readonly body: unknown }) =>
  Effect.gen(function* () {
    const requests: Array<{
      method: string
      path: string
      authorization: string
      body: Schema.Json
    }> = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: (request) =>
            request.json().then((body: Schema.Json) => {
              requests.push({
                method: request.method,
                path: new URL(request.url).pathname,
                authorization: request.headers.get("authorization") ?? "",
                body,
              })

              return Response.json(reply.body, { status: reply.status })
            }),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const context = yield* Layer.build(
      resendEmail("Akter <auth@mail.akter.dev>").pipe(
        Layer.provide(
          Layer.mergeAll(
            fromApiKey({ apiKey: key, apiBaseUrl: `http://127.0.0.1:${server.port}` }),
            FetchHttpClient.layer,
          ),
        ),
      ),
    )

    return { requests, email: Context.get(context, Email) }
  })

it.effect("sends the message through Resend from the configured sender with the API key", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { requests, email } = yield* harness({ status: 200, body: { id: "email_1" } })

      yield* email.send(message)

      expect(requests).toEqual([
        {
          method: "POST",
          path: "/emails",
          authorization: `Bearer ${key}`,
          body: {
            from: "Akter <auth@mail.akter.dev>",
            to: "ada@example.com",
            subject: "Sign in to Akter",
            text: message.text,
          },
        },
      ])
    }),
  ),
)

it.effect("fails with an EmailError that carries nothing Resend said or the message held", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const status of [401, 422]) {
        const { email } = yield* harness({
          status,
          body: {
            name: "validation_error",
            message: `rejected ${message.text} for ${key}`,
            statusCode: status,
          },
        })

        const error = yield* Effect.flip(email.send(message))

        expect(error).toEqual(EmailError.make({}))
        expect(error.message).not.toMatch(/single-use|re_email_test/u)
      }
    }),
  ),
)
