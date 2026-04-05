import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GitHubSyncError } from "@dacci/github-sync";

const sshDirectoryName = ".ssh";
const sshConfigFileName = "config";
const runtimeUserConfigFileName = "config.user";
const runtimeGeneratedConfigFileName = ".dacci-generated.conf";
const runtimeKnownHostsFileName = "known_hosts";

type RuntimeSshPaths = {
  managedLayout: boolean;
  sshDirectoryPath: string;
  sshConfigPath: string;
  userConfigPath: string;
  dacciManagedConfigPath: string;
  knownHostsPath: string;
};

export function resolveRuntimeSshPaths(): RuntimeSshPaths {
  const sshDirectoryPath = path.join(os.homedir(), sshDirectoryName);
  const managedLayout = Boolean(
    process.env.DACCI_RUNTIME_SSH_STAGE_DIR?.trim() || process.env.DACCI_RUNTIME_SSH_SOURCE_DIR?.trim(),
  );

  return {
    managedLayout,
    sshDirectoryPath,
    sshConfigPath: path.join(sshDirectoryPath, sshConfigFileName),
    userConfigPath: managedLayout
      ? path.join(sshDirectoryPath, runtimeUserConfigFileName)
      : path.join(sshDirectoryPath, sshConfigFileName),
    dacciManagedConfigPath: managedLayout
      ? path.join(sshDirectoryPath, runtimeGeneratedConfigFileName)
      : path.join(sshDirectoryPath, sshConfigFileName),
    knownHostsPath: path.join(sshDirectoryPath, runtimeKnownHostsFileName),
  };
}

export async function refreshManagedRuntimeSshState(options?: { preferLiveSource?: boolean }): Promise<void> {
  const runtimeSshPaths = resolveRuntimeSshPaths();
  if (!runtimeSshPaths.managedLayout) {
    return;
  }

  const sourceDirectoryPaths = await resolveManagedSshSourcePaths(options?.preferLiveSource ?? true);
  if (sourceDirectoryPaths.length === 0) {
    return;
  }

  const preservedDacciConfig = await readOptionalFile(runtimeSshPaths.dacciManagedConfigPath);
  const tempDirectoryPath = `${runtimeSshPaths.sshDirectoryPath}.refresh-${process.pid}-${Date.now()}`;

  await rm(tempDirectoryPath, { recursive: true, force: true });
  await mkdir(path.dirname(tempDirectoryPath), { recursive: true });

  await copyManagedSshSourceDirectory(sourceDirectoryPaths, tempDirectoryPath);

  try {
    const copiedConfigPath = path.join(tempDirectoryPath, sshConfigFileName);
    const copiedUserConfigPath = path.join(tempDirectoryPath, runtimeUserConfigFileName);

    if (await pathExists(copiedConfigPath)) {
      await rm(copiedUserConfigPath, { force: true });
      await rename(copiedConfigPath, copiedUserConfigPath);
    }

    await writeFile(path.join(tempDirectoryPath, runtimeGeneratedConfigFileName), preservedDacciConfig, "utf8");
    if (!(await pathExists(path.join(tempDirectoryPath, runtimeKnownHostsFileName)))) {
      await writeFile(path.join(tempDirectoryPath, runtimeKnownHostsFileName), "", "utf8");
    }
    await writeFile(
      path.join(tempDirectoryPath, sshConfigFileName),
      buildManagedRuntimeSshConfig({
        hasUserConfig: await pathExists(copiedUserConfigPath),
      }),
      "utf8",
    );
    await chmodRecursive(tempDirectoryPath);
    await rm(runtimeSshPaths.sshDirectoryPath, { recursive: true, force: true });
    await rename(tempDirectoryPath, runtimeSshPaths.sshDirectoryPath);
  } catch (error) {
    await rm(tempDirectoryPath, { recursive: true, force: true });
    throw error;
  }
}

function buildManagedRuntimeSshConfig(options: { hasUserConfig: boolean }): string {
  const lines = [`Include ~/.ssh/${runtimeGeneratedConfigFileName}`];
  if (options.hasUserConfig) {
    lines.push(`Include ~/.ssh/${runtimeUserConfigFileName}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function resolveManagedSshSourcePaths(preferLiveSource: boolean): Promise<string[]> {
  const liveSourcePath = process.env.DACCI_RUNTIME_SSH_SOURCE_DIR?.trim();
  const stagedSourcePath = process.env.DACCI_RUNTIME_SSH_STAGE_DIR?.trim();
  const candidatePaths = preferLiveSource
    ? [liveSourcePath, stagedSourcePath]
    : [stagedSourcePath, liveSourcePath];
  const configuredPaths = candidatePaths.filter((candidate): candidate is string => Boolean(candidate));
  const existingPaths: string[] = [];

  for (const candidatePath of configuredPaths) {
    if (await isDirectory(candidatePath)) {
      if (!existingPaths.includes(candidatePath)) {
        existingPaths.push(candidatePath);
      }
    }
  }

  if (existingPaths.length > 0) {
    return existingPaths;
  }

  if (configuredPaths.length === 0) {
    return [];
  }

  throw new GitHubSyncError(
    "invalid_configuration",
    `Managed SSH refresh expected one of these directories to exist: ${configuredPaths.join(", ")}.`,
  );
}

async function copyManagedSshSourceDirectory(candidatePaths: string[], targetDirectoryPath: string): Promise<void> {
  const copyErrors: string[] = [];

  for (const candidatePath of candidatePaths) {
    await rm(targetDirectoryPath, { recursive: true, force: true });
    try {
      await cp(candidatePath, targetDirectoryPath, {
        recursive: true,
        dereference: true,
        force: true,
        errorOnExist: false,
      });
      return;
    } catch (error) {
      copyErrors.push(`${candidatePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new GitHubSyncError(
    "invalid_configuration",
    `Failed to refresh the mounted SSH snapshot from the configured sources: ${copyErrors.join("; ")}`,
  );
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return "";
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function chmodRecursive(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmodEntry(directoryPath);
}

async function chmodEntry(entryPath: string): Promise<void> {
  const entryStats = await stat(entryPath);
  if (entryStats.isDirectory()) {
    await writeMode(entryPath, 0o700);
    const entries = await readdir(entryPath, { withFileTypes: true });
    for (const entry of entries) {
      await chmodEntry(path.join(entryPath, entry.name));
    }
    return;
  }

  await writeMode(entryPath, 0o600);
}

async function writeMode(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    throw new GitHubSyncError(
      "invalid_configuration",
      `Failed to update permissions for '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
