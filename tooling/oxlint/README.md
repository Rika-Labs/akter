# Owned lint rules

The root `.oxlintrc.json` loads two JavaScript plugins and enables each rule by
name there:

- `anti-slop/plugin.ts` registers the generic and Effect rules copied from
  dmmulroy/anti-slop revision `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. Keep
  the MIT license in `../ANTI-SLOP-LICENSE` with this code. Their standalone
  `RuleTester` files run under Node in the package test script, separate from
  the project's Vitest suites.
- `src/structure.ts` registers the repository's own rules: file and folder
  naming, the runtime import boundary, `no-inline-comments`, and
  `no-decision-references`.

Package entries and `index.ts` placement are not linted here: the tree checker
in `tooling/structure` reads each `package.json` `exports` map and is the one
owner of that rule.

`@oxlint/plugins` must exactly match the root Oxlint version. Update the owned
source deliberately; do not fetch unpinned rule code during setup.

The upstream rules are excluded from self-linting and formatting and preserve
their compiler setting for unchecked index access. This exception does not
apply to application or project tooling source.

## Spacing belongs to the formatter

Blank lines are whatever `oxfmt` produces; no lint rule adds or requires them.
`oxfmt` keeps a single blank line an author writes, collapses runs of blank
lines to one, and never inserts one, so it does not reproduce a "blank line
before every return" style and nothing here tries to. Upstream's
`require-safety-comment-for-type-assertion` is not carried either: it demanded
a `SAFETY:` comment even for casts that only bridge generics or build a test
fixture, which is boilerplate rather than evidence of a checked invariant.
