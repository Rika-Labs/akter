// The application's subject. The framework's `Principal` is empty; the app fills it in.
import { Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

declare module "../framework/Actor.ts" {
  interface Principal {
    readonly userId: UserId
    readonly roles: ReadonlyArray<"member" | "admin">
  }
}

/** The runtime half: `Actor.layer({ principal: PrincipalSchema })` decodes it from the envelope headers. */
export const PrincipalSchema = Schema.Struct({
  userId: UserId,
  roles: Schema.Array(Schema.Literals(["member", "admin"]))
})
