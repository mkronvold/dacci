# Docker deployment

This guide explains what to run to package and start Dacci on a single host with Docker Compose.

## Runtime summary

| Item | Value |
| --- | --- |
| API port | `3000` |
| Web port | `4173` |
| Mounted content repo path in container | `/workspace` |
| Content path in container | `/workspace/data` |
| Git sync root in container | `/workspace` |
| Optional Git credential mount | `/var/run/dacci-git` |
| Expected Git credential files | `id_ed25519`, `known_hosts` |

The packaged runtime expects a real Git-backed content checkout, not just a copy of the `data/` directory.

## Prerequisites

- Docker Engine
- Docker Compose v2
- a local clone of this repository

## Start and stop

From the repository root:

```bash
npm run docker:config
docker compose -f deploy/docker/compose.yaml up --build -d
```

Convenience wrappers are also available from the repository root:

```bash
./scripts/up
./scripts/down
```

`./scripts/up` starts the Compose stack in detached mode, sets `DACCI_GIT_SSH_DIR="$HOME/.ssh"` by default, and targets a sibling `../E2Open.KPE.Content` checkout. If your content checkout lives elsewhere, set `DACCI_CONTENT_ROOT` explicitly before starting the stack.

Stop the stack:

```bash
docker compose -f deploy/docker/compose.yaml down
```

## What gets mounted

`deploy/docker/compose.yaml` mounts the content repository checkout into `/workspace` and then binds the host `data/` path again onto `/workspace/data`.

What that means:

| Concern | Behavior |
| --- | --- |
| Relative host path | Defaults to a sibling `../E2Open.KPE.Content` checkout unless `DACCI_CONTENT_ROOT` is set |
| Content location | Host `data/` is explicitly bound onto `/workspace/data` |
| Git metadata | Comes from the mounted content repository `.git` directory |
| Git auth | Optional SSH credential bind mount at `/var/run/dacci-git` |
| Scheduler state | Persists with the mounted content repository because it is repo-local |

The application code itself runs from the built image. The only runtime bind mount the API needs is the Git-backed content checkout plus the optional SSH credential directory.

That explicit `data/` bind still matters when the host content checkout uses a symlink for `data/`. Docker preserves symlinks inside a parent-directory mount, but a direct bind of the `data/` path lets the host resolve a target such as `/mnt/c/...` before the container sees it.

## Basic configuration override

Use a compose override file for local customization:

```yaml
services:
  api:
    ports:
      - "8080:3000"
    environment:
      GIT_SYNC_REMOTE_NAME: origin
      GIT_SYNC_RELEASE_BRANCH: main
  web:
    ports:
      - "8081:4173"
    environment:
      WEB_API_BASE_URL: http://localhost:8080
```

Start with both files:

```bash
docker compose \
  -f deploy/docker/compose.yaml \
  -f deploy/docker/compose.override.yaml \
  up --build -d
```

## Alternate host storage

If you want the runtime content checkout somewhere other than the repository checkout, point `DACCI_CONTENT_ROOT` at it:

```bash
DACCI_CONTENT_ROOT=/srv/E2Open.KPE.Content \
docker compose -f deploy/docker/compose.yaml up --build -d
```

Because the Compose file derives both `/workspace` and `/workspace/data` from the same variable, the alternate host path still needs this structure:

```text
/srv/E2Open.KPE.Content
  /.git
  /data
```

## Git credentials

The packaged Docker runtime now follows the same basic pattern as Kubernetes: the API container always has one stable in-container SSH credential path at `/var/run/dacci-git`, and operators supply key material from the host.

| Item | Expected value |
| --- | --- |
| Mount path | `/var/run/dacci-git` |
| Files | `id_ed25519`, `known_hosts` |
| Remote override | `GIT_SYNC_REMOTE_URL=git@github.com:example/E2Open.KPE.Content.git` |
| Git wiring | `GIT_SSH_COMMAND=ssh -i /var/run/dacci-git/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=/var/run/dacci-git/known_hosts` |

The checked-in Compose file mounts a host directory into that path:

```yaml
services:
  api:
    volumes:
      - type: bind
        source: ${DACCI_GIT_SSH_DIR:-./git-ssh}
        target: /var/run/dacci-git
        read_only: true
```

By default, `./git-ssh` resolves to `deploy/docker/git-ssh/`. That directory is present in the repo only as a `.gitignore` scaffold so you can place local SSH files there without committing them. If you prefer to keep credentials entirely outside the repository checkout, set `DACCI_GIT_SSH_DIR` to another host directory before running Compose.

The checked-in Compose file does not hardcode `GIT_SYNC_REMOTE_URL`. Set it only when the content checkout should sync against an SSH remote that differs from the saved repository config.

Example host files:

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

Example startup with an external credential directory:

```bash
DACCI_CONTENT_ROOT=../E2Open.KPE.Content \
DACCI_GIT_SSH_DIR="$HOME/.config/dacci/docker-git-ssh" \
docker compose -f deploy/docker/compose.yaml up --build -d
```

Example startup with an alternate content root:

```bash
DACCI_CONTENT_ROOT=/srv/E2Open.KPE.Content \
docker compose -f deploy/docker/compose.yaml up --build -d
```

If you want the checked-in Docker stack to use the SSH files from your normal `~/.ssh` directory, the shortcut script already does that:

```bash
./scripts/up
```

If you prefer to override it explicitly:

```bash
GIT_SYNC_REMOTE_URL=git@github.com:example/E2Open.KPE.Content.git \
./scripts/up
```

## Verification

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:4173/health
curl http://localhost:4173/runtime-config.json
```

## Troubleshooting

| Problem | Check |
| --- | --- |
| Web cannot reach API | `WEB_API_BASE_URL` |
| Documents are missing | host content checkout contents, `DACCI_CONTENT_ROOT`, and `/workspace/data` |
| Sync fails or `/ready` fails | mounted content checkout includes `.git`, `/var/run/dacci-git` contains `id_ed25519` and `known_hosts`, and `GIT_SYNC_REMOTE_URL` points at an SSH URL with repo access |
| Path mapping looks wrong | remember relative paths are resolved from the compose file location |
