import Link from "next/link"

import { DocsShell } from "../components/docs-shell.tsx"

export default function NotFound() {
  return (
    <DocsShell>
      <article className="ak-page ak-landing" data-kind="landing">
        <section className="ak-hero">
          <h1 className="ak-hero-title">Page not found</h1>
          <div className="ak-hero-lede">
            <p>The page you are looking for does not exist, or it has moved.</p>
          </div>
          <div className="ak-hero-actions">
            <Link className="ak-btn ak-btn-lg" href="/welcome">
              Back to the docs
            </Link>
          </div>
        </section>
      </article>
    </DocsShell>
  )
}
