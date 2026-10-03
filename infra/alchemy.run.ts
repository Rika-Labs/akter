import * as Alchemy from "alchemy"
import { Effect } from "effect"
import { state } from "./src/aws.ts"
import { region } from "./src/config.ts"
import { resources, stackProviders } from "./src/stack.ts"

const location = await Effect.runPromise(region)

export default Alchemy.Stack(`akter-${location}`, { providers: stackProviders, state }, resources)
