import { expect, it } from "vitest"
import { releaseNotes } from "./notes.ts"

it("extracts only the requested release, with or without a date", () => {
  const changelog = `# Changelog

## 0.1.0-alpha.10 (2026-10-06)

Next alpha.

## 0.1.0-alpha.1 (2026-10-04)

Published with provenance.

- A second paragraph.

## 0.1.0-alpha.0

First alpha.
`
  expect(releaseNotes({ version: "0.1.0-alpha.1", changelog })).toBe(
    "Published with provenance.\n\n- A second paragraph.",
  )
  expect(releaseNotes({ version: "0.1.0-alpha.0", changelog })).toBe("First alpha.")
  expect(() => releaseNotes({ version: "0.1.0-alpha", changelog })).toThrow(
    "No changelog section found",
  )
})

it("refuses missing or empty notes instead of publishing a release without them", () => {
  expect(() =>
    releaseNotes({ version: "1.0.0", changelog: "# Changelog\n\n## 0.9.0\n\nOld notes." }),
  ).toThrow("No changelog section found")
  expect(() =>
    releaseNotes({
      version: "1.0.0",
      changelog: "# Changelog\n\n## 1.0.0\n\n## 0.9.0\n\nOld notes.",
    }),
  ).toThrow("Changelog section for 1.0.0 is empty")
})
