---
name: ssr-it
description: Makes documentation pages arrive complete in rendered HTML and stay stable through hydration and navigation. Use when building or changing a documentation page, route, sidebar, panel or navigation, or for "no loading state".
---

# SSR it

Done: the first HTML contains the documentation's visible content, hydration adds no missing content or
layout shift, and navigation stays usable on a slow or failed request.

1. **Scope.** This skill covers the Next documentation app in `apps/docs`, not the framework runtime or
   a hosted console. Read `apps/docs/next.config.ts`: production is a static export, not a live SSR server.
2. **Inventory.** List visible content, sidebar, headings, selections and theme, with their build-time or
   server source and client owner. Follow `apps/docs/src/app` and `apps/docs/src/content`; keep
   interactive concerns in the existing component boundaries in `apps/docs/src/components`.
3. **Render complete content.** Build document content into HTML. Do not replace available content with
   client-only fetching, lazy placeholders or loading flashes. Preserve the app's theme and navigation
   conventions; do not add a second state model or import server-only framework modules into browser code.
4. **Prove the HTML.** On your isolated surface (`../prove-it/references/stack.md`):
   - Fetch the changed page with `curl`; check its actual headings and body, not a successful status alone.
   - Block scripts in isolated agent-browser, reload, and screenshot 1440×900 and 390×844 in both themes.
     Compare with the hydrated page; only interactive affordances may differ.
   - Check console and page errors. No hydration warnings, missing fonts, content jumps or overflow.
   - For export claims, build and serve the static output, then repeat the changed page, deep-link and
     Markdown-twin checks. Development rewrites do not prove exported files exist.
5. **Prove navigation.** With destination requests blocked or delayed, check link intent, back, forward,
   direct reload, keyboard focus and rapid A-then-B navigation. Stale results must not replace the final
   destination. Test the app's actual behavior; there is no application auth/persona switching here.
   Extend the colocated navigation and shell tests when their boundary covers the regression.

**Reply:** the content inventory, fetched HTML evidence, no-script and hydrated screenshots with their
diff, navigation results, and whether the static export was checked.
