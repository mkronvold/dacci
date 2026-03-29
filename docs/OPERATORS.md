# Dacci operator notes

This guide explains what operators need to know about running the Dacci application against the Git-backed `E2Open.KPE.Content` content repository, including sync safety, runtime assumptions, and packaged deployment behavior.

## Sync configuration

| Variable | What it controls | Default |
| --- | --- | --- |
| `DATA_ROOT` | content root for the filesystem-backed knowledge base | required runtime path |
| `GIT_SYNC_REPO_ROOT` | repository root used for guarded git sync | parent of `DATA_ROOT` when unset; sibling `E2Open.KPE.Content` when both defaults are used |
| `GIT_SYNC_REMOTE_NAME` | remote used for fetch, pull, and push | `origin` |
| `GIT_SYNC_RELEASE_BRANCH` | branch used for release guidance | `default` |

When you are not using the default sibling `../E2Open.KPE.Content` checkout, set both `DATA_ROOT` and `GIT_SYNC_REPO_ROOT` explicitly. The public Dacci repo assumes content lives in a separate `E2Open.KPE.Content` checkout.

## Split checkout layout

Recommended working layout, with the Dacci app repo beside the separate `E2Open.KPE.Content` content repo:

```text
../dacci
../E2Open.KPE.Content
```

Native API and CLI runs should point into the content checkout:

```bash
export DATA_ROOT=../E2Open.KPE.Content/data
export GIT_SYNC_REPO_ROOT=../E2Open.KPE.Content
```

Packaged Docker and Kubernetes runtimes follow the same rule conceptually: the Dacci API only needs the Git-backed content checkout plus optional SSH material at runtime. The app code itself comes from the built image.

## Git authentication

The sync layer shells out to `git` and disables interactive prompts. Packaged runtimes keep credentials operator-supplied.

| Runtime | Operator input | Mount path | Expected names | Remote shape | Git wiring |
| --- | --- | --- | --- | --- | --- |
| Docker Compose | host-side SSH credential directory | `/var/run/dacci-git` | `id_ed25519`, `known_hosts` | SSH | `GIT_SSH_COMMAND=...` |
| Kubernetes | Secret `dacci-git-ssh` | `/var/run/dacci-git` | `id_ed25519`, `known_hosts` | SSH | `GIT_SSH_COMMAND=...` |

Packaged Docker and Kubernetes manifests can also set `GIT_SYNC_REMOTE_URL` so runtime sync uses SSH without rewriting the repository's saved `origin` URL on disk.

The packaged API startup and readiness checks validate the configured content root, the Git repository root used for sync, and the SSH files referenced by `GIT_SSH_COMMAND`, so bad path wiring or missing key material shows up before a later sync failure.

Docker operator checklist:

- place `id_ed25519` and `known_hosts` in `deploy/docker/git-ssh/` or point `DACCI_GIT_SSH_DIR` at another host directory
- point `DACCI_CONTENT_ROOT` at the external `E2Open.KPE.Content` checkout if it is not cloned beside the Dacci repo
- keep that directory read-only inside the container at `/var/run/dacci-git`
- set `GIT_SYNC_REMOTE_URL` to an SSH URL if the saved workspace remote stays on HTTPS
- rotate credentials by replacing the host files and restarting the API container
- optional helper scripts:
  - `./scripts/up` starts the Compose stack in detached mode with `DACCI_GIT_SSH_DIR="$HOME/.ssh"` and targets a sibling `../E2Open.KPE.Content` checkout by default
  - `./scripts/down` stops the Compose stack

Example Docker credential files:

`id_ed25519`:

```text
-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----
```

`known_hosts`:

```text
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...
```

Kubernetes baseline note:

- the API Deployment looks for an optional Secret named `dacci-git-ssh`
- it mounts that Secret at `/var/run/dacci-git`
- it sets `GIT_SSH_COMMAND` to use the mounted key material
- `GIT_SYNC_REMOTE_URL` can force an SSH remote without rewriting the saved repo config

## Sync guardrails

### Pull is blocked when

- the branch has no upstream configured
- the working tree is dirty
- the branch contains committed non-content changes that are not yet upstream

### Push is blocked when

- the remote branch is ahead
- the working tree has non-content changes outside the configured content directory
- the branch contains committed non-content changes that are not yet upstream

### Allowed behavior

- content-only commits and pushes
- explicit pull and push actions from API, CLI, or Web UI
- untracked non-content files during push
- opt-in background pull scheduling that pauses itself when the repo becomes unsafe

## Background sync scheduler

| Property | Current behavior |
| --- | --- |
| Default state | disabled |
| Automated action | guarded status refresh plus pull only |
| Auto-push | never |
| State storage | repository-local Git metadata |
| Failure mode | pauses on blockers or conflicts |

Common scheduler commands:

```bash
npm run cli -- sync schedule configure --enable --interval-minutes 15
npm run cli -- sync schedule status
npm run cli -- sync schedule pause
npm run cli -- sync schedule resume
```

## Recommended operator flow

```bash
git switch default
npm install
npm run typecheck
npm test
npm run cli -- sync status
```

If sync status reports blockers:

1. resolve the first blocker
2. rerun `npm run cli -- sync status --refresh`
3. only pull or push when the status is clear enough for that action
4. if the scheduler paused itself, resume it explicitly after cleanup

## Runtime defaults

| Environment | Default URL |
| --- | --- |
| Native API | `http://localhost:3000` |
| Native Web UI | `http://localhost:5173` |
| Packaged Docker Web | `http://localhost:4173` |

## Packaged runtime checks

Docker runtime:

```bash
npm run docker:config
npm run docker:up
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:4173/health
curl http://localhost:4173/runtime-config.json
npm run docker:down
```

Kubernetes runtime:

```bash
npm run k8s:render
npm run k8s:validate
```

If the client-side Kubernetes dry-run hangs locally, fall back to `npm run k8s:render` and inspect the rendered manifest set before applying it.

## Production focus areas

| Area | What to watch |
| --- | --- |
| Rollout behavior | API should remain single-writer |
| Storage | content checkout contains both Markdown content and Git metadata |
| Ingress | host, TLS secret, and `/api` routing must be correct |
| Health | probe failures usually point to runtime config, storage, or startup issues |

## Dependency repair

If `node_modules` is corrupted or Vite files are missing:

```bash
npm ci
```
