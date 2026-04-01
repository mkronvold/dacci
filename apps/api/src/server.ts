import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp, type BuildAppOptions, validateAppRuntimeConfiguration } from "./app.js";
import { parseConfiguredLibraryRoots } from "./repoContext.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRepoRoot = path.resolve(__dirname, "../../..");
const defaultWorkspaceRoot = path.join(appRepoRoot, "workspace");
mkdirSync(defaultWorkspaceRoot, { recursive: true });
const explicitDataRoot = normalizeOptionalEnvPath(process.env.DATA_ROOT);
const explicitGitSyncRepoRoot = normalizeOptionalEnvPath(process.env.GIT_SYNC_REPO_ROOT);
const defaultContentRepoRoot = resolveDefaultContentRepoRoot(defaultWorkspaceRoot);
const dataRoot = explicitDataRoot ?? (defaultContentRepoRoot ? path.join(defaultContentRepoRoot, "data") : undefined);
const gitSyncRepoRoot = explicitGitSyncRepoRoot ?? defaultContentRepoRoot;
const gitSyncRemoteName = process.env.GIT_SYNC_REMOTE_NAME ?? "origin";
const gitSyncRemoteUrl = process.env.GIT_SYNC_REMOTE_URL;
const gitSshCommand = process.env.GIT_SSH_COMMAND;
const gitSyncReleaseBranch = process.env.GIT_SYNC_RELEASE_BRANCH ?? "default";
const libraryRepoRoots = process.env.DACCI_LIBRARY_ROOTS?.trim()
  ? parseConfiguredLibraryRoots(undefined, process.env.DACCI_LIBRARY_ROOTS)
  : buildDefaultLibraryRoots(defaultWorkspaceRoot, gitSyncRepoRoot);
const port = parsePort(process.env.PORT ?? "3000", 3000);
const host = process.env.HOST ?? "0.0.0.0";

const appOptions: BuildAppOptions = {
  gitSyncRemoteName,
  gitSyncReleaseBranch,
};
if (dataRoot && gitSyncRepoRoot) {
  appOptions.dataRoot = dataRoot;
  appOptions.gitSyncRepoRoot = gitSyncRepoRoot;
}
if (gitSyncRemoteUrl) {
  appOptions.gitSyncRemoteUrl = gitSyncRemoteUrl;
}
if (gitSshCommand) {
  appOptions.gitSshCommand = gitSshCommand;
}
if (libraryRepoRoots.length > 0) {
  appOptions.libraryRepoRoots = libraryRepoRoots;
}

let shuttingDown = false;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  await validateAppRuntimeConfiguration(appOptions);
  app = await buildApp(appOptions);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      void (async () => {
        try {
          app?.log.info({ signal }, "Shutting down API server");
          await app?.close();
          process.exit(0);
        } catch (error) {
          app?.log.error({ err: error, signal }, "Failed to shut down API server cleanly");
          process.exit(1);
        }
      })();
    });
  }

  await app.listen({ host, port });
  app.log.info(
    {
      host,
      port,
      dataRoot,
      gitSyncRepoRoot,
      gitSyncRemoteName,
      gitSyncRemoteUrl,
      gitSyncReleaseBranch,
      libraryRepoRoots,
    },
    "API runtime started",
  );
} catch (error) {
  if (app) {
    app.log.error(error);
  } else {
    console.error(error);
  }
  process.exit(1);
}

function parsePort(value: string, fallback: number): number {
  const parsedValue = Number.parseInt(value, 10);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function normalizeOptionalEnvPath(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue ? path.resolve(normalizedValue) : undefined;
}

function buildDefaultLibraryRoots(workspaceRoot: string, defaultRepoRoot?: string): string[] {
  const roots = new Set<string>([workspaceRoot]);
  if (defaultRepoRoot && !isSameOrInside(workspaceRoot, defaultRepoRoot)) {
    roots.add(path.dirname(defaultRepoRoot));
  }

  return [...roots];
}

function resolveDefaultContentRepoRoot(workspaceRoot: string): string | undefined {
  try {
    const repoRoots = readdirSync(workspaceRoot, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(workspaceRoot, entry.name))
      .filter((repoRoot) => hasGitMetadata(repoRoot) && isDirectory(path.join(repoRoot, "data")))
      .sort((left, right) => {
        if (path.basename(left) === "E2Open.KPE.Content") {
          return -1;
        }
        if (path.basename(right) === "E2Open.KPE.Content") {
          return 1;
        }

        return left.localeCompare(right);
      });

    return repoRoots[0];
  } catch {
    return undefined;
  }
}

function hasGitMetadata(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, ".git"));
}

function isDirectory(candidatePath: string): boolean {
  try {
    return statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function isSameOrInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
