import { t as e } from "./brand-uyjyPyjo.js"
import { l as t, u as n } from "./index-BFzTgTOA.js"
var r = [`us-east-1`, `eu-west-1`],
  i = [
    {
      id: `dep_a3f9c21`,
      commit: `a3f9c21`,
      message: `Add refunds to Order`,
      author: `dallen`,
      regions: r,
      runners: 6,
      took: `41 s`,
      status: `Live`,
      when: `2h`,
    },
    {
      id: `dep_77be010`,
      commit: `77be010`,
      message: `Tune Cart idle timeout`,
      author: `dallen`,
      regions: r,
      runners: 6,
      took: `38 s`,
      status: `Drained`,
      when: `1d`,
    },
    {
      id: `dep_5d2e7c3`,
      commit: `5d2e7c3`,
      message: `Bump Effect`,
      author: `maya`,
      regions: r,
      runners: 6,
      took: `—`,
      status: `Rolled back`,
      when: `2d`,
    },
    {
      id: `dep_1c0d4a8`,
      commit: `1c0d4a8`,
      message: `SupportRoom presence`,
      author: `maya`,
      regions: [`us-east-1`],
      runners: 4,
      took: `36 s`,
      status: `Drained`,
      when: `3d`,
    },
    {
      id: `dep_e91f6b2`,
      commit: `e91f6b2`,
      message: `Initial deploy`,
      author: `dallen`,
      regions: [`us-east-1`],
      runners: 4,
      took: `52 s`,
      status: `Drained`,
      when: `6d`,
    },
  ],
  a = n.make({ environment: `production`, deploys: i }),
  o = (n) =>
    e(
      t.make({
        deploy: n,
        phases: [
          { id: `build`, label: `Build`, detail: `bun install, typecheck`, start: 0, end: 12 },
          { id: `migrate`, label: `Migrate`, detail: `1 table created`, start: 12, end: 15 },
          {
            id: `start`,
            label: `Start runners`,
            detail: `${String(n.runners)} of ${String(n.runners)} healthy`,
            start: 15,
            end: 24,
          },
          {
            id: `move`,
            label: `Move actors`,
            detail: `48,210 moved, none dropped`,
            start: 22,
            end: 36,
          },
          {
            id: `drain`,
            label: `Drain previous`,
            detail: `0 in-flight turns lost`,
            start: 34,
            end: 41,
          },
        ],
        shift: { start: 22, end: 36, moved: 48210 },
        liveAt: 41,
        runners: [
          { id: `r1`, region: `us-east-1`, actors: 9880, cpu: `38%`, health: `healthy` },
          { id: `r2`, region: `us-east-1`, actors: 10112, cpu: `41%`, health: `healthy` },
          { id: `r3`, region: `us-east-1`, actors: 9640, cpu: `36%`, health: `healthy` },
          { id: `r4`, region: `eu-west-1`, actors: 6201, cpu: `22%`, health: `healthy` },
          { id: `r5`, region: `eu-west-1`, actors: 6077, cpu: `21%`, health: `healthy` },
          { id: `r6`, region: `eu-west-1`, actors: 6300, cpu: `24%`, health: `healthy` },
        ].slice(0, n.runners),
        rollbackTargets:
          n.status === `Live`
            ? i
                .slice(i.indexOf(n) + 1)
                .filter((t) =>
                  e(
                    t.status === `Drained` || t.status === `Rolled back`,
                    `src/app/deployments/fixtures.ts#anonymous`,
                  ),
                )
            : [],
        rolledBackFrom: null,
        diffUrl: `https://github.com/acme/storefront/commit/${n.commit}`,
        log: [
          `$ bun install            ok  2.1 s`,
          `$ bun run typecheck      ok  4.8 s`,
          `$ akter contracts diff   ok  Order: +Refund (command)`,
          `$ akter migrate          ok  order_refunds created`,
          `$ start runners          ok  ${String(n.runners)} / ${String(n.runners)} ready`,
          `$ move actors            ok  48,210 moved`,
          `$ drain 77be010          ok  0 in-flight turns lost`,
        ].join(`
`),
      }),
      `src/app/deployments/fixtures.ts#deploymentOf`,
    ),
  s = (t) => {
    let n =
      i.find((n) => e(n.id === t, `src/app/deployments/fixtures.ts#anonymous~2`)) ??
      i.find((n) => e(n.commit === t, `src/app/deployments/fixtures.ts#anonymous~3`))
    return e(n === void 0 ? void 0 : o(n), `src/app/deployments/fixtures.ts#deploymentPage`)
  }
export { s as deploymentPage, a as deploymentsPage }
