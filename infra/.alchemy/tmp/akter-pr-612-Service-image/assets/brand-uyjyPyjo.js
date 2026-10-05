var e = (e) =>
    typeof e == `object` &&
    !!e &&
    `sel` in e &&
    typeof e.sel == `string` &&
    `data` in e &&
    `children` in e &&
    `text` in e &&
    `elm` in e &&
    `key` in e,
  t = (e, t) => {
    e.identity === void 0 && (e.identity = t)
  },
  n = (n, r) => {
    if (e(n)) t(n, r)
    else if (Array.isArray(n)) for (let i of n) e(i) && t(i, r)
    return n
  }
export { n as t }
