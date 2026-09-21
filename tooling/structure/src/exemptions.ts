export interface Exemption {
  readonly path: string
  readonly rule:
    | "no-ui-package"
    | "tests-beside-sources"
    | "index-not-entry"
    | "wildcard-exports"
    | "structure-rules"
  readonly reason: string
}

export const exemptions: ReadonlyArray<Exemption> = [
  {
    path: "packages/ui",
    rule: "no-ui-package",
    reason:
      "StyleX must be compiled by Babel before the console imports it, so ui stays a separate build unit until apps/console/src/build.ts runs the StyleX transform itself. Then it moves to apps/console/src/ui/<component>/{view,styles}.ts.",
  },
  {
    path: "apps/api/test",
    rule: "tests-beside-sources",
    reason:
      "Template control-plane tests predate the structure contract; they move beside their sources when apps/api is rewritten on the framework.",
  },
  {
    path: "apps/console/test",
    rule: "tests-beside-sources",
    reason:
      "Template console tests predate the structure contract; they move to src/ and scenes/ with the first console page written on the framework.",
  },
  {
    path: "packages/billing/test",
    rule: "tests-beside-sources",
    reason: "Template webhook test predates the structure contract.",
  },
  {
    path: "packages/ui/test",
    rule: "tests-beside-sources",
    reason: "Moves with packages/ui.",
  },
  {
    path: "infra/test",
    rule: "tests-beside-sources",
    reason: "Lifecycle test predates the structure contract.",
  },
  {
    path: ".github/test",
    rule: "tests-beside-sources",
    reason:
      "CI fixture tests exercise .github/src generators; they move beside their sources with the next CI rework.",
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
