import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const defaultScheduleStateFileName = "dacci-sync-schedule.json";
const scheduleStateFilePrefix = "dacci-sync-schedule-";

export interface RepoScheduleIdentityInput {
  isDefault: boolean;
  repoRoot: string;
  dataRoot: string;
}

export function buildRepoSchedulerKey(input: RepoScheduleIdentityInput): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        isDefault: input.isDefault,
        repoRoot: path.resolve(input.repoRoot),
        dataRoot: path.resolve(input.dataRoot),
      }),
    )
    .digest("hex");
}

export function buildScheduleStateFileName(input: RepoScheduleIdentityInput): string {
  if (input.isDefault) {
    return defaultScheduleStateFileName;
  }

  return `${scheduleStateFilePrefix}${buildRepoSchedulerKey(input).slice(0, 12)}.json`;
}

export function readPersistedScheduleReleaseBranch(input: RepoScheduleIdentityInput): string | undefined {
  const gitDirPath = resolveGitDirPath(input.repoRoot);
  if (!gitDirPath) {
    return undefined;
  }

  const scheduleStatePath = path.join(gitDirPath, "info", buildScheduleStateFileName(input));
  try {
    const parsed = JSON.parse(readFileSync(scheduleStatePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    return normalizeOptionalString((parsed as Record<string, unknown>).releaseBranch);
  } catch {
    return undefined;
  }
}

export function resolveGitDirPath(repoRoot: string): string | undefined {
  const gitPath = path.join(repoRoot, ".git");

  try {
    const gitStats = statSync(gitPath);
    if (gitStats.isDirectory()) {
      return gitPath;
    }

    if (!gitStats.isFile()) {
      return undefined;
    }

    const gitFileContents = readFileSync(gitPath, "utf8");
    const gitDir = gitFileContents.match(/^gitdir:\s*(.+)\s*$/im)?.[1]?.trim();
    return gitDir ? path.resolve(repoRoot, gitDir) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue ? normalizedValue : undefined;
}
