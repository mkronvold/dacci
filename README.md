# Dacci

Dacci is the application for Git-backed Markdown content repositories discovered under the repo-local `workspace/` directory. This repository contains the API, Web UI, CLI, packaging, and shared libraries; each content repo keeps its own Markdown files and Git history in `workspace/<repo-name>`.

## What this repository provides

| Area | What it does |
| --- | --- |
| Content engine | Stores and manages Markdown content under the external checkout's `data/` tree with logical topic and subtopic paths |
| API | Exposes content, transfer, and sync operations over HTTP |
| Web UI | Provides a viewer-first browser workspace for reading and managing documents |
| CLI | Supports scripted content, transfer, and sync workflows |
| Git sync | Adds guarded pull, push, and optional background pull scheduling |
| Deployment assets | Packages the local Docker runtime and keeps archived Kubernetes manifests for reference |

## Quick start

Recommended local layout:

```text
dacci/
├── workspace/
│   ├── Dacci.Example.Content
│   └── E2Open.KPE.Content
└── ...
```

From the Dacci repository root:

```bash
npm install
npm run dev
```

Local defaults scan `./workspace` and use the first discovered content repo as the compatibility default when one exists. If `workspace/` is empty, the API and Web UI still start so the browser can guide you to adopt a local checkout, adopt a remote GitHub-backed repo into the workspace, or create a new GitHub-backed repo when `gh` is available to the API runtime.

To point the native runtime at a repo outside `workspace/`, set both runtime paths explicitly:

```bash
export DATA_ROOT=/srv/E2Open.KPE.Content/data
export GIT_SYNC_REPO_ROOT=/srv/E2Open.KPE.Content
npm run dev
```

Default local endpoints:

| Surface | URL |
| --- | --- |
| API | `http://localhost:3000` |
| Web UI | `http://localhost:5173` |

Run the main automated checks:

```bash
npm run typecheck
npm test
```

## Common commands

| Task | Command |
| --- | --- |
| Start API + Web UI | `npm run dev` |
| Show CLI help | `./scripts/dacci-cli --help` |
| List the content tree | `./scripts/dacci-cli tree` |
| Search content | `./scripts/dacci-cli search release` |
| Search by tag | `./scripts/dacci-cli search tag:release-notes` |
| Show sync status | `./scripts/dacci-cli sync status` |
| Show sync status against an explicitly configured content checkout | `DATA_ROOT=/srv/E2Open.KPE.Content/data GIT_SYNC_REPO_ROOT=/srv/E2Open.KPE.Content ./scripts/dacci-cli sync status` |
| Enable background pull scheduling | `./scripts/dacci-cli sync schedule configure --enable --interval-minutes 15` |
| Validate Docker Compose config | `npm run docker:config` |

`./scripts/dacci-cli` is a thin Bash wrapper around the existing CLI build-and-run path, so you can use the CLI without typing `npm run cli -- ...` each time.

## Choosing the CLI vs the Web UI

The Web UI is the better fit when a person is reading, editing, browsing structure, or visually verifying rendered Markdown, Mermaid, tags, and theme behavior.

The CLI is the better fit when the workflow needs to be scripted, repeated, run headlessly, or composed with shell tooling. That includes:

- scheduled sync and maintenance tasks
- bulk import and export flows
- remote operator actions over SSH
- CI or cron-driven publishing
- generated status and lifecycle updates from external systems

For other projects, the most useful automation pattern is not "make Dacci the source system." Keep the external tool authoritative, generate Markdown or import bundles from it, and use the CLI to publish curated documentation into the Git-backed workspace.

This works especially well for long-running operational views such as:

- maintenance windows and rollout tracking
- lifecycle and migration programs
- release readiness summaries
- environment status and checklist rollups
- incident timelines and recovery notes

It is a good fit for periodic refreshes such as every few minutes, hourly, or daily. It is not meant to replace second-by-second dashboards; for true real-time telemetry, keep using observability tooling and link to it from the generated documents.

## Content model

| Concept | What it means |
| --- | --- |
| Topic | Top-level content area |
| Subtopic | Optional second-level grouping under a topic |
| Document | Markdown file stored under a topic or subtopic |
| Tags | Optional front matter metadata used by `tag:` search and the Web reader |

Storage notes:

- all user content lives under a Git-backed repo such as `workspace/E2Open.KPE.Content/data`
- topic-level documents are normalized internally through `CatchAll`
- the UI and API expose logical paths, not the internal `CatchAll` directory
- newly created empty topics and subtopics include a `.gitkeep` placeholder so Git can retain them before documents exist
- documents can be plain Markdown notes or richer documents with headings, Mermaid diagrams, and optional tags

## Current feature set

| Capability | Current behavior |
| --- | --- |
| Reading | Rendered Markdown reader with heading outline, tag pills, and Mermaid support |
| Editing | Explicit view/edit mode with document save, rename, move, and delete |
| Status-first docs lifecycle | New backend and browser support for `draft/`, `published/`, and `archive/` folder variants, including draft creation, published-to-draft edits, stale-save conflict detection, publish promotion, and archiving |
| Search | Path, name, body, and optional tag search through one API-driven flow |
| Import | Markdown files, directories, JSON bundles, and ZIP archives |
| Export | Markdown for single documents, JSON bundles, and ZIP archives |
| Multi-user auth foundation | New GitHub device-flow session endpoints, repo permission evaluation from GitHub teams and Dacci overrides, and an initial browser docs workspace that uses those sessions |
| Sync | Guarded Git status, pull, push, and optional background pull scheduling |
| Packaging | Multi-stage Docker images and archived Kubernetes manifests |

## API surface

Key endpoints:

| Area | Endpoints |
| --- | --- |
| Service | `GET /health`, `GET /ready`, `GET /api` |
| Discovery | `GET /api/tree`, `GET /api/summary`, `GET /api/search` |
| Library | `GET /api/library/discover`, `POST /api/library/test`, `POST /api/library/adopt-remote`, `POST /api/library/create` |
| Auth | `GET /api/auth/session`, `POST /api/auth/github/device/start`, `POST /api/auth/github/device/poll`, `POST /api/auth/session/logout` |
| Status-first docs | `GET /api/docs/tree`, `GET /api/docs/documents`, `POST /api/docs/documents`, `PUT /api/docs/documents/draft`, `PUT /api/docs/documents/published`, `POST /api/docs/documents/publish`, `POST /api/docs/documents/archive`, `DELETE /api/docs/documents/archive` |
| Documents | `GET /api/documents`, `POST /api/documents`, `PUT /api/documents` |
| Structure | topic and subtopic create, rename, and delete routes |
| Transfer | `POST /api/import/documents`, `POST /api/export` |
| Sync | `GET /api/sync/status`, `POST /api/sync/pull`, `POST /api/sync/push`, schedule routes |

See `apps/api/src/app.ts` for the exact route definitions and `docs/OPERATORS.md` for sync behavior.

## Deployment options

| Environment | What to use |
| --- | --- |
| Native local development | `npm run dev` |
| Packaged local runtime | `deploy/docker/compose.yaml` and `docs/DOCKER.md` |
| Archived Kubernetes reference | `deploy/k8s/` and `docs/KUBERNETES.md` (frozen reference only; not part of the active validation path) |

## Git access model

The active packaged-runtime target is a localhost-only Docker stack that uses normal SSH Git access:

- `./scripts/up` binds the API and web ports to localhost only
- `./scripts/up` passes the host UID/GID into both containers so workspace writes keep host ownership instead of landing as `root:root`
- the API container mounts a live read-only host SSH directory at `/var/run/dacci-host-ssh-live` plus a staged fallback snapshot at `/var/run/dacci-host-ssh-stage`, refreshes `${HOME}/.ssh` from the live mount when available, preserves Dacci-managed aliases in `.dacci-generated.conf`, and exports a runtime `GIT_SSH_COMMAND`
- if `SSH_AUTH_SOCK` is set when you start the stack, Dacci forwards that agent socket into the API container too
- the browser `Adopt Remote Repository` flow clones an existing GitHub-backed repo into the configured workspace root without depending on `gh`
- the browser `Create Repository` flow depends on `gh` being available to the API runtime; the packaged Docker API image includes it
- remote adopt and create both use a GitHub username plus an SSH host alias, default the alias from that username, refresh runtime SSH state automatically during onboarding, and can insert a missing alias into the Dacci-managed SSH include
- per-repo commit name and email live in browser-local repo settings, not `.git/config`, and Dacci injects them only for create and sync commits that it authors
- the browser does not connect GitHub, upload SSH keys, or store Git credentials
- pull, push, and refresh use the same SSH remotes and host SSH setup that already work on your machine

Before using the packaged runtime, make sure the host content checkout can already talk to its remote with normal SSH Git commands. See `docs/DOCKER.md` and `docs/OPERATORS.md` for the runtime details.

### Multi-user runtime configuration

The new multi-user slices are opt-in. They now include an initial browser workspace on top of the new API routes, but the broader product migration is still in progress:

- `DACCI_LIBRARY_REPOS` — JSON array of explicitly allowed repository definitions with `id`, `name`, `repoRoot`, and optional `dataRoot` and `releaseBranch`
- `DACCI_GITHUB_DEVICE_CLIENT_ID` — GitHub OAuth app client id for `github.com/login/device`
- `DACCI_GITHUB_TEAM_ROLE_BINDINGS` — JSON array mapping GitHub org/team membership to repo roles such as `manage` or `direct-publish`
- `DACCI_GITHUB_REPO_ROLE_OVERRIDES` — JSON array of per-repo username overrides for repo roles

If `DACCI_GITHUB_DEVICE_CLIENT_ID` is set, the new `/api/docs/*` routes require a Dacci auth session from the device-flow endpoints. The web app now includes an initial multi-user docs pane that signs in through device flow, shows repo permissions, browses logical docs by lifecycle state, and performs draft, publish, archive, and archive-delete actions against those routes.

## Documentation map

| Document | Use it for |
| --- | --- |
| `docs/DESIGN.md` | Why the UI is shaped the way it is |
| `docs/ARCHITECTURE.md` | Why the runtime is split into its current layers and deployment model |
| `docs/AUTOMATION-ADOPTION.md` | How to adopt CLI-driven automation and periodic status publishing in another repo |
| `docs/CLI.md` | How to use the CLI for operator workflows, imports, sync, and scheduled publishing |
| `docs/DOCKER.md` | What to do to run the packaged Docker runtime |
| `docs/KUBERNETES.md` | Archived Kubernetes package reference retained for historical context during the local-Docker rescope |
| `docs/OPERATORS.md` | What operators need to know about sync, runtime assumptions, and deployment behavior |
| `TESTING.md` | What to run to validate changes |
| `DEMO.md` | What to do for an end-to-end product walkthrough |

## Repository layout

```text
.
├── apps/
│   ├── api/
│   ├── cli/
│   └── web/
├── deploy/
│   ├── docker/
│   └── k8s/
├── docs/
│   ├── AUTOMATION-ADOPTION.md
│   ├── ARCHITECTURE.md
│   ├── CLI.md
│   ├── DESIGN.md
│   ├── DOCKER.md
│   ├── KUBERNETES.md
│   └── OPERATORS.md
├── packages/
│   ├── content-engine/
│   ├── github-sync/
│   └── shared-types/
├── scripts/
├── package.json
└── README.md
```

Content repos normally live under this repo's gitignored `workspace/` directory.

## Current constraints

- the Git-backed workspace is still single-writer by design
- the new multi-user docs pane still operates against local repo checkouts managed by the current API runtime, not direct GitHub API reads and writes
- background sync is pull-only, per-repo, and disabled by default
- distributed write coordination is still partial; per-repo mutation serialization and stale-save detection exist, but PR-mediated promotion and richer merge handling are still future work
- advanced production platform integrations remain future work
