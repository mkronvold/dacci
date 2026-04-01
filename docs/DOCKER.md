# Docker deployment

This guide explains how to run Dacci as a localhost-only Docker Compose app on one machine.

## Runtime summary

| Item | Value |
| --- | --- |
| API host port | `127.0.0.1:3000` |
| Web host port | `127.0.0.1:4173` |
| Mounted workspace root in container | `/workspace` |
| Configured content repo path in container | `/workspace/<repo-name>` |
| Content path in container | `/workspace/<repo-name>/data` |
| Git sync root in container | `/workspace/<repo-name>` |
| Default custom library root allowlist | `/workspace` |
| Host SSH directory mount | `/root/.ssh` |
| Optional forwarded SSH agent | host `SSH_AUTH_SOCK`, mounted at the same path when present |

The packaged runtime expects a real Git-backed content checkout, not just a copy of `data/`.

## Prerequisites

- Docker Engine
- Docker Compose v2
- a local clone of this repository
- a local clone of `E2Open.KPE.Content`
- working SSH Git access from the host shell for the content repo remote

Recommended local layout:

```text
workspace/
├── dacci
└── E2Open.KPE.Content
```

## Start and stop

From the Dacci repository root:

```bash
./scripts/up
./scripts/down
```

`./scripts/up`:

- starts the stack in detached mode
- defaults `DACCI_CONTENT_ROOT` to a sibling `../E2Open.KPE.Content` checkout
- mounts the parent workspace directory at `/workspace` so sibling Library repos are available at `/workspace/<repo-name>`
- mounts `"$HOME/.ssh"` into the API container at `/root/.ssh` unless you override `DACCI_HOST_SSH_DIR`
- forwards `SSH_AUTH_SOCK` into the API container when it is set in the shell that launches the stack
- publishes the API and web ports on `127.0.0.1` only

You can still inspect the resolved Compose file directly:

```bash
npm run docker:config
```

If you prefer to start Compose manually instead of using `./scripts/up`, set the same environment variables yourself first.

## What gets mounted

`deploy/docker/compose.yaml` mounts the parent workspace into `/workspace`, keeps the configured content checkout rooted at `/workspace/<repo-name>`, and binds the host `data/` path again onto `/workspace/<repo-name>/data`.

| Concern | Behavior |
| --- | --- |
| Relative host path | Defaults to a sibling `../E2Open.KPE.Content` checkout unless `DACCI_CONTENT_ROOT` is set |
| Content location | Host `data/` is explicitly bound onto `/workspace/<repo-name>/data` |
| Library repo location | Host workspace root is bound onto `/workspace` unless `DACCI_LIBRARY_WORKSPACE_ROOT` is set |
| Git metadata | Comes from the mounted content repository `.git` directory |
| Git access | Uses the mounted host `~/.ssh` config and any forwarded `ssh-agent` socket |
| Scheduler state | Persists with the mounted content repository because it is repo-local |

That explicit `data/` bind still matters when the host content checkout uses a symlink for `data/`. Docker preserves symlinks inside a parent-directory mount, but a direct bind of the `data/` path lets the host resolve a target such as `/mnt/c/...` before the container sees it.

## Alternate content and library roots

If your content repo is not cloned beside Dacci, point `DACCI_CONTENT_ROOT` at it:

```bash
DACCI_CONTENT_ROOT=/srv/E2Open.KPE.Content \
./scripts/up
```

That alternate content repo still needs this structure:

```text
/srv/E2Open.KPE.Content
  /.git
  /data
```

If you also want sibling custom Library repos from that alternate location, point `DACCI_LIBRARY_WORKSPACE_ROOT` at the parent directory that contains those checkouts:

```bash
DACCI_CONTENT_ROOT=/srv/E2Open.KPE.Content \
DACCI_LIBRARY_WORKSPACE_ROOT=/srv \
./scripts/up
```

If you want to use an SSH directory other than the default `"$HOME/.ssh"`, override it explicitly:

```bash
DACCI_HOST_SSH_DIR="$HOME/.config/dacci/ssh" \
./scripts/up
```

## Library repo paths inside Docker

When you run Dacci in Docker, custom Library entries must use the in-container path, not the host path you see in your shell.

Example:

- Host repo path: `/home/mkronvold/src/Dacci.Example.Content`
- Docker Library entry repo root: `/workspace/Dacci.Example.Content`
- Data root: leave blank

With the default sibling layout, `./scripts/up` mounts `/home/mkronvold/src` into the API container at `/workspace`, so the example repo is immediately usable after restarting the stack.

## Git access

This branch no longer uses GitHub OAuth, browser-stored GitHub usernames, or request-scoped SSH key selection.

Instead:

- keep your content repo remote as a normal SSH remote such as `git@github.com:owner/E2Open.KPE.Content.git`
- make sure `git -C ../E2Open.KPE.Content fetch origin` already works from the host shell
- start Dacci from a shell where `SSH_AUTH_SOCK` is set if your keys depend on an agent
- let the API container reuse that mounted SSH config and agent socket

The browser never uploads SSH keys or holds Git credentials.

The checked-in Compose file does not hardcode `GIT_SYNC_REMOTE_URL`. Set it only when the content checkout should sync against a remote URL that differs from the repository's saved remote config.

Example startup with the default sibling content repo:

```bash
./scripts/up
```

Example startup with an explicit content repo and SSH directory:

```bash
DACCI_CONTENT_ROOT=/srv/E2Open.KPE.Content \
DACCI_HOST_SSH_DIR="$HOME/.ssh" \
./scripts/up
```

## Verification

Once the stack is up:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
curl http://127.0.0.1:4173/health
curl http://127.0.0.1:4173/runtime-config.json
```

## Troubleshooting

| Problem | Check |
| --- | --- |
| Web cannot reach API | `WEB_API_BASE_URL`, container health, and that you opened the UI on `127.0.0.1:4173` or `localhost:4173` |
| Documents are missing | host content checkout contents, `DACCI_CONTENT_ROOT`, and `/workspace/<repo-name>/data` |
| Sync fails or `/ready` fails | verify the mounted content checkout includes `.git`, the repo remote uses SSH, the host `~/.ssh` config already works for that remote, and `SSH_AUTH_SOCK` was set before `./scripts/up` if your keys need an agent |
| Custom Library repos say they are unavailable | restart with the updated stack, check `DACCI_LIBRARY_WORKSPACE_ROOT` / `DACCI_LIBRARY_ROOTS`, and use the in-container repo path such as `/workspace/Dacci.Example.Content` |
| Path mapping looks wrong | remember relative paths are resolved from the compose file location |
