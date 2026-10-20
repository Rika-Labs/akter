import { defineConfig } from "vitest/config"

/**
 * The content and hosting tests run in Node. The component tests render the real components in
 * jsdom, and their JSX is compiled with the automatic runtime because the app's own compiler
 * settings leave JSX for Next. Fumadocs is loaded through the test runner in both, so resetting
 * modules also resets the search client's cache of loaded indexes.
 */
const fumadocs = { deps: { inline: [/fumadocs-core/] } }

export default defineConfig({
  test: {
    maxWorkers: 2,
    testTimeout: 15000,
    projects: [
      {
        oxc: { jsx: { runtime: "automatic" } },
        test: { name: "content", include: ["src/**/*.test.ts"], server: fumadocs },
      },
      {
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "components",
          include: ["src/**/*.test.tsx"],
          environment: "jsdom",
          server: fumadocs,
        },
      },
    ],
  },
})
