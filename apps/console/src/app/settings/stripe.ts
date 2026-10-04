import { Function, Option } from "effect"

/** The Stripe hosts whose Checkout, billing portal and invoice pages the console may open. */
const stripeHosts: ReadonlyArray<string> = [
  "checkout.stripe.com",
  "billing.stripe.com",
  "invoice.stripe.com",
  "pay.stripe.com",
]

/** The local API's Stripe stand-in serves its Checkout and portal sessions on these paths. */
const standInPath = /^\/billing\/(?:checkout|portal)\/[A-Za-z0-9_]+$/u

/**
 * Where hosted billing links are opened from: the console's origin, and whether the local API's
 * Stripe stand-in can be behind it. The stand-in only runs beside the Vite development server, which
 * proxies `/billing` to it, so a production build never accepts a same-origin billing page.
 */
export interface HostedPageContext {
  readonly origin: string | undefined
  readonly standIn: boolean
}

/** The context of the running console. */
export const browserContext = (): HostedPageContext => ({
  origin: typeof location === "undefined" ? undefined : location.origin,
  standIn: import.meta.env.DEV,
})

const parse = Option.liftThrowable((value: string) => new URL(value))

/**
 * A billing URL from the API, if the console may open it: `https:` on a Stripe host without
 * credentials or a port, or, where the stand-in runs, one of its pages on the console's own origin.
 * Anything else, such as a `javascript:` URL or a lookalike host, is refused, because these URLs are
 * navigated to or opened in a tab that starts on the console's origin.
 */
export const hostedPageUrl: {
  (context: HostedPageContext): (value: string) => Option.Option<string>
  (value: string, context: HostedPageContext): Option.Option<string>
} = Function.dual(2, (value: string, context: HostedPageContext): Option.Option<string> =>
  parse(value).pipe(
    Option.filter(
      (url) =>
        (url.protocol === "https:" &&
          stripeHosts.includes(url.hostname) &&
          url.port === "" &&
          url.username === "" &&
          url.password === "") ||
        (context.standIn &&
          context.origin !== undefined &&
          url.origin === context.origin &&
          standInPath.test(url.pathname) &&
          url.search === ""),
    ),
    Option.map((url) => url.href),
  ),
)
