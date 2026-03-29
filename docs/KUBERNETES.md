# Kubernetes deployment

This guide explains what to apply to run the packaged Dacci runtime on Kubernetes.

## Runtime summary

| Item | Value |
| --- | --- |
| Namespace | `dacci` |
| API service | `dacci-api` on port `3000` |
| Web service | `dacci-web` on port `4173` |
| Content repo mount | `/workspace` |
| Content path | `/workspace/data` |
| Ingress host | placeholder `dacci.example.com` |

The Kubernetes package preserves the current single-writer Git-backed content-repository model.

## Included resources

| Resource | Purpose |
| --- | --- |
| `namespace.yaml` | namespace scaffold |
| `api-configmap.yaml` | API runtime env values |
| `web-configmap.yaml` | Web runtime env values |
| `workspace-pvc.yaml` | persistent content-repository storage |
| `api-deployment.yaml` | API runtime with probes and content-repo mount |
| `web-deployment.yaml` | Web runtime with probes |
| `api-service.yaml` / `web-service.yaml` | in-cluster HTTP access |
| `ingress.yaml` | browser and API routing |
| `git-ssh-secret.template.yaml` | example Secret shape for SSH-based Git auth |
| `deploy/k8s-overlays/example/kustomization.yaml` | overlay scaffold for image, storage, branch, and ingress replacements |

## Prerequisites

- Kubernetes cluster with a usable storage class
- `kubectl`
- an ingress controller such as `ingress-nginx`
- published API and Web images

## Build and publish images

```bash
docker build -f deploy/docker/api.Dockerfile -t ghcr.io/example/dacci-api:0.1.0 .
docker build -f deploy/docker/web.Dockerfile -t ghcr.io/example/dacci-web:0.1.0 .
docker push ghcr.io/example/dacci-api:0.1.0
docker push ghcr.io/example/dacci-web:0.1.0
```

The base Deployments intentionally keep placeholder `seed` tags. Replace them through an overlay instead of applying `deploy/k8s/` unchanged.

## Example overlay scaffold

`deploy/k8s-overlays/example/kustomization.yaml` is checked in as a starting point. It lives beside `deploy/k8s/` so `kubectl apply -k` can reference the base directory directly. Copy it to a sibling directory under `deploy/k8s-overlays/`, then replace the example registry, tag, storage class, branch, host, and TLS values before applying it.

```bash
cp -R deploy/k8s-overlays/example deploy/k8s-overlays/my-cluster
$EDITOR deploy/k8s-overlays/my-cluster/kustomization.yaml
kubectl apply -k deploy/k8s-overlays/my-cluster
```

Keep custom overlays under `deploy/k8s-overlays/` unless you also update the scaffold's `../../k8s` base path. If your cluster uses the default storage class, remove the `storageClassName` patch instead of leaving the `fast-ssd` placeholder.

## Runtime configuration

### API defaults

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `PORT` | `3000` |
| `DATA_ROOT` | `/workspace/data` |
| `GIT_SYNC_REPO_ROOT` | `/workspace` |
| `GIT_SYNC_REMOTE_NAME` | `origin` |
| `GIT_SYNC_RELEASE_BRANCH` | `default` |

### Web defaults

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `PORT` | `4173` |
| `WEB_API_BASE_URL` | `/` |

`WEB_API_BASE_URL=/` assumes the ingress routes browser traffic and `/api` through one public host.

## Workspace requirements

The PVC mounted at `/workspace` must contain a real content-repository checkout.

Minimum expected layout:

```text
/workspace
  /.git
  /data
```

The deployment does not clone the content repository for you. The application code already ships in the API and web images.

## Git credentials

The base API Deployment includes an SSH Secret pattern for Git-backed sync.

| Item | Expected value |
| --- | --- |
| Secret name | `dacci-git-ssh` |
| Mount path | `/var/run/dacci-git` |
| Secret keys | `id_ed25519`, `known_hosts` |
| Remote override | `GIT_SYNC_REMOTE_URL=git@github.com:example/E2Open.KPE.Content.git` |
| Git wiring | `GIT_SSH_COMMAND` |

Create the Secret directly:

```bash
kubectl create secret generic dacci-git-ssh \
  --namespace dacci \
  --from-file=id_ed25519=/path/to/id_ed25519 \
  --from-file=known_hosts=/path/to/known_hosts
```

Or copy the template:

```bash
cp deploy/k8s/git-ssh-secret.template.yaml ./dacci-git-ssh.yaml
$EDITOR ./dacci-git-ssh.yaml
kubectl apply -f ./dacci-git-ssh.yaml
```

Set `GIT_SYNC_REMOTE_URL` in an overlay only when the content repository should sync against an SSH remote that differs from the saved repo config.

The API readiness check also verifies that the SSH files referenced by `GIT_SSH_COMMAND` exist. Missing `id_ed25519` or `known_hosts` files will keep the Pod unready.

If you want to override it explicitly:

```bash
kubectl patch configmap dacci-api-runtime \
  -n dacci \
  --type merge \
  -p '{"data":{"GIT_SYNC_REMOTE_URL":"git@github.com:example/E2Open.KPE.Content.git"}}'
```

## Install workflow

After copying and editing your overlay:

```bash
npm run k8s:render
npm run k8s:validate
kubectl apply -k deploy/k8s-overlays/my-cluster
kubectl rollout status deployment/dacci-api -n dacci
kubectl rollout status deployment/dacci-web -n dacci
kubectl get pods,svc,ingress -n dacci
```

If your local client-side dry-run stalls, use this fallback before applying:

```bash
npm run k8s:render
```

## Verification

If DNS is not ready yet, port-forward first:

```bash
kubectl port-forward svc/dacci-api 3000:3000 -n dacci
kubectl port-forward svc/dacci-web 4173:4173 -n dacci
```

Then verify:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
curl http://127.0.0.1:4173/health
curl http://127.0.0.1:4173/runtime-config.json
```

## Production notes

| Concern | Guidance |
| --- | --- |
| API replica count | keep at `1` unless you solve multi-writer coordination |
| Deployment strategy | keep `Recreate` for the API |
| Storage | treat the workspace PVC as critical content-repo state |
| Ingress | replace the example host and TLS secret |
| Sync | create the SSH Secret before expecting authenticated pull or push |

## Rollback

```bash
kubectl rollout undo deployment/dacci-api -n dacci
kubectl rollout undo deployment/dacci-web -n dacci
```

If the workspace contents are the problem, restore the PVC from backup as part of recovery.
