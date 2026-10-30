# Google Cloud

On Google Cloud, the server runs on a [GKE Autopilot](https://cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview) cluster, using the [Kubernetes](kubernetes.md) manifest, and the store is an R2 bucket. Autopilot manages the nodes for you, and Cloud Build builds the image, so you don't need Docker locally.

Two Google Cloud products look like a better fit and aren't:

- **Cloud Run** starts each new revision before it stops the old one, and gives no way to change that. Every deploy would start a new release while the old one still owns the store.
- **Cloud Storage** has no conditional writes in its S3-compatible API, so it can't hold an Akter store.

You need the `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), an [R2 bucket](overview.md#create-an-r2-bucket), and the `gcloud` and `kubectl` commands.

## Create the cluster and registry

```sh
gcloud config set project <PROJECT_ID>
gcloud services enable container.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

gcloud container clusters create-auto my-app --region us-central1
gcloud artifacts repositories create my-app --repository-format=docker --location=us-central1
```

Clusters can usually pull from Artifact Registry in the same project as they are. If a pull is refused, grant the nodes' service account `roles/artifactregistry.reader` on the repository.

## Build the image

```sh
gcloud builds submit --tag us-central1-docker.pkg.dev/<PROJECT_ID>/my-app/server:1
```

Cloud Build uploads the project, builds the `Dockerfile`, and pushes the image.

## Deploy

```sh
gcloud container clusters get-credentials my-app --region us-central1
```

Then follow [Kubernetes](kubernetes.md) from [Store the keys](kubernetes.md#store-the-keys), with `image` set to the image you just pushed. The Service gets an external IP from a Google Cloud load balancer.

## Releases

Build with a new tag and point the Deployment at it:

```sh
gcloud builds submit --tag us-central1-docker.pkg.dev/<PROJECT_ID>/my-app/server:2
kubectl set image deployment/my-app server=us-central1-docker.pkg.dev/<PROJECT_ID>/my-app/server:2
```

The `Recreate` strategy stops the old pod before the new one starts.
