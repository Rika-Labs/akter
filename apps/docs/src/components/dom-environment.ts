/**
 * What the components read from a browser that jsdom does not provide: the size observer the
 * menus' positioning uses, scrolling an element into view, and the media query that tells the
 * shell whether the window is wide.
 * `resizeTo` changes the window and tells whoever listens, the way a resize does.
 */
class StubResizeObserver implements ResizeObserver {
  observe() {}

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver = StubResizeObserver

Element.prototype.scrollIntoView = () => {}

const listeners = new Set<EventListenerOrEventListenerObject>()

let wide = false

window.matchMedia = (query: string): MediaQueryList => ({
  get matches() {
    return wide
  },
  media: query,
  onchange: null,
  addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.add(listener)
  },
  removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.delete(listener)
  },
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})

export const resizeTo = (nowWide: boolean): void => {
  wide = nowWide

  for (const listener of listeners)
    if ("handleEvent" in listener) listener.handleEvent(new Event("change"))
    else listener(new Event("change"))
}
