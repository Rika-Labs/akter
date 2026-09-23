# Owned lint rules

`anti-slop/` is copied from dmmulroy/anti-slop revision
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. Keep the MIT license and nested
ESLint Stylistic provenance with this code. The generic and Effect rules run
from the root Oxlint configuration except
`require-safety-comment-for-type-assertion`; see `.github/ci.md` for its
repository-wide exception. Their standalone `RuleTester` files run under Node
in the package test script, separate from the project's Vitest suites.

`@oxlint/plugins` must exactly match the root Oxlint version. Update the owned
source deliberately; do not fetch unpinned rule code during setup.

The upstream rules are excluded from self-linting and preserve their compiler
setting for unchecked index access. This exception does not apply to application
or project tooling source.
