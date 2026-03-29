import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp, type BuildAppOptions, validateAppRuntimeConfiguration } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRepoRoot = path.resolve(__dirname, "../../..");
const defaultContentRepoRoot = resolveDefaultContentRepoRoot(appRepoRoot);
const dataRoot = process.env.DATA_ROOT ?? path.join(defaultContentRepoRoot, "data");
const gitSyncRepoRoot = process.env.GIT_SYNC_REPO_ROOT ?? path.resolve(dataRoot, "..");
const gitSyncRemoteName = process.env.GIT_SYNC_REMOTE_NAME ?? "origin";
const gitSyncRemoteUrl = process.env.GIT_SYNC_REMOTE_URL;
const gitSshCommand = process.env.GIT_SSH_COMMAND;
const gitSyncReleaseBranch = process.env.GIT_SYNC_RELEASE_BRANCH ?? "default";
const port = parsePort(process.env.PORT ?? "3000", 3000);
const host = process.env.HOST ?? "0.0.0.0";

const appOptions: BuildAppOptions = {
  dataRoot,
  gitSyncRepoRoot,
  gitSyncRemoteName,
  gitSyncReleaseBranch,
};
if (gitSyncRemoteUrl) {
  appOptions.gitSyncRemoteUrl = gitSyncRemoteUrl;
}
if (gitSshCommand) {
  appOptions.gitSshCommand = gitSshCommand;
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

function resolveDefaultContentRepoRoot(repoRoot: string): string {
  const siblingContentRepoRoot = path.resolve(repoRoot, "../E2Open.KPE.Content");
  if (
    existsSync(path.join(siblingContentRepoRoot, ".git")) &&
    existsSync(path.join(siblingContentRepoRoot, "data"))
  ) {
    return siblingContentRepoRoot;
  }

  return repoRoot;
}
