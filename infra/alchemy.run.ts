import * as Alchemy from "alchemy"
import { stackName } from "./src/config.ts"
import { stackProviders } from "./src/providers.ts"
import { state } from "./src/state.ts"
import { resources } from "./src/stack.ts"

export default Alchemy.Stack(stackName, { providers: stackProviders, state }, resources)
