// An ordinary application service: effect executors are where the outside world is touched.
import { Context, Effect, Layer, Schema } from "effect"

export class MailerDown extends Schema.TaggedError<MailerDown>()("MailerDown", { reason: Schema.String }) {}

export class Mailer extends Context.Service<Mailer, {
  readonly send: (to: string, body: string) => Effect.Effect<void, MailerDown>
}>()("app/Mailer") {}

// the real one would use an HttpClient; the shape is what matters here
export const MailerLive = Layer.succeed(Mailer, { send: () => Effect.logInfo("email sent") })
