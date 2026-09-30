/**
 * One sanctioned deviation from a structure rule; the entry fails as stale
 * once its path no longer violates `rule`.
 */
export interface Exemption {
  readonly path: string
  readonly rule:
    | "no-ui-package"
    | "tests-beside-sources"
    | "index-not-entry"
    | "wildcard-exports"
    | "structure-rules"
    | "ledger-cases"
  readonly reason: string
}

/** Every deviation from the structure rules, each with the reason it exists. */
export const exemptions: ReadonlyArray<Exemption> = [
  {
    path: "packages/ui",
    rule: "no-ui-package",
    reason:
      "StyleX must be compiled by Babel before the console imports it, so ui stays a separate build unit until apps/console/src/build.ts runs the StyleX transform itself. Then it moves to apps/console/src/ui/<component>/{view,styles}.ts.",
  },
  {
    path: "tooling/oxlint/anti-slop",
    rule: "structure-rules",
    reason:
      "Vendored rule corpus (see ANTI-SLOP-LICENSE): upstream file layout, index modules and shared/ segments are kept intact so diffs against upstream stay reviewable.",
  },
  {
    path: "research",
    rule: "structure-rules",
    reason:
      "Research archive: PascalCase actor files and typechecked sketches are evidence, not shipped code. Excluded from format and structure checks.",
  },
]
