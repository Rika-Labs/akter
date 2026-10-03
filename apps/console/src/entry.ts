import "@akter/ui/base.css"
import * as Runtime from "foldkit/runtime"
import { applicationConfig, flags } from "./app/shell/application.ts"

const application = Runtime.makeApplication({
  ...applicationConfig,
  container: document.getElementById("app"),
})

Runtime.run(application, { flags })
