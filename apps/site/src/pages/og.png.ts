import type { APIRoute } from "astro"
import { openGraphImage } from "../assets/images.ts"

export const GET: APIRoute = async () =>
  new Response((await openGraphImage()).slice(), { headers: { "content-type": "image/png" } })
