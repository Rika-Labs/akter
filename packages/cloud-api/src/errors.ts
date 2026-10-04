import { Schema } from "effect"

/** The credential is absent, wrong or past its expiry; answered 401. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {
    code: Schema.Literals(["missing_credentials", "invalid_credentials", "expired"]),
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

/** The caller is known but its role or key permission does not allow the operation; answered 403. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/**
 * What a `NotFound` names. `actor` is an actor address the live deployment
 * does not have, `actor-type` a type it does not serve, `live deployment` an
 * environment with nothing deployed, and `command` a command the actor does
 * not declare, so a caller tells them apart without reading `id`.
 */
export const NotFoundResource = Schema.Literals([
  "actor",
  "actor-type",
  "api-key",
  "command",
  "cursor",
  "deployment",
  "domain",
  "environment",
  "invitation",
  "live deployment",
  "member",
  "organization",
  "project",
])
export type NotFoundResource = typeof NotFoundResource.Type

/** The resource does not exist or is not visible to the caller; answered 404. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { resource: NotFoundResource, id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The request conflicts with current state, such as a taken slug or a duplicate invitation; answered 409. */
export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The endpoint is declared by the contract and has no implementation yet; answered 501. */
export class NotImplemented extends Schema.TaggedError<NotImplemented>()(
  "NotImplemented",
  { operation: Schema.String },
  { httpApiStatus: 501 },
) {}

/** A deployment or its edge is temporarily unavailable; callers retry with the same command identity. */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  { message: Schema.String, retryAfterSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) },
  { httpApiStatus: 503 },
) {}

/** Errors every authenticated read can raise besides `Unauthorized`, which the middleware owns. */
export const ReadErrors = [Forbidden, NotFound, NotImplemented, Unavailable] as const

/** Errors every mutation can raise besides `Unauthorized`, which the middleware owns. */
export const WriteErrors = [Forbidden, NotFound, Conflict, NotImplemented, Unavailable] as const

/** Errors for operations on no existing resource, such as listing the caller's own data. */
export const SelfErrors = [Forbidden, NotImplemented] as const
