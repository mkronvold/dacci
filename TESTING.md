# Dacci Testing Guide

This guide explains what to run in the Dacci application repository and what each command proves when you are validating an `E2Open.KPE.Content` content checkout.

## Quick start

From the Dacci repository root:

```bash
npm install
npm run typecheck
npm test
```

For a clean reinstall:

```bash
npm ci
npm run typecheck
npm test
```

## Root command reference

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | TypeScript correctness across all workspaces |
| `npm run build` | Production builds for all workspaces, including the Vite web build |
| `npm test` | Full build plus `node:test` suites for content engine, sync, API, and CLI |
| `npm run docker:config` | Docker Compose configuration validity |

Important:

- `apps/web` is validated by typecheck and production build, not a browser test suite
- root commands are sequential and fail fast

## Workspace command reference

| Workspace | Commands |
| --- | --- |
| Shared types | `npm run typecheck --workspace @dacci/shared-types`<br>`npm run build --workspace @dacci/shared-types` |
| Content engine | `npm run typecheck --workspace @dacci/content-engine`<br>`npm run build --workspace @dacci/content-engine`<br>`npm run test --workspace @dacci/content-engine` |
| GitHub sync | `npm run typecheck --workspace @dacci/github-sync`<br>`npm run build --workspace @dacci/github-sync`<br>`npm run test --workspace @dacci/github-sync` |
| API | `npm run typecheck --workspace @dacci/api`<br>`npm run build --workspace @dacci/api`<br>`npm run test --workspace @dacci/api` |
| Web | `npm run typecheck --workspace @dacci/web`<br>`npm run build --workspace @dacci/web` |
| CLI | `npm run typecheck --workspace @dacci/cli`<br>`npm run build --workspace @dacci/cli`<br>`npm run test --workspace @dacci/cli` |

## Recommended validation paths

| Change type | Recommended commands |
| --- | --- |
| Small workspace-only change | Narrow workspace `typecheck`, `build`, and `test` first |
| Cross-workspace behavior change | `npm run typecheck` then `npm test` |
| Docker/runtime change | `npm run docker:config` and, if needed, runtime probes |

For Docker runtime probes:

```bash
npm run docker:up
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:4173/health
curl http://localhost:4173/runtime-config.json
npm run docker:down
```

## What success means

| Command | Success means |
| --- | --- |
| `npm run typecheck` | workspace contracts and TypeScript usage still line up |
| `npm run build` | all workspaces compiled and the web app built for production |
| `npm test` | build succeeded first and all automated suites passed |

Typical `node:test` success output ends with a pass/fail summary such as:

```text
ℹ pass 6
ℹ fail 0
```

## What failures usually mean

| Failure type | Typical cause | What to do |
| --- | --- | --- |
| Typecheck | shared type drift, strict optional-property mismatch, broken imports | fix the reported file, rerun the narrow command, then rerun root typecheck |
| Build | compile error, Vite issue, missing dependency output | fix the first failing workspace, rerun the narrow build, then rerun root build or test |
| Test | real behavior regression or contract mismatch | trust the failing test name, debug the narrow suite, then rerun root test |

## Repo-specific notes

### Web coverage

The web app is currently validated by:

- TypeScript checks
- Vite production build

There is no separate browser UI test suite in the repo.

### Dependency repair

If Vite files or other installed modules are missing even though the code looks correct:

```bash
npm ci
npm run typecheck
npm test
```

### Sync-related manual checks

Automated tests do not require a clean repo, but manual sync demos do. If you are testing `sync pull`, `sync push`, or background scheduling, verify the repo state and remote configuration first. For split-checkout validation, point `DATA_ROOT` and `GIT_SYNC_REPO_ROOT` at the `E2Open.KPE.Content` checkout before exercising sync flows.
