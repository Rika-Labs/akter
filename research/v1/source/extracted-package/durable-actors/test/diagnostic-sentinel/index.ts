// Intentionally invalid Effect usage. Excluded from ordinary checks.
// setup:toolchain must prove this produces floatingEffect at error severity.
import { Effect } from "effect"
Effect.succeed("this must not be silently ignored")
