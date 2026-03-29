# Dacci

Dacci is the application for the external `E2Open.KPE.Content` Markdown content repository. This repository contains the API, Web UI, CLI, packaging, and shared libraries; the Markdown content and Git sync history stay in a separate `E2Open.KPE.Content` checkout.

## What this repository provides

| Area | What it does |
| --- | --- |
| Content engine | Stores and manages Markdown content under the external checkout's `data/` tree with logical topic and subtopic paths |
| API | Exposes content, transfer, and sync operations over HTTP |
| Web UI | Provides a viewer-first browser workspace for reading and managing documents |
| CLI | Supports scripted content, transfer, and sync workflows |
| Git sync | Adds guarded pull, push, and optional background pull scheduling |
| Deployment assets | Packages the runtime for Docker and baseline Kubernetes deployment |

## Quick start

Recommended local layout:

```text
workspace/
├── dacci
└── E2Open.KPE.Content
```

From the Dacci repository root:

```bash
npm install
npm run dev
```

Local defaults already prefer a sibling `../E2Open.KPE.Content` checkout. If your content checkout lives elsewhere, set both runtime paths explicitly:

```bash
export DATA_ROOT=../E2Open.KPE.Content/data
export GIT_SYNC_REPO_ROOT=../E2Open.KPE.Content
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
| Show CLI help | `npm run cli -- --help` |
| List the content tree | `npm run cli -- tree` |
| Search content | `npm run cli -- search release` |
| Search by tag | `npm run cli -- search tag:release-notes` |
| Show sync status | `npm run cli -- sync status` |
| Show sync status against an explicitly configured content checkout | `DATA_ROOT=../E2Open.KPE.Content/data GIT_SYNC_REPO_ROOT=../E2Open.KPE.Content npm run cli -- sync status` |
| Enable background pull scheduling | `npm run cli -- sync schedule configure --enable --interval-minutes 15` |
| Render Kubernetes manifests | `npm run k8s:render` |
| Validate Docker Compose config | `npm run docker:config` |

## Content model

| Concept | What it means |
| --- | --- |
| Topic | Top-level content area |
| Subtopic | Optional second-level grouping under a topic |
| Document | Markdown file stored under a topic or subtopic |
| Tags | Optional front matter metadata used by `tag:` search and the Web reader |

Storage notes:

- all user content lives under the external `E2Open.KPE.Content/data` tree
- topic-level documents are normalized internally through `CatchAll`
- the UI and API expose logical paths, not the internal `CatchAll` directory
- documents can be plain Markdown notes or richer documents with headings, Mermaid diagrams, and optional tags

## Current feature set

| Capability | Current behavior |
| --- | --- |
| Reading | Rendered Markdown reader with heading outline, tag pills, and Mermaid support |
| Editing | Explicit view/edit mode with document save, rename, move, and delete |
| Search | Path, name, body, and optional tag search through one API-driven flow |
| Import | Markdown files, directories, JSON bundles, and ZIP archives |
| Export | Markdown for single documents, JSON bundles, and ZIP archives |
| Sync | Guarded Git status, pull, push, and optional background pull scheduling |
| Packaging | Multi-stage Docker images and baseline Kubernetes manifests |

## API surface

Key endpoints:

| Area | Endpoints |
| --- | --- |
| Service | `GET /health`, `GET /ready`, `GET /api` |
| Discovery | `GET /api/tree`, `GET /api/summary`, `GET /api/search` |
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
| Baseline Kubernetes deployment | `deploy/k8s/` and `docs/KUBERNETES.md` |

## Documentation map

| Document | Use it for |
| --- | --- |
| `docs/DESIGN.md` | Why the UI is shaped the way it is |
| `docs/ARCHITECTURE.md` | Why the runtime is split into its current layers and deployment model |
| `docs/DOCKER.md` | What to do to run the packaged Docker runtime |
| `docs/KUBERNETES.md` | What to do to deploy the baseline Kubernetes package |
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
│   ├── ARCHITECTURE.md
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

The external `E2Open.KPE.Content` checkout lives beside this repo, not inside it.

## Current constraints

- the Git-backed workspace is still single-writer by design
- background sync is pull-only and disabled by default
- distributed write coordination is not implemented
- advanced production platform integrations remain future work
