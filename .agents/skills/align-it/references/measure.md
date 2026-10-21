# Measure ink and draw red lines

Run in the page (`browse-it` "Run JS"). Replace `<control>` and `<label>` with selectors that match one
visible element each. It draws a fixed, pointer-transparent overlay on `document.body`, never inside app
markup, and returns the numbers.

```js
const o = document.body.appendChild(document.createElement("div"))
o.id = "redline"
o.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647"
const draw = (b, css) => {
  o.appendChild(document.createElement("div")).style.cssText =
    `position:absolute;box-sizing:border-box;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;${css}`
}
const px = (v) => parseFloat(v) || 0,
  r2 = (n) => Math.round(n * 100) / 100
const el = document.querySelector("<control>"),
  row = el.getBoundingClientRect(),
  ecs = getComputedStyle(el)
const pad = ["Top", "Right", "Bottom", "Left"].map(
  (s) => px(ecs["padding" + s]) + px(ecs["border" + s + "Width"]),
)
// Padding: green strips inside the border box.
draw({ x: row.x, y: row.y, width: row.width, height: pad[0] }, "background:rgba(147,196,125,.45)")
draw(
  { x: row.x, y: row.bottom - pad[2], width: row.width, height: pad[2] },
  "background:rgba(147,196,125,.45)",
)
draw({ x: row.x, y: row.y, width: pad[3], height: row.height }, "background:rgba(147,196,125,.45)")
draw(
  { x: row.right - pad[1], y: row.y, width: pad[1], height: row.height },
  "background:rgba(147,196,125,.45)",
)
// Icon ink: union of shape boxes mapped through each shape's CTM, widened by half the stroke.
const pts = [...el.querySelectorAll("svg :is(path,circle,ellipse,rect,line,polyline,polygon)")]
  .filter((s) => !s.closest("defs,clipPath,mask,symbol"))
  .flatMap((s) => {
    const b = s.getBBox(),
      m = s.getScreenCTM(),
      cs = getComputedStyle(s),
      w = cs.stroke === "none" ? 0 : px(cs.strokeWidth) / 2
    return [
      [b.x - w, b.y - w],
      [b.x + b.width + w, b.y - w],
      [b.x - w, b.y + b.height + w],
      [b.x + b.width + w, b.y + b.height + w],
    ].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f])
  })
const xs = pts.map((p) => p[0]),
  ys = pts.map((p) => p[1])
const icon = pts.length
  ? {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    }
  : null
// Text ink: a Range gives the line position, canvas metrics give the glyphs.
const lab = el.querySelector("<label>"),
  cs = getComputedStyle(lab),
  rg = document.createRange()
rg.selectNodeContents(lab)
const line = rg.getClientRects()[0],
  cx = document.createElement("canvas").getContext("2d")
cx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
cx.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing
const t = cx.measureText(lab.textContent.trim()),
  cap = cx.measureText("H").actualBoundingBoxAscent,
  baseline = line.top + t.fontBoundingBoxAscent
const text = {
  x: line.left - t.actualBoundingBoxLeft,
  y: baseline - t.actualBoundingBoxAscent,
  width: t.actualBoundingBoxLeft + t.actualBoundingBoxRight,
  height: t.actualBoundingBoxAscent + t.actualBoundingBoxDescent,
}
const mid = row.y + row.height / 2,
  inks = [icon, text].filter(Boolean)
draw(row, "border:1px solid red")
draw({ x: row.x, y: mid - 0.5, width: row.width, height: 1 }, "background:red")
draw({ x: row.x + row.width / 2 - 0.5, y: row.y, width: 1, height: row.height }, "background:red")
inks.forEach((b) => draw(b, "outline:1px solid magenta"))
draw({ x: text.x - 4, y: baseline - 0.5, width: text.width + 8, height: 1 }, "background:blue")
JSON.stringify({
  row: row.toJSON(),
  padding: pad,
  icon,
  text,
  font: `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`,
  iconDy: icon && r2(icon.y + icon.height / 2 - mid),
  textDy: r2(text.y + text.height / 2 - mid),
  capDy: r2(baseline - cap / 2 - mid),
  visibleInset: {
    left: r2(Math.min(...inks.map((b) => b.x)) - row.x),
    right: r2(row.right - Math.max(...inks.map((b) => b.x + b.width))),
    top: r2(Math.min(...inks.map((b) => b.y)) - row.y),
    bottom: r2(row.bottom - Math.max(...inks.map((b) => b.y + b.height))),
  },
  dpr: devicePixelRatio,
})
```

Then screenshot and remove it: `document.getElementById('redline').remove()`.

- Red outline: border box. Red lines: the box's vertical and horizontal centers. Green: padding and border.
  Magenta: icon and text ink. Blue: text baseline.
- `iconDy`, `textDy`, `capDy` are ink-center offsets from the box center; negative is above.
  `visibleInset` is the padding the eye sees.
- A Range rect is the line box, not glyph ink. `getBBox` alone ignores transforms and stroke.
- For more children or margins, extend the same pattern (margin strips in orange outside the border box).
  Run it on the parent too.
