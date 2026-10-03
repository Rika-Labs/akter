import { foldkit } from "@foldkit/vite-plugin"
import type { UserOptions } from "@stylexjs/unplugin"
import stylexVite from "@stylexjs/unplugin/vite"
import { defineConfig, loadEnv, type Plugin } from "vite"

/**
 * `@stylexjs/unplugin` publishes its Vite adapter untyped; it returns one Vite plugin whose
 * `generateBundle` hook appends the collected StyleX CSS to the emitted stylesheet.
 */
const stylex = stylexVite as (options?: Partial<UserOptions>) => Plugin

const repository = new URL("../../", import.meta.url).pathname

/**
 * One compiler pass covers the console and `@akter/ui`, which the console consumes as TypeScript
 * source. Tokens stay in `light-dark()` so the Appearance preference can switch `color-scheme`.
 * The console ships as one application chunk (about 165 kB gzipped, mostly Effect and FoldKit), so
 * the chunk warning sits above it rather than splitting routes that every session loads anyway.
 */
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const target = env.API_PROXY_TARGET ?? `http://127.0.0.1:${env.API_PORT ?? "3001"}`
  return {
    build: {
      target: "es2023",
      cssTarget: ["chrome124", "firefox128", "safari18"],
      chunkSizeWarningLimit: 640,
      manifest: true,
    },
    server: {
      host: "127.0.0.1",
      proxy: { "/api": { target }, "/auth": { target } },
    },
    preview: { host: "127.0.0.1" },
    plugins: [
      stylex({
        dev: command === "serve",
        devMode: "full",
        runtimeInjection: false,
        useCSSLayers: { before: ["reset", "base"], prefix: "stylex" },
        unstable_moduleResolution: { type: "commonJS", rootDir: repository },
        lightningcssOptions: {
          targets: { chrome: 124 << 16, firefox: 128 << 16, safari: 18 << 16 },
        },
      }),
      foldkit({ buildId: "console" }),
    ],
  }
})
