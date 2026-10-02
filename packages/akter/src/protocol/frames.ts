import { Schema } from "effect"

/** The WebSocket subprotocol a connection upgrade must offer; it versions the envelope below. */
export const SUBPROTOCOL = "akter.v1"

/**
 * Messages a client sends on a connection's socket. Member frames travel only
 * inside `frame`, so an application frame can never be read as control.
 */
export const ClientWireMessage = Schema.Union([
  Schema.Struct({
    t: Schema.Literal("hello"),
    authorization: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Json),
  }),
  Schema.Struct({ t: Schema.Literal("frame"), frame: Schema.Json }),
  Schema.Struct({ t: Schema.Literal("resyncDone"), through: Schema.optional(Schema.String) }),
  Schema.Struct({ t: Schema.Literal("reauthenticate"), authorization: Schema.String }),
])

/** A message a client sends on a connection's socket. */
export type ClientWireMessage = typeof ClientWireMessage.Type

/**
 * Messages a server sends on a connection's socket. Times are milliseconds
 * since the epoch, except `deadline`, which is how long the client has to
 * answer `resync`. `progress` is a job executor's progress apart from member frames:
 * display-only, lossy, never replayed, and without cursors.
 */
export const ServerWireMessage = Schema.Union([
  Schema.Struct({
    t: Schema.Literal("open"),
    connectionId: Schema.String,
    baseline: Schema.optional(Schema.String),
    reauthenticateBy: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({
    t: Schema.Literal("frame"),
    frame: Schema.Json,
    cursor: Schema.optional(Schema.String),
    event: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    t: Schema.Literal("resync"),
    after: Schema.optional(Schema.String),
    reason: Schema.Literal("OwnerLost"),
    deadline: Schema.Finite,
  }),
  Schema.Struct({ t: Schema.Literal("resyncReplayed"), through: Schema.optional(Schema.String) }),
  Schema.Struct({
    t: Schema.Literal("progress"),
    job: Schema.String,
    jobId: Schema.String,
    attempt: Schema.Finite,
    seq: Schema.Finite,
    frame: Schema.Json,
  }),
  Schema.Struct({ t: Schema.Literal("reauthenticate"), by: Schema.Finite }),
  Schema.Struct({ t: Schema.Literal("reauthenticated"), by: Schema.optional(Schema.Finite) }),
  Schema.Struct({ t: Schema.Literal("end"), error: Schema.optional(Schema.Json) }),
])

/** A message a server sends on a connection's socket. */
export type ServerWireMessage = typeof ServerWireMessage.Type
