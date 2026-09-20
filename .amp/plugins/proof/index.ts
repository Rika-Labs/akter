import type { PluginAPI } from "@ampcode/plugin"
import { Amp } from "@rikalabs/proof"

export const description = "Jev typed evaluation and a read-only Judge investigator."

export default (amp: PluginAPI) => Amp.register(amp)
