import type { UserOptions } from "@stylexjs/unplugin"
import stylexVite from "@stylexjs/unplugin/vite"
import type { Plugin } from "vite"
import { defineConfig } from "vitest/config"
import shared from "../../vitest.config.ts"

/** `@stylexjs/unplugin` publishes its Vite adapter untyped; it returns one Vite plugin. */
const stylex = stylexVite as (options?: Partial<UserOptions>) => Plugin

const repository = new URL("../../", import.meta.url).pathname

/**
 * The repository's test settings with StyleX compiled as the build compiles it, so view tests render
 * the console's real components: StyleX throws when its calls reach runtime uncompiled. Only the
 * compiler is kept. The plugin's dev-server hook starts a CSS-update timer that it clears when an
 * HTTP server closes, and Vitest's server has none, so the timer would keep every run alive.
 */
export default defineConfig({
  root: repository,
  plugins: [
    {
      ...stylex({
        dev: false,
        runtimeInjection: false,
        unstable_moduleResolution: { type: "commonJS", rootDir: repository },
      }),
      configureServer: undefined,
    },
  ],
  test: { ...shared.test, include: ["apps/console/src/**/*.test.ts"] },
})
