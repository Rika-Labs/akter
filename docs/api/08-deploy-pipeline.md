# Deploy pipeline

The deploy API separates building an image from rolling it out. A GitHub Actions build must finish and push a content-addressed ARM64 image before it creates a rollout. A failed build never changes the live deployment.

1. Create a deployment with `POST /api/projects/:projectId/deployments`, passing `environment` and `commitSha`. The caller needs write access to that project.
2. Record the successful build with `POST /api/projects/:projectId/deployments/:deploymentId/build`, passing `image`, the same `commitSha`, and `environmentSnapshot`. An image is a repository-qualified `@sha256:` digest, or a local `sha256:` image id. Mutable tags are refused.
3. Poll the deployment detail until it is `live` or `failed`. Provider calls execute as durable actor jobs, not in the HTTP request.

A control plane configured with a builder builds each new deployment itself instead: create and redeploy enqueue a durable `build` job that builds the commit and records the image as `RecordBuild` would, and a failed build fails the deployment and leaves the live one serving. The local development stack builds this way with Docker (`RUNNER_BUILD_CONTEXT`, see `apps/api/README.md`); hosted control planes have no builder and wait for the recorded build. A build result recorded first wins, and a later build job changes nothing.

If a caller creates the record before its external build and that build fails, `POST /api/projects/:projectId/deployments/:deploymentId/build-failure` records `{ "reason": "..." }` and releases the environment for a later rollout. The workflow template creates its record only after a successful image push, so a failed Actions build cannot occupy the environment.

`infra/workflows/deploy.yml` is a reusable workflow template for customer repositories. Publish it as a workflow in a repository accessible to the customer, pin the caller's `uses` reference to a commit, and supply the project, environment, registry, and repository inputs. It builds Linux ARM64 and registers the digest and commit after the push succeeds. The `AKTER_API_KEY` secret must have project write access. `ECR_PASSWORD` must be a short-lived ECR login password obtained by authorized credential-bearing automation; this template does not obtain AWS credentials. No ECR push or GitHub App installation has been verified without credentials.

The environment snapshot is immutable once the build has been recorded. Do not print it in build logs. A rollback targets an earlier deployment that reached live, copies its image and snapshot into a new deployment, and skips build and migrate. The replaced deployment is marked rolled-back only after the replacement is live; a failed replacement leaves it serving.
