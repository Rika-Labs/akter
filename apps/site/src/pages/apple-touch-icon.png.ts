import type { APIRoute } from "astro"
import { touchIcon } from "../assets/images.ts"

export const GET: APIRoute = async () =>
  new Response((await touchIcon()).slice(), { headers: { "content-type": "image/png" } })
