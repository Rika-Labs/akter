import { make, none } from "./auth.ts"
import { assertion } from "./assertion/verify.ts"
import { jwt } from "./jwt.ts"

/**
 * The ways `Akter.serve` authenticates: `none` serves every request as `Anonymous`, `make` runs
 * a custom function, `jwt` verifies bearer JWTs and `assertion` verifies a hosted edge's signed
 * assertions.
 */
export const Auth = { none, make, jwt, assertion }
