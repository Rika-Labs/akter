import { Effect } from "effect"

/**
 * The canonical request binding of a hosted edge assertion. The edge signs
 * the SHA-256 of the canonical string of the request it forwards; the runner
 * rebuilds the string from the request it received and compares, so an
 * assertion can't be moved to another actor, member, command id, or body.
 */

/** The header that carries an assertion from the edge to a runner. */
export const ASSERTION_HEADER = "durable-assertion"

/** The JWS `typ` of an assertion. */
export const ASSERTION_TYPE = "durable-assertion+jwt"

/** The JWS `typ` of the edge's push asking a runner to reread its key set. */
export const KEY_REFRESH_TYPE = "durable-key-refresh+jwt"

/** The route, under a served layer's base path, that takes the edge's key-set refresh push. */
export const KEY_REFRESH_PATH = "/assertion-keys/refresh"

const VERSION = "durable-assertion/v1"

/** What the canonical string binds, as the edge forwards and the runner receives it. */
export interface BoundRequest {
  readonly method: string
  /** The request target: a path with an optional `?query`, as it arrives. */
  readonly target: string
  /** The raw `Idempotency-Key` header value, if the request has one. */
  readonly idempotencyKey: string | undefined
  /** The body bytes exactly as forwarded; empty when there is none. */
  readonly body: Uint8Array
}

const utf8 = new TextEncoder()

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

const sha256 = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).pipe(Effect.map(hex))

// RFC 3986 unreserved characters, which percent-encoding never changes the meaning of.
const UNRESERVED = /^[A-Za-z0-9\-._~]$/

/** Uppercases percent-encoding hex, and decodes it where it encodes an unreserved character. */
const normalizeEscapes = (segment: string) =>
  segment.replace(/%([0-9A-Fa-f]{2})/g, (_, digits: string) => {
    const character = String.fromCharCode(Number.parseInt(digits, 16))

    return UNRESERVED.test(character) ? character : `%${digits.toUpperCase()}`
  })

/** RFC 3986 section 5.2.4: removes `.` and `..` segments. */
const removeDotSegments = (path: string) => {
  const output: Array<string> = []
  const segments = path.split("/")

  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1

    if (segment === ".") {
      if (last) output.push("")
      continue
    }

    if (segment === "..") {
      // The leading empty segment is the root, which `..` never climbs above.
      if (output.length > 1) output.pop()

      if (last) output.push("")
      continue
    }

    output.push(segment)
  }

  return output.join("/")
}

/** A path with percent-encoding normalized to uppercase hex and no dot segments. */
export const canonicalPath = (path: string) => {
  const normalized = removeDotSegments(path.split("/").map(normalizeEscapes).join("/"))

  return normalized.startsWith("/") ? normalized : `/${normalized}`
}

// Encodes everything but unreserved characters, so both sides agree whatever the client escaped.
const strictEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

/** Query parameters sorted by name then value, each percent-encoded, joined by `&`. */
export const canonicalQuery = (query: string) =>
  [...new URLSearchParams(query)]
    .map(([name, value]) => [strictEncode(name), strictEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName ? compare(leftValue, rightValue) : compare(leftName, rightName),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&")

const splitTarget = (target: string) => {
  const mark = target.indexOf("?")

  return mark === -1
    ? { path: target, query: "" }
    : { path: target.slice(0, mark), query: target.slice(mark + 1) }
}

/** The canonical string of a request, before hashing. */
export const canonicalRequest = Effect.fnUntraced(function* (request: BoundRequest) {
  const { path, query } = splitTarget(request.target)

  return [
    VERSION,
    request.method.toUpperCase(),
    canonicalPath(path),
    canonicalQuery(query),
    request.idempotencyKey ?? "",
    yield* sha256(request.body),
  ].join("\n")
})

/** The `req` claim of an assertion for `request`: the SHA-256 of its canonical string. */
export const requestDigest = (request: BoundRequest) =>
  canonicalRequest(request).pipe(Effect.flatMap((text) => sha256(utf8.encode(text))))

/**
 * The `req` claim of a streaming session's reauthentication assertion: it
 * binds the session's upgrade path and its session id, not a request.
 */
export const reauthenticationDigest = (options: {
  readonly path: string
  readonly session: string
}) =>
  sha256(
    utf8.encode(
      [
        VERSION,
        "REAUTHENTICATE",
        canonicalPath(splitTarget(options.path).path),
        options.session,
      ].join("\n"),
    ),
  )
