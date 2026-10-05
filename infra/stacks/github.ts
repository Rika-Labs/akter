import * as Alchemy from "alchemy"
import * as Axiom from "alchemy/Axiom"
import * as GitHub from "alchemy/GitHub"
import { Layer } from "effect"
import { environments } from "../src/github/environments.ts"
import { state } from "../src/state.ts"

/**
 * The GitHub environments the deploy workflow runs in. It is deployed by hand, with the values it
 * copies in its environment: `bun run deploy:github`.
 */
export default Alchemy.Stack(
  "akter-github",
  { providers: Layer.mergeAll(GitHub.providers(), Axiom.providers()), state },
  environments,
)
