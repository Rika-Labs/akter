export interface Authorship {
  readonly author: string
  readonly crossRepository: boolean
}

/**
 * Whether a pull request's code may run directly on the maintainer's machine. Only a branch in the
 * base repository, or a pull request by a named maintainer, is trusted; a fork, a deleted fork and
 * a bot account are not, so anything this function cannot positively identify runs in the sandbox.
 */
export function isTrusted(pull: Authorship, trustedAuthors: ReadonlyArray<string>): boolean {
  const author = pull.author.toLowerCase()
  if (trustedAuthors.some((name) => name.toLowerCase() === author)) return true
  return !pull.crossRepository && !author.endsWith("[bot]") && author !== ""
}
