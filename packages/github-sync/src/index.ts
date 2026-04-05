import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  GitSyncChange,
  GitSyncCommitSummary,
  GitSyncOperationResponse,
  GitSyncPushRequest,
  GitSyncScheduleConfigureRequest,
  GitSyncScheduleResponse,
  GitSyncScheduleState,
  GitSyncStatus,
} from "@dacci/shared-types";

const execFileAsync = promisify(execFile);
const pullCleanWorkingTreeMessage = "Dacci sync pull requires a clean working tree. Push local changes before pulling.";
const syncCommittedContentOnlyMessage =
  "Dacci sync only supports content. Move non-content commits off this branch or publish them separately before syncing.";
const pullCommittedContentOnlyMessage =
  "Dacci sync pull only supports content. Move non-content commits off this branch or publish them separately before pulling.";
const pullLocalChangesAction = "Push local changes before pulling.";
const pullRemoteContentAction = "Pull remote content before pushing local content.";
const localNonContentPushAction =
  "Dacci sync push leaves non-content commits local. Publish them separately if you want them on the remote branch.";
const preparePullFromLocalNonContentAction = "Publish non-content commits separately before pulling remote content.";

export type GitHubSyncErrorCode = "command_failed" | "conflict" | "invalid_configuration";

export class GitHubSyncError extends Error {
  public constructor(
    public readonly code: GitHubSyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitHubSyncError";
  }
}

export function isGitHubSyncError(error: unknown): error is GitHubSyncError {
  return error instanceof GitHubSyncError;
}

export interface GitHubSyncOptions {
  repoRoot: string;
  contentRoot: string;
  remoteName?: string;
  remoteUrl?: string;
  releaseBranch?: string;
}

export interface GitHubSyncConfigurationValidation {
  repoRoot: string;
  contentRoot: string;
  contentPath: string;
  currentBranch: string;
}

type RepositoryContext = {
  repoRoot: string;
  contentRoot: string;
  contentPath: string;
  currentBranch: string;
  remoteName: string;
  configuredRemoteUrl?: string;
  configuredLocalRemotePaths?: string[];
  upstreamBranch?: string;
};

export class GitHubSync {
  private readonly configuredRepoRoot: string;
  private readonly configuredContentRoot: string;
  private readonly remoteName: string;
  private readonly remoteUrl: string | undefined;
  private readonly releaseBranch: string;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(options: GitHubSyncOptions) {
    this.configuredRepoRoot = path.resolve(options.repoRoot);
    this.configuredContentRoot = path.resolve(options.contentRoot);
    this.remoteName = options.remoteName ?? "origin";
    this.remoteUrl = options.remoteUrl?.trim() || undefined;
    this.releaseBranch = options.releaseBranch?.trim() || "default";
  }

  public async getStatus(options?: { refreshRemote?: boolean }): Promise<GitSyncStatus> {
    return this.enqueue(() => this.getStatusInternal(options));
  }

  public async validateConfiguration(): Promise<GitHubSyncConfigurationValidation> {
    const context = await this.getRepositoryContext();
    return {
      repoRoot: context.repoRoot,
      contentRoot: context.contentRoot,
      contentPath: context.contentPath,
      currentBranch: context.currentBranch,
    };
  }

  public async getGitPath(relativePath: string): Promise<string> {
    const gitPath = await this.readFirstLine(
      ["rev-parse", "--git-path", relativePath],
      this.configuredRepoRoot,
    );
    return path.resolve(this.configuredRepoRoot, gitPath);
  }

  public async pullContent(): Promise<GitSyncOperationResponse> {
    return this.enqueue(() => this.pullContentInternal());
  }

  public async pushContent(request: GitSyncPushRequest): Promise<GitSyncOperationResponse> {
    return this.enqueue(() => this.pushContentInternal(request));
  }

  private async getStatusInternal(options?: { refreshRemote?: boolean }): Promise<GitSyncStatus> {
    const context = await this.getRepositoryContext();

    if (options?.refreshRemote) {
      await this.fetchRemote(context);
    }

    const [aheadBehind, changedFiles, repoChangedFiles, hasRepoChanges, lastContentCommit, nonContentCommittedFiles] =
      await Promise.all([
      this.getAheadBehind(context),
      this.getChangedFiles(context),
      this.getRepoChangedFiles(context),
      this.hasRepoChanges(context),
      this.getLastContentCommit(context),
      this.getNonContentCommittedFiles(context),
    ]);
    const nonContentChangedFiles = repoChangedFiles.filter(
      (change) => !this.isPathInsideContent(context.contentPath, change.path),
    );
    const pullBlockers = this.buildPullBlockers(context, hasRepoChanges, nonContentCommittedFiles);
    const pushBlockers = this.buildPushBlockers(aheadBehind.behind, nonContentCommittedFiles);
    const recommendedActions = this.buildRecommendedActions(
      context,
      aheadBehind,
      hasRepoChanges,
      nonContentCommittedFiles,
      pullBlockers,
      pushBlockers,
    );
    const resolvedRemoteUrl = this.resolveEffectiveRemoteUrl(context) ?? context.configuredRemoteUrl;

    const status: GitSyncStatus = {
      repoRoot: context.repoRoot,
      contentRoot: context.contentRoot,
      contentPath: context.contentPath,
      currentBranch: context.currentBranch,
      releaseBranch: this.releaseBranch,
      isReleaseBranch: context.currentBranch === this.releaseBranch,
      remoteName: context.remoteName,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      hasContentChanges: changedFiles.length > 0,
      hasRepoChanges,
      changedFiles,
      nonContentChangedFiles,
      nonContentCommittedFiles,
      pullBlockers,
      pushBlockers,
      recommendedActions,
    };

    if (resolvedRemoteUrl) {
      status.remoteUrl = resolvedRemoteUrl;
    }

    if (context.upstreamBranch) {
      status.upstreamBranch = context.upstreamBranch;
    }

    if (lastContentCommit) {
      status.lastContentCommit = lastContentCommit;
    }

    return status;
  }

  private async pullContentInternal(): Promise<GitSyncOperationResponse> {
    const context = await this.getRepositoryContext();
    await this.ensureCleanWorkingTree(context);
    await this.ensureNoCommittedChangesOutsideContent(context);
    await this.fetchRemote(context);

    if (!context.upstreamBranch) {
      throw new GitHubSyncError(
        "invalid_configuration",
        `Branch '${context.currentBranch}' does not have an upstream branch configured.`,
      );
    }

    const beforeStatus = await this.getStatusInternal();
    if (beforeStatus.behind === 0) {
      return {
        action: "pull",
        summary: "Repository is already up to date with the configured upstream branch.",
        status: beforeStatus,
      };
    }

    await this.runGitWithRemoteRewrite(["pull", "--rebase", context.remoteName, context.currentBranch], context, {
      cwd: context.repoRoot,
      conflictMessage: "Pulling remote content produced a rebase conflict. Resolve it manually before retrying sync.",
    });

    const status = await this.getStatusInternal({ refreshRemote: false });
    return {
      action: "pull",
      summary: `Pulled remote changes from ${context.remoteName}/${context.currentBranch}.`,
      status,
    };
  }

  private async pushContentInternal(request: GitSyncPushRequest): Promise<GitSyncOperationResponse> {
    const commitMessage = request.message.trim();
    if (!commitMessage) {
      throw new GitHubSyncError("invalid_configuration", "A sync commit message is required.");
    }
    const commitIdentity = this.normalizeCommitIdentity(request);

    const context = await this.getRepositoryContext();
    await this.fetchRemote(context);
    const beforeStatus = await this.getStatusInternal();
    if (beforeStatus.behind > 0) {
      throw new GitHubSyncError(
        "conflict",
        "Remote content is ahead of the local branch. Pull remote changes before pushing local content.",
      );
    }

    if (beforeStatus.nonContentCommittedFiles.length > 0) {
      return this.pushContentWhileKeepingLocalNonContent(context, commitMessage, commitIdentity);
    }

    let commitSha: string | undefined;
    if (beforeStatus.hasContentChanges) {
      await this.runGit(["add", "-A", "--", context.contentPath], { cwd: context.repoRoot });
      if (await this.hasCachedContentChanges(context)) {
        await this.runGit(this.buildCommitArgs(["commit", "-m", commitMessage, "--only", "--", context.contentPath], commitIdentity), {
          cwd: context.repoRoot,
        });
        commitSha = await this.readFirstLine(["rev-parse", "HEAD"], context.repoRoot);
      }
    }

    const pushArgs = context.upstreamBranch
      ? ["push", context.remoteName, context.currentBranch]
      : ["push", "-u", context.remoteName, context.currentBranch];
    await this.runGitWithRemoteRewrite(pushArgs, context, {
      cwd: context.repoRoot,
      conflictMessage: "Pushing local content failed. Fetch and resolve remote branch issues before retrying sync.",
    });

    const status = await this.getStatusInternal({ refreshRemote: false });
    const response: GitSyncOperationResponse = {
      action: "push",
      summary: commitSha
        ? `Committed and pushed content changes to ${context.remoteName}/${context.currentBranch}.`
        : `Pushed existing local content commits to ${context.remoteName}/${context.currentBranch}.`,
      status,
    };

    if (commitSha) {
      response.commitSha = commitSha;
    }

    return response;
  }

  private async pushContentWhileKeepingLocalNonContent(
    context: RepositoryContext,
    commitMessage: string,
    commitIdentity: { commitAuthorName: string; commitAuthorEmail: string } | null,
  ): Promise<GitSyncOperationResponse> {
    if (!context.upstreamBranch) {
      throw new GitHubSyncError(
        "invalid_configuration",
        "Selective content push requires an upstream branch configured for the current branch.",
      );
    }

    const originalHead = await this.readFirstLine(["rev-parse", "HEAD"], context.repoRoot);
    const localCommitShas = await this.readLocalAheadCommitShas(context);
    const stagedNonContentPatch = await this.readStdout(
      ["diff", "--binary", "--cached", "HEAD", ...this.buildNonContentPathspec(context.contentPath)],
      context.repoRoot,
    );
    const unstagedNonContentPatch = await this.readStdout(
      ["diff", "--binary", ...this.buildNonContentPathspec(context.contentPath)],
      context.repoRoot,
    );
    const backupRef = `refs/dacci-sync-backup/${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    await this.runGit(["update-ref", backupRef, originalHead], {
      cwd: context.repoRoot,
    });

    let removeBackupRef = false;
    try {
      const contentCommitSha = await this.createContentOnlyPushCommit(context, commitMessage, commitIdentity);
      if (!contentCommitSha) {
        const status = await this.getStatusInternal({ refreshRemote: false });
        removeBackupRef = true;
        return {
          action: "push",
          summary: "No content changes were available to push. Non-content changes were left local.",
          status,
        };
      }

      await this.runGitWithRemoteRewrite(
        ["push", context.remoteName, `${contentCommitSha}:refs/heads/${context.currentBranch}`],
        context,
        {
          cwd: context.repoRoot,
          conflictMessage: "Pushing local content failed. Fetch and resolve remote branch issues before retrying sync.",
        },
      );
      await this.fetchRemote(context);
      await this.runGit(["reset", "--hard", contentCommitSha], {
        cwd: context.repoRoot,
        conflictMessage: "Resetting the local branch after a content-only push failed.",
      });
      await this.replayLocalNonContentCommits(context, localCommitShas, commitIdentity);
      await this.applyPatchIfPresent(context.repoRoot, stagedNonContentPatch, {
        applyToIndex: true,
        conflictMessage: "Restoring staged non-content changes after a content-only push failed.",
      });
      await this.applyPatchIfPresent(context.repoRoot, unstagedNonContentPatch, {
        applyToIndex: false,
        conflictMessage: "Restoring non-content working tree changes after a content-only push failed.",
      });

      const status = await this.getStatusInternal({ refreshRemote: false });
      removeBackupRef = true;
      const response: GitSyncOperationResponse = {
        action: "push",
        summary: `Pushed content changes to ${context.remoteName}/${context.currentBranch} while leaving non-content changes local.`,
        status,
        commitSha: contentCommitSha,
      };
      return response;
    } finally {
      if (removeBackupRef) {
        try {
          await this.runGit(["update-ref", "-d", backupRef], {
            cwd: context.repoRoot,
          });
        } catch {
          // Best effort cleanup for a temporary recovery ref.
        }
      }
    }
  }

  private async createContentOnlyPushCommit(
    context: RepositoryContext,
    commitMessage: string,
    commitIdentity: { commitAuthorName: string; commitAuthorEmail: string } | null,
  ): Promise<string | null> {
    if (!context.upstreamBranch) {
      throw new GitHubSyncError(
        "invalid_configuration",
        "Selective content push requires an upstream branch configured for the current branch.",
      );
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-sync-push-"));
    const tempWorktree = path.join(tempRoot, "repo");

    try {
      await this.runGit(["worktree", "add", "--detach", tempWorktree, context.upstreamBranch], {
        cwd: context.repoRoot,
      });
      await this.replaceDirectorySnapshot(context.contentRoot, path.join(tempWorktree, context.contentPath));

      const contentStatus = await this.readStdout(
        ["status", "--porcelain", "--untracked-files=all", "--", context.contentPath],
        tempWorktree,
      );
      if (!contentStatus.trim()) {
        return null;
      }

      await this.runGit(["add", "-A", "--", context.contentPath], {
        cwd: tempWorktree,
      });
      await this.runGit(this.buildCommitArgs(["commit", "-m", commitMessage, "--only", "--", context.contentPath], commitIdentity), {
        cwd: tempWorktree,
        conflictMessage: "Creating a content-only sync commit failed.",
      });
      return await this.readFirstLine(["rev-parse", "HEAD"], tempWorktree);
    } finally {
      try {
        await this.runGit(["worktree", "remove", "--force", tempWorktree], {
          cwd: context.repoRoot,
        });
      } catch {
        // Best effort cleanup for a temporary worktree.
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async replayLocalNonContentCommits(
    context: RepositoryContext,
    localCommitShas: string[],
    commitIdentity: { commitAuthorName: string; commitAuthorEmail: string } | null,
  ): Promise<void> {
    for (const commitSha of localCommitShas) {
      const patch = await this.readStdout(
        ["show", "--binary", "--format=", commitSha, ...this.buildNonContentPathspec(context.contentPath)],
        context.repoRoot,
      );
      if (!patch.trim()) {
        continue;
      }

      await this.applyPatchIfPresent(context.repoRoot, patch, {
        applyToIndex: true,
        conflictMessage: "Replaying local non-content commits after a content-only push failed.",
      });
      await this.runGit(this.buildCommitArgs(["commit", "--reuse-message", commitSha], commitIdentity), {
        cwd: context.repoRoot,
        conflictMessage: "Recreating a local non-content commit after a content-only push failed.",
      });
    }
  }

  private async readLocalAheadCommitShas(context: RepositoryContext): Promise<string[]> {
    if (!context.upstreamBranch) {
      return [];
    }

    const output = await this.readStdout(["rev-list", "--reverse", `${context.upstreamBranch}..HEAD`], context.repoRoot);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private buildNonContentPathspec(contentPath: string): string[] {
    return ["--", ".", `:(exclude)${contentPath}`];
  }

  private normalizeCommitIdentity(
    request: GitSyncPushRequest,
  ): { commitAuthorName: string; commitAuthorEmail: string } | null {
    const commitAuthorName = request.commitAuthorName?.trim() ?? "";
    const commitAuthorEmail = request.commitAuthorEmail?.trim() ?? "";

    if (!commitAuthorName && !commitAuthorEmail) {
      return null;
    }

    if (!commitAuthorName || !commitAuthorEmail) {
      throw new GitHubSyncError(
        "invalid_configuration",
        "Sync commit identity requires both commitAuthorName and commitAuthorEmail when either value is provided.",
      );
    }

    return {
      commitAuthorName,
      commitAuthorEmail,
    };
  }

  private buildCommitArgs(
    args: string[],
    commitIdentity: { commitAuthorName: string; commitAuthorEmail: string } | null,
  ): string[] {
    if (!commitIdentity) {
      return args;
    }

    return [
      "-c",
      `user.name=${commitIdentity.commitAuthorName}`,
      "-c",
      `user.email=${commitIdentity.commitAuthorEmail}`,
      ...args,
    ];
  }

  private async applyPatchIfPresent(
    cwd: string,
    patch: string,
    options: {
      applyToIndex: boolean;
      conflictMessage: string;
    },
  ): Promise<void> {
    if (!patch.trim()) {
      return;
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-sync-patch-"));
    const patchPath = path.join(tempRoot, "changes.patch");
    try {
      await writeFile(patchPath, patch.endsWith("\n") ? patch : `${patch}\n`, "utf8");
      const args = ["apply"];
      if (options.applyToIndex) {
        args.push("--index");
      }
      args.push("--whitespace=nowarn", patchPath);
      await this.runGit(args, {
        cwd,
        conflictMessage: options.conflictMessage,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async replaceDirectorySnapshot(sourcePath: string, targetPath: string): Promise<void> {
    await rm(targetPath, { recursive: true, force: true });
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
  }

  private async getRepositoryContext(): Promise<RepositoryContext> {
    await Promise.all([
      this.ensureDirectoryExists(this.configuredRepoRoot, "Git sync repository root"),
      this.ensureDirectoryExists(this.configuredContentRoot, "Content root"),
    ]);

    const repoRoot = await this.readRepositoryRoot();
    const currentBranch = await this.readFirstLine(["branch", "--show-current"], this.configuredRepoRoot);
    if (!currentBranch) {
      throw new GitHubSyncError(
        "invalid_configuration",
        "GitHub sync requires a named branch. Detached HEAD checkouts are not supported.",
      );
    }

    const contentRoot = this.configuredContentRoot;
    const contentPath = path.relative(repoRoot, contentRoot);
    if (!contentPath || contentPath.startsWith("..") || path.isAbsolute(contentPath)) {
      throw new GitHubSyncError(
        "invalid_configuration",
        `Content root '${contentRoot}' must be located inside repository '${repoRoot}'.`,
      );
    }

    const upstreamBranch = await this.tryReadFirstLine(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      this.configuredRepoRoot,
    );
    const configuredRemoteUrl = await this.tryReadFirstLine(
      ["remote", "get-url", this.remoteName],
      this.configuredRepoRoot,
    );

    const repositoryContext: RepositoryContext = {
      repoRoot,
      contentRoot,
      contentPath: this.toGitPath(contentPath),
      currentBranch,
      remoteName: this.remoteName,
    };
    if (configuredRemoteUrl) {
      repositoryContext.configuredRemoteUrl = configuredRemoteUrl;
      const configuredLocalRemotePaths = resolveLocalRemoteSafeDirectories(configuredRemoteUrl, repoRoot);
      if (configuredLocalRemotePaths.length > 0) {
        repositoryContext.configuredLocalRemotePaths = configuredLocalRemotePaths;
      }
    }

    if (upstreamBranch) {
      repositoryContext.upstreamBranch = upstreamBranch;
    }

    return repositoryContext;
  }

  private async ensureDirectoryExists(directoryPath: string, label: string): Promise<void> {
    let stats;
    try {
      stats = await stat(directoryPath);
    } catch {
      throw new GitHubSyncError(
        "invalid_configuration",
        `${label} '${directoryPath}' does not exist or is not accessible.`,
      );
    }

    if (!stats.isDirectory()) {
      throw new GitHubSyncError(
        "invalid_configuration",
        `${label} '${directoryPath}' must be a directory.`,
      );
    }
  }

  private async readRepositoryRoot(): Promise<string> {
    try {
      return await this.readFirstLine(["rev-parse", "--show-toplevel"], this.configuredRepoRoot);
    } catch (error) {
      if (isGitHubSyncError(error) && error.code === "command_failed") {
        throw new GitHubSyncError(
          "invalid_configuration",
          `Configured Git sync repository root '${this.configuredRepoRoot}' is not a Git repository.`,
        );
      }

      throw error;
    }
  }

  private async getAheadBehind(context: RepositoryContext): Promise<{ ahead: number; behind: number }> {
    if (!context.upstreamBranch) {
      return { ahead: 0, behind: 0 };
    }

    const output = await this.readFirstLine(
      ["rev-list", "--left-right", "--count", `${context.upstreamBranch}...HEAD`],
      context.repoRoot,
    );
    const [behind, ahead] = output
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));

    return {
      ahead: Number.isFinite(ahead) ? (ahead ?? 0) : 0,
      behind: Number.isFinite(behind) ? (behind ?? 0) : 0,
    };
  }

  private async getChangedFiles(context: RepositoryContext): Promise<GitSyncChange[]> {
    const output = await this.readStdout(
      ["status", "--porcelain", "--untracked-files=all", "--", context.contentPath],
      context.repoRoot,
    );

    return output
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => this.parseStatusLine(line));
  }

  private async getRepoChangedFiles(context: RepositoryContext): Promise<GitSyncChange[]> {
    const output = await this.readStdout(
      ["status", "--porcelain", "--untracked-files=all"],
      context.repoRoot,
    );

    return output
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => this.parseStatusLine(line));
  }

  private async hasRepoChanges(context: RepositoryContext): Promise<boolean> {
    const output = await this.readStdout(["status", "--porcelain", "--untracked-files=all"], context.repoRoot);
    return output.trim().length > 0;
  }

  private async getLastContentCommit(
    context: RepositoryContext,
  ): Promise<GitSyncCommitSummary | null> {
    const output = await this.tryReadStdout(
      ["log", "-1", "--format=%H%x1f%s%x1f%cI", "--", context.contentPath],
      context.repoRoot,
    );
    if (!output) {
      return null;
    }

    const [sha, message, committedAt] = output.trim().split("\u001f");
    if (!sha || !message || !committedAt) {
      return null;
    }

    return {
      sha,
      message,
      committedAt,
    };
  }

  private async getNonContentCommittedFiles(context: RepositoryContext): Promise<string[]> {
    if (!context.upstreamBranch) {
      return [];
    }

    const output = await this.readStdout(
      ["diff", "--name-only", `${context.upstreamBranch}..HEAD`],
      context.repoRoot,
    );

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((changedPath) => !this.isPathInsideContent(context.contentPath, changedPath));
  }

  private async fetchRemote(context: RepositoryContext): Promise<void> {
    await this.runGitWithRemoteRewrite(["fetch", "--quiet", context.remoteName], context, {
      cwd: context.repoRoot,
      conflictMessage: `Fetching from remote '${context.remoteName}' failed.`,
    });
  }

  private async ensureCleanWorkingTree(context: RepositoryContext): Promise<void> {
    const output = await this.readStdout(["status", "--porcelain", "--untracked-files=all"], context.repoRoot);
    if (output.trim().length > 0) {
      throw new GitHubSyncError("conflict", pullCleanWorkingTreeMessage);
    }
  }

  private async ensureNoCommittedChangesOutsideContent(context: RepositoryContext): Promise<void> {
    const outsideChanges = await this.getNonContentCommittedFiles(context);

    if (outsideChanges.length > 0) {
      throw new GitHubSyncError("conflict", syncCommittedContentOnlyMessage);
    }
  }

  private buildPullBlockers(
    context: RepositoryContext,
    hasRepoChanges: boolean,
    nonContentCommittedFiles: string[],
  ): string[] {
    const blockers: string[] = [];

    if (!context.upstreamBranch) {
      blockers.push(`Branch '${context.currentBranch}' does not have an upstream branch configured.`);
    }

    if (hasRepoChanges) {
      blockers.push(pullCleanWorkingTreeMessage);
    }

    if (nonContentCommittedFiles.length > 0) {
      blockers.push(pullCommittedContentOnlyMessage);
    }

    return blockers;
  }

  private buildPushBlockers(
    behind: number,
    nonContentCommittedFiles: string[],
  ): string[] {
    const blockers: string[] = [];

    if (behind > 0) {
      blockers.push("Remote content is ahead of the local branch. Pull remote changes before pushing local content.");
    }

    return blockers;
  }

  private buildRecommendedActions(
    context: RepositoryContext,
    aheadBehind: { ahead: number; behind: number },
    hasRepoChanges: boolean,
    nonContentCommittedFiles: string[],
    pullBlockers: string[],
    pushBlockers: string[],
  ): string[] {
    const actions: string[] = [];

    if (context.currentBranch !== this.releaseBranch) {
      actions.push(
        `Switch to '${this.releaseBranch}' before running Dacci sync operations for the shared baseline.`,
      );
    }

    if (!context.upstreamBranch) {
      actions.push(
        `Set an upstream branch for '${context.currentBranch}' if you want pull status against a remote branch.`,
      );
    }

    if (hasRepoChanges) {
      actions.push(pullLocalChangesAction);
    }

    if (aheadBehind.behind > 0) {
      actions.push(pullRemoteContentAction);
    }

    if (nonContentCommittedFiles.length > 0) {
      actions.push(localNonContentPushAction);
      actions.push(preparePullFromLocalNonContentAction);
    }

    if (!hasRepoChanges && pullBlockers.length === 0 && pushBlockers.length === 0) {
      actions.push("No sync action is required right now.");
    }

    return [...new Set(actions)];
  }

  private async hasCachedContentChanges(context: RepositoryContext): Promise<boolean> {
    return this.commandExitsWithOne(
      ["diff", "--cached", "--quiet", "--", context.contentPath],
      context.repoRoot,
    );
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pendingOperation = this.operationQueue.then(operation, operation);
    this.operationQueue = pendingOperation.then(
      () => undefined,
      () => undefined,
    );
    return pendingOperation;
  }

  private async commandExitsWithOne(args: string[], cwd: string): Promise<boolean> {
    const { env, cleanup } = await this.prepareGitEnvironment(cwd);
    try {
      await execFileAsync("git", this.withSafeDirectories(args, cwd), {
        cwd,
        env,
        maxBuffer: 10 * 1024 * 1024,
      });
      return false;
    } catch (error) {
      const exitCode = this.readExitCode(error);
      if (exitCode === 1) {
        return true;
      }

      throw this.buildCommandError(args, error);
    } finally {
      await cleanup();
    }
  }

  private async readStdout(args: string[], cwd: string): Promise<string> {
    const result = await this.runGit(args, { cwd });
    return result.stdout.trimEnd();
  }

  private async tryReadStdout(args: string[], cwd: string): Promise<string | null> {
    try {
      return await this.readStdout(args, cwd);
    } catch (error) {
      if (error instanceof GitHubSyncError && error.code === "command_failed") {
        return null;
      }

      throw error;
    }
  }

  private async readFirstLine(args: string[], cwd: string): Promise<string> {
    const output = await this.readStdout(args, cwd);
    return output.split("\n")[0] ?? "";
  }

  private async tryReadFirstLine(args: string[], cwd: string): Promise<string | null> {
    const output = await this.tryReadStdout(args, cwd);
    if (output === null) {
      return null;
    }

    return output.split("\n")[0] ?? "";
  }

  private async runGit(
    args: string[],
    options: {
      cwd: string;
      conflictMessage?: string;
      safeDirectories?: string[];
    },
  ): Promise<{ stdout: string; stderr: string }> {
    const { env, cleanup } = await this.prepareGitEnvironment(options.cwd, options.safeDirectories);
    try {
      return await execFileAsync("git", this.withSafeDirectories(args, options.cwd, options.safeDirectories), {
        cwd: options.cwd,
        env,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      const message = options.conflictMessage ?? undefined;
      throw this.buildCommandError(args, error, message);
    } finally {
      await cleanup();
    }
  }

  private async runGitWithRemoteRewrite(
    args: string[],
    context: RepositoryContext,
    options: {
      cwd: string;
      conflictMessage?: string;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    const configuredRemoteUrl = context.configuredRemoteUrl?.trim();
    const safeDirectories = [...(context.configuredLocalRemotePaths ?? [])];
    const effectiveRemoteUrl = this.resolveEffectiveRemoteUrl(context);
    const overrideLocalRemotePaths = effectiveRemoteUrl
      ? resolveLocalRemoteSafeDirectories(effectiveRemoteUrl, context.repoRoot)
      : [];
    if (overrideLocalRemotePaths.length > 0) {
      safeDirectories.push(...overrideLocalRemotePaths);
    }
    if (!effectiveRemoteUrl || !configuredRemoteUrl || configuredRemoteUrl === effectiveRemoteUrl) {
      return this.runGit(args, {
        ...options,
        safeDirectories,
      });
    }

    const { env, cleanup } = await this.prepareGitEnvironment(options.cwd, safeDirectories);
    try {
      return await execFileAsync(
        "git",
        this.withSafeDirectories(
          [
          "-c",
          `url.${effectiveRemoteUrl}.insteadOf=${configuredRemoteUrl}`,
          "-c",
          `url.${effectiveRemoteUrl}.pushInsteadOf=${configuredRemoteUrl}`,
          ...args,
          ],
          options.cwd,
          safeDirectories,
        ),
        {
          cwd: options.cwd,
          env,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    } catch (error) {
      const message = options.conflictMessage ?? undefined;
      throw this.buildCommandError(args, error, message);
    } finally {
      await cleanup();
    }
  }

  private withSafeDirectories(args: string[], cwd: string, extraSafeDirectories?: string[]): string[] {
    const safeDirectories = [...new Set([path.resolve(cwd), ...(extraSafeDirectories ?? [])])];
    return [...safeDirectories.flatMap((entry) => ["-c", `safe.directory=${entry}`]), ...args];
  }

  private async prepareGitEnvironment(
    cwd: string,
    extraSafeDirectories?: string[],
  ): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    };
    const safeDirectories = [...new Set([path.resolve(cwd), ...(extraSafeDirectories ?? [])])];
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "dacci-git-safe-"));
    const configPath = path.join(tempDirectory, "gitconfig");
    const existingGlobalConfigs = await this.readExistingGlobalGitConfigPaths(env);
    const configLines: string[] = [];

    for (const configEntry of existingGlobalConfigs) {
      configLines.push("[include]");
      configLines.push(`\tpath = ${quoteGitConfigValue(configEntry)}`);
    }

    configLines.push("[safe]");
    for (const entry of safeDirectories) {
      configLines.push(`\tdirectory = ${quoteGitConfigValue(entry)}`);
    }

    await writeFile(configPath, `${configLines.join("\n")}\n`, "utf8");
    env.GIT_CONFIG_GLOBAL = configPath;
    const cleanupTasks: Array<() => Promise<void>> = [
      async () => {
        await rm(tempDirectory, { recursive: true, force: true });
      },
    ];

    return {
      env,
      cleanup: async () => {
        for (const cleanupTask of cleanupTasks.reverse()) {
          await cleanupTask();
        }
      },
    };
  }

  private async readExistingGlobalGitConfigPaths(env: NodeJS.ProcessEnv): Promise<string[]> {
    const homeDirectory = env.HOME?.trim();
    const candidatePaths = new Set<string>();
    if (env.GIT_CONFIG_GLOBAL?.trim()) {
      candidatePaths.add(path.resolve(env.GIT_CONFIG_GLOBAL));
    } else if (homeDirectory) {
      candidatePaths.add(path.join(homeDirectory, ".gitconfig"));
      candidatePaths.add(path.join(env.XDG_CONFIG_HOME?.trim() || path.join(homeDirectory, ".config"), "git", "config"));
    }

    const existingPaths: string[] = [];
    for (const candidatePath of candidatePaths) {
      try {
        const stats = await stat(candidatePath);
        if (stats.isFile()) {
          existingPaths.push(candidatePath);
        }
      } catch {
        continue;
      }
    }

    return existingPaths;
  }

  private buildCommandError(
    args: string[],
    error: unknown,
    conflictMessage?: string,
  ): GitHubSyncError {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const message = stderr || `Git command failed: git ${args.join(" ")}`;

    if (
      conflictMessage &&
      (message.includes("CONFLICT") ||
        message.includes("could not apply") ||
        message.includes("non-fast-forward") ||
        message.includes("fetch first"))
    ) {
      return new GitHubSyncError("conflict", conflictMessage);
    }

    return new GitHubSyncError("command_failed", message);
  }

  private readExitCode(error: unknown): number | null {
    if (typeof error === "object" && error !== null && "code" in error) {
      const { code } = error as { code?: unknown };
      if (typeof code === "number") {
        return code;
      }
    }

    return null;
  }

  private isPathInsideContent(contentPath: string, candidatePath: string): boolean {
    const normalizedCandidate = this.toGitPath(candidatePath.replace(/^"+|"+$/g, ""));
    return normalizedCandidate === contentPath || normalizedCandidate.startsWith(`${contentPath}/`);
  }

  private parseStatusLine(line: string): GitSyncChange {
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    const rawPath = line.slice(3).trim();
    const normalizedPath = rawPath.includes(" -> ")
      ? rawPath.split(" -> ").at(-1) ?? rawPath
      : rawPath;

    return {
      path: normalizedPath,
      indexStatus,
      worktreeStatus,
    };
  }

  private toGitPath(targetPath: string): string {
    return targetPath.split(path.sep).join(path.posix.sep);
  }

  private resolveEffectiveRemoteUrl(_context: RepositoryContext): string | undefined {
    return this.remoteUrl;
  }
}

function resolveLocalRemoteSafeDirectories(remoteUrl: string, repoRoot: string): string[] {
  const trimmedValue = remoteUrl.trim();
  if (!trimmedValue) {
    return [];
  }

  if (trimmedValue.startsWith("file://")) {
    try {
      return [path.resolve(fileURLToPath(trimmedValue))];
    } catch {
      return [];
    }
  }

  if (/^[A-Za-z]:[\\/]/.test(trimmedValue) || trimmedValue.startsWith("\\\\") || trimmedValue.startsWith("/")) {
    return [path.resolve(trimmedValue)];
  }

  if (/^[^@]+@[^:]+:.+/.test(trimmedValue) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmedValue)) {
    return [];
  }

  return [trimmedValue, path.resolve(repoRoot, trimmedValue)];
}

function quoteGitConfigValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface GitHubSyncSchedulerLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface GitHubSyncSchedulerOptions {
  defaultIntervalMinutes?: number;
  logger?: GitHubSyncSchedulerLogger;
  maxBackoffMultiplier?: number;
  maxConsecutiveFailuresBeforePause?: number;
  releaseBranch?: string;
  stateFileName?: string;
}

const defaultSchedulerIntervalMinutes = 15;
const defaultMaxBackoffMultiplier = 8;
const defaultMaxConsecutiveFailuresBeforePause = 3;
const scheduleStateFileName = "dacci-sync-schedule.json";

export class GitHubSyncScheduler {
  private readonly logger: GitHubSyncSchedulerLogger | undefined;
  private readonly defaultIntervalMinutes: number;
  private readonly maxBackoffMultiplier: number;
  private readonly maxConsecutiveFailuresBeforePause: number;
  private readonly releaseBranch: string | undefined;
  private readonly stateFileName: string;
  private readonly gitSync: GitHubSync;

  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private loadingStatePromise: Promise<void> | null = null;
  private storagePath: string | null = null;
  private state: GitSyncScheduleState;
  private runningCycle = false;

  public constructor(gitSync: GitHubSync, options: GitHubSyncSchedulerOptions = {}) {
    this.gitSync = gitSync;
    this.logger = options.logger;
    this.defaultIntervalMinutes = normalizeSchedulerIntervalMinutes(
      options.defaultIntervalMinutes ?? defaultSchedulerIntervalMinutes,
    );
    this.maxBackoffMultiplier = Math.max(
      1,
      Math.floor(options.maxBackoffMultiplier ?? defaultMaxBackoffMultiplier),
    );
    this.maxConsecutiveFailuresBeforePause = Math.max(
      1,
      Math.floor(
        options.maxConsecutiveFailuresBeforePause ?? defaultMaxConsecutiveFailuresBeforePause,
      ),
    );
    this.releaseBranch = normalizeOptionalScheduleString(options.releaseBranch);
    this.stateFileName = normalizeScheduleStateFileName(options.stateFileName ?? scheduleStateFileName);
    this.state = createDefaultScheduleState(this.defaultIntervalMinutes, this.releaseBranch);
  }

  public async start(): Promise<void> {
    this.started = true;

    try {
      await this.ensureStateLoaded();
      if (this.state.enabled && !this.state.paused) {
        this.scheduleNextRun();
      }
    } catch (error) {
      this.logError(`Background sync scheduler could not start cleanly: ${toErrorMessage(error)}`);
    }
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.clearTimer();
    try {
      await this.ensureStateLoaded();
      await this.persistState();
    } catch {
      // Avoid turning app shutdown into a fatal error when sync was never usable.
    }
  }

  public async getStatus(options?: { refreshRemote?: boolean }): Promise<GitSyncStatus> {
    await this.ensureStateLoaded();
    const status = await this.gitSync.getStatus(options);
    return this.attachSchedulerState(status);
  }

  public async pullContent(): Promise<GitSyncOperationResponse> {
    await this.ensureStateLoaded();
    const response = await this.gitSync.pullContent();
    await this.bumpNextRunAfterManualSync();
    return {
      ...response,
      status: this.attachSchedulerState(response.status),
    };
  }

  public async pushContent(request: GitSyncPushRequest): Promise<GitSyncOperationResponse> {
    await this.ensureStateLoaded();
    const response = await this.gitSync.pushContent(request);
    await this.bumpNextRunAfterManualSync();
    return {
      ...response,
      status: this.attachSchedulerState(response.status),
    };
  }

  public async configureSchedule(
    request: GitSyncScheduleConfigureRequest,
  ): Promise<GitSyncScheduleResponse> {
    await this.ensureStateLoaded();

    if (request.enabled === undefined && request.intervalMinutes === undefined) {
      throw new GitHubSyncError(
        "invalid_configuration",
        "Background sync configuration requires an enabled state or interval.",
      );
    }

    if (request.enabled !== undefined) {
      this.state.enabled = request.enabled;
      if (!request.enabled) {
        this.state.paused = false;
        delete this.state.pauseReason;
        delete this.state.nextRunAt;
      }
    }

    if (request.intervalMinutes !== undefined) {
      this.state.intervalMinutes = normalizeSchedulerIntervalMinutes(request.intervalMinutes);
    }

    if (this.state.enabled) {
      this.state.paused = false;
      delete this.state.pauseReason;
      this.state.consecutiveFailures = 0;
      delete this.state.lastError;
      if (this.started) {
        this.scheduleNextRun();
      } else {
        delete this.state.nextRunAt;
      }
    } else {
      this.clearTimer();
      delete this.state.nextRunAt;
    }

    await this.persistState();
    const status = await this.getStatus({ refreshRemote: false });
    return {
      action: "configure",
      summary: this.state.enabled
        ? `Background sync enabled on a ${this.state.intervalMinutes}-minute interval.`
        : "Background sync disabled.",
      status,
    };
  }

  public async pauseSchedule(reason = "Background sync paused by operator."): Promise<GitSyncScheduleResponse> {
    await this.ensureStateLoaded();
    this.clearTimer();
    this.state.paused = true;
    this.state.pauseReason = reason;
    this.state.lastError = reason;
    delete this.state.nextRunAt;
    await this.persistState();
    const status = await this.getStatus({ refreshRemote: false });
    return {
      action: "pause",
      summary: reason,
      status,
    };
  }

  public async resumeSchedule(): Promise<GitSyncScheduleResponse> {
    await this.ensureStateLoaded();

    if (!this.state.enabled) {
      throw new GitHubSyncError(
        "invalid_configuration",
        "Background sync is disabled. Enable it before resuming scheduled pulls.",
      );
    }

    this.state.paused = false;
    delete this.state.pauseReason;
    delete this.state.lastError;
    this.state.consecutiveFailures = 0;
    if (this.started) {
      this.scheduleNextRun();
    } else {
      delete this.state.nextRunAt;
    }
    await this.persistState();
    const status = await this.getStatus({ refreshRemote: false });
    return {
      action: "resume",
      summary: "Background sync resumed.",
      status,
    };
  }

  public async runScheduledCycleNow(): Promise<GitSyncStatus> {
    await this.ensureStateLoaded();
    await this.runScheduledCycle();
    return this.getStatus({ refreshRemote: false });
  }

  private async ensureStateLoaded(): Promise<void> {
    if (this.storagePath) {
      return;
    }

    if (!this.loadingStatePromise) {
      this.loadingStatePromise = this.loadState().finally(() => {
        this.loadingStatePromise = null;
      });
    }

    await this.loadingStatePromise;
  }

  private async loadState(): Promise<void> {
    this.storagePath = await this.gitSync.getGitPath(path.posix.join("info", this.stateFileName));

    try {
      const rawValue = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(rawValue) as unknown;
      // Persisted scheduler state may be stale or hand-edited; normalize it before reuse.
      this.state = sanitizeScheduleState(parsed, this.defaultIntervalMinutes, this.releaseBranch);
    } catch (error) {
      if (isMissingFileError(error)) {
        this.state = createDefaultScheduleState(this.defaultIntervalMinutes, this.releaseBranch);
        return;
      }

      this.logError(`Ignoring invalid persisted background sync state: ${toErrorMessage(error)}`);
      this.state = createDefaultScheduleState(this.defaultIntervalMinutes, this.releaseBranch);
    }
  }

  private async persistState(): Promise<void> {
    if (!this.storagePath) {
      return;
    }

    await mkdir(path.dirname(this.storagePath), { recursive: true });
    await writeFile(this.storagePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  private attachSchedulerState(status: GitSyncStatus): GitSyncStatus {
    return {
      ...status,
      scheduler: {
        ...this.state,
      },
    };
  }

  private async bumpNextRunAfterManualSync(): Promise<void> {
    if (!this.state.enabled || this.state.paused) {
      return;
    }

    this.state.consecutiveFailures = 0;
    delete this.state.lastError;
    if (this.started) {
      this.scheduleNextRun();
    } else {
      delete this.state.nextRunAt;
    }
    await this.persistState();
  }

  private async runScheduledCycle(): Promise<void> {
    if (this.runningCycle) {
      return;
    }

    this.runningCycle = true;
    this.clearTimer();

    let nextRunMultiplier = 1;

    try {
      if (!this.state.enabled || this.state.paused) {
        delete this.state.nextRunAt;
        return;
      }

      this.state.lastRunAt = new Date().toISOString();
      const status = await this.gitSync.getStatus({ refreshRemote: true });
      this.state.lastStatusCheckAt = new Date().toISOString();

      if (status.behind > 0) {
        if (status.pullBlockers.length > 0) {
          this.pauseWithReason(status.pullBlockers[0] ?? "Background sync paused due to pull blockers.");
          this.logWarn(this.state.pauseReason ?? "Background sync paused.");
        } else {
          const result = await this.gitSync.pullContent();
          this.state.lastPullAt = new Date().toISOString();
          this.clearFailureState();
          this.logInfo(result.summary);
        }
      } else {
        this.clearFailureState();
      }
    } catch (error) {
      const message = toErrorMessage(error);
      this.state.lastError = message;
      this.state.consecutiveFailures += 1;

      if (
        isGitHubSyncError(error) &&
        (error.code === "conflict" || error.code === "invalid_configuration")
      ) {
        // Conflicts and invalid configuration need operator action, so retries only create noise.
        this.pauseWithReason(message);
        this.logWarn(message);
      } else if (this.state.consecutiveFailures >= this.maxConsecutiveFailuresBeforePause) {
        const pauseReason = `Background sync paused after ${this.state.consecutiveFailures} failed runs: ${message}`;
        this.pauseWithReason(pauseReason);
        this.logWarn(pauseReason);
      } else {
        nextRunMultiplier = Math.min(
          this.maxBackoffMultiplier,
          2 ** this.state.consecutiveFailures,
        );
        this.logWarn(
          `Background sync run failed (${this.state.consecutiveFailures}). Retrying with backoff: ${message}`,
        );
      }
    } finally {
      if (this.state.enabled && !this.state.paused && this.started) {
        this.scheduleNextRun(nextRunMultiplier);
      } else {
        delete this.state.nextRunAt;
      }

      await this.persistState();
      this.runningCycle = false;
    }
  }

  private clearFailureState(): void {
    this.state.consecutiveFailures = 0;
    delete this.state.lastError;
  }

  private pauseWithReason(reason: string): void {
    this.clearTimer();
    this.state.paused = true;
    this.state.pauseReason = reason;
    // lastError mirrors the pause reason so callers can surface one actionable failure field.
    this.state.lastError = reason;
    delete this.state.nextRunAt;
  }

  private scheduleNextRun(multiplier = 1): void {
    this.clearTimer();
    const delayMs = Math.max(60_000, this.state.intervalMinutes * 60_000 * multiplier);
    this.state.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      void this.runScheduledCycle();
    }, delayMs);

    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private logInfo(message: string): void {
    this.logger?.info?.(message);
  }

  private logWarn(message: string): void {
    this.logger?.warn?.(message);
  }

  private logError(message: string): void {
    if (this.logger?.error) {
      this.logger.error(message);
      return;
    }

    this.logger?.warn?.(message);
  }
}

function createDefaultScheduleState(
  intervalMinutes: number,
  releaseBranch?: string,
): GitSyncScheduleState {
  const state: GitSyncScheduleState = {
    enabled: false,
    paused: false,
    intervalMinutes,
    consecutiveFailures: 0,
  };
  if (releaseBranch) {
    state.releaseBranch = releaseBranch;
  }
  return state;
}

function sanitizeScheduleState(
  rawValue: unknown,
  defaultIntervalMinutes: number,
  releaseBranch?: string,
): GitSyncScheduleState {
  if (!rawValue || typeof rawValue !== "object") {
    return createDefaultScheduleState(defaultIntervalMinutes, releaseBranch);
  }

  const record = rawValue as Record<string, unknown>;
  const state = createDefaultScheduleState(defaultIntervalMinutes, releaseBranch);

  if (typeof record.enabled === "boolean") {
    state.enabled = record.enabled;
  }

  if (typeof record.paused === "boolean") {
    state.paused = record.paused;
  }

  if (record.intervalMinutes !== undefined) {
    state.intervalMinutes = normalizeSchedulerIntervalMinutes(record.intervalMinutes);
  }

  if (typeof record.consecutiveFailures === "number" && Number.isFinite(record.consecutiveFailures)) {
    state.consecutiveFailures = Math.max(0, Math.floor(record.consecutiveFailures));
  }

  copyOptionalScheduleString(record, state, "lastRunAt");
  copyOptionalScheduleString(record, state, "lastStatusCheckAt");
  copyOptionalScheduleString(record, state, "lastPullAt");
  copyOptionalScheduleString(record, state, "nextRunAt");
  copyOptionalScheduleString(record, state, "pauseReason");
  copyOptionalScheduleString(record, state, "lastError");

  const persistedReleaseBranch = normalizeOptionalScheduleString(record.releaseBranch);
  if (releaseBranch) {
    state.releaseBranch = releaseBranch;
  } else if (persistedReleaseBranch) {
    state.releaseBranch = persistedReleaseBranch;
  }

  if (!state.enabled) {
    // Disabled schedules should not retain paused state or a previously queued next run.
    state.paused = false;
    delete state.pauseReason;
    delete state.nextRunAt;
  }

  return state;
}

type GitSyncScheduleStringField =
  | "releaseBranch"
  | "lastRunAt"
  | "lastStatusCheckAt"
  | "lastPullAt"
  | "nextRunAt"
  | "pauseReason"
  | "lastError";

function copyOptionalScheduleString(
  source: Record<string, unknown>,
  target: GitSyncScheduleState,
  key: GitSyncScheduleStringField,
): void {
  const value = source[key];
  if (typeof value === "string" && value.trim().length > 0) {
    target[key] = value;
  }
}

function normalizeSchedulerIntervalMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GitHubSyncError(
      "invalid_configuration",
      "Background sync interval must be a whole number of minutes between 1 and 1440.",
    );
  }

  const normalizedValue = Math.floor(value);
  if (normalizedValue < 1 || normalizedValue > 1440) {
    throw new GitHubSyncError(
      "invalid_configuration",
      "Background sync interval must be a whole number of minutes between 1 and 1440.",
    );
  }

  return normalizedValue;
}

function normalizeOptionalScheduleString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue ? normalizedValue : undefined;
}

function normalizeScheduleStateFileName(value: string): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new GitHubSyncError(
      "invalid_configuration",
      "Background sync state file name is required.",
    );
  }

  if (
    normalizedValue.includes("/") ||
    normalizedValue.includes("\\") ||
    normalizedValue === "." ||
    normalizedValue === ".."
  ) {
    throw new GitHubSyncError(
      "invalid_configuration",
      "Background sync state file name must be a simple file name.",
    );
  }

  return normalizedValue;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown background sync error.";
}
