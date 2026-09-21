// Every deviation from docs/architecture/repository-structure.md is listed here with its reason.
// The tree checker fails on an exemption that no longer matches a path, so stale entries cannot linger.

export interface Exemption {
  readonly path: string
  readonly rule: "no-ui-package" | "tests-beside-sources" | "structure-rules"
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
    path: "tooling/oxlint/test",
    rule: "tests-beside-sources",
    reason:
      "Directives test predates the structure contract; anti-slop rule tests already sit beside their rules.",
  },
  {
    path: "infra/test",
    rule: "tests-beside-sources",
    reason: "Lifecycle test predates the structure contract.",
  },
  {
    path: "research",
    rule: "structure-rules",
    reason:
      "Research archive: PascalCase actor files and typechecked sketches are evidence, not shipped code. Excluded from format and structure checks.",
  },
]
