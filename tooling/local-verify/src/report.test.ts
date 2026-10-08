import { expect, it } from "vitest"
import { parseManifest as parseJson, type ManifestInput } from "./manifest.ts"

const parseManifest = (value: ManifestInput) => parseJson(JSON.stringify(value))
import { renderSection, renderSignoff, sectionEnd, sectionStart, upsertSection } from "./report.ts"
import { decide, type CheckResult } from "./verdict.ts"

const manifest = parseManifest({
  repository: "Rika-Labs/akter",
  trustedAuthors: ["maintainer"],
  setup: { name: "setup", run: "true", timeoutMinutes: 5 },
  checks: ["static", "branch"].map((id) => ({
    id,
    description: `${id} | covers`,
    timeoutMinutes: 5,
    steps: [{ name: id, run: "true" }],
  })),
  statuses: [
    { context: "verify", checks: ["static"] },
    { context: "branch", checks: ["branch"] },
  ],
  suites: [],
})

const pass: CheckResult = { result: "pass", seconds: 4, logs: "/runs/1", where: "host" }
const provenance = {
  sha: "a".repeat(40),
  agent: "Capy thread SCO-1",
  at: "2026-10-08T01:02:03.000Z",
  logs: "/runs/1",
  manifestDigest: "f".repeat(64),
  tooling: "tooling identical to origin/main (abc)",
  isolation: "host: the author and head repository are trusted",
  cache: "uncached: TURBO_FORCE=1, no task result was replayed",
}

it("lists every required check with its result, the head SHA, the time and the log directory", () => {
  const section = renderSection(decide(manifest, { static: pass, branch: pass }), provenance)
  for (const expected of [
    "`static`",
    "`branch`",
    provenance.sha,
    provenance.at,
    "/runs/1",
    "Capy thread SCO-1",
    "Signed off by",
  ])
    expect(section).toContain(expected)
  expect(section).toContain("static \\| covers")
})

it("never renders a sign-off for a verdict with a failed or missing check, and lists the missing check", () => {
  const section = renderSection(
    decide(manifest, {
      static: {
        result: "fail",
        seconds: 1,
        failedStep: "Static checks",
        logs: "/runs/1",
        where: "host",
      },
    }),
    provenance,
  )
  expect(section).toContain("Not signed off")
  expect(section).not.toContain("Signed off by")
  expect(section).toContain("FAIL (failed at Static checks)")
  expect(section).toContain("MISSING")
})

it("replaces the generated section in place and leaves the rest of the body untouched", () => {
  const first = renderSection(decide(manifest, { static: pass, branch: pass }), provenance)
  const body = `## What changed\nthing\n\n${first}\n\n## Risks\nnone\n`
  const second = renderSection(decide(manifest, {}), { ...provenance, sha: "b".repeat(40) })
  const updated = upsertSection(body, second)
  expect(updated.match(new RegExp(sectionStart, "g"))).toHaveLength(1)
  expect(updated.match(new RegExp(sectionEnd, "g"))).toHaveLength(1)
  expect(updated).toContain("b".repeat(40))
  expect(updated).not.toContain("a".repeat(40))
  expect(updated.startsWith("## What changed\nthing\n\n")).toBe(true)
  expect(updated.endsWith("\n\n## Risks\nnone\n")).toBe(true)
})

it("appends the section to a body that has none and writes it into an empty body", () => {
  const section = renderSection(decide(manifest, {}), provenance)
  expect(upsertSection("Closes #1", section)).toBe(`Closes #1\n\n${section}\n`)
  expect(upsertSection("", section)).toBe(`${section}\n`)
})

it("marks the sign-off comment with the head SHA so a rerun on that SHA can find and edit it", () => {
  const comment = renderSignoff(decide(manifest, { static: pass, branch: pass }), provenance)
  expect(comment.startsWith(`<!-- local-verify:signoff ${provenance.sha} -->`)).toBe(true)
  expect(comment).toContain("Capy thread SCO-1")
})

it("lists each distinct log directory when the sign-off combines several runs", () => {
  const section = renderSection(
    decide(manifest, { static: pass, branch: { ...pass, logs: "/runs/2" } }),
    provenance,
  )
  expect(section).toContain("Log directories: `/runs/1`, `/runs/2`")
})

it("states where each check ran and how the head was isolated, so a sandboxed run cannot read as a host run", () => {
  const section = renderSection(
    decide(manifest, { static: { ...pass, where: "sandbox" }, branch: { ...pass, where: "tool" } }),
    { ...provenance, isolation: "Docker sandbox: only the checkout is mounted" },
  )
  expect(section).toContain("| `static` | pass | sandbox | 4s |")
  expect(section).toContain("| `branch` | pass | tool | 4s |")
  expect(section).toContain("- Isolation: Docker sandbox: only the checkout is mounted")
})

it("states in both the body section and the sign-off comment that the run was uncached", () => {
  const verdict = decide(manifest, { static: pass, branch: pass })
  expect(renderSection(verdict, provenance)).toContain(
    "- Turbo cache: uncached: TURBO_FORCE=1, no task result was replayed",
  )
  expect(renderSignoff(verdict, provenance)).toContain(
    "Turbo cache: uncached: TURBO_FORCE=1, no task result was replayed",
  )
})
