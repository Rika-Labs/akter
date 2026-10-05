import { D as e } from "./src-BegpNXfi.js"
var t = {
  person: { id: `usr_dallen`, name: `Dallen Pyrah`, email: `dallen@acme.dev`, role: `Owner` },
  organization: `Acme`,
  plan: e.make({ id: `pro` }),
  projects: [
    { slug: `storefront`, deployed: !0, region: `us-east-1` },
    { slug: `support-bot`, deployed: !1, region: `eu-west-1` },
  ],
  pinned: [
    { actorType: `Cart`, key: `c_19af`, awake: !0, lastTurn: `now` },
    { actorType: `Order`, key: `ord_8f2c`, awake: !0, lastTurn: `2m` },
    { actorType: `SupportRoom`, key: `general`, awake: !0, lastTurn: `now` },
    { actorType: `AgentSession`, key: `s_77k`, awake: !1, lastTurn: `14m` },
    { actorType: `NightlyReport`, key: `singleton`, awake: !1, lastTurn: `9h` },
  ],
  deadLetters: 3,
}
export { t as workspace }
