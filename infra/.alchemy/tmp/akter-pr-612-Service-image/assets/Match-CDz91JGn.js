import { Es as e, Ja as t, Os as n, Wa as r, Ya as i, js as a, qa as o } from "./Schema-y_083odB.js"
var s = `~effect/Match/Matcher`,
  c = {
    [s]: { _input: n, _filters: n, _remaining: n, _result: n, _return: n, _args: n },
    _tag: `TypeMatcher`,
    add(e) {
      return l(this.select, [...this.cases, e])
    },
    pipe() {
      return a(this, arguments)
    },
  }
function l(e, t) {
  let n = Object.create(c)
  return ((n.select = e), (n.cases = t), n)
}
var u = {
  [s]: { _input: n, _filters: n, _result: n, _return: n, _flavor: n },
  _tag: `ValueMatcher`,
  add(e) {
    return t(this.value)
      ? this
      : (e._tag === `When` && e.guard(this.provided) === !0) ||
          (e._tag === `Not` && e.guard(this.provided) === !1)
        ? d(this.provided, i(e.evaluate(this.provided)))
        : this
  },
  pipe() {
    return a(this, arguments)
  },
}
function d(e, t) {
  let n = Object.create(u)
  return ((n.provided = e), (n.value = t), n)
}
var f = (e, t) => ({ _tag: `When`, guard: e, evaluate: t }),
  p = (e) => {
    if (typeof e == `function`) return e
    if (Array.isArray(e)) {
      let t = e.map(p),
        n = t.length
      return (e) => {
        if (!Array.isArray(e)) return !1
        for (let r = 0; r < n; r++) if (t[r](e[r]) === !1) return !1
        return !0
      }
    }
    if (typeof e == `object` && e) {
      let t = Reflect.ownKeys(e).map((t) => [t, p(e[t])]),
        n = t.length
      return (e) => {
        if (typeof e != `object` || !e) return !1
        for (let r = 0; r < n; r++) {
          let [n, i] = t[r]
          if (!(n in e) || i(e[n]) === !1) return !1
        }
        return !0
      }
    }
    return (t) => t === e
  },
  m = (e) => {
    let t = e.map(p),
      n = t.length
    return (e) => {
      for (let r = 0; r < n; r++) if (t[r](e) === !0) return !0
      return !1
    }
  },
  h = (e) => d(e, r(e)),
  g = e(2, (e, t) => T(t)(l(n, []))(e)),
  _ = () => (e) => e,
  v = (e, t) => (n) => n.add(f(p(e), t)),
  y =
    (...e) =>
    (t) => {
      let n = e[e.length - 1],
        r = e.slice(0, -1)
      return t.add(f(m(r), n))
    },
  b =
    (e) =>
    (...t) => {
      let n = t[t.length - 1],
        r = t.slice(0, -1),
        i =
          r.length === 1 ? (t) => t != null && t[e] === r[0] : (t) => t != null && r.includes(t[e])
      return (e) => e.add(f(i, n))
    },
  x = (e) => (t) => {
    let n = f(
      (n) => n != null && Object.hasOwn(t, n[e]),
      (n) => t[n[e]](n),
    )
    return (e) => e.add(n)
  },
  S = (e) => (t) => {
    let n = x(e)(t)
    return (e) => k(n(e))
  },
  C = b(`_tag`),
  w = x(`_tag`),
  T = S(`_tag`),
  E = (e) => (n) => {
    let r = D(n)
    return o(r)
      ? r._tag === `Success`
        ? r.success
        : e(r.failure)
      : (...n) => {
          let i = r(...n)
          return t(i) ? i.success : e(i.failure, ...n)
        }
  },
  D = (e) => {
    if (e._tag === `ValueMatcher`) return e.value
    let t = e.cases.length
    if (t === 1) {
      let t = e.cases[0]
      return (...n) => {
        let a = e.select(...n)
        return (t._tag === `When` && t.guard(a) === !0) || (t._tag === `Not` && t.guard(a) === !1)
          ? i(t.evaluate(a, ...n))
          : r(a)
      }
    }
    return (...n) => {
      let a = e.select(...n)
      for (let r = 0; r < t; r++) {
        let t = e.cases[r]
        if ((t._tag === `When` && t.guard(a) === !0) || (t._tag === `Not` && t.guard(a) === !1))
          return i(t.evaluate(a, ...n))
      }
      return r(a)
    }
  },
  O = `effect/match/Match/exhaustive: absurd`,
  k = (e) => {
    let n = D(e)
    if (o(n)) {
      if (t(n)) return n.success
      throw Error(O)
    }
    return (...e) => {
      let r = n(...e)
      if (t(r)) return r.success
      throw Error(O)
    }
  },
  A = h,
  j = g,
  M = _,
  N = v,
  P = y,
  F = C,
  I = w,
  L = T,
  R = E,
  z = k
export { L as a, N as c, I as i, P as l, R as n, A as o, F as r, j as s, z as t, M as u }
