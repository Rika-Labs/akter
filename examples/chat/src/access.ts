import { Anonymous, type Access } from "@durable-actors/core"
import { Schema } from "effect"

/**
 * Anyone who signed in may use a room or a document: the identity provider
 * only issues callers in the chat tenant, so the actors refuse just the
 * visitors who presented no credentials.
 */
export const signedIn: Access = ({ caller }) => !Schema.is(Anonymous)(caller)
