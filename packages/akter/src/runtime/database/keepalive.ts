/**
 * Server-side probes release a vanished runner's sessions and their advisory
 * and row locks instead of waiting for the operating system's long defaults.
 * Callers can tune these for their network or disable them explicitly.
 */
export const withKeepalives = <
  A extends {
    readonly url?: Redacted.Redacted<string> | undefined
    readonly startupParameters?: Readonly<Record<string, string>> | undefined
    readonly startupOptions?: string | undefined
  },
>(
  config: A,
): A => {
  const url = config.url === undefined ? undefined : Redacted.value(config.url)
  const options =
    config.startupOptions ??
    (url !== undefined && URL.canParse(url) ? new URL(url).searchParams.get("options") : null) ??
    ""
  const named = new Set(Object.keys(config.startupParameters ?? {}).map((key) => key.toLowerCase()))
  const defaults = Object.entries({
    tcp_keepalives_idle: "5",
    tcp_keepalives_interval: "2",
    tcp_keepalives_count: "3",
  })
    .filter(([key]) => !named.has(key))
    .map(([key, value]) => `-c ${key}=${value}`)
    .join(" ")

  return { ...config, startupOptions: `${defaults} ${options}`.trim() }
}
import { Redacted } from "effect"
