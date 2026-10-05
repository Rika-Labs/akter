import { D as e } from "./src-BegpNXfi.js"
import { t } from "./brand-uyjyPyjo.js"
import { o as n } from "./index-BFzTgTOA.js"
var r = (r) =>
  t(
    n.make({
      id: r,
      organization: `Acme`,
      members: 4,
      plan: e.make({ id: `pro` }),
      catalog: [],
      inviter: `Dallen Pyrah`,
      email: `lee@acme.dev`,
      role: `Member`,
    }),
    `src/app/auth/fixtures.ts#invitation`,
  )
export { r as invitation }
