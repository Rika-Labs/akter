import type { AssertionClaims } from "@rikalabs/akter/runtime"
import { Clock, Duration, Effect } from "effect"
import type { Principal } from "../principals/authenticate.ts"

/** The actor, id, and member a served path names, for the assertion's log claims. */
const routeOf = (path: string) => {
  const segments = path.split("/")
  const at = segments.indexOf("actors")

  if (at === -1) return {}

  const [actor, id, member] = segments.slice(at + 1)

  return member === undefined
    ? { actor: actor ?? "", member: id ?? "" }
    : { actor: actor ?? "", id: decodeURIComponent(id ?? ""), member }
}

/**
 * The claims of one assertion: the verified attribution, the route the edge
 * chose, and `req`, the binding the runner rebuilds and compares.
 */
export const claimsFor = Effect.fnUntraced(function* (options: {
  readonly issuer: string
  readonly deployment: string
  readonly region: string
  readonly lifetime: Duration.Duration
  readonly principal: Principal
  readonly req: string
  readonly path: string
  readonly commandId: string | undefined
  readonly session: string | undefined
}) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
  const route = routeOf(options.path)

  const claims: AssertionClaims = {
    iss: options.issuer,
    aud: options.deployment,
    region: options.region,
    iat: now,
    exp: now + Math.floor(Duration.toSeconds(options.lifetime)),
    tenant: options.principal.tenant,
    caller: options.principal.caller,
    req: options.req,
    cexp: Math.floor(Math.min(options.principal.expiresAt, Number.MAX_SAFE_INTEGER) / 1000),
    ...route,
  }

  if (options.commandId !== undefined && options.session !== undefined)
    return { ...claims, cid: options.commandId, sid: options.session }

  if (options.commandId !== undefined) return { ...claims, cid: options.commandId }

  if (options.session !== undefined) return { ...claims, sid: options.session }

  return claims
})
