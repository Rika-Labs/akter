import { t as e } from "./brand-uyjyPyjo.js"
var t = new Intl.NumberFormat(`en-US`, { maximumFractionDigits: 0 }),
  n = [
    [0xe8d4a51000, `T`],
    [1e9, `B`],
    [1e6, `M`],
    [1e3, `K`],
  ],
  r = (n) => e(t.format(Math.round(n)), `../../packages/ui/src/geometry/format.ts#formatInteger`),
  i = (t) => {
    let i = Math.abs(t)
    if (i < 1e4)
      return e(
        Number.isInteger(t) ? r(t) : t.toFixed(1),
        `../../packages/ui/src/geometry/format.ts#formatCompact`,
      )
    let a = n.find(([t]) => e(i >= t, `../../packages/ui/src/geometry/format.ts#anonymous`))
    if (a === void 0) return e(r(t), `../../packages/ui/src/geometry/format.ts#formatCompact`)
    let o = t / a[0]
    return e(
      `${o >= 100 ? o.toFixed(0) : o.toFixed(1).replace(/\.0$/u, ``)}${a[1]}`,
      `../../packages/ui/src/geometry/format.ts#formatCompact`,
    )
  },
  a = (t) => {
    if (t < 10)
      return e(`${t.toFixed(1)} ms`, `../../packages/ui/src/geometry/format.ts#formatDuration`)
    if (t < 1e3)
      return e(`${Math.round(t)} ms`, `../../packages/ui/src/geometry/format.ts#formatDuration`)
    let n = t / 1e3
    if (n < 60)
      return e(
        `${n < 10 ? n.toFixed(1) : Math.round(n)} s`,
        `../../packages/ui/src/geometry/format.ts#formatDuration`,
      )
    let r = Math.floor(n / 60)
    return e(
      `${r} m ${Math.round(n - r * 60)} s`,
      `../../packages/ui/src/geometry/format.ts#formatDuration`,
    )
  },
  o = (t) => {
    let n = t * 100
    return e(
      `${n > 0 && n < 1 ? n.toFixed(1) : Math.round(n)}%`,
      `../../packages/ui/src/geometry/format.ts#formatPercent`,
    )
  },
  s = (t) =>
    e(
      `$${t.toLocaleString(`en-US`, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `../../packages/ui/src/geometry/format.ts#formatCurrency`,
    ),
  c = [
    { id: `command`, label: `Command`, detail: `with an idempotency key` },
    { id: `fence`, label: `Fence`, detail: `owner and generation` },
    { id: `receipt`, label: `Receipt`, detail: `a retry returns it` },
    { id: `handler`, label: `Handler`, detail: `a short, pure turn` },
    { id: `commit`, label: `Commit`, detail: `state, rows, outbox` },
    { id: `reply`, label: `Reply`, detail: `result or typed error` },
  ],
  l = { id: `outbox`, label: `Outbox`, detail: `released after commit` },
  u = [
    { id: `jobs`, label: `Jobs`, detail: `retried until done` },
    { id: `timers`, label: `Timers`, detail: `wake the actor later` },
    { id: `messages`, label: `Messages`, detail: `to other actors` },
  ],
  d = c.findIndex((t) =>
    e(t.id === `commit`, `../../packages/ui/src/geometry/lifecycle.ts#anonymous`),
  ),
  f = new Set([`fence`, `receipt`, `handler`, `commit`]),
  p = (t, n) =>
    e(
      { ...t, ...n, emphasis: t.id === `commit` },
      `../../packages/ui/src/geometry/lifecycle.ts#node`,
    ),
  m = () => {
    let t = (960 - 128 * c.length) / (c.length - 1),
      n = c.map((n, r) =>
        e(
          p(n, { x: 20 + r * (128 + t), y: 64, width: 128, height: 54 }),
          `../../packages/ui/src/geometry/lifecycle.ts#anonymous~2`,
        ),
      ),
      r = 20 + d * (128 + t),
      i = p(c[d] ?? l, { x: r, y: 64, width: 128, height: 54 }),
      a = p(l, { x: i.x, y: 196, width: 128, height: 54 }),
      o = u.map((t, n) =>
        e(
          p(t, { x: i.x + (n - 1) * 154, y: 300, width: 128, height: 54 }),
          `../../packages/ui/src/geometry/lifecycle.ts#anonymous~3`,
        ),
      ),
      s = n.slice(1).map((t, r) => {
        let i = n[r] ?? t
        return e(
          { id: `${i.id}-${t.id}`, d: `M${i.x + i.width} 91H${t.x - 4}`, dashed: !1 },
          `../../packages/ui/src/geometry/lifecycle.ts#anonymous~4`,
        )
      }),
      m = i.y + i.height,
      h = i.x + 64
    s.push({ id: `commit-outbox`, d: `M${h} ${m}V192`, dashed: !0 })
    for (let e of o) {
      let t = e.x + 64
      s.push({ id: `outbox-${e.id}`, d: `M${h} 250C${h} 275 ${t} 275 ${t} 296`, dashed: !0 })
    }
    let g = n.filter((t) =>
        e(f.has(t.id), `../../packages/ui/src/geometry/lifecycle.ts#anonymous~5`),
      ),
      _ = g[0] ?? i,
      v = g.at(-1) ?? i
    return e(
      {
        width: 1e3,
        height: 370,
        nodes: [...n, a, ...o],
        edges: s,
        regions: [
          {
            label: `One transaction`,
            x: _.x - 14,
            y: 28,
            width: v.x + v.width - _.x + 28,
            height: 106,
          },
        ],
        tracks: [`M${(n[0]?.x ?? 0) + 8} 91H${(n.at(-1)?.x ?? 0) + 128 - 8}`, `M${h} 91V223`],
      },
      `../../packages/ui/src/geometry/lifecycle.ts#horizontal`,
    )
  },
  h = () => {
    let t = c.map((t, n) =>
        e(
          p(t, { x: 14, y: 34 + n * 70, width: 150, height: 50 }),
          `../../packages/ui/src/geometry/lifecycle.ts#anonymous~6`,
        ),
      ),
      n = p(c[d] ?? l, { x: 14, y: 34 + d * 70, width: 150, height: 50 }),
      r = p(l, { x: 206, y: n.y, width: 140, height: 50 }),
      i = u.map((t, r) =>
        e(
          p(t, { x: 206, y: n.y + (r + 1) * 70, width: 140, height: 50 }),
          `../../packages/ui/src/geometry/lifecycle.ts#anonymous~7`,
        ),
      ),
      a = t.slice(1).map((n, r) => {
        let i = t[r] ?? n
        return e(
          { id: `${i.id}-${n.id}`, d: `M89 ${i.y + 50}V${n.y - 4}`, dashed: !1 },
          `../../packages/ui/src/geometry/lifecycle.ts#anonymous~8`,
        )
      })
    a.push({ id: `commit-outbox`, d: `M${n.x + 150} ${n.y + 25}H202`, dashed: !0 })
    let o = [r, ...i]
    o.slice(1).forEach((e, t) => {
      let n = o[t] ?? e
      a.push({ id: `${n.id}-${e.id}`, d: `M276 ${n.y + 50}V${e.y - 4}`, dashed: !0 })
    })
    let s = t.filter((t) =>
        e(f.has(t.id), `../../packages/ui/src/geometry/lifecycle.ts#anonymous~10`),
      ),
      m = s[0] ?? n,
      h = s.at(-1) ?? n
    return e(
      {
        width: 360,
        height: 34 + (t.length - 1) * 70 + 50 + 34,
        nodes: [...t, ...o],
        edges: a,
        regions: [
          { label: `One transaction`, x: 6, y: m.y - 26, width: 166, height: h.y + 50 - m.y + 34 },
        ],
        tracks: [`M89 42V${(t.at(-1)?.y ?? 0) + 50 - 8}`],
      },
      `../../packages/ui/src/geometry/lifecycle.ts#vertical`,
    )
  },
  g = (t) =>
    e(t === `horizontal` ? m() : h(), `../../packages/ui/src/geometry/lifecycle.ts#lifecycleLayout`)
export { r as a, a as i, i as n, o, s as r, g as t }
