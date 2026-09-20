# Owned lint rules

`anti-slop/` is copied from dmmulroy/anti-slop revision
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. Keep the MIT license and nested
ESLint Stylistic provenance with this code. All 18 generic and 5 Effect rules
are enabled in the root Oxlint configuration.

`@oxlint/plugins` must exactly match the root Oxlint version. Update the owned
source deliberately; do not fetch unpinned rule code during setup.

The upstream rules are excluded from self-linting and preserve their compiler
setting for unchecked index access. This exception does not apply to application
or project tooling source.
