# Kubernetes

On Kubernetes, the server is a StatefulSet with one pod, behind a load balancer, and the store is an R2 bucket. Alchemy's [Kubernetes provider](https://alchemy.run/kubernetes) applies it to any cluster in your kubeconfig, such as EKS, k3s or one you run yourself. For a cluster Alchemy creates too, see [Google Cloud](google-cloud.md).

You need:

- The `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), and `infra/store.ts` from [The bucket](overview.md#the-bucket).
- A cluster that can give a Service a public load balancer, and a kubeconfig context for it.
- A container registry, such as GitHub's, and a login that can push to it.
- Docker running locally. Alchemy builds the image on your machine.

## Install

```sh
bun add -d alchemy @alchemy.run/cloudflare @alchemy.run/kubernetes @alchemy.run/docker
```

## The server

Create `infra/kubernetes.ts`. It describes the server's Kubernetes objects, and the [Google Cloud guide](google-cloud.md) uses it too:

```ts
import { createHash } from "node:crypto"
import * as Kubernetes from "@alchemy.run/kubernetes"
import type { Input } from "alchemy/Input"
import * as Output from "alchemy/Output"
import { Config, Effect, Redacted } from "effect"
import { R2Store } from "./store.ts"

const name = "akter"
const namespace = "default"
const labels = { "app.kubernetes.io/name": name }

/** The pushed image, by digest, so every build changes the pod and rolls it. */
export const byDigest = (image: { readonly repoDigest: Output.Output<string | undefined> }) =>
  image.repoDigest.pipe(
    Output.map((digest) => {
      if (digest === undefined) throw new Error("The registry reported no digest for the image")
      return digest
    }),
  )

/** The Akter server on a Kubernetes cluster: one pod, its storage keys, and a load balancer. */
export const Server = (options: {
  readonly cluster: Input<Kubernetes.ClusterLike>
  readonly image: Input<string>
  readonly imagePullSecret?: Input<string>
}) =>
  Effect.gen(function* () {
    const store = yield* R2Store
    const keys = yield* Kubernetes.Manifest("StorageKeys", {
      cluster: options.cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: { name: `${name}-storage`, namespace },
        stringData: {
          AWS_ACCESS_KEY_ID: store.accessKeyId,
          AWS_SECRET_ACCESS_KEY: store.secretAccessKey,
        },
      },
    })
    const keysHash = Output.all(store.accessKeyId, store.secretAccessKey).pipe(
      Output.map(([id, secret]) =>
        createHash("sha256").update(id).update(Redacted.value(secret)).digest("hex"),
      ),
    )
    const fromKeys = (key: string) => ({
      name: key,
      valueFrom: { secretKeyRef: { name: keys.name, key } },
    })

    const service = yield* Kubernetes.Manifest("Service", {
      cluster: options.cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name, namespace, labels },
        spec: {
          type: "LoadBalancer",
          selector: labels,
          ports: [{ name: "http", port: 80, targetPort: 8080 }],
        },
      },
    })

    yield* Kubernetes.Manifest("Server", {
      cluster: options.cluster,
      manifest: {
        apiVersion: "apps/v1",
        kind: "StatefulSet",
        metadata: { name, namespace, labels },
        spec: {
          serviceName: service.name,
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels, annotations: { "checksum/storage-keys": keysHash } },
            spec: {
              terminationGracePeriodSeconds: 30,
              ...(options.imagePullSecret === undefined
                ? {}
                : { imagePullSecrets: [{ name: options.imagePullSecret }] }),
              containers: [
                {
                  name: "server",
                  image: options.image,
                  ports: [{ name: "http", containerPort: 8080 }],
                  env: [
                    { name: "AKTER_STORAGE_BUCKET", value: store.bucket },
                    { name: "AKTER_STORAGE_ENDPOINT", value: store.endpoint },
                    { name: "AKTER_STORAGE_REGION", value: "auto" },
                    { name: "AUTH_ISSUER", value: yield* Config.String("AUTH_ISSUER") },
                    { name: "AUTH_AUDIENCE", value: yield* Config.String("AUTH_AUDIENCE") },
                    { name: "AUTH_JWKS_URL", value: yield* Config.String("AUTH_JWKS_URL") },
                    fromKeys("AWS_ACCESS_KEY_ID"),
                    fromKeys("AWS_SECRET_ACCESS_KEY"),
                  ],
                  readinessProbe: { httpGet: { path: "/ready", port: 8080 } },
                },
              ],
            },
          },
        },
      },
    })

    return { bucket: store.bucket }
  })
```

- **A StatefulSet, not a Deployment.** Kubernetes promises at most one pod per StatefulSet ordinal: it starts the new `akter-0` only after the old one has exited, during a rollout and when a node is drained or upgraded. A Deployment, even with the `Recreate` strategy, starts a replacement right away when a pod is evicted.
- **`terminationGracePeriodSeconds: 30`** gives the server 30 seconds after SIGTERM.
- **The readiness probe** keeps the pod out of the load balancer until `/ready` answers `200`. There's no liveness probe: restarting a server that can't open a shard doesn't help.
- **The storage keys** live in a Secret. The pod's annotation holds a hash of them, so new keys restart the pod.
- **The Service** gives the pod a public load balancer on port 80. It forwards TCP, so WebSockets work.
- **Manifests** are plain Kubernetes objects. Alchemy applies them with server-side apply, so a change updates the objects in place.

## Describe the stack

Create `alchemy.run.ts` in the project root:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Docker from "@alchemy.run/docker"
import * as Kubernetes from "@alchemy.run/kubernetes"
import * as Alchemy from "alchemy"
import { Config, Effect, Layer, Redacted } from "effect"
import { byDigest, Server } from "./infra/kubernetes.ts"

export default Alchemy.Stack(
  "my-app",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Kubernetes.providers(), Docker.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const cluster = Kubernetes.KubeConfig({ context: yield* Config.String("KUBE_CONTEXT") })

    const repository = yield* Config.String("IMAGE_REPOSITORY")
    const registry = {
      server: repository.split("/")[0]!,
      username: yield* Config.String("REGISTRY_USERNAME"),
      password: yield* Config.Redacted("REGISTRY_PASSWORD"),
    }
    const image = yield* Docker.Image("Image", {
      name: repository,
      build: { context: ".", platform: "linux/amd64" },
      registry,
    })

    const login = `${registry.username}:${Redacted.value(registry.password)}`
    const pull = yield* Kubernetes.Manifest("RegistryLogin", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Secret",
        type: "kubernetes.io/dockerconfigjson",
        metadata: { name: "akter-registry", namespace: "default" },
        stringData: {
          ".dockerconfigjson": Redacted.make(
            JSON.stringify({ auths: { [registry.server]: { auth: btoa(login) } } }),
          ),
        },
      },
    })

    return yield* Server({ cluster, image: byDigest(image), imagePullSecret: pull.name })
  }),
)
```

- **`KubeConfig`** connects to the context you name in `KUBE_CONTEXT`, with whatever credentials it uses: a token, a certificate, or a plugin such as `aws eks get-token`.
- **`Image`** builds your `Dockerfile` for `linux/amd64` and pushes it to `IMAGE_REPOSITORY`, for example `ghcr.io/acme/my-app`.
- **`RegistryLogin`** lets the cluster pull the image from a private registry. A read-only token is better here than the one you push with.

## Deploy

```sh
KUBE_CONTEXT=prod \
IMAGE_REPOSITORY=ghcr.io/acme/my-app \
REGISTRY_USERNAME=acme-bot \
REGISTRY_PASSWORD=<token> \
bun alchemy deploy --stage prod
```

Find the load balancer's address and check the server:

```sh
kubectl --context prod get service akter \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}'
curl http://<address>/ready
```

For HTTPS, put the address behind a proxy that terminates TLS, such as Cloudflare, or add an ingress controller with cert-manager. Raise the ingress's timeouts, so WebSockets stay open.

## Releases

Run the deploy again. Kubernetes sends the old pod SIGTERM, waits for it to exit, then starts the new one. A release takes as long as the drain plus the new pod's start, usually under a minute. `kubectl rollout status statefulset/akter` shows when it's done.

`bun alchemy destroy --stage prod` removes the objects. It leaves the bucket while it holds objects.
