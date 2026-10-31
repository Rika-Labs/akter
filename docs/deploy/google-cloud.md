# Google Cloud

On Google Cloud, the server runs on a [GKE Autopilot](https://cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview) cluster as a StatefulSet with one pod, and the store is an R2 bucket. Alchemy's [GCP provider](https://alchemy.run/gcp) creates the cluster and an Artifact Registry repository, and its [Kubernetes provider](https://alchemy.run/kubernetes) runs the server on it.

Cloud Run doesn't fit: it starts the new revision before it stops the old one, and gives a server only 10 seconds after SIGTERM. Google Cloud Storage can't hold the store either, because its S3 API has no conditional writes. That's why the bucket is R2.

You need:

- The `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), and `infra/store.ts` from [The bucket](overview.md#the-bucket).
- `infra/kubernetes.ts` from the [Kubernetes guide](kubernetes.md#the-server).
- Docker running locally. Alchemy builds the image on your machine and pushes it to Artifact Registry.
- A Google Cloud project with billing, and the `gcloud` command.

## Install

```sh
bun add -d alchemy @alchemy.run/cloudflare @alchemy.run/gcp @alchemy.run/kubernetes @alchemy.run/docker
```

Turn on the APIs the stack uses:

```sh
gcloud services enable container.googleapis.com artifactregistry.googleapis.com --project <project>
```

## Describe the stack

Create `alchemy.run.ts` in the project root:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Docker from "@alchemy.run/docker"
import * as GCP from "@alchemy.run/gcp"
import * as Kubernetes from "@alchemy.run/kubernetes"
import * as Alchemy from "alchemy"
import * as Output from "alchemy/Output"
import { Effect, Layer } from "effect"
import { byDigest, Server } from "./infra/kubernetes.ts"

export default Alchemy.Stack(
  "my-app",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      GCP.providers(),
      Kubernetes.providers(),
      Docker.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { region, accessToken } = yield* Effect.orDie(yield* GCP.GcpEnvironment)

    const cluster = yield* GCP.Container.Cluster("Cluster", {
      location: region,
      autopilot: true,
      releaseChannel: "REGULAR",
    })
    const repository = yield* GCP.ArtifactRegistry.Repository("Images", {
      location: region,
      format: "DOCKER",
    })
    const image = yield* Docker.Image("Image", {
      name: Output.interpolate`${region}-docker.pkg.dev/${repository.project}/${repository.repositoryId}/server`,
      build: { context: ".", platform: "linux/amd64" },
      registry: {
        server: `${region}-docker.pkg.dev`,
        username: "oauth2accesstoken",
        password: accessToken,
      },
    })

    yield* Server({ cluster, image: byDigest(image) })
    return { cluster: cluster.clusterId, location: cluster.location }
  }),
)
```

- **`Cluster`** is an Autopilot cluster in your default region. Google runs and scales its nodes.
- **`Images`** is the Artifact Registry repository, and **`Image`** builds your `Dockerfile` for `linux/amd64` and pushes it there, signing in with the same Google credentials Alchemy deploys with.
- **`byDigest`** deploys the image by its digest, so every new build rolls the pod. A tag such as `latest` wouldn't.
- **`Server`** comes from `infra/kubernetes.ts`: the pod, its storage keys and a load balancer. The [Kubernetes guide](kubernetes.md#the-server) explains it.

## Deploy

Connect your Google Cloud project once:

```sh
bun alchemy profile edit --add GCP
```

Give it a service-account key with the Kubernetes Engine Admin, Artifact Registry Administrator and Service Account User roles, and a default region such as `us-east4`. You can also skip the profile and set `GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token)` and `GOOGLE_PROJECT_ID`. Then deploy:

```sh
bun alchemy deploy --stage prod
```

The first deploy takes about ten minutes, most of it creating the cluster. Find the load balancer's address with `kubectl`:

```sh
gcloud container clusters get-credentials <cluster> --region <location> --project <project>
kubectl get service akter -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
curl http://<ip>/ready
```

If the pod can't pull its image, the cluster's nodes need to read from Artifact Registry:

```sh
gcloud projects add-iam-policy-binding <project> \
  --member=serviceAccount:<project number>-compute@developer.gserviceaccount.com \
  --role=roles/artifactregistry.reader
```

For HTTPS, point a domain at the address through Cloudflare's proxy, or add a GKE Ingress with a managed certificate. An Ingress closes WebSockets after its backend timeout, 30 seconds by default, so raise it with a `BackendConfig`.

## Releases

Run `bun alchemy deploy --stage prod` again. Kubernetes replaces the pod: it sends the old one SIGTERM, waits for it to exit, and only then starts the new one. Autopilot upgrades nodes on its own, and moves the pod the same way.

Before `bun alchemy destroy --stage prod`, delete the load balancer with `kubectl delete service akter --wait`, so Google removes it before the cluster goes. Destroy leaves the bucket while it holds objects.
