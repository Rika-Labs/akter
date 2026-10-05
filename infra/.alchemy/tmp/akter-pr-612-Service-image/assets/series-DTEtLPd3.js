import { t as e } from "./brand-uyjyPyjo.js"
var t = (t) => {
    let n = t.seed,
      r = t.base
    return e(
      Array.from(
        { length: t.length },
        () => (
          (n = (n * 9301 + 49297) % 233280),
          (r = Math.max(t.base * 0.25, r + (n / 233280 - 0.48) * t.volatility)),
          e(Number(r.toFixed(2)), `src/app/workspace/series.ts#anonymous`)
        ),
      ),
      `src/app/workspace/series.ts#seededSeries`,
    )
  },
  n = (t) =>
    e(
      Array.from({ length: t.points }, (n, r) => {
        let i = Math.round(((t.points - 1 - r) * 24 * 60) / (t.points - 1)),
          a = (((t.end * 60 - i) % 1440) + 1440) % 1440
        return e(
          `${String(Math.floor(a / 60)).padStart(2, `0`)}:${String(a % 60).padStart(2, `0`)}`,
          `src/app/workspace/series.ts#anonymous~2`,
        )
      }),
      `src/app/workspace/series.ts#hourLabels`,
    )
export { t as n, n as t }
