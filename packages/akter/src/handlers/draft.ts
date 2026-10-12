import { Predicate } from "effect"

/** The result of a draft session: the next value and the top-level fields that changed. */
export interface Finished<T> {
  readonly value: T
  readonly changed: ReadonlyArray<string>
}

/** One action's draft over a value, finished once. */
export interface Session<T> {
  readonly draft: T
  finish(): Finished<T>
}

/** A plain object or array, the only containers the draft copies; read and written by key. */
type Container = any

interface Node {
  readonly base: Container
  copy: Container
  readonly parent: Node | undefined
  readonly drafts: Map<string, Container>
  final: Container
  holdsDrafts: boolean
}

const own = (target: Container, key: string): boolean => Object.hasOwn(target, key)

const isDraftable = (value: Container): boolean => {
  if (Array.isArray(value)) return true
  if (!Predicate.isObject(value) || Predicate.isFunction(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const shallowCopy = (base: Container): Container =>
  Array.isArray(base) ? base.slice() : { ...base }

/**
 * Begins a copy-on-write draft over plain objects and arrays with plain JavaScript semantics.
 * Reads go to the committed value until a write copies the touched container and its ancestors;
 * drafted children live inside the copy, so array methods move them and aliasing a drafted value
 * keeps one object, as it would without a draft. `finish` returns the next value with every
 * untouched branch shared, plus the changed top-level fields. Class instances, maps, sets and dates
 * are values: replace them, do not mutate them. Nothing in `base` is ever written.
 */
const begin = <T extends object>(base: T): Session<T> => {
  const original: Container = base
  const nodes = new WeakMap<object, Node>()
  const assigned: Array<Container> = []

  const ensureCopy = (node: Node): Container => {
    if (node.copy !== undefined) return node.copy
    const copy = shallowCopy(node.base)
    for (const [key, proxy] of node.drafts) copy[key] = proxy
    node.copy = copy
    if (node.parent !== undefined) ensureCopy(node.parent)
    return copy
  }

  const current = (node: Node): Container => node.copy ?? node.base

  const remember = (node: Node, value: Container): void => {
    if (!Predicate.isObject(value)) return
    if (nodes.has(value)) node.holdsDrafts = true
    else if (isDraftable(value)) assigned.push(value)
  }

  const make = (target: Container, parent: Node | undefined): Container => {
    const node: Node = {
      base: target,
      copy: undefined,
      parent,
      drafts: new Map(),
      final: undefined,
      holdsDrafts: false,
    }
    const child = (key: string, value: Container): Container => {
      const proxy = make(value, node)
      node.holdsDrafts = true
      if (node.copy === undefined) node.drafts.set(key, proxy)
      else node.copy[key] = proxy
      return proxy
    }
    const proxy = new Proxy(target, {
      get(_, key) {
        const source = current(node)
        if (Predicate.isSymbol(key)) return source[key]
        if (key === "push" && Array.isArray(source))
          return (...items: Array<Container>) => {
            const copy = ensureCopy(node)
            for (const item of items) remember(node, item)
            return copy.push(...items)
          }
        const value = source[key]
        if (!isDraftable(value) || !own(source, key) || nodes.has(value)) return value
        if (node.copy === undefined) {
          const existing = node.drafts.get(key)
          if (existing !== undefined) return existing
        }
        return child(key, value)
      },
      set(_, key, value) {
        if (Predicate.isSymbol(key)) return false
        const source = current(node)
        if (own(source, key) && source[key] === value) return true
        ensureCopy(node)[key] = value
        remember(node, value)
        return true
      },
      deleteProperty(_, key) {
        if (Predicate.isSymbol(key)) return false
        if (!own(current(node), key)) return true
        delete ensureCopy(node)[key]
        return true
      },
      has: (_, key) => key in current(node),
      ownKeys: () => Reflect.ownKeys(current(node)),
      getOwnPropertyDescriptor(_, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(current(node), key)
        if (descriptor === undefined) return undefined
        return { ...descriptor, configurable: !(key === "length" && Array.isArray(node.base)) }
      },
    })
    nodes.set(proxy, node)
    return proxy
  }

  const finalize = (node: Node): Container => {
    if (node.final !== undefined) return node.final
    const copy = node.copy
    if (copy === undefined) {
      node.final = node.base
      return node.base
    }
    node.final = copy
    if (!node.holdsDrafts) return copy
    for (const key of Object.keys(copy)) {
      const value = copy[key]
      const inner = Predicate.isObject(value) ? nodes.get(value) : undefined
      if (inner !== undefined) copy[key] = finalize(inner)
    }
    return copy
  }

  const resolve = (value: Container, seen: Set<object>): void => {
    if (seen.has(value)) return
    seen.add(value)
    for (const key of Object.keys(value)) {
      const inner = value[key]
      if (!Predicate.isObject(inner)) continue
      const node = nodes.get(inner)
      if (node !== undefined) value[key] = finalize(node)
      else if (isDraftable(inner)) resolve(inner, seen)
    }
  }

  const root = make(original, undefined)
  const rootNode = nodes.get(root)

  return {
    draft: root,
    finish: () => {
      const value = rootNode === undefined ? original : finalize(rootNode)
      const seen = new Set<object>()
      for (const item of assigned) resolve(item, seen)
      const changed: Array<string> = []
      if (value !== original) {
        for (const key of Object.keys(value))
          if (value[key] !== original[key] || !own(original, key)) changed.push(key)
        for (const key of Object.keys(original)) if (!own(value, key)) changed.push(key)
      }
      return { value, changed }
    },
  }
}

/** The copy-on-write draft of an action's state. */
export const Draft = { begin }
