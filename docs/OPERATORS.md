# Dacci operator notes

This guide explains what operators need to know about running the Dacci application against the Git-backed `E2Open.KPE.Content` content repository, including sync safety, runtime assumptions, and packaged deployment behavior.

## Sync configuration

| Variable | What it controls | Default |
| --- | --- | --- |
| `DATA_ROOT` | content root for the filesystem-backed knowledge base | optional; derived from the first discovered workspace repo when unset |
| `GIT_SYNC_REPO_ROOT` | repository root used for guarded git sync | optional; derived from `DATA_ROOT` when set |
| `DACCI_LIBRARY_ROOTS` | comma-separated absolute allowlist for custom Library repo roots | repo-local `workspace/` for the packaged runtime; empty elsewhere unless configured |
| `GIT_SYNC_REMOTE_NAME` | remote used for fetch, pull, and push | `origin` |
| `GIT_SYNC_RELEASE_BRANCH` | branch used for release guidance | `default` |

When you are not using the default repo-local `workspace/` layout, set both `DATA_ROOT` and `GIT_SYNC_REPO_ROOT` explicitly.

## Split checkout layout

Recommended working layout, with content repos living under the Dacci repo's gitignored workspace:

```text
./dacci
./dacci/workspace/E2Open.KPE.Content
./dacci/workspace/Dacci.Example.Content
```

Native API and CLI runs should point into the content checkout:

```bash
export DATA_ROOT=workspace/E2Open.KPE.Content/data
export GIT_SYNC_REPO_ROOT=workspace/E2Open.KPE.Content
```

The packaged local Docker runtime follows the same rule conceptually: the Dacci API only needs Git-backed content repos under `/workspace` at runtime. The app code itself comes from the built image. Kubernetes assets are still in the repo, but they are archived reference material rather than the active deployment target for this branch.

Custom Library repos are only accepted when their absolute runtime path lives under `DACCI_LIBRARY_ROOTS`. In Docker Compose, repo-local checkouts are mounted at `/workspace`, so Library entries should use in-container paths such as `/workspace/Dacci.Example.Content`.

Workspace discovery uses the same direct-child contract under each configured library root: Dacci scans paths like `/workspace/<repo-name>` and only treats them as content repos when they contain Git metadata and a `data/` directory. If no repos are present yet, the packaged runtime still starts so the browser can open the Library panel and guide local adoption, remote adoption, or creation of a new repo.

## Git access

The sync layer shells out to `git` and disables interactive prompts. The active packaged-runtime target is now one local Docker mode:

| Runtime or mode | Operator input | Stored in browser | Stored server-side | Remote shape | Git wiring |
| --- | --- | --- | --- | --- | --- |
| Local Docker runtime | host `~/.ssh` or `DACCI_HOST_SSH_DIR`, plus optional `SSH_AUTH_SOCK` | per-repo commit name/email and saved repo settings | nothing extra | SSH | live host SSH mount with staged fallback, refreshed into a managed runtime SSH home, plus forwarded agent socket |

The packaged API startup and readiness checks validate the configured content root, the Git repository root used for sync, and any configured SSH command files, so bad path wiring shows up before a later sync failure.

When you start the packaged runtime through `./scripts/up`, both containers also run with the host UID/GID. That keeps bind-mounted workspace writes owned by the host user instead of `root:root`.

## Library repo onboarding

The Library pane now separates three workflows:

- `Adopt Local Repository`: save or override an existing Git-backed content checkout that already exists on disk
- `Adopt Remote Repository`: clone an existing GitHub-backed content repo into the configured workspace root, check out the selected branch, and save it for use in Dacci
- `Create Repository`: use `gh` from the API runtime to create a remote repo, clone it into the configured workspace root, seed `README.md`, `.gitignore`, and `data/.gitkeep`, create the selected branch, commit, push, and then rewrite `origin` to the SSH remote Dacci will use afterward

Runtime expectations:

- packaged Docker includes `gh` in the API image, so the browser Create flow can run there without host-side `gh`
- native API/browser runs still need `gh` available on the host `PATH` for Create; Adopt Remote uses `git` plus SSH only
- onboarding and edit flows also capture a per-repo commit name and commit email in browser-local state; Dacci uses them for create and sync commits without storing them in `.git/config`
- both remote onboarding flows ask for a GitHub owner, a GitHub username, a repo name, a branch, and an SSH host alias
- the SSH host alias defaults from the GitHub username, so org-owned repos can still use a personal GitHub identity cleanly
- Library validation plus remote adopt/create refresh the runtime SSH layout automatically from the live host mount when available, otherwise from the staged snapshot
- if the selected SSH alias is missing, Dacci adds a new `Host <alias>` entry to its managed runtime include with `HostName github.com`, `User git`, and an `IdentityFile` that points at `~/.ssh/id_ed25519_<github-username>` inside the active SSH directory

Docker checklist:

- point `DACCI_CONTENT_ROOT` at the external `E2Open.KPE.Content` checkout if it is not cloned beside the Dacci repo
- point `DACCI_LIBRARY_WORKSPACE_ROOT` at the parent directory that contains any Library checkouts when you need custom repos outside the default workspace layout
- let `./scripts/up` stage `"$HOME/.ssh"` by default, or override the source directory with `DACCI_HOST_SSH_DIR`; it will also mount that live directory read-only for automatic runtime refresh
- start `./scripts/up` from a shell where `SSH_AUTH_SOCK` is set if your SSH keys rely on an agent
- keep repo remotes on normal SSH URLs
- set `GIT_SYNC_REMOTE_URL` only when the runtime should override the repo's saved remote URL
- optional helper scripts:
  - `./scripts/up` starts the Compose stack in detached mode, targets the repo-local `workspace/` tree by default, mounts that workspace at `/workspace`, and binds ports on localhost only
  - `./scripts/down` stops the Compose stack

Archived Kubernetes note:

- the manifests remain checked in as reference material while the product target shifts to local Docker
- they are not the active deployment path for current runtime validation or routine repo checks
- if you still use them manually, the API Deployment looks for an optional Secret named `dacci-git-ssh`

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
| Default state | disabled per repo |
| Automated action | guarded status refresh plus pull only |
| Auto-push | never |
| State storage | repository-local Git metadata |
| Failure mode | pauses on blockers or conflicts |

Common scheduler commands:

```bash
./scripts/dacci-cli sync schedule configure --enable --interval-minutes 15
./scripts/dacci-cli sync schedule status
./scripts/dacci-cli sync schedule pause
./scripts/dacci-cli sync schedule resume
```

## Recommended operator flow

```bash
git switch default
npm install
npm run typecheck
npm test
./scripts/dacci-cli sync status
```

If sync status reports blockers:

1. resolve the first blocker
2. rerun `./scripts/dacci-cli sync status --refresh`
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
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
curl http://127.0.0.1:4173/health
curl http://127.0.0.1:4173/runtime-config.json
npm run docker:down
```

Archived Kubernetes reference:

- the manifests under `deploy/k8s/` and `deploy/k8s-overlays/` are kept for historical/operator context only
- they are no longer exposed through top-level npm scripts or included in the active validation checklist on this branch

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
