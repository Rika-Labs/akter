var e = (e, t) => {
    switch (t.length) {
      case 0:
        return e
      case 1:
        return t[0](e)
      case 2:
        return t[1](t[0](e))
      case 3:
        return t[2](t[1](t[0](e)))
      case 4:
        return t[3](t[2](t[1](t[0](e))))
      case 5:
        return t[4](t[3](t[2](t[1](t[0](e)))))
      case 6:
        return t[5](t[4](t[3](t[2](t[1](t[0](e))))))
      case 7:
        return t[6](t[5](t[4](t[3](t[2](t[1](t[0](e)))))))
      case 8:
        return t[7](t[6](t[5](t[4](t[3](t[2](t[1](t[0](e))))))))
      case 9:
        return t[8](t[7](t[6](t[5](t[4](t[3](t[2](t[1](t[0](e)))))))))
      default: {
        let n = e
        for (let e = 0, r = t.length; e < r; e++) n = t[e](n)
        return n
      }
    }
  },
  t = {
    pipe() {
      return e(this, arguments)
    },
  },
  n = (function () {
    function e() {}
    return ((e.prototype = t), e)
  })(),
  r = function (e, t) {
    if (typeof e == `function`)
      return function () {
        return e(arguments) ? t.apply(this, arguments) : (e) => t(e, ...arguments)
      }
    switch (e) {
      case 0:
      case 1:
        throw RangeError(`Invalid arity ${e}`)
      case 2:
        return function (e, n) {
          return arguments.length >= 2
            ? t(e, n)
            : function (n) {
                return t(n, e)
              }
        }
      case 3:
        return function (e, n, r) {
          return arguments.length >= 3
            ? t(e, n, r)
            : function (r) {
                return t(r, e, n)
              }
        }
      default:
        return function () {
          if (arguments.length >= e) return t.apply(this, arguments)
          let n = arguments
          return function (e) {
            return t(e, ...n)
          }
        }
    }
  },
  i = (e) => e,
  a = (e) => () => e,
  o = a(!0),
  s = a(!1),
  c = a(null),
  l = a(void 0),
  u = l
function d(t, ...n) {
  return e(t, n)
}
function f(e, t, n, r, i, a, o, s, c) {
  switch (arguments.length) {
    case 1:
      return e
    case 2:
      return function () {
        return t(e.apply(this, arguments))
      }
    case 3:
      return function () {
        return n(t(e.apply(this, arguments)))
      }
    case 4:
      return function () {
        return r(n(t(e.apply(this, arguments))))
      }
    case 5:
      return function () {
        return i(r(n(t(e.apply(this, arguments)))))
      }
    case 6:
      return function () {
        return a(i(r(n(t(e.apply(this, arguments))))))
      }
    case 7:
      return function () {
        return o(a(i(r(n(t(e.apply(this, arguments)))))))
      }
    case 8:
      return function () {
        return s(o(a(i(r(n(t(e.apply(this, arguments))))))))
      }
    case 9:
      return function () {
        return c(s(o(a(i(r(n(t(e.apply(this, arguments)))))))))
      }
  }
}
function p(e) {
  let t = new WeakMap()
  return (n) => {
    let r = t.get(n)
    if (r !== void 0) return r
    let i = e(n)
    return (t.set(n, i), i)
  }
}
function m(e) {
  let t = new WeakMap()
  return (n) => {
    let r = t.get(n)
    if (r !== void 0) return r
    let i = e(n)
    return (t.set(n, i), i !== n && t.set(i, i), i)
  }
}
var ee = (e) => {
    let t = new Set(Reflect.ownKeys(e))
    if (e.constructor === Object) return t
    e instanceof Error && t.delete(`stack`)
    let n = Object.getPrototypeOf(e),
      r = n
    for (; r !== null && r !== Object.prototype;) {
      let e = Reflect.ownKeys(r)
      for (let n = 0; n < e.length; n++) t.add(e[n])
      r = Object.getPrototypeOf(r)
    }
    return (
      t.has(`constructor`) &&
        typeof e.constructor == `function` &&
        n === e.constructor.prototype &&
        t.delete(`constructor`),
      t
    )
  },
  te = new WeakSet(),
  ne = (e) => new Uint8Array(e.buffer, e.byteOffset, e.byteLength),
  re = 0,
  ie = () => {
    re++
  }
function ae(e) {
  return typeof e == `string`
}
function oe(e) {
  return typeof e == `number`
}
function se(e) {
  return typeof e == `boolean`
}
function ce(e) {
  return typeof e == `symbol`
}
function le(e) {
  return ae(e) || oe(e) || ce(e)
}
function ue(e) {
  return typeof e == `function`
}
function de(e) {
  return e === void 0
}
function fe(e) {
  return e !== void 0
}
function pe(e) {
  return e === null
}
function me(e) {
  return e !== null
}
function he(e) {
  return e != null
}
function ge(e) {
  return !1
}
function _e(e) {
  return !0
}
function ve(e) {
  return typeof e == `object` && !!e
}
function ye(e) {
  return typeof e == `object` && !!e && !Array.isArray(e)
}
function be(e) {
  return (typeof e == `object` && !!e) || ue(e)
}
var h = r(2, (e, t) => be(e) && t in e),
  xe = r(2, (e, t) => h(e, `_tag`) && e._tag === t)
function Se(e) {
  return e instanceof Error
}
function Ce(e) {
  return h(e, Symbol.iterator) || ae(e)
}
var g = `~effect/Hash`,
  _ = (e) => {
    switch (typeof e) {
      case `number`:
        return Oe(e)
      case `bigint`:
        return y(e.toString(10))
      case `string`:
        return y(e)
      case `function`:
      case `object`:
        if (e === null) break
        if (e instanceof Date)
          return Number.isNaN(e.getTime()) ? y(`Invalid Date`) : y(e.toISOString())
        if (e instanceof RegExp) return y(e.toString())
        {
          if (te.has(e)) return we(e)
          let t = Le.get(e)
          if (t !== void 0) return t
          if (Re.has(e)) return (ie(), y(`[Circular]`))
          Re.add(e)
          let n = re,
            r
          try {
            r =
              `~effect/Hash` in e
                ? e[g]()
                : typeof e == `function`
                  ? we(e)
                  : e instanceof DataView
                    ? Me(ne(e))
                    : Array.isArray(e) || ArrayBuffer.isView(e)
                      ? Me(e)
                      : e instanceof Map
                        ? Ne(e)
                        : e instanceof Set
                          ? Fe(e)
                          : Ae(e)
          } finally {
            Re.delete(e)
          }
          return (n === re && Le.set(e, r), r)
        }
    }
    return Ee(Te(y(String(e))))
  },
  we = (e) => (Ie.has(e) || Ie.set(e, Ee((Math.random() * 4294967296) | 0)), Ie.get(e)),
  Te = (e) => (
    (e ^= e >>> 16),
    (e = Math.imul(e, 2246822507)),
    (e ^= e >>> 13),
    (e = Math.imul(e, 3266489909)),
    e ^ (e >>> 16)
  ),
  v = r(2, (e, t) => Te(Math.imul(e, 2654435761) + Math.imul(t, 2246822507))),
  Ee = (e) => (e & 3221225471) | ((e >>> 1) & 1073741824),
  De = new DataView(new ArrayBuffer(8)),
  Oe = (e) => {
    let t = e | 0
    return t === e
      ? Ee(t)
      : (De.setFloat64(0, e === e ? e : NaN), Ee(v(De.getInt32(0), De.getInt32(4))))
  },
  y = (e) => {
    let t = 5381,
      n = e.length
    for (; n;) t = (t * 33) ^ e.charCodeAt(--n)
    return Ee(t)
  },
  ke = (e, t) => {
    let n = 12289
    for (let r of t) n ^= v(_(r), _(e[r]))
    return Ee(n)
  },
  Ae = (e) => ke(e, ee(e)),
  je = (e, t) => (n) => {
    let r = e
    for (let e of n) r ^= t(e)
    return Ee(r)
  },
  Me = (e) => {
    let t = 6151
    for (let n of e) t = v(t, _(n))
    return Ee(t)
  },
  Ne = je(y(`Map`), ([e, t]) => v(_(e), _(t))),
  Pe = y(`Set`),
  Fe = je(Pe, (e) => v(Pe, _(e))),
  Ie = new WeakMap(),
  Le = new WeakMap(),
  Re = new WeakSet(),
  b = `~effect/Equal`
function x() {
  return arguments.length === 1 ? (e) => ze(e, arguments[0]) : ze(arguments[0], arguments[1])
}
function ze(e, t) {
  if (e === t) return !0
  if (e == null || t == null) return !1
  let n = typeof e
  return n === typeof t
    ? n === `number` && e !== e && t !== t
      ? !0
      : (n !== `object` && n !== `function`) || te.has(e) || te.has(t)
        ? !1
        : Be(e, t)
    : !1
}
function Be(e, t) {
  let n = He.length
  for (let r = n; r-- > 0;) if (He[r] === e && Ue[r] === t) return !0
  if (n) return Ve(e, t)
  let r = We.get(e)
  r || We.set(e, (r = new WeakMap()))
  let i = r.get(t)
  return (i === void 0 && r.set(t, (i = Ve(e, t))), i)
}
function Ve(e, t) {
  ;(He.push(e), Ue.push(t))
  try {
    return Ge(e, t)
  } finally {
    ;(He.pop(), Ue.pop())
  }
}
var He = [],
  Ue = [],
  We = new WeakMap()
function Ge(e, t) {
  if (_(e) !== _(t)) return !1
  if (e instanceof Date) {
    if (!(t instanceof Date)) return !1
    let n = e.getTime(),
      r = t.getTime()
    return n === r || (Number.isNaN(n) && Number.isNaN(r))
  }
  if (e instanceof RegExp) return t instanceof RegExp && e.toString() === t.toString()
  let n = tt(e)
  if (n !== tt(t) || (typeof e == `function` && !n)) return !1
  if (n) return e[b](t)
  if (Array.isArray(e)) return !Array.isArray(t) || e.length !== t.length ? !1 : Ke(e, t)
  if (ArrayBuffer.isView(e)) {
    let n = e instanceof DataView
    return !ArrayBuffer.isView(t) || e.byteLength !== t.byteLength || n !== t instanceof DataView
      ? !1
      : n
        ? qe(ne(e), ne(t))
        : qe(e, t)
  }
  return e instanceof Map
    ? !(t instanceof Map) || e.size !== t.size
      ? !1
      : Ye(e, t, Xe, Ze)
    : e instanceof Set
      ? !(t instanceof Set) || e.size !== t.size
        ? !1
        : Ye(e, t, _, ze)
      : Je(e, t)
}
function Ke(e, t) {
  for (let n = 0; n < e.length; n++) if (!ze(e[n], t[n])) return !1
  return !0
}
function qe(e, t) {
  if (e.length !== t.length) return !1
  for (let n = 0; n < e.length; n++) if (e[n] !== t[n]) return !1
  return !0
}
function Je(e, t) {
  let n = ee(e),
    r = ee(t)
  if (n.size !== r.size) return !1
  for (let i of n) if (!r.has(i) || !ze(e[i], t[i])) return !1
  return !0
}
function Ye(e, t, n, r) {
  let i = new Map()
  for (let e of t) {
    let t = n(e),
      r = i.get(t)
    r ? r.push(e) : i.set(t, [e])
  }
  outer: for (let t of e) {
    let e = i.get(n(t))
    if (e) {
      for (let n = 0; n < e.length; n++)
        if (r(t, e[n])) {
          ;((e[n] = e[e.length - 1]), e.pop())
          continue outer
        }
    }
    return !1
  }
  return !0
}
var Xe = (e) => _(e[0]),
  Ze = (e, t) => ze(e[0], t[0]) && ze(e[1], t[1]),
  Qe = () => 0
function $e(e, t) {
  return et((n, r) => e(n[0], r[0]) && t(n[1], r[1]))
}
function et(e) {
  return function (t, n) {
    return Ye(t, n, Qe, e)
  }
}
var tt = (e) => h(e, b),
  nt = () => x,
  rt = Symbol.for(`~effect/Redactable`),
  it = (e) => h(e, rt)
function at(e) {
  return it(e) ? ot(e) : e
}
function ot(e) {
  return e[rt](globalThis[`~effect/Fiber/currentFiber`]?.context ?? lt)
}
var st = `~effect/Fiber/currentFiber`,
  ct = new Map(),
  lt = {
    "~effect/Context": {},
    base: ct,
    depth: 0,
    mapUnsafe: ct,
    pipe() {
      return e(this, arguments)
    },
  }
function S(e, t) {
  let n = t?.space ?? 0,
    r = new WeakSet(),
    i = n ? (typeof n == `number` ? ` `.repeat(n) : n) : ``,
    a = (e) => i.repeat(e),
    o = (e, t) => {
      let n = e?.constructor
      return n && n !== Object.prototype.constructor && n.name ? `${n.name}(${t})` : t
    },
    s = (e) => {
      try {
        return Reflect.ownKeys(e)
      } catch {
        return [`[ownKeys threw]`]
      }
    }
  function c(e, t = 0) {
    try {
      return l(e, t)
    } catch {
      return (
        ((typeof e == `object` && e) || typeof e == `function`) && r.delete(e), `[inspection threw]`
      )
    }
  }
  function l(e, n = 0) {
    if (typeof e == `string`) return JSON.stringify(e)
    if (typeof e == `number` || e == null || typeof e == `boolean` || typeof e == `symbol`)
      return String(e)
    if (typeof e == `bigint`) return String(e) + `n`
    if (typeof e == `object` || typeof e == `function`) {
      if (r.has(e)) return ut
      r.add(e)
      let l
      if (rt in e) l = c(ot(e), n)
      else if (Array.isArray(e))
        l =
          !i || e.length <= 1
            ? `[${e.map((e) => c(e, n)).join(`,`)}]`
            : `[\n${a(n + 1)}${e
                .map((e) => c(e, n + 1))
                .join(
                  `,
` + a(n + 1),
                )}\n${a(n)}]`
      else if (e instanceof Date) l = pt(e)
      else if (
        !t?.ignoreToString &&
        h(e, `toString`) &&
        typeof e.toString == `function` &&
        e.toString !== Object.prototype.toString &&
        e.toString !== Array.prototype.toString
      ) {
        let t = mt(e)
        l = e instanceof Error && e.cause !== void 0 ? `${t} (cause: ${c(e.cause, n)})` : t
      } else if (Symbol.iterator in e) l = `${e.constructor.name}(${c(Array.from(e), n)})`
      else {
        let t = s(e)
        if (!i || t.length <= 1) {
          let r = `{${t.map((t) => `${dt(t)}:${c(ht(e, t), n)}`).join(`,`)}}`
          l = o(e, r)
        } else {
          let r = `{\n${t.map((t) => `${a(n + 1)}${dt(t)}: ${c(ht(e, t), n + 1)}`).join(`,
`)}\n${a(n)}}`
          l = o(e, r)
        }
      }
      return (r.delete(e), l)
    }
    return String(e)
  }
  return c(e, 0)
}
var ut = `[Circular]`
function dt(e) {
  return typeof e == `string` ? JSON.stringify(e) : String(e)
}
function ft(e) {
  return e.map((e) => `[${dt(e)}]`).join(``)
}
function pt(e) {
  try {
    return e.toISOString()
  } catch {
    return `Invalid Date`
  }
}
function mt(e) {
  try {
    let t = e.toString()
    return typeof t == `string` ? t : String(t)
  } catch {
    return `[toString threw]`
  }
}
function ht(e, t) {
  try {
    return e[t]
  } catch {
    return `[property access threw]`
  }
}
function gt(e, t) {
  let n = []
  return (
    JSON.stringify(
      e,
      function (e, t) {
        let r = Object.getOwnPropertyDescriptor(this, e)?.value,
          i = h(r, rt) ? at(r) : at(t)
        if (typeof i == `bigint`) return S(i)
        if (typeof i != `object` || !i) return i
        let a =
          i instanceof Error && !h(i, `toJSON`) ? { ...i, name: i.name, message: i.message } : i
        for (; n.length > 0 && n[n.length - 1] !== this;) n.pop()
        if (!n.includes(i)) return (n.push(i), a !== i && n.push(a), a)
      },
      t?.space,
    ) ?? `null`
  )
}
var _t = Symbol.for(`nodejs.util.inspect.custom`),
  vt = (e) => {
    try {
      return (
        (e = at(e)),
        h(e, `toJSON`) && ue(e.toJSON) && e.toJSON.length === 0
          ? e.toJSON()
          : Array.isArray(e)
            ? e.map(vt)
            : e
      )
    } catch {
      return `[toJSON threw]`
    }
  },
  yt = (e, t = 2) => {
    if (typeof e == `string`) return e
    try {
      return typeof e == `object` ? gt(e, { space: t }) : S(e, { space: t })
    } catch {
      return String(e)
    }
  },
  bt = {
    toJSON() {
      return vt(this)
    },
    [_t]() {
      return this.toJSON()
    },
    toString() {
      return S(this.toJSON())
    },
  },
  xt = class {
    [_t]() {
      return this.toJSON()
    }
    toString() {
      return S(this.toJSON())
    }
  },
  St = (() => {
    let e = Object.getOwnPropertyDescriptor(Error, `stackTraceLimit`)
    return e === void 0
      ? Object.isExtensible(Error)
      : Object.hasOwn(e, `writable`)
        ? e.writable === !0
        : e.set !== void 0
  })(),
  Ct = () => Error.stackTraceLimit,
  wt = (e) => {
    St && (Error.stackTraceLimit = e)
  },
  Tt = class {
    constructor(e) {
      ;((this.value = e), (this.done = !1))
    }
    next(e) {
      return this.done
        ? ((this.value = e), this)
        : ((this.done = !0), { value: this.value, done: !1 })
    }
  },
  Et = (() => {
    let e = `~effect/Utils/internal`,
      t = { [e]: (e) => e() },
      n = {
        [e]: (e) => {
          try {
            return e()
          } finally {
          }
        },
      }
    return Ct() !== 0 && t[e](() => Error().stack)?.includes(e) === !0 ? t[e] : n[e]
  })()
function C(e, t, n) {
  t === `__proto__`
    ? Object.defineProperty(e, t, { value: n, writable: !0, enumerable: !0, configurable: !0 })
    : (e[t] = n)
}
function Dt(e, t) {
  for (let n of Reflect.ownKeys(t))
    Object.prototype.propertyIsEnumerable.call(t, n) && C(e, n, t[n])
}
var Ot = `~effect/Effect`,
  kt = `~effect/Exit`,
  At = { _A: i, _E: i, _R: i },
  jt = `${Ot}/identifier`,
  w = `${Ot}/args`,
  T = `${Ot}/evaluate`,
  E = `${Ot}/successCont`,
  Mt = `${Ot}/failureCont`,
  Nt = `${Ot}/ensureCont`,
  Pt = Symbol.for(`effect/Effect/Yield`),
  Ft = {
    pipe() {
      return e(this, arguments)
    },
    toJSON() {
      return { ...this }
    },
    toString() {
      return S(this.toJSON(), { ignoreToString: !0, space: 2 })
    },
    [_t]() {
      return this.toJSON()
    },
  },
  It = {
    [Ot]: At,
    ...Ft,
    [Symbol.iterator]() {
      return new Tt(this)
    },
    toJSON() {
      return { _id: `Effect`, op: this[jt], ...(w in this ? { args: this[w] } : void 0) }
    },
  },
  D = (e) => h(e, Ot),
  Lt = (e) => h(e, kt),
  Rt = `~effect/Cause`,
  zt = `~effect/Cause/Reason`,
  Bt = (e) => h(e, Rt),
  Vt = (e) => h(e, zt),
  Ht = class {
    constructor(e) {
      ;((this[Rt] = Rt), (this.reasons = e))
    }
    pipe() {
      return e(this, arguments)
    }
    toJSON() {
      return { _id: `Cause`, failures: this.reasons.map((e) => e.toJSON()) }
    }
    toString() {
      return `Cause(${S(this.reasons)})`
    }
    [_t]() {
      return this.toJSON()
    }
    [b](e) {
      return (
        Bt(e) &&
        this.reasons.length === e.reasons.length &&
        this.reasons.every((t, n) => x(t, e.reasons[n]))
      )
    }
    [g]() {
      return Me(this.reasons)
    }
  },
  Ut = new WeakMap(),
  Wt = class {
    [zt]
    annotations
    _tag
    constructor(e, t, n) {
      if (((this[zt] = zt), (this._tag = e), t !== Gt && typeof n == `object` && n && t.size > 0)) {
        let e = Ut.get(n)
        ;(e && (t = new Map([...e, ...t])), Ut.set(n, t))
      }
      this.annotations = t
    }
    annotate(e, t) {
      if (e.mapUnsafe.size === 0) return this
      let n = new Map(this.annotations)
      e.mapUnsafe.forEach((e, r) => {
        ;(t?.overwrite !== !0 && n.has(r)) || n.set(r, e)
      })
      let r = Object.assign(Object.create(Object.getPrototypeOf(this)), this)
      return ((r.annotations = n), r)
    }
    pipe() {
      return e(this, arguments)
    }
    toString() {
      return S(this)
    }
    [_t]() {
      return this.toString()
    }
  },
  Gt = new Map(),
  Kt = class extends Wt {
    constructor(e, t = Gt) {
      ;(super(`Fail`, t, e), (this.error = e))
    }
    toString() {
      return `Fail(${S(this.error)})`
    }
    toJSON() {
      return { _tag: `Fail`, error: this.error }
    }
    [b](e) {
      return $t(e) && x(this.error, e.error) && x(this.annotations, e.annotations)
    }
    [g]() {
      return v(y(this._tag))(v(_(this.error))(_(this.annotations)))
    }
  },
  qt = (e) => new Ht(e),
  Jt = new Ht([]),
  Yt = (e) => new Ht([new Kt(e)]),
  Xt = class extends Wt {
    constructor(e, t = Gt) {
      ;(super(`Die`, t, e), (this.defect = e))
    }
    toString() {
      return `Die(${S(this.defect)})`
    }
    toJSON() {
      return { _tag: `Die`, defect: this.defect }
    }
    [b](e) {
      return en(e) && x(this.defect, e.defect) && x(this.annotations, e.annotations)
    }
    [g]() {
      return v(y(this._tag))(v(_(this.defect))(_(this.annotations)))
    }
  },
  Zt = (e) => new Ht([new Xt(e)]),
  Qt = r(
    (e) => Bt(e[0]),
    (e, t, n) => (t.mapUnsafe.size === 0 ? e : new Ht(e.reasons.map((e) => e.annotate(t, n)))),
  ),
  $t = (e) => e._tag === `Fail`,
  en = (e) => e._tag === `Die`,
  tn = (e) => e._tag === `Interrupt`
function nn(e) {
  return dn(`Effect.evaluate: Not implemented`)
}
var rn = (e) => ({ ...It, [jt]: e.op, [T]: e[T] ?? nn, [E]: e[E], [Mt]: e[Mt], [Nt]: e[Nt] }),
  an = (e) => {
    let t = rn(e),
      n = function (e) {
        this[w] = e
      }
    return (
      (n.prototype = t),
      function (e) {
        return new n(e)
      }
    )
  },
  on = (e) => {
    let t = {
        [kt]: kt,
        _tag: e.op,
        get [e.prop]() {
          return this[w]
        },
        ...rn(e),
        toString() {
          return `${e.op}(${S(this[w])})`
        },
        toJSON() {
          return { _id: `Exit`, _tag: e.op, [e.prop]: this[w] }
        },
        [b](e) {
          return Lt(e) && e._tag === this._tag && x(this[w], e[w])
        },
        [g]() {
          return v(y(e.op), _(this[w]))
        },
      },
      n = function (e) {
        this[w] = e
      }
    return (
      (n.prototype = t),
      function (e) {
        return new n(e)
      }
    )
  },
  O = on({
    op: `Success`,
    prop: `value`,
    [T](e) {
      let t = e.getCont(E)
      return t ? t[E](this[w], e, this) : e.yieldWith(this)
    },
  }),
  sn = { key: `effect/Cause/StackTrace` },
  cn = { key: `effect/Cause/InterruptorStackTrace` },
  ln = on({
    op: `Failure`,
    prop: `cause`,
    [T](e) {
      let t = this[w],
        n = !1
      e.cache.stackFrame &&
        ((t = Qt(t, { mapUnsafe: new Map([[sn.key, e.cache.stackFrame]]) })), (n = !0))
      let r = e.getCont(Mt)
      for (; e.interruptible && e._interruptedCause && r;) r = e.getCont(Mt)
      return r ? r[Mt](t, e, n ? void 0 : this) : e.yieldWith(n ? ln(t) : this)
    },
  }),
  un = (e) => ln(Yt(e)),
  dn = (e) => ln(Zt(e)),
  k = an({
    op: `WithFiber`,
    [T](e) {
      return this[w](e)
    },
  }),
  fn = (function () {
    class e extends globalThis.Error {}
    let t = rn({
      op: `YieldableError`,
      [T]() {
        return un(this)
      },
    })
    return (delete t.toString, Object.assign(e.prototype, t), e)
  })(),
  pn = (function () {
    let e = Symbol.for(`effect/Data/Error/plainArgs`)
    return class extends fn {
      constructor(t) {
        ;(super(t?.message, t?.cause ? { cause: t.cause } : void 0),
          t && (Dt(this, t), Object.defineProperty(this, e, { value: t, enumerable: !1 })))
      }
      toJSON() {
        return { ...this[e], ...this }
      }
    }
  })(),
  mn = (e) => {
    class t extends pn {
      _tag = e
    }
    return ((t.prototype.name = e), t)
  },
  hn = `~effect/Cause/Done`,
  gn = (e) => h(e, hn),
  _n = { [hn]: hn, _tag: `Done`, value: void 0 },
  vn = (e) => (e === void 0 ? _n : { [hn]: hn, _tag: `Done`, value: e }),
  yn = un(_n),
  bn = (e) => (e === void 0 ? yn : un(vn(e))),
  xn = (e) => rn({ op: e.label, [T]: e.evaluate }),
  Sn = (e) => (t, n) => t === n || e(t, n),
  Cn = (e, t) => e === t,
  wn = () => Cn
function Tn(e) {
  return Sn((t, n) => {
    if (t.length !== n.length) return !1
    for (let r = 0; r < t.length; r++) if (!e[r](t[r], n[r])) return !1
    return !0
  })
}
function En(e) {
  return Sn((t, n) => {
    if (t.length !== n.length) return !1
    for (let r = 0; r < t.length; r++) if (!e(t[r], n[r])) return !1
    return !0
  })
}
var Dn = `~effect/Option`,
  On = {
    [Dn]: { _A: (e) => e },
    ...Ft,
    [Symbol.iterator]() {
      return new Tt(this)
    },
  },
  kn = Object.defineProperty(
    Object.assign(Object.create(On), {
      _tag: `Some`,
      _op: `Some`,
      [b](e) {
        return Mn(e) && Pn(e) && x(this.value, e.value)
      },
      [g]() {
        return v(_(this._tag))(_(this.value))
      },
      toString() {
        return `some(${S(this.value)})`
      },
      toJSON() {
        return { _id: `Option`, _tag: this._tag, value: vt(this.value) }
      },
    }),
    "valueOrUndefined",
    {
      get() {
        return this.value
      },
    },
  ),
  An = _(`None`),
  jn = Object.assign(Object.create(On), {
    _tag: `None`,
    _op: `None`,
    valueOrUndefined: void 0,
    [b](e) {
      return Mn(e) && Nn(e)
    },
    [g]() {
      return An
    },
    toString() {
      return `none()`
    },
    toJSON() {
      return { _id: `Option`, _tag: this._tag }
    },
  }),
  Mn = (e) => h(e, Dn),
  Nn = (e) => e._tag === `None`,
  Pn = (e) => e._tag === `Some`,
  Fn = Object.create(jn),
  In = function (e) {
    this.value = e
  }
In.prototype = kn
var Ln = (e) => new In(e),
  Rn = `~effect/Result`,
  zn = {
    [Rn]: { _A: (e) => e, _E: (e) => e },
    ...Ft,
    [Symbol.iterator]() {
      return new Tt(this)
    },
  },
  Bn = Object.assign(Object.create(zn), {
    _tag: `Success`,
    _op: `Success`,
    [b](e) {
      return Hn(e) && Wn(e) && x(this.success, e.success)
    },
    [g]() {
      return v(_(this._tag))(_(this.success))
    },
    toString() {
      return `success(${S(this.success)})`
    },
    toJSON() {
      return { _id: `Result`, _tag: this._tag, value: vt(this.success) }
    },
  }),
  Vn = Object.assign(Object.create(zn), {
    _tag: `Failure`,
    _op: `Failure`,
    [b](e) {
      return Hn(e) && Un(e) && x(this.failure, e.failure)
    },
    [g]() {
      return v(_(this._tag))(_(this.failure))
    },
    toString() {
      return `failure(${S(this.failure)})`
    },
    toJSON() {
      return { _id: `Result`, _tag: this._tag, failure: vt(this.failure) }
    },
  }),
  Hn = (e) => h(e, Rn),
  Un = (e) => e._tag === `Failure`,
  Wn = (e) => e._tag === `Success`,
  Gn = function (e) {
    this.failure = e
  }
Gn.prototype = Vn
var Kn = (e) => new Gn(e),
  qn = function (e) {
    this.success = e
  }
qn.prototype = Bn
var Jn = (e) => new qn(e)
function Yn(e) {
  return (t, n) => (t === n ? 0 : e(t, n))
}
var Xn = Yn((e, t) => (e < t ? -1 : 1)),
  Zn = Yn((e, t) =>
    globalThis.Number.isNaN(e) && globalThis.Number.isNaN(t)
      ? 0
      : globalThis.Number.isNaN(e)
        ? -1
        : globalThis.Number.isNaN(t)
          ? 1
          : e < t
            ? -1
            : 1,
  ),
  Qn = r(2, (e, t) => Yn((n, r) => e(t(n), t(r)))),
  $n = (e) => r(2, (t, n) => e(t, n) === -1),
  er = (e) => r(2, (t, n) => e(t, n) === 1),
  tr = (e) => r(2, (t, n) => e(t, n) !== 1),
  nr = (e) => r(2, (t, n) => e(t, n) !== -1),
  A = () => Fn,
  j = Ln,
  rr = Mn,
  M = Nn,
  ir = Pn,
  ar = r(2, (e, { onNone: t, onSome: n }) => (M(e) ? t() : n(e.value))),
  or = r(2, (e, t) => (M(e) ? t() : e.value)),
  sr = r(2, (e, t) => (M(e) ? t() : e)),
  cr = (e) => (e == null ? A() : j(e)),
  lr = (e) => (e === void 0 ? A() : j(e)),
  ur = or(c),
  dr = or(l),
  fr =
    (e) =>
    (...t) => {
      try {
        return j(e(...t))
      } catch {
        return A()
      }
    },
  pr = r(2, (e, t) => {
    if (ir(e)) return e.value
    throw t()
  })(() => Error(`getOrThrow called on a None`)),
  mr = r(2, (e, t) => (M(e) ? A() : j(t(e.value)))),
  hr = r(2, (e, t) => (M(e) ? A() : t(e.value))),
  gr = r(2, (e, t) => (M(e) ? A() : cr(t(e.value)))),
  _r = (e) => {
    if (Symbol.iterator in e) {
      let t = []
      for (let n of e) {
        if (M(n)) return A()
        t.push(n.value)
      }
      return j(t)
    }
    let t = {}
    for (let n of Object.keys(e)) {
      let r = e[n]
      if (M(r)) return A()
      C(t, n, r.value)
    }
    return j(t)
  },
  vr = (e) => (M(e) ? [] : [e.value]),
  yr = r(2, (e, t) => (M(e) ? A() : t(e.value) ? j(e.value) : A())),
  br = r(2, (e, t) => (t(e) ? j(e) : A())),
  xr = r(2, (e, t) => !M(e) && t(e.value)),
  Sr = `~effect/Context/Service`,
  Cr = function () {
    function e() {}
    let t = e
    Object.setPrototypeOf(t, wr)
    let n = (e, n) => (
      (t.key = e),
      n?.defaultValue && ((t[Er] = Er), (t.defaultValue = n.defaultValue)),
      n?.make && (t.make = n.make),
      n?.fiberCached && Tr.add(e),
      t
    )
    return arguments.length > 0 ? n(arguments[0], arguments[1]) : n
  },
  wr = {
    [Sr]: Sr,
    ...xn({
      label: `Service`,
      evaluate(e) {
        return O(N(e.context, this))
      },
    }),
    toJSON() {
      return { _id: `Service`, key: this.key }
    },
    of(e) {
      return e
    },
    context(e) {
      return Ur(this, e)
    },
    use(e) {
      return k((t) => e(N(t.context, this)))
    },
    useSync(e) {
      return k((t) => O(e(N(t.context, this))))
    },
  },
  Tr = new Set(),
  Er = `~effect/Context/Reference`,
  Dr = `~effect/Context`,
  Or = 8,
  kr = 8,
  Ar = (e, t, n, r) => {
    let i = Object.create(Lr)
    return (
      (i.cacheRoot = e ?? i),
      (i.base = t),
      (i.overlay = n),
      (i.depth = r),
      (i._flat = void 0),
      (i.baseHits = 0),
      i
    )
  },
  jr = (e, t) => {
    t && (jr(e, t.parent), e.set(t.key, t.value))
  },
  Mr = (e) => {
    if (e._flat) return e._flat
    if (!e.overlay) return (e._flat = e.base)
    let t = new Map(e.base)
    return (jr(t, e.overlay), (e._flat = t))
  },
  Nr = (e, t) => {
    let n = new Map(e.mapUnsafe)
    return (t(n), Ir(n))
  },
  Pr = Symbol(),
  Fr = (e, t) => {
    let n = e
    for (let e = n.overlay; e; e = e.parent) if (e.key === t) return e.value
    let r = n.base.get(t)
    return r === void 0 && !n.base.has(t)
      ? Pr
      : (n.overlay &&
          ++n.baseHits >= n.base.size &&
          n.baseHits >= kr &&
          ((n.base = Mr(n)), (n.overlay = void 0), (n.depth = 0)),
        r)
  },
  Ir = (e) => Ar(void 0, e, void 0, 0),
  Lr = {
    get mapUnsafe() {
      return Mr(this)
    },
    ...Ft,
    [Dr]: { _Services: (e) => e },
    toJSON() {
      return {
        _id: `Context`,
        services: Array.from(this.mapUnsafe).map(([e, t]) => ({ key: e, value: t })),
      }
    },
    [b](e) {
      if (!zr(e)) return !1
      let t = this.mapUnsafe,
        n = e.mapUnsafe
      if (t.size !== n.size) return !1
      for (let [e, r] of t) if (!n.has(e) || !x(r, n.get(e))) return !1
      return !0
    },
    [g]() {
      return Oe(this.mapUnsafe.size)
    },
  },
  Rr = (e, t) => e.cacheRoot === t.cacheRoot,
  zr = (e) => h(e, Dr),
  Br = (e) => !!e[Er],
  Vr = () => Hr,
  Hr = Ir(new Map()),
  Ur = (e, t) => Ir(new Map([[e.key, t]])),
  Wr = r(3, (e, t, n) => Gr(e, t.key, n)),
  Gr = (e, t, n) => {
    let r = e,
      i = Tr.has(t) ? void 0 : r.cacheRoot
    if (r.depth >= Or) {
      let e = new Map(r.mapUnsafe)
      return (e.set(t, n), Ar(i, e, void 0, 0))
    }
    return Ar(i, r.base, { key: t, value: n, parent: r.overlay }, r.depth + 1)
  },
  Kr = r(2, (e, t) => qr(e, t.key)),
  qr = (e, t) => {
    let n = Fr(e, t)
    return n === Pr ? void 0 : n
  },
  Jr = r(2, (e, t) => {
    let n = Fr(e, t.key)
    if (n === Pr) {
      if (Br(t)) return Xr(t)
      throw Zr(t)
    }
    return n
  }),
  N = Jr,
  Yr = `~effect/Context/defaultValue`,
  Xr = (e) => (Yr in e ? e[Yr] : (e[Yr] = e.defaultValue())),
  Zr = (e) => {
    let t = Error(`Service not found${e.key ? `: ${String(e.key)}` : ``}`)
    if (t.stack) {
      let e = t.stack.split(`
`)
      ;(e.splice(1, 3),
        (t.stack = e.join(`
`)))
    }
    return t
  },
  Qr = r(2, (e, t) => {
    let n = Fr(e, t.key)
    return n === Pr ? (Br(t) ? j(Xr(t)) : A()) : j(n)
  }),
  $r = r(2, (e, t) =>
    e.mapUnsafe.size === 0
      ? t
      : t.mapUnsafe.size === 0
        ? e
        : Nr(e, (e) => t.mapUnsafe.forEach((t, n) => e.set(n, t))),
  ),
  ei = (...e) => {
    let t = new Map()
    for (let n = 0; n < e.length; n++)
      e[n].mapUnsafe.forEach((e, n) => {
        t.set(n, e)
      })
    return Ir(t)
  },
  P = Cr,
  ti = (e) => e.length > 0,
  ni = (e) => (e > 0 ? Math.floor(e) : 0),
  ri = (e) => Math.max(1, ni(e)),
  ii = Jn,
  ai = Kn,
  oi = ai(void 0),
  si = (e) => {
    if (ue(e))
      try {
        return ii(e())
      } catch (e) {
        return ai(e)
      }
    try {
      return ii(e.try())
    } catch (t) {
      return ai(e.catch(t))
    }
  },
  ci = Hn,
  li = Un,
  ui = Wn,
  di = r(2, (e, { onFailure: t, onSuccess: n }) => (li(e) ? t(e.failure) : n(e.success))),
  fi = (...e) => e,
  pi = Tn,
  mi = (e) => {
    let t = e[Symbol.iterator]().next()
    if (t.done) throw Error(`headUnsafe: empty iterable`)
    return t.value
  },
  hi = r(2, (e, t) => {
    let n = 0
    for (let r of e) {
      let e = t(r, n)
      if (se(e)) {
        if (e) return j(r)
      } else if (ir(e)) return e
      n++
    }
    return A()
  }),
  gi = Object.fromEntries,
  _i = r(2, (e, t) => {
    let n = []
    for (let r of Si(e)) n.push(t(r, e[r]))
    return n
  }),
  vi = _i((e, t) => [e, t]),
  yi = r(2, (e, t) => Object.hasOwn(e, t)),
  bi = r(2, (e, t) => (Object.hasOwn(e, t) ? j(e[t]) : A())),
  xi = r(2, (e, t) => {
    let n = { ...e }
    for (let r of Si(e)) C(n, r, t(e[r], r))
    return n
  }),
  Si = (e) => Object.keys(e),
  Ci = (e) => _i(e, (e, t) => t),
  wi = (e) =>
    r(2, (t, n) => {
      for (let r of Si(t)) if (!yi(n, r) || !e(t[r], n[r])) return !1
      return !0
    }),
  Ti = (e) => {
    let t = wi(e)
    return (e, n) => t(e, n) && t(n, e)
  },
  Ei = globalThis.Array,
  Di = r(2, (e, t) => {
    let n = ri(e),
      r = new Ei(n)
    for (let e = 0; e < n; e++) r[e] = t(e)
    return r
  }),
  Oi = (e, t) => (e <= t ? Di(t - e + 1, (t) => e + t) : [e]),
  F = (e) => (Ei.isArray(e) ? e : Ei.from(e)),
  ki = (e) => (Ei.isArray(e) ? e : [e]),
  Ai = r(2, (e, { onEmpty: t, onNonEmpty: n }) => (Li(e) ? n(e) : t())),
  ji = r(2, (e, { onEmpty: t, onNonEmpty: n }) => (Li(e) ? n(Wi(e), qi(e)) : t())),
  Mi = r(2, (e, t) => [...e, t]),
  Ni = r(2, (e, t) => F(e).concat(F(t))),
  Pi = Ei.isArray,
  Fi = (e) => e.length === 0,
  Ii = ti,
  Li = ti,
  Ri = (e) => e.length
function zi(e, t) {
  return !Number.isFinite(e) || e < 0 || e >= t.length
}
var Bi = r(2, (e, t) => {
    let n = Math.floor(t)
    return zi(n, e) ? A() : j(e[n])
  }),
  Vi = r(2, (e, t) => {
    let n = Math.floor(t)
    if (zi(n, e)) throw Error(`Index out of bounds: ${n}`)
    return e[n]
  }),
  Hi = (e) => [Ji(e), Ki(e)],
  Ui = Bi(0),
  Wi = Vi(0),
  Gi = (e) => (Li(e) ? j(Ki(e)) : A()),
  Ki = (e) => e[e.length - 1],
  qi = (e) => e.slice(1),
  Ji = (e) => e.slice(0, -1),
  Yi = (e, t) => Math.min(ni(e), t),
  Xi = r(2, (e, t) => {
    let n = F(e)
    return n.slice(0, Yi(t, n.length))
  }),
  Zi = r(2, (e, t) => {
    let n = F(e)
    return n.slice(Yi(t, n.length), n.length)
  }),
  Qi = r(2, (e, t) => {
    let n = F(e),
      r = 0
    for (; r < n.length && t(n[r], r);) r++
    return n.slice(r)
  }),
  $i = r(2, (e, t) => {
    let n = 0
    for (let r of e) {
      if (t(r, n)) return j(n)
      n++
    }
    return A()
  }),
  ea = hi,
  ta = r(3, (e, t, n) => {
    let r = Ei.from(e),
      i = Math.floor(t)
    if (zi(i, r)) return A()
    let a = r
    return ((a[i] = n(r[i])), j(a))
  }),
  na = (e) => Ei.from(e).reverse(),
  ra = r(2, (e, t) => ia(e, t, fi)),
  ia = r(3, (e, t, n) => {
    let r = F(e),
      i = F(t)
    if (Li(r) && Li(i)) {
      let e = [n(Wi(r), Wi(i))],
        t = Math.min(r.length, i.length)
      for (let a = 1; a < t; a++) e[a] = n(r[a], i[a])
      return e
    }
    return []
  }),
  aa = r(2, (e, t) => Mi(Ji(e), t(Ki(e)))),
  oa = ((e) =>
    r(2, (t, n) => {
      for (let r of t) if (e(n, r)) return !0
      return !1
    }))(nt()),
  sa = (e, t) => {
    let n = _(t),
      r = e.get(n)
    if (r === void 0) return (e.set(n, [t]), !0)
    for (let e of r) if (x(e, t)) return !1
    return (r.push(t), !0)
  },
  ca = () => [],
  la = (e) => [e],
  ua = r(2, (e, t) => e.map(t)),
  da = (e) => {
    let t = []
    for (let n of e) ir(n) && t.push(n.value)
    return t
  },
  fa = r(2, (e, t) => {
    let n = F(e),
      r = []
    for (let e = 0; e < n.length; e++) {
      let i = t(n[e], e)
      ui(i) && r.push(i.success)
    }
    return r
  }),
  pa = r(2, (e, t) => {
    let n = F(e),
      r = []
    for (let e = 0; e < n.length; e++) t(n[e], e) && r.push(n[e])
    return r
  }),
  ma = r(3, (e, t, n) => F(e).reduce((e, t, r) => n(e, t, r), t)),
  ha = r(2, (e, t) => e.every(t)),
  ga = r(2, (e, t) => e.some(t)),
  _a = (e, t) => {
    let n = [],
      r = e
    for (;;) {
      let e = t(r)
      if (M(e)) break
      let [i, a] = e.value
      ;(n.push(i), (r = a))
    }
    return n
  },
  va = En,
  ya = r(2, (e, t) => F(e).forEach((e, n) => t(e, n))),
  ba = (e) => {
    let t = F(e)
    if (t.length < 2) return [...t]
    let n = new Map(),
      r = []
    for (let e of t) sa(n, e) && r.push(e)
    return r
  },
  xa = r(2, (e, t) => F(e).join(t)),
  Sa = `~effect/Duration`,
  Ca = BigInt(0),
  wa = BigInt(1),
  Ta = BigInt(2),
  Ea = BigInt(10),
  Da = BigInt(1e3),
  Oa = (e) => BigInt(e < 0 ? Math.ceil(e - 0.5) : Math.floor(e + 0.5)),
  ka = (e) => Oa(e * 1e6),
  Aa = (e, t) => {
    let n = e.indexOf(`.`)
    if (n === -1) return BigInt(e) * t
    let r = e[0] === `-`,
      i = e.slice(n + 1),
      a = Ea ** BigInt(i.length),
      o = (BigInt(e.slice(+!!r, n)) * a + BigInt(i)) * t,
      s = o / a + ((o % a) * Ta >= a ? wa : Ca)
    return r ? -s : s
  },
  ja = /^(-?\d+(?:\.\d+)?)\s+(nanos?|micros?|millis?|seconds?|minutes?|hours?|days?|weeks?)$/,
  Ma = (e) => {
    switch (typeof e) {
      case `number`:
        return Wa(e)
      case `bigint`:
        return Ua(e)
      case `string`: {
        if (e === `Infinity`) return Va
        if (e === `-Infinity`) return Ha
        let t = ja.exec(e)
        if (!t) break
        let [n, r, i] = t
        if (i === `nano` || i === `nanos`) return Ua(Aa(r, wa))
        if (i === `micro` || i === `micros`) return Ua(Aa(r, Da))
        let a = Number(r)
        switch (i) {
          case `milli`:
          case `millis`:
            return Wa(a)
          case `second`:
          case `seconds`:
            return Ga(a)
          case `minute`:
          case `minutes`:
            return Ka(a)
          case `hour`:
          case `hours`:
            return qa(a)
          case `day`:
          case `days`:
            return Ja(a)
          case `week`:
          case `weeks`:
            return Ya(a)
        }
        break
      }
      case `object`: {
        if (e === null) break
        if (Sa in e) return e
        if (Array.isArray(e))
          return e.length !== 2 || !e.every(oe)
            ? Na(e)
            : Number.isNaN(e[0]) || Number.isNaN(e[1])
              ? Ba
              : e[0] === -1 / 0 || e[1] === -1 / 0
                ? Ha
                : e[0] === 1 / 0 || e[1] === 1 / 0
                  ? Va
                  : Ra(Oa(e[0] * 1e9 + e[1]))
        let t = e,
          n = 0
        return (
          t.weeks && (n += t.weeks * 6048e5),
          t.days && (n += t.days * 864e5),
          t.hours && (n += t.hours * 36e5),
          t.minutes && (n += t.minutes * 6e4),
          t.seconds && (n += t.seconds * 1e3),
          t.milliseconds && (n += t.milliseconds),
          !t.microseconds && !t.nanoseconds
            ? Ra(n)
            : Ra(Oa(n * 1e6 + (t.microseconds ?? 0) * 1e3 + (t.nanoseconds ?? 0)))
        )
      }
    }
    return Na(e)
  },
  Na = (e) => {
    throw Error(`Invalid Input: ${e}`)
  },
  Pa = { _tag: `Millis`, millis: 0 },
  Fa = { _tag: `Infinity` },
  Ia = { _tag: `NegativeInfinity` },
  La = {
    [Sa]: Sa,
    [g]() {
      switch (this.value._tag) {
        case `Millis`: {
          let e = this.value.millis * 1e6
          return Number.isFinite(e) ? _(Oa(e)) : Oe(this.value.millis)
        }
        case `Nanos`:
          return _(this.value.nanos)
        default:
          return Ae(this.value)
      }
    },
    [b](e) {
      return za(e) && to(this, e)
    },
    toString() {
      switch (this.value._tag) {
        case `Infinity`:
          return `Infinity`
        case `NegativeInfinity`:
          return `-Infinity`
        case `Nanos`:
          return `${this.value.nanos} nanos`
        case `Millis`:
          return `${this.value.millis} millis`
      }
    },
    toJSON() {
      switch (this.value._tag) {
        case `Millis`:
          return { _id: `Duration`, _tag: `Millis`, millis: this.value.millis }
        case `Nanos`:
          return { _id: `Duration`, _tag: `Nanos`, nanos: String(this.value.nanos) }
        case `Infinity`:
          return { _id: `Duration`, _tag: `Infinity` }
        case `NegativeInfinity`:
          return { _id: `Duration`, _tag: `NegativeInfinity` }
      }
    },
    [_t]() {
      return this.toJSON()
    },
    pipe() {
      return e(this, arguments)
    },
  },
  Ra = (e) => {
    let t = Object.create(La)
    return (
      (t.value =
        typeof e == `number`
          ? isNaN(e) || e === 0 || Object.is(e, -0)
            ? Pa
            : Number.isFinite(e)
              ? Number.isInteger(e)
                ? { _tag: `Millis`, millis: e }
                : { _tag: `Nanos`, nanos: ka(e) }
              : e > 0
                ? Fa
                : Ia
          : e === Ca
            ? Pa
            : { _tag: `Nanos`, nanos: e }),
      t
    )
  },
  za = (e) => h(e, Sa),
  Ba = Ra(0),
  Va = Ra(1 / 0),
  Ha = Ra(-1 / 0),
  Ua = (e) => Ra(e),
  Wa = (e) => Ra(e),
  Ga = (e) => Ra(e * 1e3),
  Ka = (e) => Ra(e * 6e4),
  qa = (e) => Ra(e * 36e5),
  Ja = (e) => Ra(e * 864e5),
  Ya = (e) => Ra(e * 6048e5),
  Xa = (e) =>
    Qa(Ma(e), {
      onMillis: i,
      onNanos: (e) => Number(e) / 1e6,
      onInfinity: () => 1 / 0,
      onNegativeInfinity: () => -1 / 0,
    }),
  Za = (e) => {
    let t = Ma(e)
    switch (t.value._tag) {
      case `Infinity`:
      case `NegativeInfinity`:
        throw Error(`Cannot convert infinite duration to nanos`)
      case `Nanos`:
        return t.value.nanos
      case `Millis`:
        return ka(t.value.millis)
    }
  },
  Qa = r(2, (e, t) => {
    switch (e.value._tag) {
      case `Millis`:
        return t.onMillis(e.value.millis)
      case `Nanos`:
        return t.onNanos(e.value.nanos)
      case `Infinity`:
        return t.onInfinity()
      case `NegativeInfinity`:
        return (t.onNegativeInfinity ?? t.onInfinity)()
    }
  }),
  $a = r(3, (e, t, n) =>
    e.value._tag === `Infinity` ||
    e.value._tag === `NegativeInfinity` ||
    t.value._tag === `Infinity` ||
    t.value._tag === `NegativeInfinity`
      ? n.onInfinity(e, t)
      : e.value._tag === `Millis`
        ? t.value._tag === `Millis`
          ? n.onMillis(e.value.millis, t.value.millis)
          : n.onNanos(Za(e), t.value.nanos)
        : n.onNanos(e.value.nanos, Za(t)),
  ),
  eo = (e, t) =>
    $a(e, t, {
      onMillis: (e, t) => e === t,
      onNanos: (e, t) => e === t,
      onInfinity: (e, t) => e.value._tag === t.value._tag,
    }),
  to = r(2, (e, t) => eo(e, t)),
  no = (e) => (t) => {
    let n = e(t)
    return li(n) ? A() : j(n.success)
  },
  ro = P(`effect/Scheduler`, { fiberCached: !0, defaultValue: () => new co() }),
  io = (e) => {
    let t = !1
    return (
      Promise.resolve().then(() => {
        t || e()
      }),
      () => {
        t = !0
      }
    )
  },
  ao =
    `setImmediate` in globalThis
      ? (e) => {
          let t = globalThis.setImmediate(e)
          return () => globalThis.clearImmediate(t)
        }
      : (e) => {
          let t = setTimeout(e, 0)
          return () => clearTimeout(t)
        },
  oo = (e) => {
    try {
      return ao(e)
    } catch {
      return io(e)
    }
  },
  so = class {
    buckets = []
    scheduleTask(e, t) {
      let n = this.buckets,
        r = n.length,
        i,
        a = 0
      for (; a < r && !(n[a][0] > t); a++) i = n[a]
      i && i[0] === t ? i[1].push(e) : a === r ? n.push([t, [e]]) : n.splice(a, 0, [t, [e]])
    }
    drain() {
      let e = this.buckets
      return ((this.buckets = []), e)
    }
  },
  co = class {
    executionMode
    setImmediate
    constructor(e = `async`, t) {
      ;((this.executionMode = e), (this.setImmediate = t ?? (e === `sync` ? io : oo)))
    }
    shouldYield(e) {
      return e.currentOpCount >= e.cache.maxOpsBeforeYield
    }
    makeDispatcher() {
      return new lo(this.setImmediate)
    }
  },
  lo = class {
    tasks = new so()
    running = void 0
    setImmediate
    constructor(e = oo) {
      this.setImmediate = e
    }
    scheduleTask(e, t) {
      ;(this.tasks.scheduleTask(e, t),
        this.running === void 0 && (this.running = this.setImmediate(this.afterScheduled)))
    }
    afterScheduled = () => {
      ;((this.running = void 0), this.runTasks())
    }
    runTasks() {
      let e = this.tasks.drain()
      for (let t = 0; t < e.length; t++) {
        let n = e[t][1]
        for (let e = 0; e < n.length; e++) n[e]()
      }
    }
    flush() {
      for (; this.tasks.buckets.length > 0;)
        (this.running !== void 0 && (this.running(), (this.running = void 0)), this.runTasks())
    }
  },
  uo = P(`effect/Scheduler/MaxOpsBeforeYield`, { fiberCached: !0, defaultValue: () => 2048 }),
  fo = P(`effect/Scheduler/PreventSchedulerYield`, { fiberCached: !0, defaultValue: () => !1 }),
  po = class extends n {
    constructor(e) {
      ;(super(), e && Dt(this, e))
    }
  },
  mo = (e) =>
    class extends po {
      _tag = e
    },
  ho = () =>
    new Proxy(
      {},
      {
        get(e, t, n) {
          return t === `$is` ? xe : t === `$match` ? go : (e) => ({ ...e, _tag: t })
        },
      },
    )
function go() {
  if (arguments.length === 1) {
    let e = arguments[0]
    return function (t) {
      return e[t._tag](t)
    }
  }
  let e = arguments[0]
  return arguments[1][e._tag](e)
}
var _o = pn,
  vo = mn,
  yo = `~effect/encoding/EncodingError`,
  bo = class extends vo(`EncodingError`) {
    [yo] = yo
  },
  xo = (e) => {
    switch (e) {
      case 16:
        return wo()
      case 32:
        return To()
      default: {
        let t = ``
        for (let n = e >>> 3; n > 0; n--) t += Co()
        return t
      }
    }
  },
  I = Uint8Array.from(`0123456789abcdef`, (e) => e.charCodeAt(0)),
  So = () => (Math.random() * 4294967296) >>> 0,
  Co = () => {
    let e = So()
    return String.fromCharCode(
      I[e >>> 28],
      I[(e >>> 24) & 15],
      I[(e >>> 20) & 15],
      I[(e >>> 16) & 15],
      I[(e >>> 12) & 15],
      I[(e >>> 8) & 15],
      I[(e >>> 4) & 15],
      I[e & 15],
    )
  },
  wo = () => {
    let e = So(),
      t = So()
    return String.fromCharCode(
      I[e >>> 28],
      I[(e >>> 24) & 15],
      I[(e >>> 20) & 15],
      I[(e >>> 16) & 15],
      I[(e >>> 12) & 15],
      I[(e >>> 8) & 15],
      I[(e >>> 4) & 15],
      I[e & 15],
      I[t >>> 28],
      I[(t >>> 24) & 15],
      I[(t >>> 20) & 15],
      I[(t >>> 16) & 15],
      I[(t >>> 12) & 15],
      I[(t >>> 8) & 15],
      I[(t >>> 4) & 15],
      I[t & 15],
    )
  },
  To = () => {
    let e = So(),
      t = So(),
      n = So(),
      r = So()
    return String.fromCharCode(
      I[e >>> 28],
      I[(e >>> 24) & 15],
      I[(e >>> 20) & 15],
      I[(e >>> 16) & 15],
      I[(e >>> 12) & 15],
      I[(e >>> 8) & 15],
      I[(e >>> 4) & 15],
      I[e & 15],
      I[t >>> 28],
      I[(t >>> 24) & 15],
      I[(t >>> 20) & 15],
      I[(t >>> 16) & 15],
      I[(t >>> 12) & 15],
      I[(t >>> 8) & 15],
      I[(t >>> 4) & 15],
      I[t & 15],
      I[n >>> 28],
      I[(n >>> 24) & 15],
      I[(n >>> 20) & 15],
      I[(n >>> 16) & 15],
      I[(n >>> 12) & 15],
      I[(n >>> 8) & 15],
      I[(n >>> 4) & 15],
      I[n & 15],
      I[r >>> 28],
      I[(r >>> 24) & 15],
      I[(r >>> 20) & 15],
      I[(r >>> 16) & 15],
      I[(r >>> 12) & 15],
      I[(r >>> 8) & 15],
      I[(r >>> 4) & 15],
      I[r & 15],
    )
  },
  Eo = `effect/Tracer/ParentSpan`,
  Do = class extends Cr()(Eo, { fiberCached: !0 }) {},
  Oo = (e) => e,
  ko = P(`effect/Tracer/DisablePropagation`, { defaultValue: s }),
  Ao = P(`effect/Tracer/CurrentTraceLevel`, { defaultValue: () => `Info` }),
  jo = P(`effect/Tracer/MinimumTraceLevel`, { defaultValue: () => `All` }),
  Mo = `effect/Tracer`,
  No = Oo({ span: (e) => new Po(e) }),
  Po = class {
    _tag = `Span`
    sampled
    name
    parent
    annotations
    links
    startTime
    kind
    status
    _traceId = void 0
    _spanId = void 0
    _attributes = void 0
    _events = void 0
    constructor(e) {
      ;((this.name = e.name),
        (this.parent = e.parent),
        (this.annotations = e.annotations),
        (this.links = e.links),
        (this.startTime = e.startTime),
        (this.kind = e.kind),
        (this.sampled = e.sampled),
        (this.status = { _tag: `Started`, startTime: e.startTime }))
    }
    get traceId() {
      return (this._traceId ??= dr(this.parent)?.traceId ?? xo(32))
    }
    get spanId() {
      return (this._spanId ??= xo(16))
    }
    get attributes() {
      return (this._attributes ??= new Map())
    }
    get events() {
      return (this._events ??= [])
    }
    end(e, t) {
      this.status = { _tag: `Ended`, endTime: e, exit: t, startTime: this.status.startTime }
    }
    attribute(e, t) {
      this.attributes.set(e, t)
    }
    event(e, t, n) {
      this.events.push([e, t, n ?? {}])
    }
    addLinks(e) {
      this.links.push(...e)
    }
  },
  Fo = `effect/Metric/FiberRuntimeMetrics`,
  Io = P(`effect/References/CurrentStackFrame`, { fiberCached: !0, defaultValue: l }),
  Lo = P(`effect/References/TracerEnabled`, { fiberCached: !0, defaultValue: o }),
  Ro = P(`effect/References/TracerTimingEnabled`, { defaultValue: o }),
  zo = P(`effect/References/TracerSpanAnnotations`, { defaultValue: () => ({}) }),
  Bo = P(`effect/References/TracerSpanLinks`, { defaultValue: () => [] }),
  Vo = P(`effect/References/CurrentLogAnnotations`, { defaultValue: () => ({}) }),
  Ho = P(`effect/References/CurrentLogLevel`, { fiberCached: !0, defaultValue: () => `Info` }),
  Uo = P(`effect/References/MinimumLogLevel`, { fiberCached: !0, defaultValue: () => `Info` }),
  Wo = P(`effect/References/CurrentLogSpans`, { defaultValue: () => [] }),
  Go = (e) => {
    if (
      e?.captureStackTrace === !1 ||
      (e?.captureStackTrace !== void 0 && typeof e.captureStackTrace != `boolean`)
    )
      return e
    let t = Ct()
    if (t === 0 && e?.captureStackTrace !== !0) return { ...e, captureStackTrace: !1 }
    wt(3)
    let n = Error()
    return (wt(t), { ...e, captureStackTrace: Ko(() => n.stack) })
  },
  Ko = ((e) => (t) => {
    let n
    return () => {
      if (n !== void 0) return n
      let r = t()
      if (!r) return
      let i = r.split(`
`)
      if (i[e] !== void 0) return ((n = i[e].trim()), n)
    }
  })(3),
  qo = class extends Wt {
    constructor(e, t = Gt) {
      ;(super(`Interrupt`, t, `Interrupted`), (this.fiberId = e))
    }
    toString() {
      return `Interrupt(${this.fiberId})`
    }
    toJSON() {
      return { _tag: `Interrupt`, fiberId: this.fiberId }
    }
    [b](e) {
      return tn(e) && this.fiberId === e.fiberId && this.annotations === e.annotations
    }
    [g]() {
      return v(y(`${this._tag}:${this.fiberId}`))(we(this.annotations))
    }
  },
  Jo = (e) => new qo(e),
  Yo = (e) => new Ht([new qo(e)]),
  Xo = (e) => {
    let t = e.reasons.find($t)
    return t ? ii(t) : ai(e)
  },
  Zo = (e) => {
    for (let t = 0; t < e.reasons.length; t++) {
      let n = e.reasons[t]
      if (n._tag === `Fail`) return ii(n.error)
    }
    return ai(e)
  },
  Qo = no(Zo),
  $o = (e) => e.reasons.some(tn),
  es = (e) => {
    let t
    for (let n = 0; n < e.reasons.length; n++) {
      let r = e.reasons[n]
      r._tag === `Interrupt` && ((t ??= new Set()), r.fiberId !== void 0 && t.add(r.fiberId))
    }
    return t ? ii(t) : ai(e)
  },
  ts = (e) => e.reasons.length > 0 && e.reasons.every(tn),
  ns = (e, t) => {
    let n = new Map(),
      r = []
    for (let i of e.concat(t)) {
      let e = _(i),
        t = n.get(e)
      if (t === void 0) n.set(e, [i])
      else if (t.some((e) => x(e, i))) continue
      else t.push(i)
      r.push(i)
    }
    return r
  },
  rs = r(2, (e, t) => {
    if (e.reasons.length === 0) return t
    if (t.reasons.length === 0) return e
    let n = new Ht(ns(e.reasons, t.reasons))
    return x(e, n) ? e : n
  }),
  is = r(2, (e, t) => {
    let n = !1,
      r = e.reasons.map((e) => ($t(e) ? ((n = !0), new Kt(t(e.error), e.annotations)) : e))
    return n ? qt(r) : e
  }),
  as = (e) => {
    let t
    for (let n of e.reasons) {
      if (n._tag === `Fail`) return n.error
      n._tag === `Die` && (t ??= n)
    }
    return t === void 0
      ? e.reasons.length > 0
        ? new globalThis.Error(`All fibers interrupted without error`)
        : new globalThis.Error(`Empty cause`)
      : t.defect
  },
  os = (e, t) => {
    let n = [],
      r = []
    if (e.reasons.length === 0) return n
    let i = Ct()
    i !== 0 && wt(1)
    try {
      for (let i of e.reasons) {
        if (i._tag === `Interrupt`) {
          r.push(i)
          continue
        }
        n.push(ss(i._tag === `Die` ? i.defect : i.error, i.annotations, t))
      }
      if (n.length === 0) {
        let e = Error(`The fiber was interrupted by:`)
        ;((e.name = `InterruptCause`), (e.stack = fs(e, r)))
        let i = new globalThis.Error(`All fibers interrupted without error`, { cause: e })
        ;((i.name = `InterruptError`),
          (i.stack = `${i.name}: ${i.message}`),
          n.push(ss(i, r[0].annotations, t)))
      }
    } finally {
      i !== 0 && wt(i)
    }
    return n
  },
  ss = (e, t, n) => {
    let r = typeof e,
      i
    if (e && r === `object`) {
      if (
        ((i = new globalThis.Error(cs(e), { cause: e.cause ? ss(e.cause) : void 0 })),
        typeof e.name == `string` && (i.name = e.name),
        typeof e.stack == `string`)
      )
        i.stack = us(e.stack, i, t)
      else {
        let e = `${i.name}: ${i.message}`
        i.stack = t ? ds(e, t) : e
      }
      n?.includeCauseInStack && (i.stack = hs(i))
      for (let t of Object.keys(e)) t in i || (i[t] = e[t])
    } else i = new globalThis.Error(e ? (r === `string` ? e : gt(e)) : `Unknown error: ${e}`)
    return i
  },
  cs = (e) => {
    if (typeof e.message == `string`) return e.message
    if (
      typeof e.toString == `function` &&
      e.toString !== Object.prototype.toString &&
      e.toString !== Array.prototype.toString
    )
      try {
        return e.toString()
      } catch {}
    return gt(e)
  },
  ls = /\((.*)\)/g,
  us = (e, t, n) => {
    let r = `${t.name}: ${t.message}`,
      i = (e.startsWith(r) ? e.slice(r.length) : e).split(`
`),
      a = [r]
    for (let e = 1; e < i.length && !/Generator\.next|~effect\/(?:Effect|Utils)/.test(i[e]); e++)
      a.push(i[e])
    return n
      ? ds(
          a.join(`
`),
          n,
        )
      : a.join(`
`)
  },
  ds = (e, t) => {
    let n = t?.get(sn.key)
    return (n && (e = `${e}\n${ps(n)}`), e)
  },
  fs = (e, t) => {
    let n = [`${e.name}: ${e.message}`]
    for (let e of t) {
      let t = e.fiberId === void 0 ? `unknown` : `#${e.fiberId}`,
        r = e.annotations.get(cn.key)
      ;(n.push(`    at fiber (${t})`), r && n.push(ps(r)))
    }
    return n.join(`
`)
  },
  ps = (e) => {
    let t = [],
      n = e,
      r = 0
    for (; n && r < 10;) {
      let e = n.stack()
      if (e) {
        let r = e.matchAll(ls),
          i = !1
        for (let [, e] of r) ((i = !0), t.push(`    at ${n.name} (${e})`))
        i || t.push(`    at ${n.name} (${e.replace(/^at /, ``)})`)
      } else t.push(`    at ${n.name}`)
      ;((n = n.parent), r++)
    }
    return t.join(`
`)
  },
  ms = (e) =>
    os(e).map(hs).join(`
`),
  hs = (e) => (e.cause ? `${e.stack} {\n${gs(e.cause, `  `)}\n}` : e.stack),
  gs = (e, t) => {
    let n = e.stack.split(`
`),
      r = `${t}[cause]: ${n[0]}`
    for (let e = 1, i = n.length; e < i; e++) r += `\n${t}${n[e]}`
    return (e.cause && (r += ` {\n${gs(e.cause, `${t}  `)}\n${t}}`), r)
  },
  _s = `~effect/Fiber`,
  vs = { _A: i, _E: i },
  ys = { id: 0 },
  bs = () => globalThis[st],
  xs = class {
    constructor(e, t = !0) {
      ;(this.setContext(e),
        (this.id = ++ys.id),
        (this.currentOpCount = 0),
        (this.interruptible = t),
        (this._stack = []),
        (this._observers = void 0),
        (this._exit = void 0),
        (this._children = void 0),
        (this._interruptedCause = void 0),
        (this._yielded = void 0),
        (this._running = !1),
        (this._deferredInterrupt = !1),
        (this._parent = void 0),
        this.cache.runtimeMetrics?.recordFiberStart(this.context))
    }
    get [_s]() {
      return vs
    }
    get currentDispatcher() {
      return (this._dispatcher ??= this.cache.scheduler.makeDispatcher())
    }
    getRef(e) {
      return N(this.context, e)
    }
    addObserver(e) {
      return this._exit
        ? (e(this._exit), u)
        : (this._observers === void 0 ? (this._observers = [e]) : this._observers.push(e),
          () => this.removeObserver(e))
    }
    removeObserver(e) {
      if (this._exit || this._observers === void 0) return
      let t = this._observers.indexOf(e)
      t >= 0 && this._observers.splice(t, 1)
    }
    interruptUnsafe(e, t) {
      if (this._exit) return
      let n = Yo(e)
      ;(this.cache.stackFrame && (n = Qt(n, Ur(sn, this.cache.stackFrame))),
        t && (n = Qt(n, t)),
        (this._interruptedCause = this._interruptedCause ? rs(this._interruptedCause, n) : n),
        this.interruptible &&
          (this._running
            ? (this._deferredInterrupt = !0)
            : this.evaluate(R(this._interruptedCause))))
    }
    pollUnsafe() {
      return this._exit
    }
    evaluate(e) {
      if (this._exit) return
      if (this._yielded !== void 0) {
        let e = this._yielded
        ;((this._yielded = void 0), e())
      }
      let t = this.runLoop(e)
      if (t === Pt) return
      let n = Ts.interruptChildren && Ts.interruptChildren(this)
      if (n !== void 0) return this.evaluate(H(n, () => t))
      if (
        ((this._exit = t),
        this.cache.runtimeMetrics?.recordFiberEnd(this.context, this._exit),
        (this._parent &&= (this._parent._children?.delete(this), void 0)),
        this._observers !== void 0)
      ) {
        let e = this._observers
        this._observers = void 0
        for (let n = 0; n < e.length; n++) e[n](t)
      }
      ;((this._stack.length = 0), (this._children = void 0), (this.context = Vr()))
    }
    runLoop(e) {
      let t = globalThis[st]
      globalThis[st] = this
      let n = this._running
      this._running = !0
      let r = !1,
        i = e
      this.currentOpCount = 0
      try {
        for (;;) {
          ;(this._deferredInterrupt &&
            ((this._deferredInterrupt = !1), (i = R(this._interruptedCause))),
            this.currentOpCount++)
          let e = this.cache
          if (!r && !e.preventYield && e.scheduler.shouldYield(this)) {
            r = !0
            let e = i
            i = H(Is, () => e)
          }
          if (((i = e.tracerContext ? e.tracerContext(i, this) : i[T](this)), i === Pt)) {
            let e = this._yielded
            if (kt in e) return ((this._deferredInterrupt = !1), (this._yielded = void 0), e)
            if (this._deferredInterrupt) {
              ;((this._yielded = void 0), e())
              continue
            }
            return Pt
          }
        }
      } catch (e) {
        return h(i, T) ? this.runLoop(dn(e)) : dn(`Fiber.runLoop: Not a valid effect: ${String(i)}`)
      } finally {
        ;((this._running = n), (globalThis[st] = t))
      }
    }
    getCont(e) {
      if (this._deferredInterrupt) return ((this._deferredInterrupt = !1), Cs)
      for (;;) {
        let t = this._stack.pop()
        if (!t) return
        let n = t[Nt]
        if (n !== void 0) {
          let r = n.call(t, this)
          if (r) return ((r[e] = r), r)
        }
        if (t[e]) return t
      }
    }
    succeedWith(e) {
      if (!(++this.currentOpCount & (ws - 1))) return O(e)
      let t = this.getCont(E)
      return t ? t[E](e, this) : this.yieldWith(O(e))
    }
    yieldWith(e) {
      return ((this._yielded = e), Pt)
    }
    children() {
      return (this._children ??= new Set())
    }
    pipe() {
      return e(this, arguments)
    }
    setContext(e) {
      let t = this.context
      if (((this.context = e), t !== void 0 && Rr(t, e))) return
      let n = e.cacheRoot,
        r = (n._fiberCache ??= Ss(e))
      ;(this.cache?.scheduler !== r.scheduler && (this._dispatcher = void 0), (this.cache = r))
    }
    get currentSpanLocal() {
      let e = this.cache.span
      return e?._tag === `Span` ? e : void 0
    }
  },
  Ss = (e) => {
    let t = qr(e, Mo)
    return {
      scheduler: N(e, ro),
      tracer: t,
      tracerContext: t ? t.context : void 0,
      tracerEnabled: N(e, Lo),
      span: qr(e, Eo),
      logLevel: N(e, Ho),
      minimumLogLevel: N(e, Uo),
      stackFrame: N(e, Io),
      runtimeMetrics: qr(e, Fo),
      maxOpsBeforeYield: N(e, uo),
      preventYield: N(e, fo),
    }
  },
  Cs = {
    [E](e, t) {
      return R(t._interruptedCause)
    },
    [Mt](e, t) {
      return R(t._interruptedCause)
    },
  },
  ws = 32,
  Ts = { interruptChildren: void 0 },
  Es = (e) => {
    if (!e.cache.stackFrame) return
    let t = new Map()
    return (t.set(cn.key, e.cache.stackFrame), Ir(t))
  },
  Ds = (e) => {
    if (e._children !== void 0 && e._children.size !== 0) return Ns(e._children)
  },
  Os = (e) => {
    let t = e
    return t._exit
      ? L(t._exit)
      : Js((n) => (t._exit ? n(L(t._exit)) : z(e.addObserver((e) => n(L(e))))))
  },
  ks = (e) =>
    Js((t) => {
      let n = e[Symbol.iterator](),
        r = [],
        i
      function a() {
        let e = n.next()
        for (; !e.done;) {
          if (e.value._exit) {
            ;(r.push(e.value._exit), (e = n.next()))
            continue
          }
          i = e.value.addObserver((e) => {
            ;(r.push(e), a())
          })
          return
        }
        t(L(r))
      }
      return (a(), z(() => i?.()))
    }),
  As = (e) => {
    let t = e
    return t._exit ? t._exit : Js((n) => (t._exit ? n(t._exit) : z(e.addObserver(n))))
  },
  js = (e) => k((t) => Ms(e, t.id)),
  Ms = r(
    (e) => h(e[0], _s),
    (e, t, n) =>
      k((r) => {
        let i = Es(r)
        return ((i = i && n ? $r(i, n) : (i ?? n)), e.interruptUnsafe(t, i), _c(Os(e)))
      }),
  ),
  Ns = (e) =>
    k((t) => {
      let n = Es(t),
        r = ca()
      for (let i of e) (i.interruptUnsafe(t.id, n), r.push(i))
      return _c(ks(r))
    }),
  L = O,
  R = ln,
  Ps = un,
  z = an({
    op: `Sync`,
    [T](e) {
      let t = this[w](),
        n = e.getCont(E)
      return n ? n[E](t, e) : e.yieldWith(O(t))
    },
  }),
  B = an({
    op: `Suspend`,
    [T](e) {
      return this[w]()
    },
  }),
  Fs = di({ onFailure: Ps, onSuccess: L }),
  Is = an({
    op: `Yield`,
    [T](e) {
      let t = !1
      return (
        e.currentDispatcher.scheduleTask(() => {
          t || e.evaluate(jc)
        }, this[w] ?? 0),
        e.yieldWith(() => {
          t = !0
        })
      )
    },
  })(0),
  Ls = (e) => L(j(e)),
  Rs = L(A()),
  zs = (e) => B(() => R(e())),
  Bs = (e) => dn(e),
  Vs = (e) => B(() => Ps(e())),
  V = L(void 0),
  Hs = (e) => {
    let t = typeof e == `function` ? e : e.try,
      n = typeof e == `function` ? (e) => new fd(e, `An error occurred in Effect.try`) : e.catch
    return B(() => {
      try {
        return L(t())
      } catch (e) {
        return Ps(n(e))
      }
    })
  },
  Us = (e) =>
    Ks(function (t, n) {
      e(n).then(
        (e) => t(L(e)),
        (e) => t(Bs(e)),
      )
    }, e.length !== 0),
  Ws = (e) => {
    let t = typeof e == `function` ? e : e.try,
      n =
        typeof e == `function`
          ? (e) => new fd(e, `An error occurred in Effect.tryPromise`)
          : e.catch
    return Ks(function (e, r) {
      let i = (t) => {
        try {
          e(Ps(Et(() => n(t))))
        } catch (t) {
          e(Bs(t))
        }
      }
      try {
        t(r).then((t) => e(L(t)), i)
      } catch (e) {
        i(e)
      }
    }, t.length !== 0)
  },
  Gs = (e) => k((t) => e(t.id)),
  Ks = (function () {
    let e = rn({
        op: `Async`,
        [T](e) {
          let t = !1,
            n = !1,
            r = this.withSignal ? new AbortController() : void 0,
            i = this.register.call(
              e.cache.scheduler,
              (r) => {
                t || ((t = !0), n ? e.evaluate(r) : (n = r))
              },
              r?.signal,
            )
          return n === !1
            ? ((n = !0),
              (e._yielded = () => {
                t = !0
              }),
              (r === void 0 && i === void 0) ||
                e._stack.push(qs(() => ((t = !0), r?.abort(), i ?? jc))),
              Pt)
            : n
        },
      }),
      t = function (e, t) {
        ;((this.register = e), (this.withSignal = t))
      }
    return (
      (t.prototype = e),
      function (e, n) {
        return new t(e, n)
      }
    )
  })(),
  qs = an({
    op: `AsyncFinalizer`,
    [Nt](e) {
      e.interruptible && ((e.interruptible = !1), e._stack.push(au))
    },
    [Mt](e, t) {
      return $o(e) ? H(Al(ln(e), this[w]()), () => R(e)) : R(e)
    },
  }),
  Js = (e) => Ks(e, e.length >= 2),
  Ys = Js(u),
  Xs = (...e) => {
    if (e.length === 1) {
      let t = e[0]
      return B(() => tc(t()))
    }
    let [t, n] = e
    return B(() => tc(n.call(t.self)))
  },
  Zs = (e, ...t) => {
    let n =
      t.length === 0
        ? function () {
            return B(() => tc(e.apply(this, arguments)))
          }
        : function () {
            let n = B(() => tc(e.apply(this, arguments)))
            for (let e = 0; e < t.length; e++) n = t[e](n, ...arguments)
            return n
          }
    return Qs(e.length, n)
  },
  Qs = (e, t) => Object.defineProperty(t, "length", { value: e, configurable: !0 }),
  $s = (e, ...t) =>
    Qs(
      e.length,
      t.length === 0
        ? function () {
            return ec(() => e.apply(this, arguments))
          }
        : function () {
            let n = ec(() => e.apply(this, arguments))
            for (let e of t) n = e(n, ...arguments)
            return n
          },
    ),
  ec = (e) => {
    try {
      let t = e(),
        n
      for (;;) {
        let r = t.next(n)
        if (r.done) return L(r.value)
        let i = r.value
        if (i && i._tag === `Success`) {
          n = i.value
          continue
        }
        if (i && i._tag === `Failure`) return r.value
        {
          let n = !0
          return B(() => (n ? ((n = !1), H(r.value, (e) => tc(t, e))) : B(() => tc(e()))))
        }
      }
    } catch (e) {
      return Bs(e)
    }
  },
  tc = (function () {
    let e = rn({
        op: `Iterator`,
        [E](e, t) {
          let n = this.iterator
          for (;;) {
            let r = n.next(e)
            if (r.done) return L(r.value)
            if (!U(r.value)) return (t._stack.push(this), r.value)
            if (r.value._tag === `Failure`) return r.value
            e = r.value.value
          }
        },
        [T](e) {
          return this[E](this.initial, e)
        },
      }),
      t = function (e, t) {
        ;((this.iterator = e), (this.initial = t))
      }
    return (
      (t.prototype = e),
      function (e, n) {
        return new t(e, n)
      }
    )
  })(),
  nc = r(2, (e, t) => new ac(e, oc, L(t))),
  rc = function (e) {
    return (e._stack.push(this), this[w])
  },
  ic = rn({ op: `OnSuccess`, [T]: rc }),
  ac = function (e, t, n) {
    ;((this[w] = e), (this[E] = t), (this.payload = n))
  }
ac.prototype = ic
var oc = function () {
    return this.payload
  },
  sc = function (e, t) {
    return t.succeedWith(this.payload)
  },
  cc = (() => {
    let e = `~effect/Effect/stackProbe`
    return (
      {
        [e]: function () {
          return Error().stack
        },
      }
        [e]()
        ?.includes(`[as ` + e + `]`) === !0
    )
  })(),
  lc = function (e, t) {
    let n = this.payload
    return t.succeedWith(cc ? n(e) : Et(() => n(e)))
  },
  uc = function (e) {
    let t = this.payload
    return t(e)
  },
  dc = function (e) {
    let t = this.payload
    return new ac(t(e), sc, e)
  },
  fc = function (e) {
    return new ac(this.payload, sc, e)
  },
  pc = (e) => Sc(e, j),
  mc = (e) => yl(e, { onFailure: L, onSuccess: Ps }),
  hc = r(2, (e, t) => new ac(e, D(t) ? oc : uc, t)),
  gc = r(2, (e, t) => new ac(e, D(t) ? fc : dc, t)),
  _c = (e) => new ac(e, oc, jc),
  vc = (e, t) =>
    k((n) => {
      let r = new Set()
      return (
        Jl(n, () => (r.size === 0 ? void 0 : Ns(r))),
        Js((i) => {
          let a = !1,
            o = 0
          for (let s of e) {
            if (a) break
            let e = o++,
              c = xu(n, s, !0, !0, !1)
            ;(r.add(c),
              c.addObserver((o) => {
                r.delete(c)
                let s = !a
                ;((a = !0),
                  i(o),
                  s && t?.onWinner && t.onWinner({ fiber: c, index: e, parentFiber: n }))
              }))
          }
        })
      )
    }),
  yc = r(
    (e) => D(e[1]),
    (e, t, n) => vc([e, t], n),
  ),
  H = r(2, (e, t) => new ac(e, uc, t)),
  U = (e) => e[kt] !== void 0,
  bc = r(2, (e, t) => (U(e) ? (e._tag === `Success` ? t(e.value) : e) : H(e, t))),
  xc = (e) => H(e, i),
  Sc = r(2, (e, t) => new ac(e, lc, t)),
  Cc = r(2, (e, t) => (U(e) ? Mc(e, t) : Sc(e, t))),
  wc = r(2, (e, t) => (U(e) ? Nc(e, t) : ol(e, t))),
  Tc = r(2, (e, t) => (U(e) ? Pc(e, t) : sl(e, t))),
  Ec = (e) => ln(Yo(e)),
  Dc = (e) => e._tag === `Success`,
  Oc = (e) => e._tag === `Failure`,
  kc = (e) => (e._tag === `Failure` ? ii(e.cause) : ai(e)),
  Ac = (e) => e._tag === `Failure` && $o(e.cause),
  jc = O(void 0),
  Mc = r(2, (e, t) => (e._tag === `Success` ? O(t(e.value)) : e)),
  Nc = r(2, (e, t) => {
    if (e._tag === `Success`) return e
    let n = Zo(e.cause)
    return li(n) ? e : un(t(n.success))
  }),
  Pc = r(2, (e, t) => {
    if (e._tag === `Success`) return O(t.onSuccess(e.value))
    let n = Zo(e.cause)
    return li(n) ? e : un(t.onFailure(n.success))
  }),
  Fc = r(2, (e, t) => (Dc(e) ? t : e)),
  Ic = r(2, (e, t) => (Dc(e) ? t.onSuccess(e.value) : t.onFailure(e.cause))),
  Lc = (e) => {
    let t = []
    for (let n of e) n._tag === `Failure` && t.push(...n.cause.reasons)
    return t.length === 0 ? jc : ln(qt(t))
  },
  Rc = (e) => k((t) => L(Qr(t.context, e))),
  zc = r(2, (e, t) =>
    k((n) => {
      let r = n.context,
        i = t(r)
      return r === i
        ? e
        : (n.setContext(i),
          Jl(n, () => {
            n.setContext(r)
          }),
          e)
    }),
  ),
  Bc = r(3, (e, t, n) =>
    zc(e, (e) => {
      let r = Jr(e, t),
        i = n(r)
      return r === i ? e : Wr(e, t, i)
    }),
  ),
  Vc = () => Hc,
  Hc = k((e) => L(e.context)),
  Uc = (e) => k((t) => e(t.context)),
  Wc = r(2, (e, t) => (U(e) ? e : zc(e, $r(t)))),
  Gc = function () {
    return arguments.length === 1
      ? r(2, (e, t) => Kc(e, arguments[0], t))
      : r(3, (e, t, n) => Kc(e, t, n)).apply(this, arguments)
  },
  Kc = (e, t, n) => zc(e, Wr(t, n)),
  qc = r(
    (e) => D(e[1]),
    (e, t, n, r) =>
      r?.concurrent
        ? Sc(du([e, t], { concurrency: 2 }), ([e, t]) => n(e, t))
        : H(e, (e) => Sc(t, (t) => n(e, t))),
  ),
  Jc = r(2, (e, t) => H(t, (t) => (t ? pc(e) : Rs))),
  Yc = r(
    (e) => D(e[0]),
    (e, t) => fu({ while: o, body: a(t?.disableYield ? e : H(e, (e) => Is)), step: u }),
  ),
  Xc = r(2, (e, t) => new Qc(e, t.length === 1 ? t : (e) => t(e))),
  Zc = rn({ op: `OnFailure`, [T]: rc }),
  Qc = function (e, t) {
    ;((this[w] = e), (this[Mt] = t))
  }
Qc.prototype = Zc
var $c = r(3, (e, t, n) =>
    Xc(e, (e) => {
      let r = t(e)
      return li(r) ? R(r.failure) : n(r.success, e)
    }),
  ),
  el = r(2, (e, t) => $c(e, Zo, (e) => t(e))),
  tl = r(2, (e, t) => Xc(e, (e) => hc(t(e), R(e)))),
  nl = r(3, (e, t, n) =>
    Xc(e, (e) => {
      let r = t(e)
      return li(r) ? R(e) : hc(n(r.success, e), R(e))
    }),
  ),
  rl = r(2, (e, t) => nl(e, Zo, (e) => t(e))),
  il = r(
    (e) => D(e[0]),
    (e, t, n, r) =>
      Xc(e, (e) => {
        let i = Zo(e)
        return li(i) ? R(i.failure) : t(i.success) ? n(i.success) : r ? r(i.success) : R(e)
      }),
  ),
  al = r(
    (e) => D(e[0]),
    (e, t, n, r) =>
      il(e, Array.isArray(t) ? (e) => h(e, `_tag`) && t.includes(e._tag) : xe(t), n, r),
  ),
  ol = r(2, (e, t) => el(e, (e) => Vs(() => t(e)))),
  sl = r(2, (e, t) =>
    yl(e, {
      onFailure: (e) => Vs(() => t.onFailure(e)),
      onSuccess: (e) => z(() => t.onSuccess(e)),
    }),
  ),
  cl = (e) => el(e, Bs),
  ll = r(2, (e, t) => el(e, (e) => z(() => t(e)))),
  ul = (e) =>
    B(() => {
      let t = e[Symbol.iterator](),
        n = t.next()
      if (n.done) return Bs(Error(`Received an empty collection of effects`))
      function r(e) {
        let n = t.next()
        return n.done ? e.value : el(e.value, (e) => r(n))
      }
      return r(n)
    }),
  dl = r(
    (e) => D(e[0]),
    (e, t) => {
      if (!t?.log) return yl(e, { onFailure: (e) => V, onSuccess: (e) => V })
      let n = xd(t.log === !0 ? void 0 : t.log)
      return ml(e, {
        onFailure(e) {
          let r = Xo(e)
          return li(r) ? R(r.failure) : t.message === void 0 ? n(e) : n(t.message, e)
        },
        onSuccess: (e) => V,
      })
    },
  ),
  fl = (e) => bl(e, { onFailure: A, onSuccess: j }),
  pl = (e) => xl(e, { onFailure: ai, onSuccess: ii }),
  ml = r(
    2,
    (e, t) =>
      new gl(
        e,
        t.onSuccess.length === 1 ? t.onSuccess : (e) => t.onSuccess(e),
        t.onFailure.length === 1 ? t.onFailure : (e) => t.onFailure(e),
      ),
  ),
  hl = rn({ op: `OnSuccessAndFailure`, [T]: rc }),
  gl = function (e, t, n) {
    ;((this[w] = e), (this[E] = t), (this[Mt] = n))
  }
gl.prototype = hl
var _l = function (e, t) {
    let n = this.payload
    return t.succeedWith(cc ? n.onSuccess(e) : Et(() => n.onSuccess(e)))
  },
  vl = ((e, t) => {
    let n = rn({ op: e, [T]: rc, [E]: _l, [Mt]: t }),
      r = function (e, t) {
        ;((this[w] = e), (this.payload = t))
      }
    return ((r.prototype = n), r)
  })(`Match`, function (e, t) {
    let n = e.reasons.find($t)
    if (n === void 0) return R(e)
    let r = this.payload
    return t.succeedWith(cc ? r.onFailure(n.error) : Et(() => r.onFailure(n.error)))
  }),
  yl = r(2, (e, t) =>
    ml(e, {
      onFailure: (e) => {
        let n = e.reasons.find($t)
        return n ? t.onFailure(n.error) : R(e)
      },
      onSuccess: t.onSuccess,
    }),
  ),
  bl = r(2, (e, t) => new vl(e, t)),
  xl = r(2, (e, t) => {
    if (U(e)) {
      if (e._tag === `Success`) return O(t.onSuccess(e.value))
      let n = Zo(e.cause)
      return li(n) ? e : O(t.onFailure(n.success))
    }
    return bl(e, t)
  }),
  Sl = (e) => (U(e) ? O(e) : Cl(e)),
  Cl = an({
    op: `Exit`,
    [T](e) {
      return (e._stack.push(this), this[w])
    },
    [E](e, t, n) {
      return t.succeedWith(n ?? O(e))
    },
    [Mt](e, t, n) {
      return t.succeedWith(n ?? ln(e))
    },
  }),
  wl = `~effect/Scope`,
  Tl = `~effect/Scope/Closeable`,
  El = Cr(`effect/Scope`),
  Dl = (e, t) =>
    k((n) => {
      let r = Ol(e, t)
      return r === void 0 ? V : (cu(n), r)
    }),
  Ol = (e, t) => {
    let n = e.state
    if (
      n._tag === `Closed` ||
      ((e.state = { _tag: `Closed`, exit: t }),
      e.parent !== void 0 && Il(e.parent, e),
      n._tag === `Empty`)
    )
      return
    if (n.finalizer !== void 0) return kl(n.finalizer, t)
    let r = n.finalizers
    return r.size === 1 ? kl(r.values().next().value, t) : jl(e, r, t)
  },
  kl = (e, t) => {
    try {
      return e(t)
    } catch (e) {
      return dn(e)
    }
  },
  Al = (e, t) => (Dc(e) ? t : Xc(t, (t) => R(rs(e.cause, t)))),
  jl = Zs(function* (e, t, n) {
    let r = [],
      i = [],
      a = Array.from(t.values()),
      o = bs()
    for (let t = a.length - 1; t >= 0; t--) {
      let s = a[t]
      e.strategy === `sequential`
        ? r.push(yield* Sl(kl(s, n)))
        : i.push(xu(o, kl(s, n), !0, !0, `inherit`))
    }
    return (i.length > 0 && (r = yield* ks(i)), yield* Lc(r))
  }),
  Ml = (e, t) => {
    let n = Rl(t, e)
    return e.state._tag === `Closed` ? ((n.state = e.state), n) : (Fl(e, n, (e) => Dl(n, e)), n)
  },
  Nl = (e, t) => B(() => (e.state._tag === `Closed` ? t(e.state.exit) : (Fl(e, {}, t), V))),
  Pl = (e, t) => Nl(e, a(t)),
  Fl = (e, t, n) => {
    if (e.state._tag === `Empty`)
      e.state = { _tag: `Open`, finalizerKey: t, finalizer: n, finalizers: void 0 }
    else if (e.state._tag === `Open`) {
      let r = e.state
      r.finalizer === void 0
        ? r.finalizers.set(t, n)
        : ((r.finalizers = new Map([[r.finalizerKey, r.finalizer]])),
          (r.finalizerKey = void 0),
          (r.finalizer = void 0),
          r.finalizers.set(t, n))
    }
  },
  Il = (e, t) => {
    if (e.state._tag !== `Open`) return
    let n = e.state
    n.finalizerKey === t
      ? (e.state = zl)
      : n.finalizers !== void 0 &&
        (n.finalizers.delete(t), n.finalizers.size === 0 && (e.state = zl))
  },
  Ll = (e) => Rl(e, void 0),
  Rl = (e = `sequential`, t) => ({ [Tl]: Tl, [wl]: wl, strategy: e, parent: t, state: zl }),
  zl = { _tag: `Empty` },
  Bl = El,
  Vl = Gc(El),
  Hl = (e) =>
    k((t) => {
      let n = t.context,
        r = Ll()
      return (t.setContext(Wr(t.context, El, r)), Jl(t, (e) => (t.setContext(n), Ol(r, e))), e)
    }),
  Ul = (e) =>
    B(() => {
      let t = Ll()
      return Yl(e(t), (e) => B(() => Ol(t, e) ?? V))
    }),
  Wl = (e, t, n) =>
    Uc((r) =>
      uu((i) => H(Bl, (a) => gc(n?.interruptible ? i(e) : e, (e) => Nl(a, (n) => Wc(t(e, n), r))))),
    ),
  Gl = (e) => H(Bl, (t) => Uc((n) => Nl(t, (t) => Wc(e(t), n)))),
  Kl = (function () {
    let e = rn({
        op: `OnExit`,
        [T](e) {
          return (e._stack.push(this), this.effect)
        },
        [Nt](e) {
          e.interruptible &&
            this.interruptible !== !0 &&
            (e._stack.push(au), (e.interruptible = !1))
        },
        [E](e, t, n) {
          n ??= O(e)
          let r
          try {
            r = this.onExit(n)
          } catch (e) {
            r = dn(e)
          }
          return r ? H(r, (e) => n) : n
        },
        [Mt](e, t, n) {
          n ??= ln(e)
          let r
          try {
            r = this.onExit(n)
          } catch (e) {
            r = dn(e)
          }
          return r ? H(Al(n, r), (e) => n) : n
        },
      }),
      t = function (e, t, n) {
        ;((this.effect = e), (this.onExit = t), (this.interruptible = n))
      }
    return ((t.prototype = e), t)
  })(),
  ql = (e, t, n) => new Kl(e, t, n),
  Jl = (e, t) => {
    e._stack.push(new Kl(void 0, t, void 0))
  },
  Yl = r(2, ql),
  Xl = r(2, (e, t) => Yl(e, (e) => t)),
  Zl = r(3, (e, t, n) =>
    Yl(e, (e) => {
      let r = t(e)
      return li(r) ? V : n(r.success, e)
    }),
  ),
  Ql = r(2, (e, t) => Zl(e, kc, t)),
  $l = r(3, (e, t, n) =>
    Yl(e, (e) => {
      if (e._tag !== `Failure`) return V
      let r = t(e.cause)
      return li(r) ? V : n(r.success, e.cause)
    }),
  ),
  eu = r(2, (e, t) => $l(es, t)(e)),
  tu = (e) =>
    z(() => {
      let t = zu(!1),
        n = !1,
        r,
        i = H(t.await, () => r)
      return k((a) =>
        r === void 0
          ? n
            ? i
            : ((n = !0),
              Jl(a, (e) =>
                z(() => {
                  ;((r = e), t.openUnsafe())
                }),
              ),
              e)
          : r,
      )
    }),
  nu = k((e) => R(Yo(e.id))),
  ru = (e) => k((t) => (t.interruptible ? ((t.interruptible = !1), t._stack.push(au), e) : e)),
  iu = an({
    op: `SetInterruptible`,
    [Nt](e) {
      if (((e.interruptible = this[w]), e._interruptedCause && e.interruptible))
        return () => R(e._interruptedCause)
    },
  }),
  au = iu(!0),
  ou = iu(!1),
  su = (e) => {
    if (((e.interruptible = !0), e._stack.push(ou), e._interruptedCause))
      return R(e._interruptedCause)
  },
  cu = (e) => {
    let t = e
    t.interruptible && ((t.interruptible = !1), t._stack.push(au))
  },
  lu = (e) => k((t) => (t.interruptible ? e : (su(t) ?? e))),
  uu = (e) =>
    k((t) => (t.interruptible ? ((t.interruptible = !1), t._stack.push(au), e(lu)) : e(i))),
  du = (e, t) =>
    Ce(e)
      ? t?.mode === `result`
        ? pu(e, pl, t)
        : pu(e, i, t)
      : t?.discard
        ? t.mode === `result`
          ? pu(Object.values(e), pl, t)
          : pu(Object.values(e), i, t)
        : B(() => {
            let n = {}
            return nc(
              pu(
                Object.entries(e),
                ([e, r]) =>
                  Sc(t?.mode === `result` ? pl(r) : r, (t) => {
                    C(n, e, t)
                  }),
                { discard: !0, concurrency: t?.concurrency },
              ),
              n,
            )
          }),
  fu = an({
    op: `While`,
    [E](e, t) {
      return (this[w].step(e), this[w].while() ? (t._stack.push(this), this[w].body()) : jc)
    },
    [T](e) {
      return this[w].while() ? (e._stack.push(this), this[w].body()) : jc
    },
  }),
  pu = r(
    (e) => typeof e[1] == `function`,
    (e, t, n) =>
      B(() => {
        let r = hu(n?.concurrency)
        if (r === 1) return mu(e, t, n)
        let i = F(e),
          a = i.length
        if (a === 0) return n?.discard ? V : L([])
        let o = n?.discard ? void 0 : Array(a),
          s = yu({ f: t, out: o }, i, { concurrency: r })
        return s ? nc(s, o) : L(o)
      }),
  ),
  mu = (e, t, n) =>
    B(() => {
      let r = n?.discard ? void 0 : [],
        i = e[Symbol.iterator](),
        a = i.next(),
        o = 0
      return nc(
        fu({
          while: () => !a.done,
          body: () => t(a.value, o++),
          step: (e) => {
            ;(r && r.push(e), (a = i.next()))
          },
        }),
        r,
      )
    }),
  hu = (e) => (e === `unbounded` ? 1 / 0 : Math.max(1, e ?? 1)),
  gu = () => (e) => {
    let t = e.onItem,
      n = e.step,
      r = (e, t, r, a, o) => H(Sl(o), (o) => n(e, t[r], o, r) ?? i(e, t, r + 1, a) ?? V),
      i = (e, i, a = 0, o = i.length) => {
        for (; a < o; a++) {
          let s = i[a],
            c = t(e, s, a)
          if (!U(c)) return r(e, i, a, o, c)
          let l = n(e, s, c, a)
          if (l) return l._tag === `Failure` ? l : void 0
        }
      }
    return i
  },
  _u = (e) => {
    let t = e.onItem,
      n = e.step
    return (e, r, i) => {
      let a = 0,
        o = i.end ?? r.length,
        s = i.concurrency,
        c = !1,
        l,
        u,
        d,
        f,
        p,
        m = (e) => {
          let t = dn(e)
          return ((f = t), (c = !0), u && u.size > 0 ? H(ru(Ns(Array.from(u))), () => f ?? t) : t)
        },
        ee = () => {
          let i = !1
          for (; !f && a < o; a++) {
            let o = r[a],
              te = p ?? t(e, o, a)
            if (U(te)) {
              if (((f = n(e, o, te, a)), f)) break
            } else if (l) {
              p = void 0
              let t = xu(l, te, !0, !0, `inherit`)
              if (t._exit) {
                if (((f = n(e, o, t._exit, a)), f)) break
                continue
              }
              u.add(t)
              let r = a
              if (
                (t.addObserver((a) => {
                  u.delete(t)
                  try {
                    if (f) {
                      if (a._tag === `Failure`) {
                        let e = a.cause.reasons.filter((e) => e._tag !== `Interrupt`)
                        if (e.length > 0) {
                          let t = qt(e)
                          f = ln(f._tag === `Failure` ? rs(f.cause, t) : t)
                        }
                      }
                    } else {
                      let t = n(e, o, a, r)
                      t && ((f = t), ee())
                    }
                    if (i) {
                      let e = ee()
                      e && d(e)
                    } else c && u.size === 0 && d(f ?? V)
                  } catch (e) {
                    d(m(e))
                  }
                }),
                u.size < s)
              )
                continue
              ;((i = !0), a++)
              return
            } else
              return Js((e) => {
                ;((l = bs()), (u = new Set()), (p = te), (d = e))
                let t
                try {
                  t = ee()
                } catch (t) {
                  return e(m(t))
                }
                return t
                  ? e(t)
                  : B(() => ((f ??= jc), H(u ? Ns(u) : V, () => (f?._tag === `Failure` ? f : V))))
              })
          }
          if (((c = !0), f)) {
            if (u && u.size > 0) {
              let e = Es(l)
              u.forEach((t) => t.interruptUnsafe(l.id, e))
              return
            }
            if (d || f._tag === `Failure`) return f
          } else if (d) {
            if (u) u.size === 0 && d(V)
            else return jc
          }
        }
      return ee()
    }
  },
  vu = () => (e) => _u(e),
  yu = _u({
    onItem(e, t, n) {
      return e.f(t, n)
    },
    step(e, t, n, r) {
      if (n._tag === `Failure`) return n
      e.out && (e.out[r] = n.value)
    },
  }),
  bu = r(
    (e) => D(e[0]),
    (e, t) => k((n) => (Ed(), L(xu(n, e, t?.startImmediately, !1, t?.uninterruptible ?? !1)))),
  ),
  xu = (e, t, n = !1, r = !1, i = !1) => {
    let a = e,
      o = i === `inherit` ? a.interruptible : !i,
      s = new xs(a.context, o)
    return (
      n ? s.evaluate(t) : a.currentDispatcher.scheduleTask(() => s.evaluate(t), 0),
      !r && !s._exit && (a.children().add(s), (s._parent = a)),
      s
    )
  },
  Su = r(
    (e) => D(e[0]),
    (e, t, n) =>
      k((r) => {
        let i = xu(r, e, n?.startImmediately, !0, n?.uninterruptible)
        if (!i._exit) {
          if (t.state._tag !== `Closed`) {
            let e = {}
            ;(Fl(t, e, () => Gs((e) => (e === i.id ? V : js(i)))), i.addObserver(() => Il(t, e)))
          } else i.interruptUnsafe(r.id, Es(r))
        }
        return L(i)
      }),
  ),
  Cu = (e) => (t, n) => {
    let r = new xs(n?.scheduler ? Wr(e, ro, n.scheduler) : e, n?.uninterruptible !== !0)
    if ((r.evaluate(t), r._exit)) return r
    if (n?.signal) {
      if (n.signal.aborted) r.interruptUnsafe()
      else {
        let e = () => r.interruptUnsafe()
        ;(n.signal.addEventListener(`abort`, e, { once: !0 }),
          r.addObserver(() => n.signal.removeEventListener(`abort`, e)))
      }
    }
    return (n?.onFiberStart && n.onFiberStart(r), r)
  },
  wu = r(2, (e, t) => {
    if (e._exit) return e
    if (t.state._tag === `Closed`) return (e.interruptUnsafe(e.id), e)
    let n = {}
    return (Fl(t, n, () => js(e)), e.addObserver(() => Il(t, n)), e)
  }),
  Tu = Cu(Vr()),
  Eu = (e) => {
    let t = Cu(e)
    return (e, n) => {
      let r = t(e, n)
      return (n?.onExit && r.addObserver(n.onExit), (e) => r.interruptUnsafe(e))
    }
  },
  Du = Eu(Vr()),
  Ou = (e) => {
    let t = Cu(e)
    return (e, n) => {
      let r = t(e, n)
      return new Promise((e) => {
        r.addObserver((t) => e(t))
      })
    }
  },
  ku = Ou(Vr()),
  Au = (e) => {
    let t = Ou(e)
    return (e, n) =>
      t(e, n).then((e) => {
        if (e._tag === `Failure`) throw as(e.cause)
        return e.value
      })
  },
  ju = Au(Vr()),
  Mu = (e) => {
    let t = Cu(e)
    return (e) => {
      if (U(e)) return e
      let n = new co(`sync`),
        r = t(e, { scheduler: n })
      return (r._dispatcher?.flush(), r._exit ?? dn(new ud(r)))
    }
  },
  Nu = Mu(Vr()),
  Pu = (e) => {
    let t = Mu(e)
    return (e) => {
      let n = t(e)
      if (n._tag === `Failure`) throw as(n.cause)
      return n.value
    }
  },
  Fu = Pu(Vr()),
  Iu = L(!0),
  Lu = L(!1),
  Ru = class {
    waiters = []
    scheduled = void 0
    _isOpen
    constructor(e) {
      this._isOpen = e
    }
    scheduleUnsafe(e) {
      if (this.waiters.length === 0) return Iu
      if (this.scheduled === void 0)
        ((this.scheduled = this.waiters), e.currentDispatcher.scheduleTask(this.flushScheduled, 0))
      else for (let e = 0; e < this.waiters.length; e++) this.scheduled.push(this.waiters[e])
      return ((this.waiters = []), Iu)
    }
    flushScheduled = () => {
      if (this.scheduled === void 0) return
      let e = this.scheduled
      this.scheduled = void 0
      for (let t = 0; t < e.length; t++) e[t](jc)
    }
    flushWaiters() {
      let e = this.waiters
      ;((this.waiters = []), this.flushScheduled())
      for (let t = 0; t < e.length; t++) e[t](jc)
    }
    open = k((e) => (this._isOpen ? Lu : ((this._isOpen = !0), this.scheduleUnsafe(e))))
    release = k((e) => (this._isOpen ? Lu : this.scheduleUnsafe(e)))
    openUnsafe() {
      return !this._isOpen && ((this._isOpen = !0), this.flushWaiters(), !0)
    }
    await = Js((e) =>
      this._isOpen
        ? e(V)
        : (this.waiters.push(e),
          z(() => {
            let t = this.waiters.indexOf(e)
            t === -1
              ? this.scheduled !== void 0 &&
                ((t = this.scheduled.indexOf(e)), t !== -1 && this.scheduled.splice(t, 1))
              : this.waiters.splice(t, 1)
          })),
    )
    closeUnsafe() {
      return this._isOpen ? ((this._isOpen = !1), !0) : !1
    }
    close = z(() => this.closeUnsafe())
    whenOpen = (e) => H(this.await, () => e)
    isOpen() {
      return this._isOpen
    }
  },
  zu = (e) => new Ru(e ?? !1),
  Bu = (e) => z(() => zu(e)),
  Vu = BigInt(0),
  Hu = {
    _tag: `Span`,
    spanId: `noop`,
    traceId: `noop`,
    sampled: !1,
    status: { _tag: `Ended`, startTime: Vu, endTime: Vu, exit: jc },
    attributes: new Map(),
    links: [],
    kind: `internal`,
    attribute() {},
    event() {},
    end() {},
    addLinks() {},
  },
  Uu = (e) => Object.assign(Object.create(Hu), e),
  Wu = (e) =>
    e ? (N(e.annotations, ko) ? (e._tag === `Span` ? Wu(dr(e.parent)) : A()) : j(e)) : A(),
  Gu = (e, t, n) => {
    let r = !e.cache.tracerEnabled || (n?.annotations && N(n.annotations, ko)),
      i = n?.parent === void 0 ? (n?.root ? A() : Wu(e.cache.span)) : j(n.parent),
      a
    if (r) a = Uu({ name: t, parent: i, annotations: Wr(n?.annotations ?? Vr(), ko, !0) })
    else {
      let r = e.cache.tracer ?? No,
        o = e.getRef(Qu),
        s = e.getRef(Ro),
        c = e.getRef(zo),
        l = e.getRef(Bo),
        u = n?.level ?? e.getRef(Ao),
        d = n?.links === void 0 ? (l.length === 0 ? [] : l.slice()) : [...l, ...n.links]
      a = r.span({
        name: t,
        parent: i,
        annotations: n?.annotations ?? Vr(),
        links: d,
        startTime: s ? o.currentTimeNanosUnsafe() : Vu,
        kind: n?.kind ?? `internal`,
        root: n?.root ?? M(i),
        sampled: n?.sampled ?? (ir(i) && i.value.sampled === !1 ? !1 : !md(e.getRef(jo), u)),
      })
      for (let e in c) a.attribute(e, c[e])
      if (n?.attributes !== void 0) for (let e in n.attributes) a.attribute(e, n.attributes[e])
    }
    return a
  },
  Ku = (e, t) => (
    (t = typeof t == `function` ? t : l),
    Bc(Io, (n) => ({ name: e, stack: t, parent: n }))
  ),
  qu = (e, t, n, r) =>
    z(() => {
      e.status._tag !== `Ended` && e.end(r ? n.currentTimeNanosUnsafe() : Vu, t)
    }),
  Ju = (e, ...t) => {
    let n = t.length === 1 ? void 0 : t[0],
      r = t[t.length - 1]
    return k((t) => {
      let i = Gu(t, e, n),
        a = t.getRef(Qu),
        o = t.getRef(Ro)
      return (Jl(t, (e) => qu(i, e, a, o)), r(i))
    })
  },
  Yu = Gc(Do),
  Xu = function () {
    let e = D(arguments[0]),
      t = e ? arguments[1] : arguments[0],
      n = e ? arguments[2] : arguments[1],
      r = i
    return (
      t._tag === `Span` && ((n = Go(n)), (r = Ku(t.name, n?.captureStackTrace))),
      e ? Yu(r(arguments[0]), t) : (e) => Yu(r(e), t)
    )
  },
  Zu = function () {
    let e = typeof arguments[0] != `string`,
      t = e ? arguments[1] : arguments[0],
      n = Go(arguments[2])
    if (e) {
      let e = arguments[0]
      return Ju(t, arguments[2], (t) => Xu(e, t, n))
    }
    let r = typeof arguments[1] == `function` ? arguments[1] : void 0,
      i = r ? void 0 : arguments[1]
    return (e, ...a) => Ju(t, r ? r(...a) : i, (t) => Xu(e, t, n))
  },
  Qu = P(`effect/Clock`, { defaultValue: () => new ed() }),
  $u = 2 ** 31 - 1,
  ed = class {
    currentTimeMillisUnsafe() {
      return Date.now()
    }
    currentTimeMillis = z(() => this.currentTimeMillisUnsafe())
    currentTimeNanosUnsafe() {
      return rd()
    }
    currentTimeNanos = z(() => this.currentTimeNanosUnsafe())
    monotonicTimeNanosUnsafe() {
      return nd()
    }
    monotonicTimeNanos = z(() => this.monotonicTimeNanosUnsafe())
    sleep(e) {
      return this.sleepMillis(Xa(e))
    }
    sleepMillis(e) {
      return e <= 0
        ? Is
        : Number.isFinite(e)
          ? Js((t) => {
              let n = e > $u ? this.sleepMillis(e - $u) : V,
                r = setTimeout(() => t(n), Math.min(e, $u))
              return z(() => clearTimeout(r))
            })
          : Ys
    }
  },
  td = BigInt(1e6),
  nd = (function () {
    let e = globalThis.process?.hrtime
    if (typeof e?.bigint == `function`) return () => e.bigint()
    if (typeof performance < `u` && typeof performance.now == `function`)
      return () => BigInt(Math.round(performance.now() * 1e6))
    let t = BigInt(0)
    return () => {
      let e = BigInt(Date.now()) * td
      return (e > t && (t = e), t)
    }
  })(),
  rd = (function () {
    let e = BigInt(1e9),
      t
    return () => {
      let n = nd(),
        r = BigInt(Date.now()) * td
      if (t === void 0) t = r - n
      else {
        let i = t + n
        ;(r > i ? r - i : i - r) > e && (t = r - n)
      }
      return t + n
    }
  })(),
  id = (e) => k((t) => e(t.getRef(Qu))),
  ad = (e) => id((t) => t.sleep(Ma(e))),
  od = id((e) => e.currentTimeMillis),
  sd = `~effect/Cause/IllegalArgumentError`,
  cd = class extends mn(`IllegalArgumentError`) {
    [sd] = sd
    constructor(e) {
      super({ message: e })
    }
  },
  ld = `~effect/Cause/AsyncFiberError`,
  ud = class extends mn(`AsyncFiberError`) {
    [ld] = ld
    constructor(e) {
      super({ message: `An asynchronous Effect was executed with Effect.runSync`, fiber: e })
    }
  },
  dd = `~effect/Cause/UnknownError`,
  fd = class extends mn(`UnknownError`) {
    [dd] = dd
    constructor(e, t) {
      super({ message: t, cause: e })
    }
  },
  pd = P(`effect/Console`, { defaultValue: () => globalThis.console }),
  md = er(
    Qn(Zn, (e) => {
      switch (e) {
        case `All`:
          return -(2 ** 53 - 1)
        case `Fatal`:
          return 5e4
        case `Error`:
          return 4e4
        case `Warn`:
          return 3e4
        case `Info`:
          return 2e4
        case `Debug`:
          return 1e4
        case `Trace`:
          return 0
        case `None`:
          return 2 ** 53 - 1
      }
    }),
  ),
  hd = P(`effect/Logger/CurrentLoggers`, { defaultValue: () => new Set([wd, Td]) }),
  gd = P(`effect/Logger/LogToStderr`, { defaultValue: s }),
  _d = {
    "~effect/Logger": { _Message: i, _Output: i },
    pipe() {
      return e(this, arguments)
    },
  },
  vd = (e) => {
    let t = Object.create(_d)
    return ((t.log = e), t)
  },
  yd = (e) => e.replace(/[\s="]/g, `_`),
  bd = (e, t) => `${yd(e[0])}=${t - e[1]}ms`,
  xd =
    (e) =>
    (...t) => {
      let n
      for (let e = 0, r = t.length; e < r; e++) {
        let r = t[e]
        Bt(r) &&
          (n ? t.splice(e, 1) : (t = t.slice(0, e).concat(t.slice(e + 1))),
          (n = n ? qt(n.reasons.concat(r.reasons)) : r),
          e--)
      }
      return (
        n === void 0 && (n = Jt),
        k((r) => {
          let i = e ?? r.cache.logLevel
          if (md(r.cache.minimumLogLevel, i)) return V
          let a = r.getRef(Qu),
            o = r.getRef(hd)
          if (o.size > 0) {
            let e = new Date(a.currentTimeMillisUnsafe())
            for (let a of o) a.log({ cause: n, fiber: r, date: e, logLevel: i, message: t })
          }
          return V
        })
      )
    },
  Sd = {
    bold: `1`,
    red: `31`,
    green: `32`,
    yellow: `33`,
    blue: `34`,
    cyan: `36`,
    white: `37`,
    gray: `90`,
    black: `30`,
    bgBrightRed: `101`,
  }
;(Sd.gray, Sd.blue, Sd.green, Sd.yellow, Sd.red, Sd.bgBrightRed, Sd.black)
var Cd = (e) =>
    `${e.getHours().toString().padStart(2, `0`)}:${e.getMinutes().toString().padStart(2, `0`)}:${e.getSeconds().toString().padStart(2, `0`)}.${e.getMilliseconds().toString().padStart(3, `0`)}`,
  wd = vd(({ cause: e, date: t, fiber: n, logLevel: r, message: i }) => {
    let a = Array.isArray(i) ? i.slice() : [i]
    e.reasons.length > 0 && a.push(ms(e))
    let o = t.getTime(),
      s = n.getRef(Wo),
      c = ``
    for (let e of s) c += ` ${bd(e, o)}`
    let l = n.getRef(Vo)
    Object.keys(l).length > 0 && a.push(l)
    let u = n.getRef(pd)
    ;(n.getRef(gd) ? u.error : u.log)(`[${Cd(t)}] ${r.toUpperCase()} (#${n.id})${c}:`, ...a)
  }),
  Td = vd(({ cause: e, fiber: t, logLevel: n, message: r }) => {
    let i = t.getRef(Qu),
      a = t.getRef(Vo),
      o = t.cache.span
    if (o === void 0 || o._tag === `ExternalSpan`) return
    let s = {}
    for (let [e, t] of Object.entries(a)) C(s, e, t)
    ;((s[`effect.fiberId`] = t.id),
      (s[`effect.logLevel`] = n.toUpperCase()),
      e.reasons.length > 0 && (s[`effect.cause`] = ms(e)),
      o.event(yt(Array.isArray(r) && r.length === 1 ? r[0] : r), i.currentTimeNanosUnsafe(), s))
  })
function Ed() {
  Ts.interruptChildren ??= Ds
}
var Dd = Bt,
  Od = Vt,
  kd = $t,
  Ad = qt,
  jd = Yt,
  Md = Zt,
  Nd = (e) => new Kt(e),
  Pd = (e) => new Xt(e),
  Fd = Jo,
  Id = ts,
  Ld = is,
  Rd = rs,
  zd = as,
  Bd = Zo,
  Vd = Qo,
  Hd = $o,
  Ud = gn,
  Wd = vn,
  Gd = bn,
  Kd = cd,
  qd = class extends Cr()(`effect/Cause/StackTrace`) {},
  Jd = O,
  Yd = ln,
  Xd = un,
  Zd = jc,
  Qd = Dc,
  $d = Oc,
  ef = Ac,
  tf = Ic,
  nf = {
    "~effect/Deferred": { _A: i, _E: i },
    pipe() {
      return e(this, arguments)
    },
  },
  rf = function () {
    ;((this.resumes = void 0), (this.effect = void 0))
  }
rf.prototype = nf
var af = () => new rf(),
  of = (e) =>
    Js((t) =>
      e.effect
        ? t(e.effect)
        : ((e.resumes ??= []),
          e.resumes.push(t),
          z(() => {
            let n = e.resumes
            if (n === void 0) return
            let r = n.indexOf(t)
            r >= 0 && n.splice(r, 1)
          })),
    ),
  sf = r(2, (e, t) => z(() => uf(e, t))),
  cf = r(2, (e, t) => sf(e, ln(t))),
  lf = r(2, (e, t) => cf(e, Yo(t))),
  uf = (e, t) => {
    if (e.effect) return !1
    if (((e.effect = t), e.resumes)) {
      let n = e.resumes
      e.resumes = void 0
      for (let e = 0; e < n.length; e++) n[e](t)
    }
    return !0
  },
  df = El,
  ff = Ll,
  pf = Vl,
  mf = Nl,
  hf = Pl,
  gf = Ml,
  _f = Dl,
  vf = `~effect/Layer`,
  yf = `~effect/Layer/MemoMap`,
  bf = (e, t) => {
    let n = {
      observers: 0,
      deferred: af(),
      scope: ff(),
      finalizer: (r) => B(() => (--n.observers > 0 ? V : (e.map.delete(t), _f(n.scope, r)))),
    }
    return n
  },
  xf = (e, t) => t.state._tag !== `Closed` && (e.observers++, Fl(t, {}, e.finalizer), !0),
  Sf = {
    [vf]: { _ROut: i, _E: i, _RIn: i },
    pipe() {
      return e(this, arguments)
    },
  },
  Cf = (e) => {
    let t = Object.create(Sf)
    return ((t.build = e), t)
  },
  wf = (e) =>
    Cf((t, n) => {
      let r = gf(n)
      return Yl(e(t, r), (e) => (e._tag === `Failure` ? _f(r, e) : V))
    }),
  Tf = (e) => {
    let t = wf((n, r) => n.getOrElseMemoize(t, r, e))
    return t
  },
  Ef = class {
    get [yf]() {
      return yf
    }
    parent
    constructor(e) {
      this.parent = e
    }
    map = new Map()
    get(e, t) {
      let n = this.map.get(e)
      return n ? (xf(n, t), n.deferred.effect ?? of(n.deferred)) : this.parent?.get(e, t)
    }
    getOrElseMemoize(e, t, n) {
      return B(() => {
        let r
        return ql(
          B(() => {
            let i = this.get(e, t)
            if (i) return i
            let a = bf(this, e)
            return xf(a, t) ? ((r = a.deferred), this.map.set(e, a), n(this, a.scope)) : n(this, t)
          }),
          (e) => {
            r && uf(r, e)
          },
        )
      })
    }
  },
  Df = () => new Ef(),
  Of = (e) => new Ef(e),
  kf = class e extends Cr()(`effect/Layer/CurrentMemoMap`) {
    static forkOrCreate(t) {
      let n = Kr(t, e)
      return n ? Of(n) : Df()
    }
  },
  Af = r(3, (e, t, n) => Gc(Sc(e.build(t, n), Wr(kf, t)), kf, t)),
  jf = r(2, (e, t) => k((n) => Af(e, kf.forkOrCreate(n.context), t))),
  Mf = function () {
    return arguments.length === 1
      ? (e) => Nf(Ur(arguments[0], e))
      : Nf(Ur(arguments[0], arguments[1]))
  },
  Nf = (e) => Cf(a(L(e))),
  Pf = Nf(Vr()),
  Ff = function () {
    return arguments.length === 1 ? (e) => If(arguments[0], e) : If(arguments[0], arguments[1])
  },
  If = (e, t) => Lf(Sc(t, (t) => Ur(e, t))),
  Lf = (e) => Tf((t, n) => pf(e, n)),
  Rf = (e) => Lf(nc(e, Vr())),
  zf = (e, t, n) => {
    let r = gf(n, `parallel`)
    return pu(e, (e) => e.build(t, gf(r, `sequential`)), { concurrency: e.length }).pipe(
      Sc((e) => ei(...e)),
    )
  },
  Bf = (...e) => wf((t, n) => zf(e, t, n)),
  Vf = r(2, (e, t) => Bf(e, ...(Array.isArray(t) ? t : [t]))),
  Hf = (e, t, n) =>
    wf((r, i) =>
      H(Array.isArray(t) ? zf(t, r, i) : t.build(r, i), (t) =>
        e.build(r, i).pipe(
          Wc(t),
          Sc((e) => n(e, t)),
        ),
      ),
    ),
  Uf = r(2, (e, t) => Hf(e, t, i)),
  Wf = r(2, (e, t) => Hf(e, t, (e, t) => $r(t, e))),
  Gf = od,
  Kf = `~effect/DateTime`,
  qf = `~effect/DateTime/TimeZone`,
  Jf = {
    [Kf]: Kf,
    pipe() {
      return e(this, arguments)
    },
    [_t]() {
      return this.toString()
    },
    toJSON() {
      return lp(this).toJSON()
    },
  },
  Yf = {
    ...Jf,
    _tag: `Utc`,
    [g]() {
      return Oe(this.epochMilliseconds)
    },
    [b](e) {
      return $f(e) && e._tag === `Utc` && this.epochMilliseconds === e.epochMilliseconds
    },
    toString() {
      return `DateTime.Utc(${lp(this).toJSON()})`
    },
  },
  Xf = {
    ...Jf,
    _tag: `Zoned`,
    [g]() {
      return v(Oe(this.epochMilliseconds))(_(this.zone))
    },
    [b](e) {
      return (
        $f(e) &&
        e._tag === `Zoned` &&
        this.epochMilliseconds === e.epochMilliseconds &&
        x(this.zone, e.zone)
      )
    },
    toString() {
      return `DateTime.Zoned(${kp(this)})`
    },
  },
  Zf = {
    [qf]: qf,
    [_t]() {
      return this.toString()
    },
  }
;(({ ...Zf }), { ...Zf })
var Qf = (e, t, n) => {
    let r = Object.create(Xf)
    return (
      (r.epochMilliseconds = e),
      (r.zone = t),
      Object.defineProperty(r, "partsUtc", { value: n, enumerable: !1, writable: !0 }),
      Object.defineProperty(r, "adjustedEpochMillis", {
        value: void 0,
        enumerable: !1,
        writable: !0,
      }),
      Object.defineProperty(r, "partsAdjusted", { value: void 0, enumerable: !1, writable: !0 }),
      r
    )
  },
  $f = (e) => h(e, Kf),
  ep = (e) => $f(e[0]),
  tp = (e) => e._tag === `Utc`,
  np = (e) => {
    let t = Object.create(Yf)
    return (
      (t.epochMilliseconds = e),
      Object.defineProperty(t, "partsUtc", { value: void 0, enumerable: !1, writable: !0 }),
      t
    )
  },
  rp = (e) => {
    let t = e.getTime()
    if (Number.isNaN(t)) throw new Kd(`Invalid date`)
    return np(t)
  },
  ip = (e) => {
    if ($f(e)) return e
    if (e instanceof Date) return rp(e)
    if (typeof e == `object`) {
      if (`epochMilliseconds` in e) return rp(new Date(e.epochMilliseconds))
      let t = new Date(0)
      return (_p(t, e), rp(t))
    }
    return typeof e == `string` && !ap(e) ? rp(new Date(e + `Z`)) : rp(new Date(e))
  },
  ap = (e) => /Z|GMT|[+-]\d{2}$|[+-]\d{2}:?\d{2}$|\]$/.test(e),
  op = fr(ip),
  sp = Sc(Gf, np),
  cp = (e) => np(e.epochMilliseconds),
  lp = (e) => new Date(e.epochMilliseconds),
  up = (e) => {
    if (e._tag === `Utc`) return new Date(e.epochMilliseconds)
    if (e.zone._tag === `Offset`) return new Date(e.epochMilliseconds + e.zone.offset)
    if (e.adjustedEpochMilliseconds !== void 0) return new Date(e.adjustedEpochMilliseconds)
    let t = e.zone.format.formatToParts(e.epochMilliseconds).filter((e) => e.type !== `literal`),
      n = new Date(0)
    return (
      n.setUTCFullYear(Number(t[2].value), Number(t[0].value) - 1, Number(t[1].value)),
      n.setUTCHours(Number(t[3].value), Number(t[4].value), Number(t[5].value), Number(t[6].value)),
      (e.adjustedEpochMilliseconds = n.getTime()),
      n
    )
  },
  dp = (e) => up(e).getTime() - mp(e),
  fp = (e) => {
    let t = Math.abs(e),
      n = Math.floor(t / 36e5),
      r = Math.round((t % 36e5) / 6e4)
    return (
      r === 60 && ((n += 1), (r = 0)),
      `${e < 0 ? `-` : `+`}${String(n).padStart(2, `0`)}:${String(r).padStart(2, `0`)}`
    )
  },
  pp = (e) => fp(dp(e)),
  mp = (e) => e.epochMilliseconds,
  hp = (e) => ({
    millisecond: e.getUTCMilliseconds(),
    second: e.getUTCSeconds(),
    minute: e.getUTCMinutes(),
    hour: e.getUTCHours(),
    day: e.getUTCDate(),
    weekDay: e.getUTCDay(),
    month: e.getUTCMonth() + 1,
    year: e.getUTCFullYear(),
  }),
  gp = (e) => (e.partsUtc === void 0 && (e.partsUtc = wp(e, hp)), e.partsUtc),
  _p = (e, t) => {
    if (
      ((t.year !== void 0 || t.month !== void 0 || t.day !== void 0) &&
        e.setUTCFullYear(
          t.year ?? e.getUTCFullYear(),
          t.month === void 0 ? e.getUTCMonth() : t.month - 1,
          t.day ?? e.getUTCDate(),
        ),
      t.weekDay !== void 0)
    ) {
      let n = t.weekDay - e.getUTCDay()
      e.setUTCDate(e.getUTCDate() + n)
    }
    ;(t.hour !== void 0 && e.setUTCHours(t.hour),
      t.minute !== void 0 && e.setUTCMinutes(t.minute),
      t.second !== void 0 && e.setUTCSeconds(t.second),
      t.millisecond !== void 0 && e.setUTCMilliseconds(t.millisecond))
  },
  vp = 864e5,
  yp = (e, t, n) => {
    if (t._tag === `Offset`) return Qf(e - t.offset, t)
    let r = Sp(e - vp, e, t),
      i = Sp(e + vp, e, t)
    if (r === i) return Qf(e - r, t)
    let a = r < i,
      o = r - i
    if (a) {
      if (Sp(e - i, e, t) === i) return Qf(e - i, t)
      let a = Qf(e - r, t)
      if (e !== up(a).getTime())
        switch (n) {
          case `reject`: {
            let n = new Date(e).toISOString()
            throw RangeError(`Gap time: ${n} does not exist in time zone ${t.id}`)
          }
          case `earlier`:
            return Qf(e - i, t)
          case `compatible`:
          case `later`:
            return a
        }
      return a
    }
    if (Sp(e - r, e, t) === r) {
      if (n === `earlier` || n === `compatible` || Sp(e - r + o, e + o, t) === r)
        return Qf(e - r, t)
      if (n === `reject`) {
        let n = new Date(e).toISOString()
        throw RangeError(`Ambiguous time: ${n} occurs twice in time zone ${t.id}`)
      }
    }
    return Qf(e - i, t)
  },
  bp = /([+-])(\d{2}):(\d{2})$/,
  xp = (e) => {
    let t = bp.exec(e)
    if (t === null) return null
    let [, n, r, i] = t
    return (n === `+` ? 1 : -1) * (Number(r) * 60 + Number(i)) * 60 * 1e3
  },
  Sp = (e, t, n) => {
    let r = n.format.formatToParts(e).find((e) => e.type === `timeZoneName`)?.value ?? ``
    if (r === `GMT`) return 0
    let i = xp(r)
    return i === null ? dp(Qf(t, n)) : i
  },
  Cp = r(ep, (e, t, n) => {
    if (e._tag === `Utc`) {
      let n = lp(e)
      return (t(n), np(n.getTime()))
    }
    let r = up(e),
      i = new Date(r.getTime())
    return (t(i), yp(i.getTime(), e.zone, n?.disambiguation ?? `compatible`))
  }),
  wp = r(2, (e, t) => t(lp(e))),
  Tp = (e, t) => {
    e.setTime(e.getTime() + t)
  },
  Ep = r(2, (e, t) =>
    Cp(e, (e) => {
      if (
        (t.milliseconds && Tp(e, t.milliseconds),
        t.seconds && Tp(e, t.seconds * 1e3),
        t.minutes && Tp(e, t.minutes * 60 * 1e3),
        t.hours && Tp(e, t.hours * 60 * 60 * 1e3),
        t.days && e.setUTCDate(e.getUTCDate() + t.days),
        t.weeks && e.setUTCDate(e.getUTCDate() + t.weeks * 7),
        t.months)
      ) {
        let n = e.getUTCDate()
        ;(e.setUTCMonth(e.getUTCMonth() + t.months + 1, 0), n < e.getUTCDate() && e.setUTCDate(n))
      }
      if (t.years) {
        let n = e.getUTCDate(),
          r = e.getUTCMonth()
        ;(e.setUTCFullYear(e.getUTCFullYear() + t.years, r + 1, 0),
          n < e.getUTCDate() && e.setUTCDate(n))
      }
    }),
  ),
  Dp = (e) => lp(e).toISOString(),
  Op = (e) => {
    let t = up(e)
    return e._tag === `Utc` ? t.toISOString() : `${t.toISOString().slice(0, -1)}${pp(e)}`
  },
  kp = (e) => (e.zone._tag === `Offset` ? Op(e) : `${Op(e)}[${e.zone.id}]`),
  Ap = (e, t, n) => Ul((r) => H(n?.local ? Af(t, Df(), r) : jf(t, r), (t) => Wc(e, t))),
  jp = r(
    (e) => D(e[0]),
    (e, t, n) => (zr(t) ? Wc(e, t) : Ap(e, Array.isArray(t) ? Bf(...t) : t, n)),
  ),
  Mp = D,
  Np = du,
  Pp = pu,
  Fp = fu,
  Ip = Us,
  Lp = Ws,
  Rp = L,
  zp = Rs,
  Bp = Ls,
  Vp = B,
  Hp = z,
  Up = V,
  Wp = Js,
  Gp = Ys,
  Kp = Xs,
  W = Ps,
  qp = R,
  Jp = zs,
  Yp = Bs,
  Xp = Hs,
  Zp = Is,
  Qp = k,
  $p = Fs,
  em = H,
  tm = xc,
  nm = hc,
  rm = gc,
  im = pl,
  am = fl,
  om = Sl,
  sm = Sc,
  cm = nc,
  lm = pc,
  um = _c,
  dm = mc,
  fm = qc,
  pm = el,
  mm = al,
  hm = Xc,
  gm = il,
  _m = ol,
  vm = cl,
  ym = rl,
  bm = tl,
  xm = dl,
  Sm = ll,
  Cm = ul,
  wm = ad,
  Tm = yc,
  Em = Jc,
  Dm = ml,
  Om = yl,
  km = Vc,
  Am = Uc,
  jm = jp,
  Mm = Wc,
  Nm = Rc,
  Pm = zc,
  Fm = Gc,
  Im = Bl,
  Lm = Hl,
  Rm = Ul,
  zm = Wl,
  Bm = Gl,
  Vm = Xl,
  Hm = Ql,
  Um = Yl,
  Wm = tu,
  Gm = nu,
  Km = eu,
  qm = ru,
  Jm = uu,
  Ym = Yc,
  Xm = Ju,
  Zm = Zu,
  Qm = Xu,
  $m = bu,
  eh = Su,
  th = Tu,
  nh = Cu,
  rh = Eu,
  ih = Du,
  ah = ju,
  oh = Au,
  sh = ku,
  ch = Ou,
  lh = Fu,
  uh = Pu,
  dh = Nu,
  fh = Mu,
  ph = Zs,
  mh = id,
  hh = xd(`Error`),
  gh = Cc,
  _h = wc,
  vh = Tc,
  yh = bc,
  bh = $s,
  xh = `~effect/BigDecimal`,
  Sh = {
    [xh]: xh,
    [g]() {
      let e = Ah(this)
      return v(y(String(e.value)), Oe(e.scale))
    },
    [b](e) {
      return Ch(e) && Fh(this, e) === 0
    },
    toString() {
      return `BigDecimal(${Lh(this)})`
    },
    toJSON() {
      return { _id: `BigDecimal`, value: String(this.value), scale: this.scale }
    },
    [_t]() {
      return this.toJSON()
    },
    pipe() {
      return e(this, arguments)
    },
  },
  Ch = (e) => h(e, xh),
  wh = (e, t) => {
    if (!Number.isSafeInteger(t)) throw RangeError(`Scale must be a safe integer, got ${t}`)
    let n = Object.create(Sh)
    return ((n.value = e), (n.scale = t), n)
  },
  Th = (e, t) => {
    let n = wh(e, t)
    return ((n.normalized = n), n)
  },
  Eh = BigInt(0),
  Dh = BigInt(1),
  Oh = BigInt(10),
  kh = Th(Eh, 0),
  Ah = (e) => {
    if (e.normalized === void 0) {
      if (e.value === Eh) e.normalized = kh
      else {
        let t = `${e.value}`,
          n = t.length
        for (; t[n - 1] === `0`;) n--
        e.normalized = Th(BigInt(t.slice(0, n)), e.scale - (t.length - n))
      }
    }
    return e.normalized
  },
  jh = 100,
  Mh = [Dh],
  Nh = (e, t) => (e === t ? 0 : e < t ? -1 : 1),
  Ph = (e, t) => {
    let n = `${e.value < Eh ? -e.value : e.value}`,
      r = `${t.value < Eh ? -t.value : t.value}`,
      i = BigInt(n.length - r.length) - BigInt(e.scale) + BigInt(t.scale)
    if (i !== Eh) return i < Eh ? -1 : 1
    let a = Math.max(n.length, r.length)
    return Xn(n.padEnd(a, `0`), r.padEnd(a, `0`))
  },
  Fh = (e, t) => {
    if (e.scale === t.scale) return Nh(e.value, t.value)
    let n = Ih(e),
      r = Ih(t)
    if (n !== r) return n < r ? -1 : 1
    if (n === 0) return 0
    let i = e.scale - t.scale,
      a = Math.abs(i)
    if (a > jh) return n === -1 ? Ph(t, e) : Ph(e, t)
    let o = (Mh[a] ??= Oh ** BigInt(a))
    return i > 0 ? Nh(e.value, t.value * o) : Nh(e.value * o, t.value)
  },
  Ih = (e) => (e.value === Eh ? 0 : e.value < Eh ? -1 : 1),
  Lh = (e) => {
    let t = Ah(e)
    if (Math.abs(t.scale) >= 16) return Rh(t)
    let n = t.value < Eh,
      r = `${n ? -t.value : t.value}`,
      i = t.scale > 0 ? r.padStart(t.scale + 1, `0`) : r.padEnd(r.length - t.scale, `0`),
      a = i.length - t.scale,
      o = t.scale > 0 ? `${i.slice(0, a)}.${i.slice(a)}` : i
    return n ? `-${o}` : o
  },
  Rh = (e) => {
    if (zh(e)) return `0e+0`
    let t = Ah(e),
      n = `${t.value}`,
      r = t.value < Eh ? 2 : 1,
      i = n.slice(0, r),
      a = n.slice(r),
      o = a.length - t.scale
    return `${i}${a === `` ? `` : `.${a}`}e${o >= 0 ? `+` : ``}${o}`
  },
  zh = (e) => e.value === Eh,
  Bh = $f,
  Vh = tp,
  Hh = ip,
  Uh = op,
  Wh = sp,
  Gh = cp,
  Kh = mp,
  qh = gp,
  Jh = Ep,
  Yh = Dp,
  Xh = (e) => Qh(typeof e == `string` ? $h.encode(e) : e),
  Zh = (e) => {
    let t = eg(e),
      n = t.length
    if (n % 4 != 0)
      return ai(
        new bo({
          kind: `Decode`,
          module: `Base64`,
          input: t,
          message: `Length must be a multiple of 4, but is ${n}`,
        }),
      )
    let r = t.indexOf(`=`)
    if (r !== -1 && (r < n - 2 || (r === n - 2 && t[n - 1] !== `=`)))
      return ai(
        new bo({
          kind: `Decode`,
          module: `Base64`,
          input: t,
          message: `Found a '=' character, but it is not at the end`,
        }),
      )
    try {
      let e = t.endsWith(`==`) ? 2 : +!!t.endsWith(`=`),
        r = new Uint8Array((n / 4) * 3 - e)
      for (let e = 0, i = 0; e < n; e += 4, i += 3) {
        let n =
          (rg(t.charCodeAt(e)) << 18) |
          (rg(t.charCodeAt(e + 1)) << 12) |
          (rg(t.charCodeAt(e + 2)) << 6) |
          rg(t.charCodeAt(e + 3))
        ;((r[i] = n >> 16), (r[i + 1] = (n >> 8) & 255), (r[i + 2] = n & 255))
      }
      return ii(r)
    } catch (e) {
      return ai(
        new bo({
          kind: `Decode`,
          module: `Base64`,
          input: t,
          message: e instanceof Error ? e.message : `Invalid input`,
        }),
      )
    }
  },
  Qh = (e) => {
    let t = e.length,
      n = ``,
      r = 2
    for (; r < t; r += 3)
      ((n += tg[e[r - 2] >> 2]),
        (n += tg[((e[r - 2] & 3) << 4) | (e[r - 1] >> 4)]),
        (n += tg[((e[r - 1] & 15) << 2) | (e[r] >> 6)]),
        (n += tg[e[r] & 63]))
    return (
      r === t + 1 && ((n += tg[e[r - 2] >> 2]), (n += tg[(e[r - 2] & 3) << 4]), (n += `==`)),
      r === t &&
        ((n += tg[e[r - 2] >> 2]),
        (n += tg[((e[r - 2] & 3) << 4) | (e[r - 1] >> 4)]),
        (n += tg[(e[r - 1] & 15) << 2]),
        (n += `=`)),
      n
    )
  },
  $h = new TextEncoder(),
  eg = (e) => e.replace(/[\n\r]/g, ``),
  tg = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/`,
  ng = new Uint8Array(123).fill(255)
for (let e = 0; e < 64; e++) ng[tg.charCodeAt(e)] = e
ng[61] = 0
var rg = (e) => {
    if (e >= ng.length || ng[e] === 255)
      throw TypeError(`Invalid character ${String.fromCharCode(e)}`)
    return ng[e]
  },
  ig = `~effect/http/Cookies`,
  ag = `~effect/http/Cookies/Cookie`,
  og = {
    [ig]: ig,
    ...bt,
    toJSON() {
      return { _id: `effect/Cookies`, cookies: xi(this.cookies, (e) => e.toJSON()) }
    },
    pipe() {
      return e(this, arguments)
    },
  },
  sg = (e) => {
    let t = Object.create(og)
    return ((t.cookies = e), t)
  },
  cg = (e) => {
    let t = {}
    for (let n of e) C(t, n.name, n)
    return sg(t)
  },
  lg = (e) => {
    let t = typeof e == `string` ? [e] : e,
      n = []
    for (let e of t) {
      let t = ug(e.trim())
      t && n.push(t)
    }
    return cg(n)
  }
function ug(e) {
  let t = e
    .split(`;`)
    .map((e) => e.trim())
    .filter((e) => e !== ``)
  if (t.length === 0) return
  let n = t[0].indexOf(`=`)
  if (n === -1) return
  let r = t[0].slice(0, n)
  if (!fg.test(r)) return
  let i = t[0].slice(n + 1),
    a = hg(i)
  if (t.length === 1)
    return Object.assign(Object.create(pg), { name: r, value: a, valueEncoded: i })
  let o = {}
  for (let e = 1; e < t.length; e++) {
    let n = t[e],
      r = n.indexOf(`=`),
      i = r === -1 ? n : n.slice(0, r).trim(),
      a = r === -1 ? void 0 : n.slice(r + 1).trim()
    switch (i.toLowerCase()) {
      case `domain`: {
        if (a === void 0) break
        let e = a.trim().replace(/^\./, ``)
        e && (o.domain = e)
        break
      }
      case `expires`: {
        if (a === void 0) break
        let e = new Date(a)
        isNaN(e.getTime()) || (o.expires = e)
        break
      }
      case `max-age`: {
        if (a === void 0) break
        let e = parseInt(a, 10)
        isNaN(e) || (o.maxAge = Ga(e))
        break
      }
      case `path`:
        if (a === void 0) break
        a[0] === `/` && (o.path = a)
        break
      case `priority`:
        if (a === void 0) break
        switch (a.toLowerCase()) {
          case `low`:
            o.priority = `low`
            break
          case `medium`:
            o.priority = `medium`
            break
          case `high`:
            o.priority = `high`
        }
        break
      case `httponly`:
        o.httpOnly = !0
        break
      case `secure`:
        o.secure = !0
        break
      case `partitioned`:
        o.partitioned = !0
        break
      case `samesite`:
        if (a === void 0) break
        switch (a.toLowerCase()) {
          case `lax`:
            o.sameSite = `lax`
            break
          case `strict`:
            o.sameSite = `strict`
            break
          case `none`:
            o.sameSite = `none`
        }
    }
  }
  return Object.assign(Object.create(pg), {
    name: r,
    value: a,
    valueEncoded: i,
    options: Object.keys(o).length > 0 ? o : void 0,
  })
}
var dg = cg([]),
  fg = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/,
  pg = {
    [ag]: ag,
    ...bt,
    toJSON() {
      return {
        _id: `effect/Cookies/Cookie`,
        name: this.name,
        value: this.value,
        options: this.options,
      }
    },
  }
function mg(e) {
  let t = {},
    n = e.length,
    r = 0,
    i = 0
  for (; i !== n;) {
    ;((i = e.indexOf(`;`, r)), i === -1 && (i = n))
    let a = e.indexOf(`=`, r)
    if (a === -1) break
    if (a > i) {
      r = i + 1
      continue
    }
    let o = e.substring(r, a++).trim()
    if (!Object.hasOwn(t, o)) {
      let n = e.charCodeAt(a) === 34 ? e.substring(a + 1, i - 1).trim() : e.substring(a, i).trim()
      C(t, o, n.indexOf(`%`) === -1 ? n : hg(n))
    }
    r = i + 1
  }
  return t
}
var hg = (e) => {
    try {
      return decodeURIComponent(e)
    } catch {
      return e
    }
  },
  gg = `~effect/http/UrlParams`,
  _g = (e) => h(e, gg),
  vg = {
    ...Ft,
    [gg]: gg,
    [Symbol.iterator]() {
      return this.params[Symbol.iterator]()
    },
    toJSON() {
      return { _id: `UrlParams`, params: Object.fromEntries(this.params) }
    },
    [b](e) {
      return Sg(this, e)
    },
    [g]() {
      return Me(this.params.flat())
    },
  },
  yg = (e) => {
    let t = Object.create(vg)
    return ((t.params = e), t)
  },
  bg = (e) => {
    if (_g(e)) return e
    let t = xg(e),
      n = []
    for (let e = 0; e < t.length; e++)
      if (Array.isArray(t[e][0])) {
        let [r, i] = t[e]
        n.push([`${r[0]}[${r.slice(1).join(`][`)}]`, i])
      } else n.push(t[e])
    return yg(n)
  },
  xg = (e) => {
    let t = typeof e[Symbol.iterator] == `function` ? F(e) : Object.entries(e),
      n = []
    for (let [e, r] of t)
      if (Array.isArray(r))
        for (let t = 0; t < r.length; t++) r[t] !== void 0 && n.push([e, String(r[t])])
      else if (typeof r == `object` && r) {
        let t = xg(r)
        for (let [r, i] of t) n.push([[e, ...(typeof r == `string` ? [r] : r)], i])
      } else r !== void 0 && n.push([e, String(r)])
    return n
  },
  Sg = Sn((e, t) => Cg(e.params, t.params)),
  Cg = va(pi([wn(), wn()])),
  wg = yg([]),
  Tg = r(2, (e, t) => yg(t(e.params))),
  Eg = r(2, (e, t) => {
    let n = bg(t).params.slice(),
      r = new Set()
    for (let e = 0; e < n.length; e++) r.add(n[e][0])
    for (let t = 0; t < e.params.length; t++) r.has(e.params[t][0]) || n.push(e.params[t])
    return yg(n)
  }),
  Dg = r(2, (e, t) => Tg(e, Ni(bg(t).params))),
  Og = (e) => new URLSearchParams(bg(e).params).toString(),
  kg = (e) => {
    let t = {}
    for (let [n, r] of e.params)
      if (!Object.hasOwn(t, n)) C(t, n, r)
      else {
        let e = t[n]
        typeof e == `string` ? C(t, n, [e, r]) : e.push(r)
      }
    return t
  }
function Ag(e) {
  return e.checks ? e.checks[e.checks.length - 1].annotations : e.annotations
}
function jg(e) {
  return (t) => Ag(t)?.[e]
}
var Mg = `~structural`,
  Ng = `~sentinels`,
  Pg = `~constructor`,
  Fg = p((e) => {
    let t = Ag(e)?.identifier
    return typeof t == `string` ? t : e.getExpected(Fg)
  }),
  G = Symbol(),
  K = Jd,
  Ig = K(G),
  q = K(G),
  Lg = (e) => (e === G ? A() : j(e)),
  Rg = (e) => (e._tag === `None` ? Ig : K(e.value)),
  zg = `~effect/SchemaIssue/Issue`
function Bg(e) {
  return h(e, zg) && e[zg] === zg
}
function Vg(e) {
  return Object.hasOwn(e, `input`)
}
var Hg = class {
    [zg] = zg
    constructor(e, t) {
      t?.reportInput === !0 && e !== G && (this.input = e)
    }
  },
  Ug = class extends Hg {
    _tag = `Filter`
    filter
    issue
    constructor(e, t, n, r) {
      ;(super(n, r), (this.filter = e), (this.issue = t))
    }
  },
  Wg = class extends Hg {
    _tag = `Encoding`
    ast
    issue
    constructor(e, t, n, r) {
      ;(super(n, r), (this.ast = e), (this.issue = t))
    }
  },
  Gg = class extends Hg {
    _tag = `Pointer`
    path
    issue
    constructor(e, t) {
      ;(super(), (this.path = e), (this.issue = t))
    }
  },
  Kg = class extends Hg {
    _tag = `MissingKey`
    annotations
    constructor(e) {
      ;(super(), (this.annotations = e))
    }
  },
  qg = class extends Hg {
    _tag = `UnexpectedKey`
    ast
    constructor(e, t, n) {
      ;(super(t, n), (this.ast = e))
    }
  },
  J = class extends Hg {
    _tag = `Composite`
    ast
    issues
    constructor(e, t, n, r) {
      ;(super(n, r), (this.ast = e), (this.issues = t))
    }
  },
  Jg = class extends Hg {
    _tag = `InvalidType`
    ast
    constructor(e, t, n) {
      ;(super(t, n), (this.ast = e))
    }
  },
  Yg = class extends Hg {
    _tag = `InvalidValue`
    annotations
    constructor(e, t, n) {
      ;(super(t, n), (this.annotations = e))
    }
  }
function Xg(e, t, n, r, i) {
  return new J(e, [new Gg([t], n)], r, i)
}
var Zg = class extends Hg {
    _tag = `Forbidden`
    annotations
    constructor(e, t, n) {
      ;(super(t, n), (this.annotations = e))
    }
  },
  Qg = class extends Hg {
    _tag = `AnyOf`
    ast
    issues
    constructor(e, t, n, r) {
      ;(super(n, r), (this.ast = e), (this.issues = t))
    }
  },
  $g = class extends Hg {
    _tag = `OneOf`
    ast
    successes
    constructor(e, t, n, r) {
      ;(super(n, r), (this.ast = e), (this.successes = t))
    }
  }
function e_(e, t, n) {
  if (Bg(e)) return e
  if (typeof e == `string`) return new Yg({ message: e }, t, n)
  let r = typeof e.issue == `string` ? new Yg({ message: e.issue }, t, n) : e.issue
  return new Gg(e.path, r)
}
function t_(e, t, n) {
  if (e !== void 0) return typeof e == `boolean` ? (e ? void 0 : new Yg(void 0, t, n)) : e_(e, t, n)
}
function n_(e, t, n, r) {
  return Array.isArray(t)
    ? Li(t)
      ? t.length === 1
        ? e_(t[0], n, r)
        : new J(
            e,
            ua(t, (e) => e_(e, n, r)),
            n,
            r,
          )
      : void 0
    : t_(t, n, r)
}
var r_ = (e) => {
    let t = f_(e)
    if (t !== void 0) return t
    switch (e._tag) {
      case `InvalidType`:
        return s_(Fg(e.ast), e)
      case `InvalidValue`: {
        let t = o_(e)
        if (t !== void 0) return s_(t, e)
        let n = a_(e)
        return n === void 0 ? `Expected a valid value` : `Invalid data ${n}`
      }
      case `MissingKey`:
        return `Missing key`
      case `UnexpectedKey`: {
        let t = a_(e)
        return t === void 0 ? `Expected no excess property` : `Unexpected key with value ${t}`
      }
      case `Forbidden`:
        return `Forbidden operation`
      case `OneOf`: {
        let t = a_(e)
        return t === void 0
          ? `Expected exactly one member to match`
          : `Expected exactly one member to match the input ${t}`
      }
    }
  },
  i_ = (e) => f_(e.issue) ?? f_(e)
function a_(e) {
  return Vg(e) ? S(e.input) : void 0
}
function o_(e) {
  let t = e.annotations?.expected
  return typeof t == `string` ? t : void 0
}
function s_(e, t) {
  let n = a_(t)
  return n === void 0 ? `Expected ${e}` : `Expected ${e}, got ${n}`
}
function c_(e) {
  let t = e.annotations?.expected
  if (typeof t == `string`) return t
  switch (e._tag) {
    case `Filter`:
      return `<filter>`
    case `FilterGroup`:
      return e.checks.map((e) => c_(e)).join(` & `)
  }
}
function l_() {
  return (e) => d_(e, ``)
}
var u_ = l_()
function d_(e, t) {
  let n
  switch (e._tag) {
    case `Filter`: {
      let r = i_(e)
      if (r !== void 0) n = r
      else {
        if (e.issue._tag !== `InvalidValue`) return d_(e.issue, t)
        let r = o_(e.issue)
        n = r === void 0 ? s_(c_(e.filter), e) : s_(r, e.issue)
      }
      break
    }
    case `Encoding`:
      return d_(e.issue, t)
    case `Pointer`:
      return d_(e.issue, t + ft(e.path))
    case `Composite`:
    case `AnyOf`:
      if (e._tag === `Composite` || e.issues.length > 0)
        return e.issues.map((e) => d_(e, t)).join(`
`)
      n = f_(e) ?? s_(Fg(e.ast), e)
      break
    default:
      n = r_(e)
  }
  return t ? `${n}\n  at ${t}` : n
}
function f_(e) {
  if (e._tag === `Pointer`) return
  if (e._tag === `Encoding`) return f_(e.issue)
  let t = (
    e._tag === `Filter`
      ? e.filter.annotations
      : `annotations` in e
        ? e.annotations
        : e.ast.annotations
  )?.[
    e._tag === `MissingKey`
      ? `messageMissingKey`
      : e._tag === `UnexpectedKey`
        ? `messageUnexpectedKey`
        : `message`
  ]
  if (typeof t == `string`) return t
}
function p_(e) {
  let t
  for (let n of e.reasons) {
    if (!kd(n) || !Bg(n.error)) return
    t ??= n.error
  }
  return t
}
function m_(e, t) {
  let n = p_(e)
  if (n === void 0) throw Error(t, { cause: e })
  return n
}
var h_ = (e) => Object.assign(Object.create(t), e)
function g_(e) {
  return S_((t, n) => W(e(t, n)))
}
function __(e) {
  return g_((t, n) => {
    let r = { message: e(t) }
    return ir(t) ? new Zg(r, t.value, n) : new Zg(r)
  })
}
var v_ = __(() => `Encoding is not supported`),
  y_ = h_({ _tag: `Passthrough` })
function b_() {
  return y_
}
function Y(e) {
  return h_({ _tag: `Transform`, transform: e })
}
function x_(e) {
  return h_({ _tag: `TransformEffect`, transform: e })
}
function S_(e) {
  return h_({ _tag: `TransformOptionalEffect`, transform: e })
}
function C_() {
  return Y(globalThis.String)
}
function w_() {
  return Y(globalThis.Number)
}
function T_(e) {
  return x_((t, n) =>
    Xp({
      try: () => JSON.parse(t, e?.reviver),
      catch: () => new Yg({ expected: `a valid JSON string` }, t, n),
    }),
  )
}
function E_(e) {
  return x_((t, n) =>
    Xp({
      try: () => {
        let n = JSON.stringify(t, e?.replacer, e?.space)
        if (n === void 0) throw TypeError(`Value cannot be represented as JSON`)
        return n
      },
      catch: () => new Yg({ expected: `a JSON-serializable value` }, t, n),
    }),
  )
}
function D_() {
  return Y(Xh)
}
function O_() {
  return x_((e, t) => _h($p(Zh(e)), () => new Yg({ expected: `a valid Base64 string` }, e, t)))
}
var k_ = class extends n {
    _tag = `Middleware`
    decode
    encode
    constructor(e, t) {
      ;(super(), (this.decode = e), (this.encode = t))
    }
    flip() {
      return new k_(this.encode, this.decode)
    }
  },
  A_ = `~effect/SchemaTransformation/Transformation`,
  X = class extends n {
    [A_] = A_
    _tag = `Transformation`
    decode
    encode
    constructor(e, t) {
      ;(super(), (this.decode = e), (this.encode = t))
    }
    flip() {
      return new X(this.encode, this.decode)
    }
  }
function j_(e) {
  return h(e, A_) && e[A_] === A_
}
var M_ = (e) => (j_(e) ? e : new X(e.decode, e.encode))
function N_(e) {
  return new X(x_(e.decode), x_(e.encode))
}
function P_(e) {
  return new X(Y(e.decode), Y(e.encode))
}
var F_ = new X(b_(), b_())
function I_() {
  return F_
}
var L_ = new X(w_(), C_()),
  R_ = (e) => ye(e) && typeof e.message == `string`,
  z_ = (e) => {
    let t = Object.hasOwn(e, `cause`) ? Error(e.message, { cause: U_(e.cause) }) : Error(e.message)
    return (
      typeof e.name == `string` && e.name !== `Error` && (t.name = e.name),
      typeof e.stack == `string` && (t.stack = e.stack),
      t
    )
  },
  B_ = (e) => {
    try {
      let t = gt(e)
      return t === void 0 ? S(e) : JSON.parse(t)
    } catch {
      return S(e)
    }
  },
  V_ = (e, t, n) => {
    let r = { name: e.name, message: typeof e.message == `string` ? e.message : `` }
    return (
      t?.includeStack && typeof e.stack == `string` && (r.stack = e.stack),
      !t?.excludeCause && e.cause !== void 0 && (r.cause = n(e.cause)),
      r
    )
  },
  H_ = (e) => {
    let t = new WeakSet(),
      n = (r) => {
        if (Se(r)) {
          if (t.has(r)) return `[Circular]`
          t.add(r)
          let i = V_(r, e, n)
          return (t.delete(r), i)
        }
        return B_(r)
      }
    return n
  },
  U_ = (e) => (R_(e) ? z_(e) : e),
  W_ = (e) => P_({ decode: U_, encode: H_(e) }),
  G_ = new X(O_(), D_())
function K_(e) {
  return new X(T_(e ?? {}), E_(e))
}
function q_(e) {
  return (t) => t._tag === e
}
var J_ = q_(`Declaration`),
  Y_ = q_(`Null`),
  X_ = q_(`Void`),
  Z_ = q_(`Never`),
  Q_ = q_(`Literal`),
  $_ = q_(`UniqueSymbol`),
  ev = q_(`Arrays`),
  tv = q_(`Objects`),
  nv = q_(`Union`),
  rv = q_(`Suspend`),
  Z = class {
    to
    transformation
    constructor(e, t) {
      ;((this.to = e), (this.transformation = t))
    }
  },
  iv = {},
  av = class {
    isOptional
    isMutable
    constructorDefault
    annotations
    constructor(e, t, n = void 0, r = void 0) {
      ;((this.isOptional = e),
        (this.isMutable = t),
        (this.constructorDefault = n),
        (this.annotations = r))
    }
  },
  ov = `~effect/Schema`,
  sv = class {
    [ov] = ov
    annotations
    checks
    encoding
    context
    constructor(e = void 0, t = void 0, n = void 0, r = void 0) {
      ;((this.annotations = e), (this.checks = t), (this.encoding = n), (this.context = r))
    }
    toString() {
      return `<${this._tag}>`
    }
  },
  cv = class extends sv {
    _tag = `Declaration`
    typeParameters
    run
    encodingChecks
    encodingRun
    constructor(e, t, n, r, i, a, o, s) {
      ;(super(n, r, i, a),
        (this.typeParameters = e),
        (this.run = t),
        (this.encodingChecks = o),
        (this.encodingRun = s))
    }
    getParser() {
      let e
      return (t, n) => (t === G ? Ig : (e ??= this.run(this.typeParameters))(t, this, n))
    }
    _rebuild(e, t, n, r, i) {
      let a = Ay(this.typeParameters, e)
      return a === this.typeParameters &&
        t === this.checks &&
        n === this.encodingChecks &&
        r === this.run &&
        i === this.encodingRun
        ? this
        : new cv(a, r, this.annotations, t, void 0, this.context, n, i)
    }
    recur(e) {
      return this._rebuild(e, this.checks, this.encodingChecks, this.run, this.encodingRun)
    }
    flip(e) {
      return this._rebuild(
        e,
        this.encodingChecks,
        this.checks,
        this.encodingRun ?? this.run,
        this.run,
      )
    }
    getExpected() {
      let e = this.annotations?.expected
      return typeof e == `string` ? e : `<Declaration>`
    }
  },
  lv = new (class extends sv {
    _tag = `Null`
    getParser() {
      return Jy(this, null)
    }
    getExpected() {
      return `null`
    }
  })(),
  uv = class extends sv {
    _tag = `Undefined`
    getParser() {
      return Jy(this, void 0)
    }
    toCodecJson() {
      return Q(this, [dv])
    }
    getExpected() {
      return `undefined`
    }
  },
  dv = new Z(
    lv,
    new X(
      Y(() => void 0),
      Y(() => null),
    ),
  ),
  fv = new uv(),
  pv = new (class extends sv {
    _tag = `Void`
    getParser() {
      let e = K(void 0)
      return (t) => (t === G ? Ig : e)
    }
    toCodecJson() {
      return Q(this, [dv])
    }
    getExpected() {
      return `void`
    }
  })(),
  mv = new (class extends sv {
    _tag = `Never`
    getParser() {
      return Yy(this, ge)
    }
    getExpected() {
      return `never`
    }
  })(),
  hv = new (class extends sv {
    _tag = `Unknown`
    getParser() {
      return Yy(this, _e)
    }
    getExpected() {
      return `unknown`
    }
  })(),
  gv = class extends sv {
    _tag = `Literal`
    literal
    constructor(e, t, n, r, i) {
      if ((super(t, n, r, i), typeof e == `number` && !globalThis.Number.isFinite(e)))
        throw Error(`A numeric literal must be finite, got ${S(e)}`)
      this.literal = e
    }
    getParser() {
      return Jy(this, this.literal)
    }
    matchPart(e, t) {
      return e === globalThis.String(this.literal) ? this.literal : void 0
    }
    toCodecJson() {
      return typeof this.literal == `bigint` ? _v(this) : this
    }
    toCodecStringTree() {
      return typeof this.literal == `string` ? this : _v(this)
    }
    getExpected() {
      return typeof this.literal == `string`
        ? JSON.stringify(this.literal)
        : globalThis.String(this.literal)
    }
  }
function _v(e) {
  let t = globalThis.String(e.literal)
  return Q(e, [
    new Z(
      new gv(t),
      new X(
        Y(() => e.literal),
        Y(() => t),
      ),
    ),
  ])
}
var vv = new (class extends sv {
    _tag = `String`
    getParser() {
      return Yy(this, ae)
    }
    matchPart(e, t) {
      let n = this.checks
      return n && !t.disableChecks && ib(n, e, void 0, this, t) ? void 0 : e
    }
    getExpected() {
      return `string`
    }
  })(),
  yv = class extends sv {
    _tag = `Number`
    getParser() {
      return Yy(this, oe)
    }
    matchKey(e, t) {
      return this._match($y, e, t)
    }
    matchPart(e, t) {
      return this._match(Qy, e, t)
    }
    _match(e, t, n) {
      if (!e.test(t)) return
      let r = globalThis.Number(t)
      return n.disableChecks || !this.checks ? r : ib(this.checks, r, void 0, this, n) ? void 0 : r
    }
    toCodecJson() {
      return this.checks &&
        (bv(this.checks, `effect/schema/isFinite`) || bv(this.checks, `effect/schema/isInt`))
        ? this
        : Q(this, [my])
    }
    toCodecStringTree() {
      return this.toCodecJson() === this ? Q(this, [nb]) : Q(this, [rb])
    }
    getExpected() {
      return `number`
    }
  }
function bv(e, t) {
  return e.some(
    (e) => e.annotations?.representation?.id === t || (e._tag === `FilterGroup` && bv(e.checks, t)),
  )
}
var xv = new yv(),
  Sv = new (class extends sv {
    _tag = `Boolean`
    getParser() {
      return Yy(this, se)
    }
    getExpected() {
      return `boolean`
    }
  })(),
  Cv = class extends sv {
    _tag = `Arrays`
    isMutable
    elements
    rest
    encodingChecks
    constructor(e, t, n, r, i, a, o, s) {
      ;(super(r, i, a, o),
        (this.isMutable = e),
        (this.elements = t),
        (this.rest = n),
        (this.encodingChecks = s))
      let c = !1
      for (let e = 0; e < t.length; e++)
        if (zy(t[e])) c = !0
        else if (c) throw Error(`A required element cannot follow an optional element. ts(1257)`)
      if (c && n.length > 1)
        throw Error(`A required element cannot follow an optional element. ts(1257)`)
      for (let e = 1; e < n.length; e++)
        if (zy(n[e])) throw Error(`An optional element cannot follow a rest element. ts(1266)`)
    }
    getParser(e, t = e) {
      let n = this,
        r,
        i,
        a = n.elements.length,
        o = Math.max(0, n.rest.length - 1)
      function s(e, t) {
        return t < a ? r[t] : t >= e ? i[t - e + 1] : i[0]
      }
      let c = (e) => {
          let { input: t, len: r, options: i } = e
          if (n.rest.length === 0 && r > a)
            for (let o = a; o < r; o++) {
              let r = new qg(n, t[o], i),
                a = new Gg([o], r)
              if (i.errors === `all`) e.issues ? e.issues.push(a) : (e.issues = [a])
              else return W(new J(n, [a], t, i))
            }
          return e.issues ? W(new J(n, e.issues, t, i)) : K(e.output)
        },
        l = (e, t) => {
          let r = e.length,
            i = {
              ast: n,
              getParser: s,
              input: e,
              len: r,
              tailThreshold: Math.max(a, r - o),
              output: new globalThis.Array(r),
              issues: void 0,
              options: t,
            },
            u = n.rest.length === 0 ? a : Math.max(r, a + o),
            d = t.concurrency === void 0 ? 1 : hu(t.concurrency),
            f = d === 1 ? Ev(i, e, 0, u) : Dv(i, e, { concurrency: d, end: u })
          if (!f) return c(i)
          if (U(f)) return yh(f, () => c(i))
          let p = !0
          return Vp(() => (p ? ((p = !1), em(f, () => c(i))) : l(e, t)))
        }
      return (e, a) => {
        if (e === G) return Ig
        try {
          return Array.isArray(e)
            ? (r ||
                ((r = n.elements.map((e) => ({ ast: e, parser: t(e) }))),
                (i = n.rest.map((e) => ({ ast: e, parser: t(e) })))),
              l(e, a))
            : W(new Jg(n, e, a))
        } catch (e) {
          return Yp(e)
        }
      }
    }
    _rebuild(e, t, n) {
      let r = Ay(this.elements, e),
        i = Ay(this.rest, e)
      return r === this.elements &&
        i === this.rest &&
        t === this.checks &&
        n === this.encodingChecks
        ? this
        : new Cv(this.isMutable, r, i, this.annotations, t, void 0, this.context, n)
    }
    recur(e) {
      return this._rebuild(e, this.checks, this.encodingChecks)
    }
    flip(e) {
      return this._rebuild(e, this.encodingChecks, this.checks)
    }
    getExpected() {
      return `array`
    }
  }
function wv(e, t, n, r) {
  if (n._tag === `Failure`) return Ov(e, e.ast, r, n)
  let i = n === q ? t : n[w]
  if (i !== G) e.output[r] = i
  else {
    let t = e.getParser(e.tailThreshold, r)
    if (zy(t.ast)) return
    let n = new Gg([r], new Kg(t.ast.context?.annotations))
    if (e.options.errors === `all`) e.issues ? e.issues.push(n) : (e.issues = [n])
    else return Xd(new J(e.ast, [n], e.input, e.options))
  }
}
var Tv = {
    onItem(e, t, n) {
      let r = n < e.len ? t : G
      return e.getParser(e.tailThreshold, n).parser(r, e.options)
    },
    step: wv,
  },
  Ev = gu()(Tv),
  Dv = vu()(Tv),
  Ov = (e, t, n, r) => {
    if (r.cause.reasons.length === 0) return r
    let i = p_(r.cause)
    if (i === void 0) return Yd(Ld(r.cause, (r) => new J(t, [new Gg([n], r)], e.input, e.options)))
    let a = new Gg([n], i)
    if (e.options.errors === `all`) e.issues ? e.issues.push(a) : (e.issues = [a])
    else return Xd(new J(t, [a], e.input, e.options))
  },
  kv = `[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?`
function Av(e, t, n = iv) {
  let r, i
  function a(t) {
    switch (t._tag) {
      case `String`:
      case `TemplateLiteral`:
        return (r ??= Object.keys(e)).filter((e) => t.matchPart(e, n) !== void 0)
      case `Number`:
        return (r ??= Object.keys(e)).filter((e) => t.matchKey(e, n) !== void 0)
      case `Symbol`:
        return (i ??= Object.getOwnPropertySymbols(e)).filter(
          (r) => Object.prototype.propertyIsEnumerable.call(e, r) && t.matchKey(r, n) !== void 0,
        )
      case `Union`:
        return [...new Set(t.types.flatMap(a))]
      default:
        return []
    }
  }
  return a(Xy(Wy(t)))
}
var jv = class {
  name
  type
  constructor(e, t) {
    ;((this.name = e), (this.type = t))
  }
}
function Mv(e) {
  switch (e._tag) {
    case `String`:
    case `Number`:
    case `Symbol`:
    case `TemplateLiteral`:
      return !0
    case `Union`:
      return e.types.every(Mv)
    default:
      return !1
  }
}
function Nv(e) {
  let t = by(e)
  switch (t._tag) {
    case `String`:
    case `Number`:
    case `Symbol`:
    case `TemplateLiteral`:
      return !0
    case `Union`:
      return t.types.every(Nv)
    default:
      return !1
  }
}
function Pv(e) {
  return Mv(e) && Nv(e)
}
var Fv = class {
    parameter
    type
    constructor(e, t) {
      if (!Pv(e)) throw Error(`Invalid index signature parameter ${e._tag}`)
      if (((this.parameter = e), (this.type = t), zy(t) && !qy(t)))
        throw Error(
          "Cannot use `Schema.optionalKey` with index signatures, use `Schema.optional` instead.",
        )
    }
  },
  Iv = class extends sv {
    _tag = `Objects`
    propertySignatures
    indexSignatures
    encodingChecks
    constructor(e, t, n, r, i, a, o) {
      ;(super(n, r, i, a),
        (this.propertySignatures = e),
        (this.indexSignatures = t),
        (this.encodingChecks = o))
    }
    getParser(e, t = e) {
      let n = this,
        r = n.propertySignatures.length,
        i = n.indexSignatures.length
      if (!r && !i) return Yy(n, he)
      let a,
        o,
        s = () => (
          a ||
            ((a = n.propertySignatures.map((e) => ({
              parser: t(e.type),
              name: e.name,
              type: e.type,
            }))),
            (o = i
              ? n.indexSignatures.map((n) => ({
                  is: n,
                  parserKey: e(Xy(n.parameter)),
                  parserValue: t(n.type),
                }))
              : void 0)),
          a
        ),
        c = () => {
          let e = new Set(
              n.propertySignatures.map((e) =>
                typeof e.name == `number` ? globalThis.String(e.name) : e.name,
              ),
            ),
            t = (t, i, a, o, s) => {
              if (s._tag === `Failure`) return Ov(t, n, i, s) ?? Zd
              let c = s === q ? o : s[w]
              if (a !== G && c !== G) {
                if (r && (e.has(i) || e.has(typeof a == `number` ? globalThis.String(a) : a)))
                  return Zd
                C(t.out, a, c)
              }
              return Zd
            },
            c = (e, r, i, a) => {
              if (!a) {
                let t = i.parserKey(r, e.options)
                if (!U(t)) return em(om(t), (t) => c(e, r, i, t))
                a = t
              }
              if (a._tag === `Failure`) return Ov(e, n, r, a) ?? Zd
              let o = a === q ? r : a[w],
                s = e.input[r],
                l = i.parserValue(s, e.options)
              return U(l) ? t(e, r, o, s, l) : em(om(l), (n) => t(e, r, o, s, n))
            },
            l = (e, n, r) => {
              let i = e.input[n],
                a = r.parserValue(i, e.options)
              return U(a) ? t(e, n, n, i, a) : em(om(a), (r) => t(e, n, n, i, r))
            },
            u = i
              ? vu()({
                  onItem: (e, [t, n]) => (n.is.parameter === vv ? l(e, t, n) : c(e, t, n)),
                  step: (e, t, n) => (n._tag === `Failure` ? n : void 0),
                })
              : void 0
          return bh(function* (t, d) {
            if (t === G) return G
            if (typeof t != `object` || !t || Array.isArray(t)) return yield* W(new Jg(n, t, d))
            s()
            let f = t,
              p = {},
              m = { ast: n, input: f, out: p, issues: void 0, options: d },
              ee = d.errors === `all`,
              te = d.onExcessProperty === `error`,
              ne = d.concurrency === void 0 ? 1 : hu(d.concurrency),
              re = i && te ? n.indexSignatures.map((e) => Av(f, e.parameter, d)) : void 0
            if (te) {
              let r = re ? new Set(e) : e
              if (re) for (let e of re) for (let t of e) r.add(t)
              let i = Reflect.ownKeys(f)
              for (let e = 0; e < i.length; e++) {
                let a = i[e]
                if (!r.has(a) && Object.prototype.propertyIsEnumerable.call(f, a)) {
                  let e = new qg(n, f[a], d),
                    r = new Gg([a], e)
                  if (ee) {
                    m.issues ? m.issues.push(r) : (m.issues = [r])
                    continue
                  }
                  return yield* W(new J(n, [r], t, d))
                }
              }
            }
            if (r) {
              let e = ne === 1 ? zv(m, a) : Bv(m, a, { concurrency: ne })
              e && (yield* e)
            }
            if (i && ne === 1)
              for (let e = 0; e < i; e++) {
                let t = o[e],
                  n = t.is.parameter === vv ? l : c,
                  r = re?.[e] ?? (t.is.parameter === vv ? Object.keys(f) : Av(f, t.is.parameter, d))
                for (let e = 0; e < r.length; e++) {
                  let i = n(m, r[e], t)
                  if (!U(i)) yield* i
                  else if (i._tag === `Failure`) return yield* i
                }
              }
            else if (u) {
              let e = ca()
              for (let t = 0; t < i; t++) {
                let n = o[t],
                  r = re?.[t] ?? (n.is.parameter === vv ? Object.keys(f) : Av(f, n.is.parameter, d))
                for (let t = 0; t < r.length; t++) e.push([r[t], n])
              }
              let t = u(m, e, { concurrency: ne })
              t && (yield* t)
            }
            return m.issues ? yield* W(new J(n, m.issues, t, d)) : p
          })
        }
      if (i) return c()
      let l,
        u = (e, t, n) => {
          let r = a[t]
          return em(om(n), (n) => {
            let i = Lv(e, r, n)
            if (i) return i
            let o = () => K(e.out),
              s = zv(e, a.slice(t + 1))
            return s ? yh(s, o) : o()
          })
        }
      return (e, t) => {
        if (e === G) return Ig
        if (
          t.errors === `all` ||
          t.onExcessProperty !== void 0 ||
          (t.concurrency !== void 0 && hu(t.concurrency) !== 1)
        )
          return (l ??= c())(e, t)
        if (typeof e != `object` || !e || Array.isArray(e)) return W(new Jg(n, e, t))
        let r = s(),
          i = e,
          a = {},
          o = { ast: n, input: i, out: a, issues: void 0, options: t }
        try {
          for (let e = 0; e < r.length; e++) {
            let n = r[e],
              s = n.name,
              c = Qv(i, s),
              l = c ? i[s] : G,
              d = n.parser(l, t)
            if (!U(d)) return u(o, e, d)
            if (d === q) {
              c && C(a, s, l)
              continue
            }
            let f = Lv(o, n, d)
            if (f) return f
          }
        } catch (e) {
          return Yp(e)
        }
        return K(a)
      }
    }
    _rebuild(e, t, n, r) {
      let i = Ay(this.propertySignatures, (t) => {
          let n = e(t.type)
          return n === t.type ? t : new jv(t.name, n)
        }),
        a = Ay(this.indexSignatures, (n) => {
          let r = t(n.parameter),
            i = e(n.type)
          return r === n.parameter && i === n.type ? n : new Fv(r, i)
        })
      return i === this.propertySignatures &&
        a === this.indexSignatures &&
        n === this.checks &&
        r === this.encodingChecks
        ? this
        : new Iv(i, a, this.annotations, n, void 0, this.context, r)
    }
    flip(e) {
      return this._rebuild(e, e, this.encodingChecks, this.checks)
    }
    recur(e, t = e) {
      return this._rebuild(e, t, this.checks, this.encodingChecks)
    }
    getExpected() {
      return this.propertySignatures.length === 0 && this.indexSignatures.length === 0
        ? `object | array`
        : `object`
    }
  }
function Lv(e, t, n) {
  if (n._tag === `Failure`) return Ov(e, e.ast, t.name, n)
  if (n === q) return
  let r = n[w]
  if (r !== G) {
    C(e.out, t.name, r)
    return
  }
  if ((delete e.out[t.name], !zy(t.type))) {
    let n = new Gg([t.name], new Kg(t.type.context?.annotations))
    if (e.options.errors === `all`) {
      e.issues ? e.issues.push(n) : (e.issues = [n])
      return
    }
    return Xd(new J(e.ast, [n], e.input, e.options))
  }
}
var Rv = {
    onItem(e, t) {
      if (!Qv(e.input, t.name)) return t.parser(G, e.options)
      let n = e.input[t.name]
      return (C(e.out, t.name, n), t.parser(n, e.options))
    },
    step: Lv,
  },
  zv = gu()(Rv),
  Bv = vu()(Rv)
function Vv(e, t) {
  return e ? (t ? [...e, ...t] : e) : t
}
function Hv(e, t, n) {
  return new Iv(
    Reflect.ownKeys(e).map((t) => new jv(t, e[t].ast)),
    [],
    n,
    t,
  )
}
function Uv(e) {
  return e.ast
}
function Wv(e, t = void 0) {
  return new Cv(
    !1,
    e.map((e) => e.ast),
    [],
    void 0,
    t,
  )
}
function Gv(e, t, n) {
  return new ey(e.map(Uv), t, void 0, n)
}
var Kv = m((e) => {
  for (;;) {
    if (rv(e)) return hv
    let t = e.encoding
    if (!t) return e.recur?.(Kv, i) ?? e
    if (t.some((e) => e.transformation._tag === `Middleware` && e.transformation.decode !== i))
      return hv
    e = t[t.length - 1].to
  }
})
function qv(e) {
  switch (e._tag) {
    case `Null`:
      return [`null`]
    case `Undefined`:
      return [`undefined`]
    case `String`:
    case `TemplateLiteral`:
      return [`string`]
    case `Number`:
      return [`number`]
    case `Boolean`:
      return [`boolean`]
    case `Symbol`:
    case `UniqueSymbol`:
      return [`symbol`]
    case `BigInt`:
      return [`bigint`]
    case `Arrays`:
      return [`array`]
    case `ObjectKeyword`:
      return [`object`, `array`, `function`]
    case `Objects`:
      return e.propertySignatures.length || e.indexSignatures.length
        ? [`object`]
        : [`string`, `number`, `boolean`, `symbol`, `bigint`, `object`, `array`, `function`]
    case `Enum`:
      return Array.from(new Set(e.enums.map(([, e]) => typeof e)))
    case `Literal`:
      return [typeof e.literal]
    case `Union`:
      return Array.from(new Set(e.types.flatMap(qv)))
    default:
      return [
        `null`,
        `undefined`,
        `string`,
        `number`,
        `boolean`,
        `symbol`,
        `bigint`,
        `object`,
        `array`,
        `function`,
      ]
  }
}
function Jv(e) {
  switch (e._tag) {
    default:
      return []
    case `Declaration`: {
      let t = e.annotations?.[Ng]
      return Array.isArray(t) ? t : []
    }
    case `Objects`:
      return e.propertySignatures.flatMap((e) => {
        let t = e.type
        if (!zy(t)) {
          if (Q_(t)) return [{ key: e.name, literal: t.literal }]
          if ($_(t)) return [{ key: e.name, literal: t.symbol }]
        }
        return []
      })
    case `Arrays`:
      return e.elements.flatMap((e, t) => {
        if (!zy(e)) {
          if (Q_(e)) return [{ key: t, literal: e.literal }]
          if ($_(e)) return [{ key: t, literal: e.symbol }]
        }
        return []
      })
    case `Union`: {
      if (e.types.length === 0) return []
      let t = e.types.map((e) => Jv(Kv(e)))
      return t[0].filter((e) =>
        t.every((t) => t.some((t) => t.key === e.key && t.literal === e.literal)),
      )
    }
    case `Suspend`:
      return Jv(e.thunk())
  }
}
var Yv = new WeakMap(),
  Xv = Object.freeze([]),
  Zv = (e) => (e === null ? `null` : Array.isArray(e) ? `array` : typeof e),
  Qv = (e, t) => (t === `__proto__` ? Object.hasOwn(e, t) : t in e)
function $v(e) {
  let t = Yv.get(e)
  if (t) return t
  let n,
    r = 0,
    i,
    a,
    o = !0,
    s = []
  for (let t = 0; t < e.length; t++) {
    let c = e[t],
      l = Kv(c)
    if (Z_(l)) continue
    if (Q_(l) || $_(l)) {
      a ??= new Map()
      let e = Q_(l) ? l.literal : l.symbol
      s[t] = e
      let n = a.get(e)
      ;(n || a.set(e, (n = [])), n.push(t))
    } else o = !1
    let u = Jv(l)
    if (u.length) {
      ;((n ??= new Map()), r++)
      for (let { key: e, literal: r } of u) {
        let i = n.get(e)
        ;(i || n.set(e, (i = [new Map(), new Set()])), i[1].add(t))
        let a = i[0].get(r)
        ;(a || i[0].set(r, (a = new Set())), a.add(t))
      }
    } else {
      i ??= {}
      let e = qv(l)
      for (let n of e) (i[n] ??= []).push(t)
    }
  }
  let c = {},
    l = (e) => (c[e] ??= Object.freeze(i?.[e] ?? Xv))
  if (o && a) (a.forEach(Object.freeze), (t = (e) => a.get(e) ?? Xv))
  else if (n?.size === 1 && !i) {
    let [r, [i]] = n.entries().next().value,
      a = new Map()
    for (let [e, t] of i) a.set(e, Object.freeze(Array.from(t)))
    let o = Object.freeze(e.map((e, t) => t))
    t = (e, t) => {
      if (be(e)) {
        let n = Qv(e, r) ? e[r] : void 0
        if (n !== void 0) return a.get(n) ?? Xv
        if (t) return o
      }
      return Xv
    }
  } else if (n) {
    let e
    for (let t of n) (!e || t[1][0].size > e[1][0].size) && t[1][1].size === r && (e = t)
    t = (t, r) => {
      let a = Zv(t)
      if (!be(t)) return l(a)
      let o = new Set(i?.[a]),
        s
      if (e) {
        let [n, [i]] = e,
          c = Qv(t, n),
          u = c ? t[n] : void 0
        if (c && (!r || u !== void 0)) {
          let e = i.get(u)
          if (!e) return l(a)
          for (let t of e) o.add(t)
          s = n
        }
      }
      if (s === void 0)
        for (let [e, [i, a]] of n) {
          let n = Qv(t, e),
            s = n ? t[e] : void 0
          if (n && (!r || s !== void 0)) {
            let e = i.get(s)
            if (e) for (let t of e) o.add(t)
          } else if (r) for (let e of a) o.add(e)
        }
      for (let [e, [i, a]] of n) {
        if (e === s) continue
        let n = Qv(t, e),
          c = n ? t[e] : void 0
        if (n && (!r || c !== void 0)) {
          let e = i.get(c)
          for (let t of o) a.has(t) && !e?.has(t) && o.delete(t)
        }
      }
      return Array.from(o).sort((e, t) => e - t)
    }
  } else
    t = (e) => {
      let t = l(Zv(e))
      return a ? t.filter((t) => s[t] === void 0 || s[t] === e) : t
    }
  return (Yv.set(e, t), t)
}
var ey = class extends sv {
  _tag = `Union`
  types
  options
  encodingChecks
  constructor(e, t, n, r, i, a, o) {
    ;(super(n, r, i, a), (this.types = e), (this.options = t), (this.encodingChecks = o))
  }
  getParser(e, t) {
    let n = this,
      r = t !== void 0,
      i = [],
      a = (t) => (i[t] ??= e(n.types[t])),
      o
    return (e, t) => {
      if (e === G) return Ig
      let i = (o ??= $v(n.types))(e, r)
      if (i.length === 0) return W(new Qg(n, [], e, t))
      if (i.length === 1) {
        let r = a(i[0])(e, t)
        return r._tag === `Success` ? r : U(r) ? ty(n, r.cause, e, t) : ny(n, r, e, t)
      }
      return ry(n, a, i, e, t)
    }
  }
  _rebuild(e, t, n) {
    let r = Ay(this.types, e)
    return r === this.types && t === this.checks && n === this.encodingChecks
      ? this
      : new ey(r, this.options, this.annotations, t, void 0, this.context, n)
  }
  recur(e) {
    return this._rebuild(e, this.checks, this.encodingChecks)
  }
  flip(e) {
    return this._rebuild(e, this.encodingChecks, this.checks)
  }
  matchPart(e, t) {
    for (let n of this.types) {
      let r = n.matchPart(e, t)
      if (r !== void 0) return r
    }
  }
  getExpected(e) {
    let t = this.annotations?.expected
    if (typeof t == `string`) return t
    if (this.types.length === 0) return `never`
    let n = this.types.map((t) => {
      let n = Wy(t)
      switch (n._tag) {
        case `Arrays`: {
          let t = n.elements.filter(Q_)
          if (t.length > 0)
            return `${sy(n.isMutable)}[ ${t.map((t) => e(t) + cy(t.context?.isOptional)).join(`, `)}, ... ]`
          break
        }
        case `Objects`: {
          let t = n.propertySignatures.filter((e) => Q_(e.type))
          if (t.length > 0)
            return `{ ${t.map((t) => `${sy(t.type.context?.isMutable)}${dt(t.name)}${cy(t.type.context?.isOptional)}: ${e(t.type)}`).join(`, `)}, ... }`
          break
        }
      }
      return e(n)
    })
    return Array.from(new Set(n)).join(` | `)
  }
}
function ty(e, t, n, r) {
  let i = p_(t)
  return i ? Xd(new Qg(e, [i], n, r)) : Yd(t)
}
function ny(e, t, n, r) {
  return hm(t, (t) => ty(e, t, n, r))
}
function ry(e, t, n, r, i) {
  let a = {
      ast: e,
      parser: t,
      input: r,
      out: void 0,
      successes: e.options?.mode === `oneOf` ? [] : void 0,
      issues: void 0,
      options: i,
    },
    o = ay(a, n)
  return o ? iy(o, a) : a.out ? a.out : W(new Qg(e, a.issues ?? [], r, i))
}
function iy(e, t) {
  return yh(e, (e) =>
    t.out === q
      ? Rp(t.input)
      : t.out
        ? t.out
        : W(new Qg(t.ast, t.issues ?? [], t.input, t.options)),
  )
}
var ay = gu()({
    onItem(e, t) {
      return e.parser(t)(e.input, e.options)
    },
    step(e, t, n) {
      if (n._tag === `Failure`) {
        let t = p_(n.cause)
        if (t === void 0) return n
        e.issues ? e.issues.push(t) : (e.issues = [t])
      } else {
        if (e.out && e.successes)
          return (
            e.successes.push(e.ast.types[t]), Xd(new $g(e.ast, e.successes, e.input, e.options))
          )
        if (((e.out = n), e.successes)) e.successes.push(e.ast.types[t])
        else return Zd
      }
    },
  }),
  oy = new ey([new gv(`Infinity`), new gv(`-Infinity`), new gv(`NaN`)])
function sy(e) {
  return e ? `` : `readonly `
}
function cy(e) {
  return e ? `?` : ``
}
var ly = class extends n {
    _tag = `Filter`
    run
    annotations
    aborted
    constructor(e, t = void 0, n = !1) {
      ;(super(), (this.run = e), (this.annotations = t), (this.aborted = n))
    }
    annotate(e) {
      return new ly(this.run, { ...this.annotations, ...e }, this.aborted)
    }
    abort() {
      return new ly(this.run, this.annotations, !0)
    }
    and(e, t) {
      return new uy([this, e], t)
    }
  },
  uy = class extends n {
    _tag = `FilterGroup`
    checks
    annotations
    constructor(e, t = void 0) {
      ;(super(), (this.checks = e), (this.annotations = t))
    }
    annotate(e) {
      return new uy(this.checks, { ...this.annotations, ...e })
    }
    and(e, t) {
      return new uy([this, e], t)
    }
  }
function dy(e, t, n = !1) {
  return new ly((t, n, r) => n_(n, e(t, n, r), t, r), t, n)
}
function fy(e) {
  return dy((e) => globalThis.Number.isFinite(e), {
    expected: `a finite number`,
    representation: { id: `effect/schema/isFinite`, payload: null },
    toJsonSchema: () => ({ type: `number` }),
    toCode: () => ({ runtime: `Schema.isFinite()` }),
    arbitraryConstraint: { number: `finite` },
    ...e,
  })
}
var py = Cy(xv, [fy()]),
  my = new Z(
    new ey([py, oy]),
    new X(
      w_(),
      Y((e) => (globalThis.Number.isFinite(e) ? e : globalThis.String(e))),
    ),
  )
function hy(e, t) {
  let n = new globalThis.RegExp(e),
    r = { source: n.source, flags: n.flags }
  return dy((e) => ((n.lastIndex = 0), n.test(e)), {
    expected: `a string matching the RegExp ${r.source}`,
    representation: { id: `effect/schema/isPattern`, payload: r },
    toJsonSchema: () => [{}, !0],
    arbitraryConstraint: { patterns: [r] },
    ...t,
  })
}
var gy = new WeakMap()
function _y(e, t) {
  let n = Object.assign(Object.create(Object.getPrototypeOf(e)), e, t)
  return (
    Reflect.ownKeys(t).every((e) => e === `context` || e === `encoding`) && gy.set(n, vy(e)), n
  )
}
function vy(e) {
  let t = gy.get(e)
  if (t !== void 0) return t
  if (e.encoding === void 0) return e
  let n = Object.assign(Object.create(Object.getPrototypeOf(e)), e, { encoding: void 0 })
  return (gy.set(e, n), n)
}
function Q(e, t) {
  return e.encoding === t ? e : _y(e, { encoding: t })
}
function yy(e, t) {
  if (e.context === t) return e
  let n = vy(e)
  return n.context === t && n.encoding === e.encoding ? n : _y(e, { context: t })
}
function by(e) {
  return e.encoding ? by(e.encoding[e.encoding.length - 1].to) : e
}
function xy(e, t) {
  if (e.checks) {
    let n = e.checks[e.checks.length - 1]
    return Sy(e, Mi(e.checks.slice(0, -1), n.annotate(t)))
  }
  return _y(e, { annotations: { ...e.annotations, ...t } })
}
function Sy(e, t) {
  if (e._tag === `Suspend` && t) throw Error(`Cannot add checks to Suspend`)
  return e.checks === t ? e : _y(e, { checks: t })
}
function Cy(e, t) {
  return Sy(e, Vv(e.checks, t))
}
function wy(e, t) {
  let n = t(e.to)
  return n === e.to ? e : new Z(n, e.transformation)
}
function Ty(e, t) {
  let n = e,
    r = n[n.length - 1],
    i = wy(r, t)
  return i === r ? e : Mi(e.slice(0, e.length - 1), i)
}
function Ey(e) {
  return (t) => (t.encoding ? Q(t, Ty(t.encoding, e)) : t)
}
function Dy(e, t) {
  return Ey((e) => yy(e, t))(e)
}
function Oy(e, t) {
  function n(r) {
    if (r.encoding) {
      let e = r.encoding[r.encoding.length - 1]
      return t?.stopAt?.(e) ? r : Q(r, Ty(r.encoding, n))
    }
    return e(r)
  }
  return m(n)
}
function ky(e, t, n) {
  let r = new Z(e, t)
  return Q(n, n.encoding ? [...n.encoding, r] : [r])
}
function Ay(e, t) {
  let n
  for (let r = 0; r < e.length; r++) {
    let i = e[r],
      a = t(i)
    if (n) n[r] = a
    else if (a !== i) {
      n = Array(e.length)
      for (let t = 0; t < r; t++) n[t] = e[t]
      n[r] = a
    }
  }
  return n ?? e
}
function jy(e, t) {
  return yy(
    e,
    e.context
      ? new av(e.context.isOptional, e.context.isMutable, e.context.constructorDefault, {
          ...e.context.annotations,
          ...t,
        })
      : new av(!1, !1, void 0, t),
  )
}
var My = m((e) =>
    Ny(
      yy(
        e,
        e.context
          ? e.context.isOptional === !1
            ? new av(!0, e.context.isMutable, e.context.constructorDefault, e.context.annotations)
            : e.context
          : new av(!0, !1),
      ),
    ),
  ),
  Ny = Ey(My),
  Py = p((e) => My(new ey([e, fv])))
function Fy(e, t) {
  return yy(
    e,
    e.context
      ? new av(e.context.isOptional, e.context.isMutable, t, e.context.annotations)
      : new av(!1, !1, t),
  )
}
function Iy(e, t, n) {
  return ky(e, n, t)
}
function Ly(e) {
  let t = [],
    n = []
  function r(e) {
    switch (e._tag) {
      case `Literal`:
        le(e.literal) && !t.includes(e.literal) && t.push(e.literal)
        return
      case `UniqueSymbol`:
        t.includes(e.symbol) || t.push(e.symbol)
        return
      case `Never`:
        return
      case `Union`:
        for (let t = 0; t < e.types.length; t++) r(e.types[t])
        return
      default:
        n.push(e)
    }
  }
  return (r(e), { literals: t, parameters: n })
}
function Ry(e, t) {
  let { literals: n, parameters: r } = Ly(e)
  return new Iv(
    n.map((e) => new jv(e, t)),
    r.map((e) => new Fv(e, t)),
  )
}
function zy(e) {
  return e.context?.isOptional ?? !1
}
function By(e) {
  return e.annotations?.[`~structural`] === !0 || (e._tag === `FilterGroup` && e.checks.every(By))
}
function Vy(e) {
  function t(e) {
    return By(e) ? [e] : e._tag === `FilterGroup` ? e.checks.flatMap(t) : []
  }
  let n = e.flatMap(t)
  return Ii(n) ? n : void 0
}
function Hy(e) {
  let t = !0
  function n(e) {
    return ((t = t && !e.encoding && !rv(e)), t && `recur` in e && e.recur(n), e)
  }
  return (`recur` in e && e.recur(n), t)
}
var Uy = m((e) => {
    let t = vy(e)
    if (t !== e) {
      let n = Uy(t)
      return n === t && e.encoding === void 0 ? e : yy(n, e.context)
    }
    let n = `recur` in e ? e.recur(Uy) : e
    if (`encodingChecks` in n && n.encodingChecks) {
      let t = Hy(e)
        ? n.encodingChecks
        : ev(n) || tv(n) || (J_(n) && n.typeParameters.length > 0)
          ? Vy(n.encodingChecks)
          : void 0
      return _y(n, { encodingChecks: void 0, checks: Vv(n.checks, t) })
    }
    return n
  }),
  Wy = m((e) => Uy(Ky(e)))
function Gy(e, t) {
  let n = t,
    r = n.length,
    i = n[r - 1],
    a = [new Z(Ky(Q(e, void 0)), n[0].transformation.flip())]
  for (let e = 1; e < r; e++) a.unshift(new Z(Ky(n[e - 1].to), n[e].transformation.flip()))
  let o = Ky(i.to)
  return o.encoding ? Q(o, [...o.encoding, ...a]) : Q(o, a)
}
var Ky = p((e) => {
  if (e.encoding) return Gy(e, e.encoding)
  let t = vy(e)
  if (t !== e) {
    let n = Ky(t)
    return n === t ? e : yy(n, e.context)
  }
  return `flip` in e ? e.flip(Ky) : `recur` in e ? e.recur(Ky) : e
})
function qy(e) {
  switch (e._tag) {
    case `Undefined`:
      return !0
    case `Union`:
      return e.types.some(qy)
    default:
      return !1
  }
}
function Jy(e, t) {
  let n = t === 0 ? q : K(t)
  return (r, i) => (r === G ? Ig : r === t ? n : W(new Jg(e, r, i)))
}
function Yy(e, t) {
  return (n, r) => (n === G ? Ig : t(n) ? q : W(new Jg(e, n, r)))
}
var Xy = Oy((e) => {
    switch (e._tag) {
      default:
        return e
      case `Number`:
        return e.toCodecStringTree()
      case `Union`:
        return e.recur(Xy)
    }
  }),
  Zy = Oy((e) => {
    switch (e._tag) {
      default:
        return e
      case `Symbol`:
      case `UniqueSymbol`:
        return e.toCodecStringTree()
      case `Union`:
        return e.recur(Zy)
    }
  }),
  Qy = new globalThis.RegExp(`^${kv}$`),
  $y = new globalThis.RegExp(`^(?:${kv}|Infinity|-Infinity|NaN)$`)
function eb(e) {
  return hy(Qy, {
    expected: `a string representing a finite number`,
    representation: { id: `effect/schema/isStringFinite`, payload: null },
    toJsonSchema: () => ({ pattern: Qy.source }),
    ...e,
  })
}
var tb = Cy(vv, [eb()]),
  nb = new Z(tb, L_),
  rb = new Z(new ey([tb, oy]), L_)
function ib(e, t, n, r, i) {
  for (let a = 0; a < e.length; a++) {
    let o = e[a]
    if (o._tag === `FilterGroup`) {
      if (
        ((n = ib(o.checks, t, n, r, i)),
        n && (i.errors !== `all` || n[n.length - 1].filter.aborted))
      )
        return n
    } else {
      let e = o.run(t, r, i)
      if (e) {
        let r = new Ug(o, e, t, i)
        if ((n ? n.push(r) : (n = [r]), i.errors !== `all` || o.aborted)) return n
      }
    }
  }
  return n
}
function ab(e) {
  if (!J_(e)) return
  let t = e.annotations?.[Pg]
  return ue(t) ? t(e.typeParameters) : void 0
}
var ob = jg
function sb(e) {
  return (
    e === null ||
    typeof e == `string` ||
    typeof e == `boolean` ||
    (typeof e == `number` && globalThis.Number.isFinite(e))
  )
}
function cb(e) {
  return e === void 0 || typeof e == `string`
}
function lb(e, t) {
  let n = new WeakMap(),
    r = []
  outer: for (;;) {
    if (typeof e != `object` || !e) {
      if (!t(e)) return !1
    } else {
      let t = e,
        i = n.get(t)
      if (i === !1) return !1
      if (i === void 0) {
        let e = Array.isArray(t)
        if (!e) {
          let e = Object.getPrototypeOf(t)
          if (e !== null && e !== Object.prototype && Object.getPrototypeOf(e) !== null) return !1
        }
        ;(n.set(t, !1), r.push({ value: t, keys: e ? t.length : Object.keys(t), index: 0 }))
      }
    }
    for (; r.length > 0;) {
      let t = r[r.length - 1],
        i = t.keys
      if (typeof i == `number`) {
        if (t.index < i) {
          e = t.value[t.index++]
          continue outer
        }
      } else if (t.index < i.length) {
        e = t.value[i[t.index++]]
        continue outer
      }
      ;(n.set(t.value, !0), r.pop())
    }
    return !0
  }
}
function ub(e) {
  return lb(e, sb)
}
var db = new cv([], () => (e, t, n) => (ub(e) ? q : W(new Jg(t, e, n))), {
    representation: { id: `effect/schema/Json`, payload: null },
    expected: `JSON value`,
    toCodecJson: () => void 0,
    toCodecStringTree: () => hb,
  }),
  fb = new Z(db, I_()),
  pb = new Z(new ey([new Cv(!1, [], [db]), new Iv([], [new Fv(vv, db)])]), I_())
function mb(e) {
  return lb(e, cb)
}
var hb = new Z(
    new cv([], () => (e, t, n) => (mb(e) ? q : W(new Jg(t, e, n))), {
      expected: `StringTree`,
      toCodecStringTree: () => void 0,
    }),
    I_(),
  ),
  gb = (e, t, n) => (e === q ? n(t) : yh(e, n))
function _b(e) {
  if (e._tag === `Middleware`)
    return (t, n, r) => vb(t === q ? e.decode(K(Lg(n)), r) : e.decode(gh(t, Lg), r))
  let t = e.decode
  switch (t._tag) {
    case `Passthrough`:
      return (e, t) => (e === q ? K(t) : e)
    case `Transform`: {
      let e = (e) => (e === G ? Ig : K(t.transform(e)))
      return (t, n) => gb(t, n, e)
    }
    case `TransformOptional`: {
      let e = (e) => Rg(t.transform(Lg(e)))
      return (t, n) => gb(t, n, e)
    }
    case `TransformEffect`:
      return (e, n, r) => gb(e, n, (e) => (e === G ? Ig : t.transform(e, r)))
    case `TransformOptionalEffect`:
      return (e, n, r) => gb(e, n, (e) => vb(t.transform(Lg(e), r)))
  }
}
var vb = (e) => yh(e, Rg),
  yb = (e, t, n, r) => hm(r, (r) => Jp(() => Ld(r, (r) => new Wg(e, r, t, n))))
function bb(e, t) {
  let n = _b(e.link.transformation),
    r
  return (i, a) => {
    if (i === G) return Ig
    if (e.isConstructed(i)) return q
    let o = (r ??= t(e.link.to))(i, a)
    return n(o, i, a)
  }
}
function xb(e, t) {
  let n = e.context.constructorDefault
  return (r, i) => {
    if (r !== G && r !== void 0) return t(r, i)
    let a = n
    if (U(a) && a._tag === `Success`) {
      let e = t(a[w], i)
      return e === q ? a : e
    }
    return yh(yb(e, r, i, a), (e) => {
      let n = t(e, i)
      return n === q ? K(e) : n
    })
  }
}
function Sb(e, t) {
  let n = t(e)
  return e.context?.constructorDefault === void 0 ? n : xb(e, n)
}
function Cb(e, t, n, r, i) {
  if (e._tag === `Declaration`) for (let n of e.typeParameters) t(n)
  let a = n ? ab(e) : void 0,
    o = a ? bb(a, t) : (r ?? e.getParser(t, n)),
    s = e.checks,
    c = e.encoding,
    l = c?.map((e) => _b(e.transformation)),
    u = e.encodingChecks
  if (!c && !s && !u) return o
  let d,
    f = (t, n) => {
      let r = o(t, n)
      if (u && !n.disableChecks) {
        if (U(r)) {
          if (r._tag === `Success`) {
            let i = r === q ? t : r[w]
            if (t !== G && i !== G) {
              let i = ib(u, t, void 0, e, n)
              i && (r = W(new J(e, i, t, n)))
            }
          }
        } else
          r = em(r, (r) => {
            if (t !== G && r !== G) {
              let r = ib(u, t, void 0, e, n)
              if (r) return W(new J(e, r, t, n))
            }
            return Rp(r)
          })
      }
      if (s && !n.disableChecks) {
        if (U(r)) {
          if (r._tag === `Success`) {
            let i = r === q ? t : r[w]
            if (i === G) return r
            let a = ib(s, i, void 0, e, n)
            a && (r = W(new J(e, a, i, n)))
          }
        } else
          r = em(r, (t) => {
            if (t !== G) {
              let r = ib(s, t, void 0, e, n)
              if (r) return W(new J(e, r, t, n))
            }
            return Rp(t)
          })
      }
      return r
    },
    p = i === void 0 ? f : i(f)
  return c
    ? (n, r) => {
        let i = (d ??= c.map((e) => t(e.to))),
          a = n,
          o = i[i.length - 1](n, r)
        for (let e = c.length - 1; e >= 0; e--)
          if (((o = l[e](o, a, r)), e !== 0)) {
            let t = i[e - 1]
            o._tag === `Success`
              ? ((a = o[w]), (o = t(a, r)))
              : (o = yh(o, (e) => {
                  let n = t(e, r)
                  return n === q ? K(e) : n
                }))
          }
        if (o._tag === `Success`) {
          let e = o[w],
            t = p(e, r)
          return t === q ? o : t
        }
        return (
          (o = yb(e, n, r, o)),
          yh(o, (e) => {
            let t = p(e, r)
            return t === q ? K(e) : t
          })
        )
      }
    : p
}
var wb = Symbol(),
  Tb = new WeakMap(),
  Eb = (e) => Ab(e).parser,
  Db = (e) => Ab(e).makeEffect,
  Ob = (e) => Sb(e, Db),
  kb = class {
    ast
    constructor(e) {
      this.ast = e
    }
    get decodeEffect() {
      return (this.cachedDecodeEffect ??= Cb(this.ast, Eb))
    }
    get parser() {
      return this.decodeEffect
    }
    get makeEffect() {
      return (this.cachedMakeEffect ??= Cb(this.ast, Db, Ob))
    }
  }
function Ab(e) {
  let t = Tb.get(e)
  if (t !== void 0) return t
  let n = new kb(e)
  return (Tb.set(e, n), n)
}
function jb(e) {
  let t = e.ast,
    n
  return (e, r) =>
    (n ??= Jb(ex, Uy(t)))(
      e,
      r?.disableChecks
        ? r?.parseOptions
          ? { ...r.parseOptions, disableChecks: !0 }
          : { disableChecks: !0 }
        : r?.parseOptions,
    )
}
function Mb(e) {
  let t = jb(e)
  return (e, n) => {
    let r = dh(t(e, n))
    return Qd(r)
      ? j(r.value)
      : (m_(r.cause, `Option adapter can only return none for schema issues`), A())
  }
}
function Nb(e) {
  return Qb(Uy(e.ast))
}
function Pb(e) {
  return Ib(e.ast)
}
function Fb(e) {
  {
    let t = Yb(Kb(e))
    return (e) => {
      let n = t(e, iv)
      return Qd(n)
        ? !0
        : (m_(n.cause, `Type guard adapter can only return false for schema issues`), !1)
    }
  }
}
function Ib(e) {
  let t = Uy(e),
    n = (e) => ((n = Fb(t)), n(e))
  return (e) => n(e)
}
function Lb(e, t) {
  let n = Kb(e.ast)
  return t === void 0 ? n : (e, r) => n(e, Wb(t, r))
}
function Rb(e, t) {
  return Yb(Lb(e, t))
}
function zb(e, t) {
  return Xb(Lb(e, t))
}
var Bb = zb
function Vb(e, t) {
  let n = Kb(Ky(e.ast))
  return t === void 0 ? n : (e, r) => n(e, Wb(t, r))
}
function Hb(e, t) {
  return Xb(Vb(e, t))
}
var Ub = Hb,
  Wb = (e, t) => (t ? { ...e, ...t } : e),
  Gb = (e) => (e === G ? W(new Yg()) : Rp(e))
function Kb(e) {
  return Jb($b, e)
}
function qb(e, t) {
  return e === q ? Rp(t) : U(e) ? (e[w] === G ? Gb(G) : e) : yh(e, Gb)
}
function Jb(e, t) {
  let n
  return (r, i) => {
    let a = (n ??= e(t))(r, i ?? iv)
    return a === q ? Rp(r) : U(a) ? (a[w] === G ? Gb(G) : a) : yh(a, Gb)
  }
}
function Yb(e) {
  return (t, n) => dh(e(t, n))
}
function Xb(e) {
  let t = Yb(e)
  return (e, n) => {
    let r = t(e, n)
    return Qd(r)
      ? j(r.value)
      : (m_(r.cause, `Option adapter can only return none for schema issues`), A())
  }
}
function Zb(e, t) {
  let n = dh(e)
  if (Qd(n)) return n.value
  let r = m_(n.cause, t)
  throw Error(`Schema validation failed`, { cause: r })
}
function Qb(e) {
  let t, n
  return (r, i) => {
    t ??= Ab(e)
    let a = i?.disableChecks
        ? i.parseOptions
          ? { ...i.parseOptions, disableChecks: !0 }
          : { disableChecks: !0 }
        : (i?.parseOptions ?? iv),
      o = t.make
    if (o !== void 0 && r !== G) {
      let e
      try {
        e = o(r, a)
      } catch (e) {
        throw (m_(Md(e), `Constructor adapter can only throw schema issues`), e)
      }
      if (e !== wb && e !== G) return e
    }
    return Zb(qb((n ??= t.makeEffect)(r, a), r), `Constructor adapter can only throw schema issues`)
  }
}
var $b = (e) => Ab(e).parser,
  ex = (e) => Ab(e).makeEffect,
  tx = `~effect/Schema/Schema`,
  nx = Symbol(),
  rx = {
    [tx]: tx,
    get make() {
      let e = Nb(this)
      return (Object.defineProperty(this, "make", { value: e, enumerable: !0 }), e)
    },
    get makeEffect() {
      let e = jb(this)
      return (Object.defineProperty(this, "makeEffect", { value: e, enumerable: !0 }), e)
    },
    get makeOption() {
      let e = Mb(this)
      return (Object.defineProperty(this, "makeOption", { value: e, enumerable: !0 }), e)
    },
    pipe() {
      return e(this, arguments)
    },
    annotate(e) {
      return this.rebuild(xy(this.ast, e))
    },
    annotateKey(e) {
      return this.rebuild(jy(this.ast, e))
    },
    check(...e) {
      return this.rebuild(Cy(this.ast, e))
    },
    rebuild(e) {
      return ix(e, this[nx])
    },
  }
function ix(e, t) {
  function n() {}
  let r = Object.setPrototypeOf(n, rx)
  return (
    t && (Object.hasOwn(t, `name`) || Object.hasOwn(t, `length`) || Object.hasOwn(t, `__proto__`))
      ? Object.defineProperties(r, Object.getOwnPropertyDescriptors({ ...t }))
      : Object.assign(r, t),
    (r[nx] = t),
    (r.ast = e),
    r
  )
}
function ax(e) {
  return ix(ox(e.ast), { schema: e })
}
var ox = Oy((e) => {
  let t = dx(e, ox),
    n = e.context
  return t === e || n === void 0 ? t : Dy(t, sx(n))
})
function sx(e) {
  return e.constructorDefault === void 0
    ? e
    : new av(e.isOptional, e.isMutable, void 0, e.annotations)
}
function cx(e) {
  if (e.propertySignatures.some((e) => typeof e.name != `string`))
    throw new globalThis.Error(`Objects property names must be strings`, { cause: e })
}
function lx(e) {
  return (t) => {
    let n = [...t].sort((t, n) => e(Wy(t)) - e(Wy(n)))
    return n.some((e, n) => e !== t[n]) ? n : t
  }
}
var ux = lx((e) => {
  switch (e._tag) {
    case `BigInt`:
    case `Symbol`:
    case `UniqueSymbol`:
      return 0
    default:
      return 1
  }
})
function dx(e, t) {
  switch (e._tag) {
    case `Declaration`: {
      let n = e.annotations?.toCodecJson ?? e.annotations?.toCodec
      if (!ue(n)) return Q(e, [fb])
      let r = n(e.typeParameters.map((e) => ix(Wy(e))))
      return r === void 0 ? e : Q(e, [wy(r, t)])
    }
    case `Unknown`:
      return Q(e, [fb])
    case `ObjectKeyword`:
      return Q(e, [pb])
    case `Undefined`:
    case `Void`:
    case `Literal`:
    case `Number`:
      return e.toCodecJson()
    case `UniqueSymbol`:
    case `Symbol`:
    case `BigInt`:
      return e.toCodecStringTree()
    case `Objects`:
      return (cx(e), e.recur(t, Zy))
    case `Union`: {
      let n = ux(e.types)
      return n === e.types
        ? e.recur(t)
        : new ey(
            n,
            e.options,
            e.annotations,
            e.checks,
            e.encoding,
            e.context,
            e.encodingChecks,
          ).recur(t)
    }
    case `Arrays`:
    case `Suspend`:
      return e.recur(t)
  }
  return e
}
function fx(e) {
  return ix(vx(e.ast), { schema: e })
}
var px = lx((e) => {
  switch (e._tag) {
    case `Null`:
    case `Boolean`:
    case `Number`:
    case `BigInt`:
    case `Symbol`:
    case `UniqueSymbol`:
      return 0
    default:
      return 1
  }
})
function mx(e, t, n) {
  switch (e._tag) {
    case `Declaration`: {
      let r = e.typeParameters.map((e) => ix(t(Wy(e)))),
        i = e.annotations?.toCodecStringTree
      if (ue(i)) {
        let n = i(r)
        return n === void 0 ? e : Q(e, [wy(n, t)])
      }
      let a = e.annotations?.toCodecJson,
        o = ue(a) ? a(r) : void 0,
        s = o === void 0 ? e.annotations?.toCodec : void 0,
        c = o ?? (ue(s) ? s(r) : void 0)
      return c === void 0 ? n(e) : Q(e, [wy(c, t)])
    }
    case `Null`:
      return Q(e, [hx])
    case `Boolean`:
      return Q(e, [gx])
    case `Unknown`:
    case `ObjectKeyword`:
      return Q(e, [hb])
    case `Enum`:
    case `Number`:
    case `Literal`:
    case `UniqueSymbol`:
    case `Symbol`:
    case `BigInt`:
      return e.toCodecStringTree()
    case `Objects`:
      return (cx(e), e.recur(t, Zy))
    case `Union`: {
      let n = px(e.types)
      return n === e.types
        ? e.recur(t)
        : new ey(
            n,
            e.options,
            e.annotations,
            e.checks,
            e.encoding,
            e.context,
            e.encodingChecks,
          ).recur(t)
    }
    case `Arrays`:
    case `Suspend`:
      return e.recur(t)
  }
  return e
}
var hx = new Z(
    new gv(`null`),
    new X(
      Y(() => null),
      Y(() => `null`),
    ),
  ),
  gx = new Z(
    new ey([new gv(`true`), new gv(`false`)]),
    new X(
      Y((e) => e === `true`),
      C_(),
    ),
  ),
  _x = new X(
    Y((e) => (typeof e == `string` ? [e] : e)),
    b_(),
  ),
  vx = Oy(
    (e) => {
      let t = mx(e, vx, (e) => {
        throw new globalThis.Error(`Missing structural codec for StringTree`, { cause: e })
      })
      return t !== e && e.context !== void 0 ? Dy(t, sx(e.context)) : t
    },
    { stopAt: (e) => e.transformation === _x },
  ),
  yx = p((e) => bx(e))
function bx(e) {
  let t = Ag(e)?.toEquivalence
  if (t) return t(J_(e) ? e.typeParameters.map(bx) : [])
  switch (e._tag) {
    case `Never`:
      return wn()
    case `Declaration`:
      return xx(e)
    case `Null`:
    case `Undefined`:
    case `Void`:
    case `Unknown`:
    case `Any`:
    case `String`:
    case `Number`:
    case `Boolean`:
    case `BigInt`:
    case `Symbol`:
    case `Literal`:
    case `UniqueSymbol`:
    case `ObjectKeyword`:
    case `Enum`:
    case `TemplateLiteral`:
      return x
    case `Arrays`: {
      let t = e.elements.map(bx),
        n = e.rest.map(bx),
        [r, ...i] = n,
        a = i.length
      return Sn((o, s) => {
        if (!Array.isArray(o) || !Array.isArray(s)) return !1
        let c = o.length
        if (c !== s.length) return !1
        let l = 0
        for (; l < Math.min(c, e.elements.length); l++) if (!t[l](o[l], s[l])) return !1
        if (n.length > 0) {
          for (; l < c - a; l++) if (!r(o[l], s[l])) return !1
          for (let e = 0; e < a; e++) if (!i[e](o[l + e], s[l + e])) return !1
        }
        return !0
      })
    }
    case `Objects`: {
      if (e.propertySignatures.length === 0 && e.indexSignatures.length === 0) return x
      let t = e.propertySignatures.map((e) => bx(e.type)),
        n = e.indexSignatures.map((e) => bx(e.type))
      return Sn((r, i) => {
        if (!ye(r) || !ye(i)) return !1
        for (let n = 0; n < t.length; n++) {
          let a = e.propertySignatures[n],
            o = a.name,
            s = Object.hasOwn(r, o),
            c = Object.hasOwn(i, o)
          if ((zy(a.type) && s !== c) || (s && c && !t[n](r[o], i[o]))) return !1
        }
        for (let t = 0; t < n.length; t++) {
          let a = e.indexSignatures[t],
            o = Av(r, a.parameter),
            s = Av(i, a.parameter)
          if (o.length !== s.length) return !1
          for (let e = 0; e < o.length; e++) {
            let a = o[e]
            if (!Object.hasOwn(i, a) || !n[t](r[a], i[a])) return !1
          }
        }
        return !0
      })
    }
    case `Union`: {
      let t = Uy(e).types,
        n = $v(t),
        r = t.map((t, n) => [Ib(t), bx(e.types[n])])
      return Sn((e, t) => {
        let i = n(e, !1)
        for (let n = 0; n < i.length; n++) {
          let [a, o] = r[i[n]]
          if (a(e) && a(t)) return o(e, t)
        }
        return !1
      })
    }
    case `Suspend`: {
      let t
      return Sn((n, r) => (t ??= yx(e.thunk()))(n, r))
    }
  }
}
function xx(e) {
  let t = e.annotations?.representation
  if (t === void 0) return x
  switch (t.id) {
    case `effect/schema/Option`: {
      let [t] = Sx(e)
      return (e, n) => e._tag === n._tag && (e._tag === `None` || t(e.value, n.value))
    }
    case `effect/schema/Result`: {
      let [t, n] = Sx(e)
      return (e, r) =>
        e._tag === r._tag &&
        (e._tag === `Success` ? t(e.success, r.success) : n(e.failure, r.failure))
    }
    case `effect/schema/CauseReason`: {
      let [t, n] = Sx(e)
      return Cx(t, n)
    }
    case `effect/schema/Cause`: {
      let [t, n] = Sx(e)
      return wx(t, n)
    }
    case `effect/schema/Exit`: {
      let [t, n, r] = Sx(e),
        i = wx(n, r)
      return (e, n) =>
        e._tag === n._tag && (e._tag === `Success` ? t(e.value, n.value) : i(e.cause, n.cause))
    }
    case `effect/schema/ReadonlyMap`: {
      let [t, n] = Sx(e)
      return $e(t, n)
    }
    case `effect/schema/ReadonlySet`:
      return et(Sx(e)[0])
    case `effect/schema/RegExp`:
      return (e, t) => e.source === t.source && e.flags === t.flags
    case `effect/schema/URL`:
      return (e, t) => e.toString() === t.toString()
    default:
      return x
  }
}
function Sx(e) {
  return e.typeParameters.map(bx)
}
function Cx(e, t) {
  return (n, r) => {
    if (n._tag !== r._tag) return !1
    switch (n._tag) {
      case `Fail`:
        return e(n.error, r.error)
      case `Die`:
        return t(n.defect, r.defect)
      case `Interrupt`:
        return n.fiberId === r.fiberId
    }
  }
}
function wx(e, t) {
  let n = En(Cx(e, t))
  return (e, t) => n(e.reasons, t.reasons)
}
var Tx = r(2, (e, t) => kx(e, (e, n) => (Ox(t, e) ? void 0 : [e, n]))),
  Ex = r(2, (e, t) => kx(e, (e, n) => [e, Object.hasOwn(t, e) ? t[e](n) : n])),
  Dx = (e) => e
function Ox(e, t) {
  return e.some((e) => e === t || (typeof e == `number` && String(e) === t))
}
function kx(e, t) {
  let n = {}
  for (let r of Reflect.ownKeys(e)) {
    if (!Object.prototype.propertyIsEnumerable.call(e, r)) continue
    let i = t(r, e[r])
    if (i) {
      let [e, t] = i
      C(n, e, t)
    }
  }
  return n
}
var Ax = `~effect/Schema/SchemaError`
function jx(e) {
  return (
    h(e, `~effect/Schema/SchemaError`) &&
    e[`~effect/Schema/SchemaError`] === `~effect/Schema/SchemaError`
  )
}
var Mx = tx
function Nx() {
  return (e, t, n) => $(new cv(e.map(Uv), (e) => t(e.map((e) => $(e))), n))
}
function Px(e, t) {
  return Nx()([], () => (t, n, r) => (e(t) ? Rp(t) : W(new Jg(n, t, r))), t)
}
var Fx = class extends vo(`SchemaError`) {
  [Ax] = Ax
  constructor(e) {
    let t = Ct()
    wt(0)
    try {
      super({ issue: e })
    } finally {
      wt(t)
    }
  }
  get message() {
    return u_(this.issue)
  }
  toString() {
    return `SchemaError(${this.message})`
  }
}
function Ix(e) {
  return jx(e)
}
function Lx(e) {
  return U(e) ? Rx(e) : hm(e, (e) => Jp(() => Ld(e, (e) => new Fx(e))))
}
function Rx(e) {
  return Qd(e) ? e : Yd(Ld(e.cause, (e) => new Fx(e)))
}
function zx(e, t) {
  let n
  for (let r of e.reasons) {
    if (!kd(r) || !Ix(r.error)) throw new globalThis.Error(t, { cause: e })
    n ??= r.error
  }
  if (n === void 0) throw new globalThis.Error(t, { cause: e })
  return n
}
function Bx(e) {
  let t = dh(e)
  if (Qd(t)) return t.value
  throw zx(t.cause, `Sync adapter can only throw schema errors`)
}
var Vx = Pb
function Hx(e, t) {
  let n = Lb(e, t)
  return (e, t) => Lx(n(e, t))
}
var Ux = Hx
function Wx(e, t) {
  let n = Rb(e, t)
  return (e, t) => Rx(n(e, t))
}
var Gx = zb,
  Kx = Bb
function qx(e, t) {
  let n = Hx(e, t)
  return (e, t) => Bx(n(e, t))
}
function Jx(e, t) {
  let n = Vb(e, t)
  return (e, t) => Lx(n(e, t))
}
var Yx = Jx,
  Xx = Ub
function Zx(e, t) {
  let n = Jx(e, t)
  return (e, t) => Bx(n(e, t))
}
var Qx = Zx,
  $ = ix
function $x(e) {
  return h(e, Mx) && e[Mx] === Mx
}
var eS = Dx((e) => $(My(e.ast), { schema: e })),
  tS = Dx((e) => {
    let t = CS(e)
    return $(Py(e.ast), { schema: t })
  }),
  nS = Dx((e) => $(Uy(e.ast), { schema: e }))
function rS(e) {
  let t = $(new gv(e), {
    literal: e,
    transform(n) {
      return t.pipe(ES(rS(n), { decode: Y(() => n), encode: Y(() => e) }))
    },
  })
  return t
}
var iS = $(mv),
  aS = $(hv),
  oS = $(lv),
  sS = $(fv),
  cS = $(vv),
  lS = $(xv),
  uS = $(Sv),
  dS = $(pv)
function fS(e, t) {
  return $(e, {
    fields: t,
    mapFields(e, t) {
      let n = e(this.fields)
      return fS(Hv(n, t?.unsafePreserveChecks ? this.ast.checks : void 0), n)
    },
  })
}
function pS(e) {
  return fS(Hv(e, void 0), e)
}
function mS(e, t) {
  return $(Ry(e.ast, t.ast), { key: e, value: t })
}
function hS(e, t) {
  return $(e, {
    elements: t,
    mapElements(e, t) {
      let n = e(this.elements)
      return hS(Wv(n, t?.unsafePreserveChecks ? this.ast.checks : void 0), n)
    },
  })
}
function gS(e) {
  return hS(Wv(e), e)
}
var _S = Dx((e) => $(new Cv(!1, [], [e.ast]), { value: e })),
  vS = Dx((e) => $(new Cv(!1, [e.ast], [e.ast]), { value: e }))
function yS(e, t) {
  return $(e, {
    members: t,
    mapMembers(e, t) {
      let n = e(this.members)
      return yS(Gv(n, this.ast.options, t?.unsafePreserveChecks ? this.ast.checks : void 0), n)
    },
  })
}
function bS(e, t) {
  return yS(Gv(e, t, void 0), e)
}
function xS(e) {
  let t = e.map(rS)
  return $(Gv(t, void 0, void 0), {
    literals: e,
    members: t,
    mapMembers(e) {
      return bS(e(this.members))
    },
    pick(e) {
      return xS(e)
    },
    transform(e) {
      return bS(t.map((t, n) => t.transform(e[n])))
    },
  })
}
var SS = Dx((e) => bS([e, oS])),
  CS = Dx((e) => bS([e, sS]))
function wS(...e) {
  return (t) => t.check(...e)
}
function TS(e) {
  return (t) => $(t.ast, { schema: t, identifier: e })
}
function ES(e, t) {
  return (n) => $(Iy(n.ast, e.ast, t ? M_(t) : I_()), { from: n, to: e })
}
function DS() {
  return (e, t) => PS()(e, { decode: t, encode: v_ })
}
function OS(e) {
  return (t) => $(Fy(t.ast, e), { schema: t })
}
function kS(e) {
  return rS(e).pipe(OS(Rp(e)))
}
function AS(e, t) {
  return pS({ _tag: kS(e), ...t })
}
function jS(e) {
  return (t) => {
    let n = {},
      r = [],
      i = new Set(),
      a = {}
    return (
      o(t),
      Object.assign(t, {
        cases: n,
        discriminants: r,
        isAnyOf: (t) => (n) => t.includes(n[e]),
        guards: a,
        match: s,
        matchOrElse: c,
      })
    )
    function o(t) {
      let s = t.ast
      if (nv(s) && `members` in t && globalThis.Array.isArray(t.members) && t.members.every($x))
        return t.members.forEach(o)
      let c = Jv(s)
      if (c.length > 0) {
        let o = c.find((t) => t.key === e)?.literal
        if (le(o)) {
          let e = typeof o == `number` ? globalThis.String(o) : o
          if (i.has(e))
            throw new globalThis.Error(`Duplicate discriminant: ${globalThis.String(o)}`)
          ;(i.add(e), r.push(o), C(n, o, t), C(a, o, Pb(nS(t))))
          return
        }
      }
      throw new globalThis.Error(`No literal or unique symbol found`)
    }
    function s() {
      if (arguments.length === 1) {
        let t = arguments[0]
        return function (n) {
          let r = n[e]
          return (Object.hasOwn(t, r) ? t[r] : void 0)(n)
        }
      }
      let t = arguments[0],
        n = arguments[1],
        r = t[e]
      return (Object.hasOwn(n, r) ? n[r] : void 0)(t)
    }
    function c() {
      if (arguments.length === 2) {
        let t = arguments[0],
          n = arguments[1]
        return function (r) {
          let i = r[e]
          return (Object.hasOwn(t, i) ? (t[i] ?? n) : n)(r)
        }
      }
      let t = arguments[0],
        n = arguments[1],
        r = arguments[2],
        i = t[e]
      return (Object.hasOwn(n, i) ? (n[i] ?? r) : r)(t)
    }
  }
}
function MS(e) {
  let t = {},
    n = []
  for (let r of Object.keys(e)) {
    let i = AS(r, e[r])
    ;(C(t, r, i), n.push(i))
  }
  let r = bS(n),
    { guards: i, isAnyOf: a, match: o, matchOrElse: s } = jS(`_tag`)(r)
  return $(r.ast, { cases: t, isAnyOf: a, guards: i, match: o, matchOrElse: s })
}
function NS(e, t) {
  return Px((t) => t instanceof e, t)
}
function PS() {
  return (e, t) => new Z(e.ast, M_(t))
}
var FS = dy
function IS(e, t) {
  let n = e.source,
    r = e.flags,
    i = /^[dg]*uy?$/.test(r),
    a = r === `` ? `new RegExp(${S(n)})` : `new RegExp(${S(n)}, ${S(r)})`
  return hy(e, {
    toJsonSchema: () => (i ? { pattern: r.endsWith(`y`) ? `^(?:${n})` : n } : [{}, !0]),
    toCode: () => ({ runtime: `Schema.isPattern(${a})` }),
    ...t,
  })
}
var LS = $(py)
function RS(e) {
  let t = nr(e.order),
    n = e.formatter ?? S
  return (r, i) =>
    FS((e) => t(e, r), {
      expected: `a value greater than or equal to ${n(r)}`,
      arbitraryConstraint: { order: e.order, minimum: r },
      ...e.annotate?.(r),
      ...i,
    })
}
function zS(e) {
  let t = nr(e.order),
    n = er(e.order),
    r = tr(e.order),
    i = $n(e.order),
    a = e.formatter ?? S
  return (o, s) => {
    let c = o.exclusiveMinimum ? n : t,
      l = o.exclusiveMaximum ? i : r
    return FS((e) => c(e, o.minimum) && l(e, o.maximum), {
      expected: `a value between ${a(o.minimum)}${o.exclusiveMinimum ? ` (excluded)` : ``} and ${a(o.maximum)}${o.exclusiveMaximum ? ` (excluded)` : ``}`,
      arbitraryConstraint: {
        order: e.order,
        minimum: o.minimum,
        maximum: o.maximum,
        ...(o.exclusiveMinimum && { exclusiveMinimum: !0 }),
        ...(o.exclusiveMaximum && { exclusiveMaximum: !0 }),
      },
      ...e.annotate?.(o),
      ...s,
    })
  }
}
function BS(e) {
  if (!globalThis.Number.isFinite(e))
    throw new globalThis.RangeError(`Expected a finite number, got ${S(e)}`)
  return e
}
var VS = RS({
    order: Zn,
    annotate: (e) => ({
      representation: { id: `effect/schema/isGreaterThanOrEqualTo`, payload: { minimum: BS(e) } },
      toJsonSchema: () => ({ minimum: e }),
      toCode: () => ({ runtime: `Schema.isGreaterThanOrEqualTo(${S(e)})` }),
    }),
  }),
  HS = zS({
    order: Zn,
    annotate: (e) => {
      let t = e.exclusiveMinimum ? !0 : void 0,
        n = e.exclusiveMaximum ? !0 : void 0
      return {
        representation: {
          id: `effect/schema/isBetween`,
          payload: {
            minimum: BS(e.minimum),
            maximum: BS(e.maximum),
            ...(t && { exclusiveMinimum: t }),
            ...(n && { exclusiveMaximum: n }),
          },
        },
        toJsonSchema: () => ({
          [t ? `exclusiveMinimum` : `minimum`]: e.minimum,
          [n ? `exclusiveMaximum` : `maximum`]: e.maximum,
        }),
        toCode: () => ({
          runtime: `Schema.isBetween({ minimum: ${S(e.minimum)}, maximum: ${S(e.maximum)}, exclusiveMinimum: ${S(t)}, exclusiveMaximum: ${S(n)} })`,
        }),
      }
    },
  })
function US(e) {
  return FS((e) => globalThis.Number.isSafeInteger(e), {
    expected: `an integer`,
    representation: { id: `effect/schema/isInt`, payload: null },
    toJsonSchema: () => [{ type: `integer` }, !0],
    toCode: () => ({ runtime: `Schema.isInt()` }),
    arbitraryConstraint: { number: `integer` },
    ...e,
  })
}
var WS = lS.check(US())
function GS(e, t) {
  return ((e = YS(e)), KS(e, Math.ceil(e / 2), t))
}
function KS(e, t, n) {
  return FS((t) => t.length >= e, {
    expected: `a value with a length of at least ${e}`,
    representation: { id: `effect/schema/isMinLength`, payload: { minLength: e } },
    toJsonSchema: ({ type: n }) =>
      n === `string`
        ? e <= 1
          ? { minLength: t }
          : [{ minLength: t }, !0]
        : n === `array`
          ? { minItems: e }
          : n === void 0
            ? [{ minLength: t, minItems: e }, !0]
            : [{}, !0],
    toCode: () => ({ runtime: `Schema.isMinLength(${e})` }),
    [Mg]: !0,
    arbitraryConstraint: { minLength: e },
    ...n,
  })
}
function qS(e) {
  return KS(1, 1, e)
}
function JS(e, t) {
  return (
    (e = YS(e)),
    FS((t) => t.length <= e, {
      expected: `a value with a length of at most ${e}`,
      representation: { id: `effect/schema/isMaxLength`, payload: { maxLength: e } },
      toJsonSchema: ({ type: t }) =>
        t === `string`
          ? e === 0
            ? { maxLength: e }
            : [{ maxLength: e }, !0]
          : t === `array`
            ? { maxItems: e }
            : t === void 0
              ? [{ maxLength: e, maxItems: e }, !0]
              : [{}, !0],
      toCode: () => ({ runtime: `Schema.isMaxLength(${e})` }),
      [Mg]: !0,
      arbitraryConstraint: { maxLength: e },
      ...t,
    })
  )
}
function YS(e) {
  if (!globalThis.Number.isFinite(e))
    throw new globalThis.RangeError(`Expected a finite number, got ${e}`)
  return Math.max(0, Math.floor(e))
}
var XS = cS.check(qS()),
  ZS = (e) => +(e?.includeStack === !0) | (e?.excludeCause === !0 ? 2 : 0),
  QS = (e) => {
    switch (e) {
      case 0:
        return
      case 1:
        return { includeStack: !0 }
      case 2:
        return { excludeCause: !0 }
      case 3:
        return { includeStack: !0, excludeCause: !0 }
    }
  },
  $S = []
function eC(e) {
  let t = ZS(e),
    n = $S[t]
  if (n !== void 0) return n
  let r = OC.pipe(ES(aS, W_(QS(t))))
  return (($S[t] = r), r)
}
;(globalThis.RegExp, globalThis.URL)
var tC = cS.annotate({
  expected: `a string that will be decoded as JSON`,
  contentMediaType: `application/json`,
})
function nC(e, t) {
  return tC.pipe(ES(e, K_(t)))
}
var rC = nC(aS)
;(globalThis.File, globalThis.FormData, globalThis.URLSearchParams)
var iC = cS.annotate({
    expected: `a base64 encoded string that will be decoded as Uint8Array`,
    format: `byte`,
    contentEncoding: `base64`,
  }),
  aC = NS(globalThis.Uint8Array, {
    representation: { id: `effect/schema/Uint8Array`, payload: null },
    toCode: () => ({ runtime: `Schema.Uint8Array`, Type: `globalThis.Uint8Array` }),
    expected: `Uint8Array`,
    toCodecJson: () => PS()(iC, G_),
  })
function oC(e, t) {
  return $(
    Nx()(
      [e, t],
      ([e, t]) =>
        (n, r, i) => {
          if (!Od(n)) return W(new Jg(r, n, i))
          switch (n._tag) {
            case `Fail`:
              return vh(Lb(e)(n.error, i), {
                onSuccess: Nd,
                onFailure: (e) => Xg(r, `error`, e, n, i),
              })
            case `Die`:
              return vh(Lb(t)(n.defect, i), {
                onSuccess: Pd,
                onFailure: (e) => Xg(r, `defect`, e, n, i),
              })
            case `Interrupt`:
              return Rp(n)
          }
        },
      {
        representation: { id: `effect/schema/CauseReason`, payload: null },
        toCode: ({ typeParameters: e }) => ({
          runtime: `Schema.CauseReason(${e[0].runtime}, ${e[1].runtime})`,
          Type: `Cause.Failure<${e[0].Type}, ${e[1].Type}>`,
          importDeclarations: [`import * as Cause from "effect/Cause"`],
        }),
        expected: `Cause.Failure`,
        toCodec: ([e, t]) =>
          PS()(
            bS([
              pS({ _tag: rS(`Fail`), error: e }),
              pS({ _tag: rS(`Die`), defect: t }),
              pS({ _tag: rS(`Interrupt`), fiberId: CS(LS) }),
            ]),
            P_({
              decode: (e) => {
                switch (e._tag) {
                  case `Fail`:
                    return Nd(e.error)
                  case `Die`:
                    return Pd(e.defect)
                  case `Interrupt`:
                    return Fd(e.fiberId)
                }
              },
              encode: (e) => {
                switch (e._tag) {
                  case `Fail`:
                    return { _tag: `Fail`, error: e.error }
                  case `Die`:
                    return { _tag: `Die`, defect: e.defect }
                  case `Interrupt`:
                    return { _tag: `Interrupt`, fiberId: e.fiberId }
                }
              },
            }),
          ),
      },
    ).ast,
    { error: e, defect: t },
  )
}
function sC(e, t) {
  return $(
    Nx()(
      [e, t],
      ([e, t]) => {
        let n = _S(oC(e, t))
        return (e, t, r) =>
          Dd(e)
            ? vh(Lb(n)(e.reasons, r), {
                onSuccess: Ad,
                onFailure: (n) => Xg(t, `failures`, n, e, r),
              })
            : W(new Jg(t, e, r))
      },
      {
        representation: { id: `effect/schema/Cause`, payload: null },
        toCode: ({ typeParameters: e }) => ({
          runtime: `Schema.Cause(${e[0].runtime}, ${e[1].runtime})`,
          Type: `Cause.Cause<${e[0].Type}, ${e[1].Type}>`,
          importDeclarations: [`import * as Cause from "effect/Cause"`],
        }),
        expected: `Cause`,
        toCodec: ([e, t]) => PS()(_S(oC(e, t)), P_({ decode: Ad, encode: ({ reasons: e }) => e })),
      },
    ).ast,
    { error: e, defect: t },
  )
}
var cC = N_({
    decode: (e, t) =>
      ar(Uh(e), {
        onNone: () => W(new Yg({ expected: `a valid UTC DateTime string` }, e, t)),
        onSome: (e) => Rp(Gh(e)),
      }),
    encode: (e) => Rp(Yh(e)),
  }),
  lC = -864e13,
  uC = 864e13
function dC(e, t, n) {
  let r = Math.max(
      t,
      e?.minimum === void 0 ? t : e.minimum.epochMilliseconds + +(e.exclusiveMinimum === !0),
    ),
    i = Math.min(
      n,
      e?.maximum === void 0 ? n : e.maximum.epochMilliseconds - +(e.exclusiveMaximum === !0),
    )
  return r <= i ? [r, i] : [t, n]
}
function fC(e, t) {
  return WS.check(HS({ minimum: e, maximum: t }))
}
var pC = Px((e) => Bh(e) && Vh(e), {
  representation: { id: `effect/schema/DateTimeUtc`, payload: null },
  toCode: () => ({
    runtime: `Schema.DateTimeUtc`,
    Type: `DateTime.Utc`,
    importDeclarations: [`import * as DateTime from "effect/DateTime"`],
  }),
  expected: `DateTime.Utc`,
  toCodecArbitrary: ({ constraint: e }) => {
    let [t, n] = dC(e, lC, uC)
    return DS()(fC(t, n), Y(Hh))
  },
  toCodecJson: () => PS()(cS, cC),
  toFormatter: () => (e) => e.toString(),
})
function mC(e) {
  return $(
    Nx()(
      [e],
      ([e]) =>
        (t, n, r) =>
          rr(t)
            ? M(t)
              ? zp
              : vh(Lb(e)(t.value, r), { onSuccess: j, onFailure: (e) => Xg(n, `value`, e, t, r) })
            : W(new Jg(n, t, r)),
      {
        representation: { id: `effect/schema/Option`, payload: null },
        toCode: ({ typeParameters: e }) => ({
          runtime: `Schema.Option(${e[0].runtime})`,
          Type: `Option.Option<${e[0].Type}>`,
          importDeclarations: [`import * as Option from "effect/Option"`],
        }),
        expected: `Option`,
        toCodec: ([e]) =>
          PS()(
            bS([pS({ _tag: rS(`Some`), value: e }), pS({ _tag: rS(`None`) })]),
            P_({
              decode: (e) => (e._tag === `None` ? A() : j(e.value)),
              encode: (e) => (ir(e) ? { _tag: `Some`, value: e.value } : { _tag: `None` }),
            }),
          ),
      },
    ).ast,
    { value: e },
  )
}
var hC = Px(_g, {
    representation: { id: `effect/http/UrlParams`, payload: null },
    toCode: () => ({
      runtime: `Schema.UrlParams`,
      Type: `UrlParams.UrlParams`,
      importDeclarations: [`import * as UrlParams from "effect/http/UrlParams"`],
    }),
    expected: `UrlParams`,
    toEquivalence: () => Sg,
    toCodec: () => PS()(_S(gS([cS, cS])), P_({ decode: yg, encode: (e) => e.params })),
  }).pipe(ES(mS(cS, bS([cS, vS(cS)])), P_({ decode: kg, encode: bg }))),
  gC = globalThis.Symbol.for(`immer-draftable`),
  _C = {}
function vC(t, n, r, i, a) {
  let o = xC(r, n, i),
    s = bC(n),
    c = class extends t {
      constructor(...[e, t]) {
        let n = t?.[`~payload`],
          i = n?.token === _C ? n.value : r.make(e ?? {}, t)
        super(i, { ...t, disableChecks: !0, "~payload": { token: _C, value: i } })
      }
      static [Mx] = Mx
      get [s]() {
        return s
      }
      static [gC] = !0
      static identifier = n
      static fields = r.fields
      static get ast() {
        return o(this).ast
      }
      static pipe() {
        return e(this, arguments)
      }
      static rebuild(e) {
        return o(this).rebuild(e)
      }
      static make(e, t) {
        return Nb(o(this))(e ?? {}, t)
      }
      static makeOption(e, t) {
        return Mb(o(this))(e ?? {}, t)
      }
      static makeEffect(e, t) {
        return o(this).makeEffect(e ?? {}, t)
      }
      static annotate(e) {
        return this.rebuild(xy(this.ast, e))
      }
      static annotateKey(e) {
        return this.rebuild(jy(this.ast, e))
      }
      static check(...e) {
        return this.rebuild(Cy(this.ast, e))
      }
      static extend(e) {
        return (t, n) => {
          let i = SC(t) ? t : pS(t),
            o = { ...r.fields, ...i.fields },
            s = Hv(o, r.ast.checks, { identifier: e })
          return vC(this, e, fS(Cy(s, i.ast.checks), o), n, a)
        }
      }
      static mapFields(e, t) {
        return r.mapFields(e, t)
      }
    }
  return (a !== void 0 && Object.assign(c.prototype, a(n)), c)
}
function yC(e) {
  return new X(
    Y((t) => new e(t, { "~payload": { token: _C, value: t } })),
    b_(),
  )
}
function bC(e) {
  return `~effect/Schema/Class/${e}`
}
function xC(e, t, n) {
  let r
  return (i) => {
    if (r !== void 0) return r
    let a = bC(t),
      o = (e) => e instanceof i || h(e, a),
      s = yC(i)
    return (r = ES(
      $(
        new cv([e.ast], () => (e, t, n) => (o(e) ? Rp(e) : W(new Jg(t, e, n))), {
          identifier: t,
          [Pg]: ([e]) => ({ isConstructed: o, link: new Z(e, s) }),
          toCodec: ([e]) => new Z(e.ast, s),
          toEquivalence: ([e]) => e,
          toFormatter:
            ([e]) =>
            (t) =>
              `${i.identifier}(${e(t)})`,
          [Ng]: Jv(e.ast),
          ...n,
        }),
      ),
      s,
    )(e))
  }
}
function SC(e) {
  return $x(e)
}
var CC = (e) => (t, n) => vC(pn, e, SC(t) ? t : pS(t), n, (e) => ({ name: e })),
  wC = (e) => (t, n, r) => {
    let i = SC(n)
      ? n.mapFields((e) => ({ _tag: kS(t), ...e }), { unsafePreserveChecks: !0 })
      : AS(t, n)
    return CC(e ?? t)(i, r)
  }
function TC(e) {
  return yx(e.ast)
}
var EC = ax,
  DC = fx,
  OC = $(xy(db, { toCode: () => ({ runtime: `Schema.Json`, Type: `Schema.Json` }) }))
export {
  IS as $,
  ti as $a,
  Qi as $i,
  Rm as $n,
  x as $o,
  Jd as $r,
  mh as $t,
  dS as A,
  ga as Aa,
  zu as Ai,
  am as An,
  A as Ao,
  Pf as Ar,
  d as As,
  Og as At,
  qx as B,
  xi as Ba,
  mo as Bi,
  rh as Bn,
  ln as Bo,
  _f as Br,
  zm as Bt,
  MS as C,
  ji as Ca,
  js as Ci,
  _m as Cn,
  M as Co,
  fm as Cr,
  l as Cs,
  N_ as Ct,
  bS as D,
  Oi as Da,
  H as Di,
  Hm as Dn,
  fr as Do,
  Ff as Dr,
  f as Ds,
  wg as Dt,
  CS as E,
  la as Ea,
  wu as Ei,
  Gp as En,
  br as Eo,
  jf as Er,
  r as Es,
  Dg as Et,
  Kx as F,
  gi as Fa,
  z as Fi,
  Mm as Fn,
  nr as Fo,
  Mf as Fr,
  Yh as Ft,
  Zx as G,
  oi as Ga,
  Wa as Gi,
  ch as Gn,
  wt as Go,
  lf as Gr,
  lm as Gt,
  Xx as H,
  Ci as Ha,
  ho as Hi,
  nh as Hn,
  k as Ho,
  ff as Hr,
  Np as Ht,
  ES as I,
  bi as Ia,
  uu as Ii,
  Fm as In,
  wn as Io,
  Nf as Ir,
  Hh as It,
  Vx as J,
  ui as Ja,
  Mi as Ji,
  dh as Jn,
  _t as Jo,
  Yd as Jr,
  Wp as Jt,
  nC as K,
  li as Ka,
  Ga as Ki,
  oh as Kn,
  bt as Ko,
  af as Kr,
  um as Kt,
  Hx as L,
  yi as La,
  V as Li,
  Tm as Ln,
  vn as Lo,
  df as Lr,
  Wh as Lt,
  wS as M,
  Hi as Ma,
  L as Mi,
  Sm as Mn,
  j as Mo,
  Vf as Mr,
  lg as Mt,
  Px as N,
  _a as Na,
  Rs as Ni,
  Ip as Nn,
  vr as No,
  Uf as Nr,
  mg as Nt,
  aS as O,
  ma as Oa,
  bs as Oi,
  Um as On,
  mr as Oo,
  Lf as Or,
  i as Os,
  bg as Ot,
  Ux as P,
  ra as Pa,
  B as Pi,
  jm as Pn,
  Zn as Po,
  Wf as Pr,
  Jh as Pt,
  GS as Q,
  ri as Qa,
  Zi as Qi,
  Lm as Qn,
  rt as Qo,
  tf as Qr,
  pm as Qt,
  Wx as R,
  Si as Ra,
  ko as Ri,
  im as Rn,
  Ft as Ro,
  hf as Rr,
  Kh as Rt,
  AS as S,
  Ai as Sa,
  Os as Si,
  sm as Sn,
  dr as So,
  Zp as Sr,
  o as Ss,
  P_ as St,
  sS as T,
  aa as Ta,
  As as Ti,
  Om as Tn,
  ir as To,
  Af as Tr,
  a as Ts,
  Yg as Tt,
  Qx as U,
  mi as Ua,
  co as Ui,
  ah as Un,
  C as Uo,
  pf as Ur,
  nm as Ut,
  Yx as V,
  vi as Va,
  vo as Vi,
  th as Vn,
  O as Vo,
  gf as Vr,
  Bm as Vt,
  Jx as W,
  ai as Wa,
  ro as Wi,
  sh as Wn,
  Ct as Wo,
  uf as Wr,
  cm as Wt,
  VS as X,
  si as Xa,
  oa as Xi,
  uh as Xn,
  S as Xo,
  $d as Xr,
  gm as Xt,
  HS as Y,
  ii as Ya,
  Ni as Yi,
  fh as Yn,
  vt as Yo,
  ef as Yr,
  hm as Yt,
  JS as Z,
  ni as Za,
  ba as Zi,
  Im as Zn,
  at as Zo,
  Qd as Zr,
  mm as Zt,
  mS as _,
  xa as _a,
  Js as _i,
  Kp as _n,
  cr as _o,
  Em as _r,
  ae as _s,
  nv as _t,
  eC as a,
  ea as aa,
  Gd as ai,
  W as an,
  Qr as ao,
  Vp as ar,
  Ae as as,
  kS as at,
  pS as b,
  Ri as ba,
  jc as bi,
  Mp as bn,
  ur as bo,
  Qm as br,
  re as bs,
  Wy as bt,
  OC as c,
  F as ca,
  Vd as ci,
  em as cn,
  Jr as co,
  bm as cr,
  se as cs,
  TC as ct,
  iS as d,
  Ui as da,
  Id as di,
  dm as dn,
  $r as do,
  Xp as dr,
  he as ds,
  Tx as dt,
  ca as ea,
  Zd as ei,
  km as en,
  P as eo,
  Nm as er,
  b as es,
  $x as et,
  vS as f,
  Wi as fa,
  Dd as fi,
  ph as fn,
  _r as fo,
  qm as fr,
  fe as fs,
  by as ft,
  mC as g,
  Li as ga,
  pc as gi,
  eh as gn,
  gr as go,
  Up as gr,
  ve as gs,
  rv as gt,
  lS as h,
  Fi as ha,
  hc as hi,
  $m as hn,
  hr as ho,
  Xm as hr,
  ye as hs,
  tv as ht,
  pC as i,
  fa as ia,
  Md as ii,
  om as in,
  N as io,
  Bp as ir,
  y as is,
  eS as it,
  TS as j,
  Xi as ja,
  ql as ji,
  vm as jn,
  sr as jo,
  Df as jr,
  e as js,
  dg as jt,
  rC as k,
  na as ka,
  Bu as ki,
  Km as kn,
  ar as ko,
  Rf as kr,
  p as ks,
  Eg as kt,
  rS as l,
  Bi as la,
  Ad as li,
  yh as ln,
  Ur as lo,
  ym as lr,
  ue as ls,
  nS as lt,
  SS as m,
  Ii as ma,
  zd as mi,
  Ym as mn,
  yr as mo,
  Pm as mr,
  oe as ms,
  Y_ as mt,
  uS as n,
  ha as na,
  qd as ni,
  Yp as nn,
  Wr as no,
  Rp as nr,
  _ as ns,
  FS as nt,
  LS as o,
  $i as oa,
  jd as oi,
  qp as on,
  Kr as oo,
  Hp as or,
  g as os,
  EC as ot,
  XS as p,
  Pi as pa,
  Ud as pi,
  Pp as pn,
  xr as po,
  Jm as pr,
  pe as ps,
  Q_ as pt,
  NS as q,
  ci as qa,
  Xa as qi,
  lh as qn,
  xt as qo,
  Xd as qr,
  Wm as qt,
  sC as r,
  pa as ra,
  Rd as ri,
  Vm as rn,
  Vr as ro,
  zp as rr,
  Ee as rs,
  tS as rt,
  WS as s,
  ya as sa,
  Bd as si,
  Cm as sn,
  qr as so,
  rm as sr,
  h as ss,
  DC as st,
  _S as t,
  ki as ta,
  Wd as ti,
  Am as tn,
  Cr as to,
  wm as tr,
  v as ts,
  $ as tt,
  xS as u,
  da as ua,
  Hd as ui,
  tm as un,
  Ir as uo,
  Lp as ur,
  me as us,
  Ex as ut,
  hC as v,
  Gi as va,
  $c as vi,
  xm as vn,
  lr as vo,
  Fp as vr,
  xe as vs,
  X_ as vt,
  aC as w,
  ta as wa,
  Ns as wi,
  Dm as wn,
  rr as wo,
  kf as wr,
  u as ws,
  Zg as wt,
  wC as x,
  ua as xa,
  Fc as xi,
  hh as xn,
  pr as xo,
  Zm as xr,
  s as xs,
  Uy as xt,
  cS as y,
  Ki as ya,
  Ec as yi,
  Gm as yn,
  or as yo,
  Qp as yr,
  de as ys,
  ob as yt,
  Gx as z,
  Ti as za,
  _o as zi,
  ih as zn,
  un as zo,
  mf as zr,
  qh as zt,
}
