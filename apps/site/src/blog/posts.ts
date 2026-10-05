/** A published post's metadata, shared by the blog index and the post's own page. */
export interface Post {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly category: string
  readonly author: string
  readonly published: string
}

/** The published posts, newest first. */
export const posts: ReadonlyArray<Post> = [
  {
    slug: "introducing-akter",
    title: "Introducing Akter",
    summary:
      "The framework for durable, stateful backends, and why we built it around one actor per thing.",
    category: "Announcement",
    author: "Dallen Pyrah",
    published: "2026-10-04",
  },
]
