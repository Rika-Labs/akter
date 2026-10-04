import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, type Crypto, Effect, FileSystem, Option } from "effect"
import {
  configDirectory,
  controlPlaneUrl,
  CredentialsExposed,
  CredentialsUnreadable,
  loadCredentials,
  loadCredentialsToRevoke,
  NotLoggedIn,
  removeCredentials,
  saveCredentials,
} from "./credentials.ts"

/** A fresh directory inside a temporary one, removed with the scope, named by `AKTER_CONFIG_DIR` for `effect`. */
const inConfigDirectory = <A, E>(
  effect: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Crypto.Crypto>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = `${yield* fs.makeTempDirectoryScoped()}/nested/akter`

    return yield* effect(directory).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { AKTER_CONFIG_DIR: directory } }),
      ),
    )
  })

const credentials = { apiUrl: "http://127.0.0.1:4100", token: "tok-asymmetric", email: "a@b.dev" }

/** Writes `contents` as the credentials file, `0600`, the way no `login` would. */
const plant = (directory: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(`${directory}/credentials.json`, contents, { mode: 0o600 })
  })

const modeOf = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(path)).pipe(
    Effect.map((info) => info.mode & 0o777),
  )

const posix = process.platform !== "win32"

layer(BunServices.layer)("credential storage", (it) => {
  it("lives in each operating system's own configuration directory unless AKTER_CONFIG_DIR names one", () => {
    expect(configDirectory({ platform: "darwin", home: "/Users/ada" })).toBe(
      "/Users/ada/Library/Application Support/akter",
    )
    expect(configDirectory({ platform: "linux", home: "/home/ada" })).toBe(
      "/home/ada/.config/akter",
    )
    expect(
      configDirectory({ platform: "linux", home: "/home/ada", xdgConfigHome: "/xdg/config" }),
    ).toBe("/xdg/config/akter")
    expect(configDirectory({ platform: "linux", home: "/home/ada", xdgConfigHome: "" })).toBe(
      "/home/ada/.config/akter",
    )
    expect(
      configDirectory({
        platform: "win32",
        home: "C:\\Users\\ada",
        appData: "D:\\Profiles\\ada\\Roaming",
      }),
    ).toBe("D:\\Profiles\\ada\\Roaming\\akter")
    expect(configDirectory({ platform: "win32", home: "C:\\Users\\ada" })).toBe(
      "C:\\Users\\ada\\AppData\\Roaming\\akter",
    )
    expect(
      configDirectory({ platform: "darwin", home: "/Users/ada", override: "/srv/akter-ci" }),
    ).toBe("/srv/akter-ci")
  })

  it.effect.skipIf(!posix)(
    "writes the file 0600 in a 0700 directory, and tightens an older file and directory other users could read",
    () =>
      inConfigDirectory((directory) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* saveCredentials(credentials)

          expect(file).toBe(`${directory}/credentials.json`)
          expect(yield* modeOf(file)).toBe(0o600)
          expect(yield* modeOf(directory)).toBe(0o700)
          expect(yield* loadCredentials).toEqual(credentials)

          yield* fs.chmod(file, 0o644)
          yield* fs.chmod(directory, 0o755)

          const replaced = { ...credentials, token: "tok-second", email: "c@d.dev" }

          yield* saveCredentials(replaced)

          expect(yield* modeOf(file)).toBe(0o600)
          expect(yield* modeOf(directory)).toBe(0o700)
          expect(yield* loadCredentials).toEqual(replaced)
          expect((yield* fs.readDirectory(directory)).toSorted()).toEqual(["credentials.json"])
        }),
      ),
  )

  it.effect.skipIf(!posix)(
    "refuses a credentials file group or others can read or write, and one it did not write",
    () =>
      inConfigDirectory((directory) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* saveCredentials(credentials)

          for (const mode of [0o640, 0o604, 0o620, 0o602]) {
            yield* fs.chmod(file, mode)
            expect(yield* Effect.flip(loadCredentials)).toEqual(
              CredentialsExposed.make({ path: file, mode }),
            )
          }

          yield* fs.chmod(file, 0o400)
          expect(yield* loadCredentials).toEqual(credentials)

          yield* fs.chmod(file, 0o600)
          yield* fs.writeFileString(file, '{"apiUrl":"http://x"}')
          expect(yield* Effect.flip(loadCredentials)).toEqual(
            CredentialsUnreadable.make({ path: `${directory}/credentials.json` }),
          )
        }),
      ),
  )

  it("accepts a control plane over https anywhere and over http only on this machine", () => {
    expect(controlPlaneUrl("https://api.akter.dev/")).toEqual(Option.some("https://api.akter.dev"))
    expect(controlPlaneUrl("https://cloud.test/base//")).toEqual(
      Option.some("https://cloud.test/base"),
    )
    for (const url of [
      "http://localhost:3001",
      "http://api.localhost:3001",
      "http://127.0.0.1:4100",
      "http://127.8.9.10",
      "http://[::1]:3001",
    ])
      expect(Option.isSome(controlPlaneUrl(url)), url).toBe(true)
    for (const url of [
      "http://api.akter.dev",
      "http://10.0.0.5",
      "http://128.0.0.1",
      "http://localhost.evil.test",
      "http://127.0.0.1.evil.test",
      "ws://localhost",
      "https://user:secret@api.akter.dev",
      "https://api.akter.dev/?token=x",
      "not a url",
    ])
      expect(controlPlaneUrl(url), url).toEqual(Option.none())
  })

  it.effect(
    "refuses stored credentials that would send the token over plain HTTP off this machine",
    () =>
      inConfigDirectory((directory) =>
        Effect.gen(function* () {
          yield* plant(directory, '{"apiUrl":"http://cloud.test","token":"tok","email":"a@b.dev"}')

          expect(yield* Effect.flip(loadCredentials)).toEqual(
            CredentialsUnreadable.make({ path: `${directory}/credentials.json` }),
          )
        }),
      ),
  )

  it.effect.skipIf(!posix)("leaves no temporary file behind when the write fails", () =>
    inConfigDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(`${directory}/credentials.json`, { recursive: true })

        const failed = yield* Effect.flip(saveCredentials(credentials))

        expect(failed._tag).toBe("PlatformError")
        expect(yield* fs.readDirectory(directory)).toEqual(["credentials.json"])
        expect((yield* fs.stat(`${directory}/credentials.json`)).type).toBe("Directory")
      }),
    ),
  )

  it.effect.skipIf(!posix)("reads credentials other users could read for revocation alone", () =>
    inConfigDirectory(() =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* saveCredentials(credentials)

        yield* fs.chmod(file, 0o644)

        expect(yield* Effect.flip(loadCredentials)).toEqual(
          CredentialsExposed.make({ path: file, mode: 0o644 }),
        )
        expect(yield* loadCredentialsToRevoke).toEqual(credentials)

        yield* removeCredentials

        expect(yield* Effect.flip(loadCredentialsToRevoke)).toEqual(
          NotLoggedIn.make({ path: file }),
        )
      }),
    ),
  )

  it.effect(
    "reports no credentials before login and after removal, and removal is idempotent",
    () =>
      inConfigDirectory((directory) =>
        Effect.gen(function* () {
          const missing = NotLoggedIn.make({ path: `${directory}/credentials.json` })

          expect(yield* Effect.flip(loadCredentials)).toEqual(missing)
          expect(yield* removeCredentials).toBe(false)

          yield* saveCredentials(credentials)

          expect(yield* removeCredentials).toBe(true)
          expect(yield* Effect.flip(loadCredentials)).toEqual(missing)
          expect(yield* removeCredentials).toBe(false)
        }),
      ),
  )
})
