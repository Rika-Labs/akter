# Owned lint rules

The root `.oxlintrc.json` loads two JavaScript plugins and enables each rule by
name there:

- `anti-slop/plugin.ts` registers the generic and Effect rules copied from
  dmmulroy/anti-slop revision `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. Keep
  the MIT license in `../ANTI-SLOP-LICENSE` with this code. Their standalone
  `RuleTester` files run under Node in the package test script, separate from
  the project's Vitest suites.
- `src/structure.ts` registers the repository's own rules: file and folder
  naming, the runtime import boundary, `no-inline-comments`,
  `no-decision-references`, and `synchronous-actions`.

## `akter/synchronous-actions`

Action, view, `connect` and `disconnect` handlers must be plain synchronous
functions that reach the world only through `ctx`, so a turn replays
identically from the log. The rule reports `Date`, `Math.random`, every
`Math` function except `floor`, `ceil`, `round`, `trunc`, `abs`, `min`, `max`
and `sign` (constants such as `Math.PI` pass), `**` and `**=`, `crypto`,
`performance`, `process`, `globalThis`, `Promise`, `await`, `async` functions,
`setTimeout`, `setInterval`, `Intl`, `toLocaleString`, `toLocaleDateString`,
`toLocaleTimeString`, `localeCompare`, `toString` called with an argument,
`.message` and `.stack` read from a `catch` binding, `structuredClone`,
`Effect` and `yield`. Each message names its replacement (`ctx.now()`,
`ctx.random()`, `ctx.id()`, `ctx.schedule(...)`, or a job).

Scope is syntactic, because Oxlint JavaScript plugins have no type
information:

- Handlers are the function values written inline in the object literal passed
  to `<Contract>.toLayer({...})`, including functions nested inside them.
- A handler is a job, and exempt, when its key appears under `jobs:` in the
  `Actor.make(name, {...})` call that `<Contract>` resolves to: a `const` in
  the same module, or an export reached through relative imports, `export
{ X } from` and `export * from` in another module. A receiver that does not
  resolve to an `Actor.make` call (a package import, a computed value, another
  service's `toLayer`) is not checked at all.
- Helpers declared outside the object literal and passed by name
  (`post: handlePost`), or imported from another module, are not checked.
- `toString(radix)` is reported for any receiver, and an error's `.message` or
  `.stack` only when read from the `catch` binding in the handler.

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
