import type { Effect } from "effect"
import type { ActorRef, Caller } from "../identity/caller.ts"

/** One question an access policy answers: may `caller` do `command` on the actor `ref`? */
export interface AccessRequest {
  readonly caller: Caller
  readonly ref: ActorRef
  readonly command: string
  /**
   * What is being asked: `command` for commands and reducers, `query` for
   * queries, `open` for a connection, `stream` for a stream, `feed` for an
   * event feed (with `command` set to the event tag), `watch` for a query
   * watch (with `command` set to the query tag), `reauthorize` for a live
   * session's periodic check, and `content` for a content operation on the
   * actor, with `command` set to `<blob>.grant` or `<blob>.get`. A policy
   * should deny kinds it does not know.
   */
  readonly kind:
    | "command"
    | "query"
    | "open"
    | "stream"
    | "feed"
    | "watch"
    | "reauthorize"
    | "content"
  /** On `reauthorize`, what the session is: an `open` connection, a `stream`, a `feed`, or a `watch`. */
  readonly of?: "open" | "stream" | "feed" | "watch"
}

/**
 * Decides whether a caller may do what a request names. The global
 * `Actors.layer({ authorize })` hook and an actor's own `access` share this
 * shape, and when both exist both must allow.
 */
export type Access = (request: AccessRequest) => boolean | Effect.Effect<boolean>

/**
 * Allows every caller every kind of request, `Anonymous` visitors under
 * `Actor.auth.none` included. It opens the actor to anyone who can reach the
 * server, so use it only for demos and deliberately public actors.
 */
export const publicAccess: Access = () => true
