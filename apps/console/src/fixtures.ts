import type { Dashboard } from "./http.js"

/** Fixed dashboard data for the isolated preview. */
export const dashboard: Dashboard = {
  user: { name: "Alex Morgan", email: "alex@example.test" },
  organization: { id: "org-1", name: "Northstar Studio", slug: "northstar", role: "owner" },
  members: [{ id: "member-1", name: "Alex Morgan", email: "alex@example.test", role: "owner" }],
  projects: [
    { id: "project-1", name: "Website refresh", status: "active" },
    { id: "project-2", name: "Customer research", status: "planning" },
  ],
  billing: { plan: "Free", status: "active" },
}
