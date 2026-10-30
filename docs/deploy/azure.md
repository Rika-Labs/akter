# Azure

On Azure, the server runs on an [AKS](https://learn.microsoft.com/en-us/azure/aks/) cluster, using the [Kubernetes](kubernetes.md) manifest, and the store is an R2 bucket. Azure Container Registry builds the image, so you don't need Docker locally.

Two Azure products look like a better fit and aren't:

- **Container Apps** activates each new revision before it deactivates the old one, so every deploy would start a new release while the old one still owns the store.
- **Blob Storage** doesn't speak the S3 API, so it can't hold an Akter store.

You need the `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), an [R2 bucket](overview.md#create-an-r2-bucket), and the `az` and `kubectl` commands.

## Create the registry and cluster

```sh
az group create --name my-app --location eastus
az acr create --resource-group my-app --name myappregistry --sku Basic
az aks create --resource-group my-app --name my-app \
  --node-count 1 --attach-acr myappregistry --generate-ssh-keys
```

Registry names are global, so pick your own in place of `myappregistry`. `--attach-acr` lets the cluster pull from it.

## Build the image

```sh
az acr build --registry myappregistry --image my-app:1 .
```

ACR uploads the project, builds the `Dockerfile`, and stores the image as `myappregistry.azurecr.io/my-app:1`.

## Deploy

```sh
az aks get-credentials --resource-group my-app --name my-app
```

Then follow [Kubernetes](kubernetes.md) from [Store the keys](kubernetes.md#store-the-keys), with `image` set to `myappregistry.azurecr.io/my-app:1`. The Service gets an external IP from an Azure load balancer.

## Releases

Build with a new tag and point the Deployment at it:

```sh
az acr build --registry myappregistry --image my-app:2 .
kubectl set image deployment/my-app server=myappregistry.azurecr.io/my-app:2
```

The `Recreate` strategy stops the old pod before the new one starts.
