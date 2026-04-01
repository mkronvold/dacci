import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { ContentEngine } from "@dacci/content-engine";
import { GitHubSync, GitHubSyncError, type GitHubSyncOptions } from "@dacci/github-sync";
import type { LibraryRepoDefinition, RepoContextSummary, RepoSelection } from "@dacci/shared-types";
import { configuredRepoId } from "@dacci/shared-types";

import {
  readPersistedScheduleReleaseBranch,
  resolveGitDirPath,
} from "./scheduleState.js";

export interface RepoContextResolverOptions {
  defaultDataRoot?: string;
  defaultRepoRoot?: string;
  gitSyncRemoteName?: string;
  gitSyncRemoteUrl?: string;
  gitSyncReleaseBranch?: string;
  libraryRepoRoots?: string[];
}

export interface ResolvedRepoContext {
  isDefault: boolean;
  dataRoot: string;
  repoRoot: string;
  summary: RepoContextSummary;
  createEngine: () => ContentEngine;
  createGitSync: () => GitHubSync;
}

export class RepoContextResolver {
  private readonly defaultDataRoot: string | null;
  private readonly defaultRepoRoot: string | null;
  private readonly gitSyncRemoteName: string | undefined;
  private readonly gitSyncRemoteUrl: string | undefined;
  private readonly gitSyncReleaseBranch: string | undefined;
  private readonly libraryRepoRoots: string[];

  public constructor(options: RepoContextResolverOptions) {
    this.defaultDataRoot = options.defaultDataRoot ? path.resolve(options.defaultDataRoot) : null;
    this.defaultRepoRoot = options.defaultRepoRoot ? path.resolve(options.defaultRepoRoot) : null;
    this.gitSyncRemoteName = options.gitSyncRemoteName?.trim() || undefined;
    this.gitSyncRemoteUrl = options.gitSyncRemoteUrl?.trim() || undefined;
    this.gitSyncReleaseBranch = options.gitSyncReleaseBranch?.trim() || undefined;
    this.libraryRepoRoots = [...new Set((options.libraryRepoRoots ?? []).map((entry) => path.resolve(entry)))];
  }

  public getDefaultSummary(): RepoContextSummary | null {
    if (!this.defaultDataRoot || !this.defaultRepoRoot) {
      return null;
    }

    const releaseBranch = resolveReleaseBranch(this.gitSyncReleaseBranch);
    return {
      id: configuredRepoId,
      kind: "default",
      name: buildConfiguredRepoName(this.defaultRepoRoot, this.gitSyncRemoteUrl, this.gitSyncRemoteName),
      repoRoot: this.defaultRepoRoot,
      dataRoot: this.defaultDataRoot,
      isDefault: true,
      releaseBranch,
    };
  }

  public getConfiguredLibraryRoots(): string[] {
    return [...this.libraryRepoRoots];
  }

  public async discoverLibraryRepos(): Promise<RepoContextSummary[]> {
    const discoveredRepos = new Map<string, RepoContextSummary>();

    for (const rootPath of this.libraryRepoRoots) {
      for (const summary of await this.discoverLibraryReposInRoot(rootPath)) {
        discoveredRepos.set(summary.repoRoot, summary);
      }
    }

    return [...discoveredRepos.values()].sort(compareRepoContextSummaries);
  }

  public async validateConfiguredLibraryRoots(): Promise<void> {
    await Promise.all(
      this.libraryRepoRoots.map(async (rootPath) => {
        if (!path.isAbsolute(rootPath)) {
          throw new GitHubSyncError(
            "invalid_configuration",
            `Configured library root '${rootPath}' must be an absolute path.`,
          );
        }

        if (rootPath === path.parse(rootPath).root) {
          throw new GitHubSyncError(
            "invalid_configuration",
            `Configured library root '${rootPath}' is too broad. Point Dacci at a specific directory of content checkouts instead.`,
          );
        }

        let stats;
        try {
          stats = await stat(rootPath);
        } catch {
          throw new GitHubSyncError(
            "invalid_configuration",
            `Configured library root '${rootPath}' does not exist or is not accessible.`,
          );
        }

        if (!stats.isDirectory()) {
          throw new GitHubSyncError(
            "invalid_configuration",
            `Configured library root '${rootPath}' must be a directory.`,
          );
        }
      }),
    );
  }

  public resolveRequestSelection(headerValue: string | string[] | undefined): ResolvedRepoContext {
    return this.resolveSelection(parseRepoSelectionHeader(headerValue));
  }

  public resolveLibraryRepo(repo: LibraryRepoDefinition): ResolvedRepoContext {
    return this.resolveSelection({
      kind: "library",
      repo,
    });
  }

  private resolveSelection(selection: RepoSelection): ResolvedRepoContext {
    if (selection.kind === "default") {
      const defaultSummary = this.getDefaultSummary();
      if (!defaultSummary || !this.defaultDataRoot || !this.defaultRepoRoot) {
        throw new GitHubSyncError(
          "invalid_configuration",
          "No content repository is selected yet. Clone one into the workspace or add one in the Library panel first.",
        );
      }

      return this.createContext({
        summary: defaultSummary,
        repoRoot: this.defaultRepoRoot,
        dataRoot: this.defaultDataRoot,
        isDefault: true,
        releaseBranch: defaultSummary.releaseBranch ?? resolveReleaseBranch(this.gitSyncReleaseBranch),
      });
    }

    const normalizedRepo = normalizeLibraryRepoDefinition(selection.repo);
    const repoRoot = normalizedRepo.repoRoot;
    const dataRoot = normalizedRepo.dataRoot ? normalizedRepo.dataRoot : path.join(repoRoot, "data");
    ensurePathInside(repoRoot, dataRoot, "Content root");

    const defaultSummary = this.getDefaultSummary();
    const defaultRepoSelection =
      defaultSummary !== null &&
      repoRoot === this.defaultRepoRoot &&
      dataRoot === this.defaultDataRoot;
    const persistedReleaseBranch =
      normalizedRepo.releaseBranch ||
      (!defaultRepoSelection && this.isRepoRootAllowed(repoRoot)
        ? readPersistedScheduleReleaseBranch({
            isDefault: false,
            repoRoot,
            dataRoot,
          })
        : undefined);
    const releaseBranch = resolveReleaseBranch(persistedReleaseBranch, this.gitSyncReleaseBranch);
    if (
      defaultRepoSelection &&
      defaultSummary &&
      releaseBranch === defaultSummary.releaseBranch
    ) {
      return this.createContext({
        summary: defaultSummary,
        repoRoot: this.defaultRepoRoot!,
        dataRoot: this.defaultDataRoot!,
        isDefault: true,
        releaseBranch,
      });
    }

    if (!this.isRepoRootAllowed(repoRoot)) {
      throw new GitHubSyncError(
        "invalid_configuration",
        this.libraryRepoRoots.length > 0
          ? `Repository root '${repoRoot}' is outside the configured library roots.`
          : "Custom library repositories are not available in this runtime until Dacci is configured with allowed library roots.",
      );
    }

    return this.createContext({
      summary: {
        id: normalizedRepo.id,
        kind: "library",
        name: buildResolvedRepoName(repoRoot, normalizedRepo.name, undefined, this.gitSyncRemoteName),
        repoRoot,
        dataRoot,
        isDefault: false,
        releaseBranch,
      },
      repoRoot,
      dataRoot,
      isDefault: false,
      releaseBranch,
    });
  }

  private createContext(input: {
    summary: RepoContextSummary;
    repoRoot: string;
    dataRoot: string;
    isDefault: boolean;
    releaseBranch: string;
  }): ResolvedRepoContext {
    return {
      isDefault: input.isDefault,
      repoRoot: input.repoRoot,
      dataRoot: input.dataRoot,
      summary: input.summary,
      createEngine: () =>
        new ContentEngine({
          dataRoot: input.dataRoot,
        }),
      createGitSync: () => new GitHubSync(this.buildGitSyncOptions(input.repoRoot, input.dataRoot, input.releaseBranch)),
    };
  }

  private buildGitSyncOptions(repoRoot: string, dataRoot: string, releaseBranch: string): GitHubSyncOptions {
    const options: GitHubSyncOptions = {
      repoRoot,
      contentRoot: dataRoot,
      releaseBranch,
    };
    if (this.gitSyncRemoteName) {
      options.remoteName = this.gitSyncRemoteName;
    }
    if (this.gitSyncRemoteUrl) {
      options.remoteUrl = this.gitSyncRemoteUrl;
    }

    return options;
  }

  private isRepoRootAllowed(repoRoot: string): boolean {
    return this.libraryRepoRoots.some((rootPath) => isSameOrInside(rootPath, repoRoot));
  }

  private async discoverLibraryReposInRoot(rootPath: string): Promise<RepoContextSummary[]> {
    let entries;
    try {
      entries = await readdir(rootPath, {
        withFileTypes: true,
      });
    } catch {
      throw new GitHubSyncError(
        "invalid_configuration",
        `Configured library root '${rootPath}' does not exist or is not accessible.`,
      );
    }

    const discoveredRepos = await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith(".")) {
          return null;
        }

        const repoRoot = path.join(rootPath, entry.name);
        if (!(await isDirectoryPath(repoRoot))) {
          return null;
        }

        return this.discoverLibraryRepo(repoRoot);
      }),
    );

    return discoveredRepos.filter((entry): entry is RepoContextSummary => entry !== null);
  }

  private async discoverLibraryRepo(repoRoot: string): Promise<RepoContextSummary | null> {
    const dataRoot = path.join(repoRoot, "data");
    const gitConfigPath = resolveGitConfigPath(repoRoot);
    if (!gitConfigPath || !(await isFilePath(gitConfigPath)) || !(await isDirectoryPath(dataRoot))) {
      return null;
    }

    try {
      return this.resolveLibraryRepo({
        id: buildDiscoveredRepoId(repoRoot),
        name: buildRepoRootFallbackName(repoRoot),
        repoRoot,
      }).summary;
    } catch (error) {
      if (error instanceof GitHubSyncError && error.code === "invalid_configuration") {
        return null;
      }

      throw error;
    }
  }
}

export function parseConfiguredLibraryRoots(
  defaultRepoRoot?: string,
  configuredValue?: string,
): string[] {
  const normalizedValue = configuredValue?.trim();
  if (normalizedValue) {
    return normalizedValue
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry));
  }

  if (!defaultRepoRoot) {
    return [];
  }

  const defaultParent = path.dirname(path.resolve(defaultRepoRoot));
  return defaultParent !== path.parse(defaultParent).root ? [defaultParent] : [];
}

export function parseRepoSelectionHeader(
  headerValue: string | string[] | undefined,
): RepoSelection {
  if (Array.isArray(headerValue)) {
    throw new GitHubSyncError(
      "invalid_configuration",
      "Repository selection header must not be repeated.",
    );
  }

  if (!headerValue?.trim()) {
    return { kind: "default" };
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(decodeURIComponent(headerValue));
  } catch {
    throw new GitHubSyncError(
      "invalid_configuration",
      "Repository selection header is not valid JSON.",
    );
  }

  if (!parsedValue || typeof parsedValue !== "object") {
    throw new GitHubSyncError(
      "invalid_configuration",
      "Repository selection must be an object.",
    );
  }

  const selection = parsedValue as Record<string, unknown>;
  if (selection.kind === "default") {
    return { kind: "default" };
  }

  if (selection.kind !== "library") {
    throw new GitHubSyncError(
      "invalid_configuration",
      "Repository selection kind must be 'default' or 'library'.",
    );
  }

  const repo = selection.repo;
  if (!repo || typeof repo !== "object") {
    throw new GitHubSyncError(
      "invalid_configuration",
      "Library repository selection is missing its repo definition.",
    );
  }

  return {
    kind: "library",
    repo: normalizeLibraryRepoDefinition(repo as Record<string, unknown>),
  };
}

function normalizeLibraryRepoDefinition(repo: LibraryRepoDefinition | Record<string, unknown>): LibraryRepoDefinition {
  const id = normalizeRequiredString(repo.id, "Library repository id");
  const name = normalizeRequiredString(repo.name, "Library repository name");
  const repoRoot = normalizeAbsolutePath(repo.repoRoot, "Repository root");
  const rawDataRoot = typeof repo.dataRoot === "string" ? repo.dataRoot.trim() : "";
  const dataRoot = rawDataRoot ? normalizeAbsolutePath(rawDataRoot, "Content root") : undefined;
  const releaseBranch = normalizeOptionalString(repo.releaseBranch, "Release branch");

  const normalizedRepo: LibraryRepoDefinition = {
    id,
    name,
    repoRoot,
  };
  if (dataRoot) {
    normalizedRepo.dataRoot = dataRoot;
  }
  if (releaseBranch) {
    normalizedRepo.releaseBranch = releaseBranch;
  }

  return normalizedRepo;
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new GitHubSyncError("invalid_configuration", `${label} must be a string.`);
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new GitHubSyncError("invalid_configuration", `${label} is required.`);
  }

  return trimmedValue;
}

function normalizeAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new GitHubSyncError("invalid_configuration", `${label} must be a string.`);
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new GitHubSyncError("invalid_configuration", `${label} is required.`);
  }

  if (!path.isAbsolute(trimmedValue)) {
    throw new GitHubSyncError("invalid_configuration", `${label} must be an absolute path.`);
  }

  return path.resolve(trimmedValue);
}

function normalizeOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new GitHubSyncError("invalid_configuration", `${label} must be a string.`);
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : undefined;
}

function ensurePathInside(rootPath: string, candidatePath: string, label: string): void {
  if (!isSameOrInside(rootPath, candidatePath) || rootPath === candidatePath) {
    throw new GitHubSyncError(
      "invalid_configuration",
      `${label} '${candidatePath}' must stay inside repository root '${rootPath}'.`,
    );
  }
}

function isSameOrInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function isDirectoryPath(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFilePath(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isFile();
  } catch {
    return false;
  }
}

function buildConfiguredRepoName(repoRoot: string, remoteUrl?: string, remoteName?: string): string {
  const remoteSlug = parseRemoteRepositorySlug(remoteUrl) ?? readRepositoryRemoteSlug(repoRoot, remoteName);
  if (remoteSlug) {
    return remoteSlug;
  }

  return buildRepoRootFallbackName(repoRoot);
}

function buildResolvedRepoName(
  repoRoot: string,
  fallbackName: string,
  remoteUrl?: string,
  remoteName?: string,
): string {
  const remoteSlug = parseRemoteRepositorySlug(remoteUrl) ?? readRepositoryRemoteSlug(repoRoot, remoteName);
  return remoteSlug || fallbackName.trim() || buildRepoRootFallbackName(repoRoot);
}

function buildRepoRootFallbackName(repoRoot: string): string {
  const basename = path.basename(repoRoot);
  return basename && basename !== "." && basename !== path.parse(repoRoot).root && basename !== "workspace"
    ? basename
    : "Content repository";
}

function buildDiscoveredRepoId(repoRoot: string): string {
  return `discovered-${createHash("sha1").update(repoRoot).digest("hex").slice(0, 12)}`;
}

function compareRepoContextSummaries(left: RepoContextSummary, right: RepoContextSummary): number {
  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }

  const nameComparison = left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.repoRoot.localeCompare(right.repoRoot);
}

function resolveReleaseBranch(explicitReleaseBranch?: string, fallbackReleaseBranch?: string): string {
  return explicitReleaseBranch?.trim() || fallbackReleaseBranch?.trim() || "default";
}

function parseRemoteRepositorySlug(remoteUrl?: string): string | undefined {
  const trimmedUrl = remoteUrl?.trim();
  if (!trimmedUrl) {
    return undefined;
  }

  const remotePath = extractRemoteRepositoryPath(trimmedUrl);
  if (!remotePath) {
    return undefined;
  }

  const normalizedPath = remotePath.replace(/\.git$/i, "");
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments.length === 2 ? `${segments[0]}/${segments[1]}` : undefined;
}

function extractRemoteRepositoryPath(remoteUrl: string): string | undefined {
  const scpLikeMatch = remoteUrl.match(/^[^@]+@[^:]+:(.+)$/);
  if (scpLikeMatch?.[1]) {
    return scpLikeMatch[1];
  }

  try {
    return new URL(remoteUrl).pathname.replace(/^\/+/, "");
  } catch {
    return undefined;
  }
}

function readRepositoryRemoteSlug(repoRoot: string, remoteName?: string): string | undefined {
  const configPath = resolveGitConfigPath(repoRoot);
  if (!configPath) {
    return undefined;
  }

  try {
    const remoteSectionPattern = new RegExp(
      `\\[remote "${escapeRegExp(remoteName?.trim() || "origin")}"\\]([\\s\\S]*?)(?=\\n\\[|$)`,
    );
    const configContents = readFileSync(configPath, "utf8");
    const remoteSection = configContents.match(remoteSectionPattern)?.[1];
    const remoteUrl = remoteSection?.match(/^\s*url\s*=\s*(.+)\s*$/m)?.[1];
    return parseRemoteRepositorySlug(remoteUrl);
  } catch {
    return undefined;
  }
}

function resolveGitConfigPath(repoRoot: string): string | undefined {
  const gitDirPath = resolveGitDirPath(repoRoot);
  if (!gitDirPath) {
    return undefined;
  }

  try {
    const configPath = path.join(gitDirPath, "config");
    return statSync(configPath).isFile() ? configPath : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
