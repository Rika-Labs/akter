import type { APIRoute } from "astro"
import { faviconSvg } from "../assets/images.ts"

export const GET: APIRoute = () =>
  new Response(faviconSvg(), { headers: { "content-type": "image/svg+xml" } })
