import { Effect, Schema as S } from "effect"

/** The Appearance preference: follow the operating system, or force light or dark. */
export const Preference = S.Literals(["system", "light", "dark"])
export type Preference = typeof Preference.Type

const storageKey = "akter-theme"

const chrome = { light: "#fbfbfa", dark: "#121311" } as const

const isPreference = S.is(Preference)

/**
 * Reads the stored preference. The console is designed light-first, so without a stored choice (or
 * with storage unavailable, as in some private windows) it starts light.
 */
export const readPreference: Effect.Effect<Preference> = Effect.try(() =>
  window.localStorage.getItem(storageKey),
).pipe(
  Effect.map((stored) => (isPreference(stored) ? stored : "light")),
  Effect.orElseSucceed(() => "light" as const),
)

/**
 * Applies the preference to the document, whose `color-scheme` decides every `light-dark()` token,
 * updates the browser chrome colour, and remembers the choice.
 */
export const applyPreference = (preference: Preference): Effect.Effect<void> =>
  Effect.sync(() => {
    document.documentElement.dataset["theme"] = preference
    const dark =
      preference === "dark" ||
      (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
      meta.content = dark ? chrome.dark : chrome.light
  }).pipe(
    Effect.andThen(Effect.try(() => window.localStorage.setItem(storageKey, preference))),
    Effect.ignore,
  )
