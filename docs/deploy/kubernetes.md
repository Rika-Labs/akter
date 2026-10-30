# Kubernetes

On Kubernetes, the server is a Deployment with one replica, exposed by a Service. The same manifest works on any cluster. [Google Cloud](google-cloud.md), [Azure](azure.md) and [DigitalOcean](digitalocean.md) have the commands to create one.

You need:

- An image built from the `Dockerfile` in [Deploying](overview.md), pushed to a registry your cluster can pull from.
- A bucket and its keys. See [Choose a bucket](overview.md#choose-a-bucket).

## Store the keys

```sh
kubectl create secret generic my-app-store \
  --from-literal=AWS_ACCESS_KEY_ID=<access key id> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<secret access key>
```

## Write the manifest

Create `k8s.yaml`, with your image and settings:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: server
          image: registry.example.com/my-app:1
          ports:
            - containerPort: 8080
          env:
            - name: AKTER_STORAGE_BUCKET
              value: my-app-store
            - name: AKTER_STORAGE_ENDPOINT
              value: https://ACCOUNT_ID.r2.cloudflarestorage.com
            - name: AKTER_STORAGE_REGION
              value: auto
            - name: AUTH_ISSUER
              value: https://login.example.com/
            - name: AUTH_AUDIENCE
              value: my-app
            - name: AUTH_JWKS_URL
              value: https://login.example.com/.well-known/jwks.json
          envFrom:
            - secretRef:
                name: my-app-store
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            periodSeconds: 5
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: my-app
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
```

- **`replicas: 1`** runs one server.
- **`strategy: Recreate`** makes every rollout stop the old pod before it starts the new one. The default, `RollingUpdate`, does the opposite.
- **`readinessProbe`** sends traffic only while `/ready` answers `200`. There's no liveness probe on purpose: restarting a server that's unready doesn't make it ready.
- **`terminationGracePeriodSeconds`** leaves room for the 8-second drain.
- **The Service** gets a public address from your cloud's load balancer. For HTTPS, put your cluster's usual ingress in front of it instead.

For an S3 bucket on AWS, drop `AKTER_STORAGE_ENDPOINT` and set `AKTER_STORAGE_REGION` to the bucket's region.

## Deploy

```sh
kubectl apply -f k8s.yaml
kubectl rollout status deployment/my-app
kubectl get service my-app
```

When the Service shows an external IP, check the server:

```sh
curl http://<external ip>/ready
```

## Releases

Push a new image, update `image` in `k8s.yaml`, and apply it again. Kubernetes stops the old pod, waits for it to drain, then starts the new one. Expect a short gap while the new pod starts; clients retry through it.

If a node goes away, Kubernetes starts a replacement pod right away, sometimes before the old one has stopped. That's safe: both run the same release, so the new one replays whatever the old one didn't checkpoint.
