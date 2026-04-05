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
| Container user | Host UID/GID when started through `./scripts/up` |
| Live host SSH directory mount | `/var/run/dacci-host-ssh-live` |
| Staged host SSH snapshot mount | `/var/run/dacci-host-ssh-stage` |
| Runtime SSH path in API container | `${HOME}/.ssh` (defaults to `/tmp/dacci-home-<uid>/.ssh` through `./scripts/up`) |
| Optional forwarded SSH agent | host `SSH_AUTH_SOCK`, mounted at the same path when present |

The packaged runtime expects a real Git-backed content checkout, not just a copy of `data/`.

## Prerequisites

- Docker Engine
- Docker Compose v2
- a local clone of this repository
- zero or more local content repos cloned into `workspace/`
- working SSH Git access from the host shell for the content repo remote
- optional browser-driven repo creation uses `gh`, which is already included in the packaged API image

Recommended local layout:

```text
dacci/
├── workspace/
│   ├── Dacci.Example.Content
│   └── E2Open.KPE.Content
└── ...
```

Workspace discovery follows a direct-child contract under each configured library root such as `/workspace`: every candidate repo should live at `/workspace/<repo-name>` and include Git metadata plus a `data/` directory.

## Start and stop

From the Dacci repository root:

```bash
./scripts/up
./scripts/down
```

`./scripts/up`:

- starts the stack in detached mode
- defaults `DACCI_LIBRARY_WORKSPACE_ROOT` to the repo-local `./workspace` directory
- mounts that workspace directory at `/workspace`
- uses the first discovered content repo in `workspace/` as the compatibility default when one exists
- still starts cleanly when `workspace/` is empty so the browser can guide local adoption, remote adoption, or creation of a new repo
- passes your host UID/GID into both containers so bind-mounted workspace writes stay owned by your host user
- stages `"$HOME/.ssh"` and mounts that staged snapshot into the API container at `/var/run/dacci-host-ssh-stage` unless you override `DACCI_HOST_SSH_DIR`
- also mounts the live host SSH directory read-only at `/var/run/dacci-host-ssh-live` so repo validation, remote adopt, and create can refresh from current host files without a container restart
- defaults the runtime home inside both containers to a host-UID-specific path such as `/tmp/dacci-home-1000`
- exports `GIT_SSH_COMMAND` inside the API container so Git always uses the managed runtime SSH config and runtime `known_hosts`
- forwards `SSH_AUTH_SOCK` into the API container when it is set in the shell that launches the stack
- includes `gh` in the API image so the Library pane can create GitHub-backed repos from inside Docker
- publishes the API and web ports on `127.0.0.1` only

You can still inspect the resolved Compose file directly:

```bash
npm run docker:config
```

If you prefer to start Compose manually instead of using `./scripts/up`, set the same environment variables yourself first.

## What gets mounted

`deploy/docker/compose.yaml` mounts the repo-local workspace into `/workspace`, lets the API discover repos directly from that tree, and still binds one repo's `data/` path again onto `/workspace/<repo-name>/data` for the current overlay-compatibility story.

| Concern | Behavior |
| --- | --- |
| Relative host path | Defaults to the repo-local `./workspace` directory |
| Content location | Host `data/` is explicitly bound onto `/workspace/<repo-name>/data` |
| Library repo location | Host workspace root is bound onto `/workspace` unless `DACCI_LIBRARY_WORKSPACE_ROOT` is set |
| Container UID/GID | `./scripts/up` exports your host UID/GID so both containers run with matching numeric ownership |
| Git metadata | Comes from the mounted content repository `.git` directory |
| Git access | Uses a live read-only mount of the host `~/.ssh` directory plus a staged fallback snapshot. The API runtime refreshes `${HOME}/.ssh` into a managed layout with `config`, `config.user`, `.dacci-generated.conf`, and `known_hosts`, plus any forwarded `ssh-agent` socket |
| Scheduler state | Persists with the mounted content repository because it is repo-local |

That explicit `data/` bind still matters when the host content checkout uses a symlink for `data/`. Docker preserves symlinks inside a parent-directory mount, but a direct bind of the `data/` path lets the host resolve a target such as `/mnt/c/...` before the container sees it.

## Alternate content and library roots

If your content repo is not cloned inside `workspace/`, point `DACCI_CONTENT_ROOT` at it:

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

If you also want custom Library repos from that alternate location, point `DACCI_LIBRARY_WORKSPACE_ROOT` at the parent directory that contains those checkouts:

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

With the default repo-local layout, `./scripts/up` mounts `<dacci>/workspace` into the API container at `/workspace`, so any repo cloned under `workspace/` is immediately usable after restarting the stack.

The browser `Adopt Remote Repository` and `Create Repository` flows both target that in-container `/workspace/<repo-name>` layout. Create seeds the checkout with `README.md`, `.gitignore`, and `data/.gitkeep`, pushes the selected branch, keeps `origin` on the alias-aware SSH remote it will use for later sync, and uses the browser-saved commit identity for the initial commit without writing that identity into repo-local Git config.

## Git access

This branch no longer uses GitHub OAuth, browser-stored GitHub usernames, or request-scoped SSH key selection.

Instead:

- keep your content repo remote as a normal SSH remote such as `git@github.com:owner/E2Open.KPE.Content.git`
- make sure `git -C workspace/E2Open.KPE.Content fetch origin` already works from the host shell
- start Dacci from a shell where `SSH_AUTH_SOCK` is set if your keys depend on an agent
- let the API container reuse the live host SSH mount, staged fallback snapshot, and forwarded agent socket
- if you change host SSH files while the stack is running, Library validation plus remote adopt/create will refresh the runtime SSH layout automatically from the live mount when available
- if a repo should use an alternate GitHub identity, enter the GitHub username plus an optional SSH alias in the Library pane remote onboarding form; Dacci will preserve the copied user config as `config.user`, manage its own aliases in `.dacci-generated.conf`, and point the generated alias `IdentityFile` at `~/.ssh/id_ed25519_<github-username>`
- enter a commit name and commit email per repo in the Library pane; Dacci stores that identity in browser-local repo settings and injects it only for create and sync commits that Dacci authors

The browser never uploads SSH keys or holds Git credentials.

The checked-in Compose file does not hardcode `GIT_SYNC_REMOTE_URL`. Set it only when the content checkout should sync against a remote URL that differs from the repository's saved remote config.

Example startup with the default repo-local workspace:

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
| Sync fails or `/ready` fails | verify the mounted content checkout includes `.git`, the repo remote uses SSH, the host `~/.ssh` config already works for that remote, and `SSH_AUTH_SOCK` was set before `./scripts/up` if your keys need an agent; `./scripts/up` mounts both a live host SSH directory and a staged fallback snapshot, and Dacci rebuilds `${HOME}/.ssh` from those sources |
| No repos appear on first load | clone a content repo into `workspace/`, then refresh the page or restart the stack |
| Path mapping looks wrong | remember relative paths are resolved from the compose file location |
