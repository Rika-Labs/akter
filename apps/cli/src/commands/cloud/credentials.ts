import { homedir } from "node:os"
import { Config, Crypto, Effect, FileSystem, Option, Schema } from "effect"

/** Hosts a session token may travel to over plain HTTP: this machine alone. */
const isLoopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/u.test(hostname)

/**
 * A control plane's base URL, without trailing slashes, when a session token
 * may be sent to it: over `https`, or over `http` to a loopback host only, so
 * a token never crosses a network in the clear.
 */
export const controlPlaneUrl = (input: string) => {
  const url = URL.parse(input)

  if (url === null || url.username !== "" || url.password !== "" || url.search !== "")
    return Option.none()
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
    return Option.none()

  return Option.some(`${url.origin}${url.pathname}`.replace(/\/+$/u, ""))
}

/**
 * What `login` keeps: the control plane it signed in to, the session token
 * Better Auth's device authorization grant issued, and who it belongs to.
 * The token is a credential; it is only ever sent to `apiUrl`, which
 * `controlPlaneUrl` must accept.
 */
export const Credentials = Schema.Struct({
  apiUrl: Schema.String.check(
    Schema.makeFilter(
      (url) => Option.isSome(controlPlaneUrl(url)) || "An https URL, or http on a loopback host",
    ),
  ),
  token: Schema.String,
  email: Schema.String,
})
export type Credentials = typeof Credentials.Type

/** No credentials are stored; `login` stores them. */
export class NotLoggedIn extends Schema.TaggedError<NotLoggedIn>()("NotLoggedIn", {
  path: Schema.String,
}) {}

/** The credentials file can be read by other users, so it is not trusted until it is fixed. */
export class CredentialsExposed extends Schema.TaggedError<CredentialsExposed>()(
  "CredentialsExposed",
  { path: Schema.String, mode: Schema.Int },
) {}

/** The credentials file exists but does not hold credentials this CLI wrote. */
export class CredentialsUnreadable extends Schema.TaggedError<CredentialsUnreadable>()(
  "CredentialsUnreadable",
  { path: Schema.String },
) {}

/** The environment that decides where the CLI's configuration lives. */
export interface ConfigLocation {
  readonly platform: string
  readonly home: string
  readonly override?: string | undefined
  readonly xdgConfigHome?: string | undefined
  readonly appData?: string | undefined
}

/**
 * The CLI's configuration directory: `AKTER_CONFIG_DIR` when set, otherwise
 * `~/Library/Application Support/akter` on macOS, `%APPDATA%\akter` on
 * Windows, and `$XDG_CONFIG_HOME/akter` (default `~/.config/akter`)
 * elsewhere.
 */
export const configDirectory = (location: ConfigLocation) => {
  if (location.override !== undefined && location.override !== "") return location.override
  if (location.platform === "darwin") return `${location.home}/Library/Application Support/akter`
  if (location.platform === "win32")
    return `${location.appData ?? `${location.home}\\AppData\\Roaming`}\\akter`
  return `${location.xdgConfigHome === undefined || location.xdgConfigHome === "" ? `${location.home}/.config` : location.xdgConfigHome}/akter`
}

const optional = (name: string) =>
  Config.option(Config.String(name)).pipe(Effect.map(Option.getOrUndefined))

/** The credentials file in this process's configuration directory. */
export const credentialsPath = Effect.gen(function* () {
  const platform = process.platform
  const directory = configDirectory({
    platform,
    home: homedir(),
    override: yield* optional("AKTER_CONFIG_DIR"),
    xdgConfigHome: yield* optional("XDG_CONFIG_HOME"),
    appData: yield* optional("APPDATA"),
  })

  return { directory, file: `${directory}${platform === "win32" ? "\\" : "/"}credentials.json` }
})

const encode = Schema.encodeEffect(Schema.fromJsonString(Credentials))

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials))

/**
 * Writes `credentials` readable by the current user alone: the directory is
 * `0700` and the file `0600`. The file is first created beside its final
 * name under a random suffix, refusing one that already exists, so nothing
 * planted there is written through, then renamed over the old file; a reader
 * never sees half a file, an older file with wider permissions is replaced
 * rather than rewritten in place, and a failed write leaves no copy behind.
 */
export const saveCredentials = (credentials: Credentials) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { directory, file } = yield* credentialsPath
    const suffix = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
    const pending = `${file}.${suffix}.tmp`

    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    yield* fs.chmod(directory, 0o700)
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(pending, yield* encode(credentials).pipe(Effect.orDie), {
        flag: "wx",
        mode: 0o600,
      })
      yield* fs.chmod(pending, 0o600)
      yield* fs.rename(pending, file)
    }).pipe(Effect.onError(() => fs.remove(pending, { force: true }).pipe(Effect.ignore)))

    return file
  })

/** The stored credentials, read whatever the file's permissions. */
const readCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { file } = yield* credentialsPath

  if (!(yield* fs.exists(file))) return yield* NotLoggedIn.make({ path: file })

  const mode = (yield* fs.stat(file)).mode & 0o777
  const credentials = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decode),
    Effect.mapError(() => CredentialsUnreadable.make({ path: file })),
  )

  return { credentials, file, mode }
})

/**
 * Reads the stored credentials. A file group or others can read is refused
 * on systems with POSIX permissions, the way `ssh` refuses a private key.
 */
export const loadCredentials = Effect.gen(function* () {
  const { credentials, file, mode } = yield* readCredentials

  if (process.platform !== "win32" && (mode & 0o077) !== 0)
    return yield* CredentialsExposed.make({ path: file, mode })

  return credentials
})

/**
 * Reads the stored credentials even when other users could read them, for
 * `logout` alone: a token that may have leaked is exactly the one to revoke.
 */
export const loadCredentialsToRevoke = Effect.map(readCredentials, (read) => read.credentials)

/** Deletes the stored credentials, answering whether there were any. */
export const removeCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { file } = yield* credentialsPath

  if (!(yield* fs.exists(file))) return false

  yield* fs.remove(file)

  return true
})
