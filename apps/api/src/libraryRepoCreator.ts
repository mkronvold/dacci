import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { GitHubSyncError } from "@dacci/github-sync";
import {
  libraryRepoCreateVisibilities,
  type ApiCapabilities,
  type LibraryRepoCreateRequest,
  type LibraryRepoCreateVisibility,
  type LibraryRepoDefinition,
  type LibraryRepoRemoteAdoptRequest,
} from "@dacci/shared-types";

import { RepoContextResolver, type ResolvedRepoContext } from "./repoContext.js";
import { refreshManagedRuntimeSshState, resolveRuntimeSshPaths } from "./runtimeSsh.js";

const execFileAsync = promisify(execFile);
const dataDirectoryName = "data";
const gitkeepFileName = ".gitkeep";
const defaultGitHubSshHost = "github.com";
const initialCommitMessage = "Initialize Dacci content repository";
const sshDefaultKeyPrefix = "id_ed25519_";

type NormalizedRemoteRepoRequest = {
  repo: LibraryRepoDefinition;
  githubOwner: string;
  githubRepo: string;
  githubUsername: string;
  sshHostAlias: string;
};

type NormalizedCreateRequest = NormalizedRemoteRepoRequest & {
  commitAuthorEmail: string;
  commitAuthorName: string;
  visibility: LibraryRepoCreateVisibility;
};

export async function readApiCapabilities(): Promise<ApiCapabilities> {
  try {
    const result = await execFileAsync("gh", ["--version"], {
      env: buildCommandEnvironment(),
    });
    const versionLine = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return versionLine ? { ghCliAvailable: true, ghCliVersion: versionLine } : { ghCliAvailable: true };
  } catch {
    return { ghCliAvailable: false };
  }
}

export async function adoptRemoteLibraryRepoCheckout(
  request: LibraryRepoRemoteAdoptRequest,
  repoContextResolver: RepoContextResolver,
): Promise<ResolvedRepoContext> {
  const normalizedRequest = await normalizeRemoteRepoRequest(request, repoContextResolver);

  await refreshManagedRuntimeSshState({ preferLiveSource: true });
  await ensureDestinationReady(normalizedRequest.repo.repoRoot);
  await ensureSshHostAliasConfigured(normalizedRequest.sshHostAlias, normalizedRequest.githubUsername);
  await cloneExistingRemoteRepo(normalizedRequest);

  return repoContextResolver.resolveLibraryRepo(normalizedRequest.repo);
}

export async function createLibraryRepoCheckout(
  request: LibraryRepoCreateRequest,
  repoContextResolver: RepoContextResolver,
): Promise<ResolvedRepoContext> {
  const normalizedRequest = await normalizeCreateRequest(request, repoContextResolver);

  await refreshManagedRuntimeSshState({ preferLiveSource: true });
  await ensureDestinationReady(normalizedRequest.repo.repoRoot);
  await ensureSshHostAliasConfigured(normalizedRequest.sshHostAlias, normalizedRequest.githubUsername);
  await createRemoteRepo(normalizedRequest);
  await cloneNewRemoteRepo(normalizedRequest);
  await initializeRepoCheckout(normalizedRequest);

  return repoContextResolver.resolveLibraryRepo(normalizedRequest.repo);
}

async function normalizeRemoteRepoRequest(
  request: LibraryRepoRemoteAdoptRequest,
  repoContextResolver: RepoContextResolver,
): Promise<NormalizedRemoteRepoRequest> {
  if (!request || typeof request !== "object") {
    throw new GitHubSyncError("invalid_configuration", "Remote repository adoption request is required.");
  }

  const githubRepo = normalizeGitHubSlug(request.githubRepo, "GitHub repository name");
  const githubUsername = normalizeGitHubSlug(request.githubUsername, "GitHub username");
  const githubOwner = normalizeGitHubOwner(request.githubOwner, githubUsername);
  const repo = normalizeOnboardingRepoDefinition(request.repo, githubRepo, repoContextResolver);
  await ensureValidBranchName(repo.releaseBranch!);

  return {
    repo,
    githubOwner,
    githubRepo,
    githubUsername,
    sshHostAlias: normalizeOptionalHostAlias(request.sshHostAlias) ?? githubUsername,
  };
}

async function normalizeCreateRequest(
  request: LibraryRepoCreateRequest,
  repoContextResolver: RepoContextResolver,
): Promise<NormalizedCreateRequest> {
  if (!request || typeof request !== "object") {
    throw new GitHubSyncError("invalid_configuration", "Repository creation request is required.");
  }

  const normalizedRequest = await normalizeRemoteRepoRequest(request, repoContextResolver);
  return {
    ...normalizedRequest,
    commitAuthorEmail: normalizeRequiredString(request.commitAuthorEmail, "Commit author email"),
    commitAuthorName: normalizeRequiredString(request.commitAuthorName, "Commit author name"),
    visibility: normalizeVisibility(request.visibility),
  };
}

function normalizeOnboardingRepoDefinition(
  repo: LibraryRepoCreateRequest["repo"] | LibraryRepoRemoteAdoptRequest["repo"],
  githubRepo: string,
  repoContextResolver: RepoContextResolver,
): LibraryRepoDefinition {
  if (!repo || typeof repo !== "object") {
    throw new GitHubSyncError("invalid_configuration", "Repository details are required.");
  }

  const id = normalizeRequiredString(repo.id, "Repository id");
  const name = normalizeRequiredString(repo.name, "Repository name");
  const releaseBranch = normalizeRequiredString(repo.releaseBranch, "Repository branch");

  return {
    id,
    name,
    repoRoot: repoContextResolver.resolveLibraryCheckoutRoot(githubRepo),
    releaseBranch,
  };
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new GitHubSyncError("invalid_configuration", `${label} must be a string.`);
  }

  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new GitHubSyncError("invalid_configuration", `${label} is required.`);
  }

  return normalizedValue;
}

function normalizeGitHubSlug(value: unknown, label: string): string {
  const normalizedValue = normalizeRequiredString(value, label);
  if (!/^[A-Za-z0-9_.-]+$/.test(normalizedValue)) {
    throw new GitHubSyncError(
      "invalid_configuration",
      `${label} '${normalizedValue}' must use GitHub-safe characters only: letters, numbers, '.', '_' or '-'.`,
    );
  }

  return normalizedValue;
}

function normalizeGitHubOwner(value: unknown, githubUsername: string): string {
  if (value === undefined) {
    return githubUsername;
  }

  if (typeof value !== "string") {
    throw new GitHubSyncError("invalid_configuration", "GitHub owner must be a string.");
  }

  const normalizedValue = value.trim();
  return normalizedValue ? normalizeGitHubSlug(normalizedValue, "GitHub owner") : githubUsername;
}

function normalizeOptionalHostAlias(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new GitHubSyncError("invalid_configuration", "GitHub SSH host alias must be a string.");
  }

  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return undefined;
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(normalizedValue)) {
    throw new GitHubSyncError(
      "invalid_configuration",
      `GitHub SSH host alias '${normalizedValue}' must use letters, numbers, '.', '_' or '-'.`,
    );
  }

  return normalizedValue;
}

function normalizeVisibility(value: unknown): LibraryRepoCreateVisibility {
  if (typeof value !== "string") {
    throw new GitHubSyncError("invalid_configuration", "Repository visibility must be a string.");
  }

  if (!libraryRepoCreateVisibilities.includes(value as LibraryRepoCreateVisibility)) {
    throw new GitHubSyncError(
      "invalid_configuration",
      `Repository visibility must be one of: ${libraryRepoCreateVisibilities.join(", ")}.`,
    );
  }

  return value as LibraryRepoCreateVisibility;
}

async function ensureValidBranchName(branchName: string): Promise<void> {
  await runCommand("git", ["check-ref-format", "--branch", branchName], {
    failurePrefix: `Branch '${branchName}' is not a valid Git branch name`,
  });
}

async function ensureDestinationReady(repoRoot: string): Promise<void> {
  try {
    const repoRootStats = await stat(repoRoot);
    if (!repoRootStats.isDirectory()) {
      throw new GitHubSyncError(
        "conflict",
        `Repository destination '${repoRoot}' already exists and is not a directory.`,
      );
    }

    const existingEntries = await readdir(repoRoot);
    if (existingEntries.length > 0) {
      throw new GitHubSyncError(
        "conflict",
        `Repository destination '${repoRoot}' already exists and is not empty.`,
      );
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      await mkdir(path.dirname(repoRoot), { recursive: true });
      return;
    }

    throw error;
  }
}

async function ensureSshHostAliasConfigured(hostAlias: string, githubUsername: string): Promise<void> {
  if (hostAlias === defaultGitHubSshHost) {
    return;
  }

  const { dacciManagedConfigPath, sshConfigPath, sshDirectoryPath } = resolveRuntimeSshPaths();
  await mkdir(sshDirectoryPath, {
    recursive: true,
    mode: 0o700,
  });

  if (await sshConfigResolvesHostAlias(sshConfigPath, hostAlias)) {
    return;
  }

  let configContents = "";
  try {
    configContents = await readFile(dacciManagedConfigPath, "utf8");
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw new GitHubSyncError(
        "invalid_configuration",
        `Failed to read SSH config '${dacciManagedConfigPath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const nextContents = `${buildSshHostAliasConfigBlock(hostAlias, githubUsername)}${configContents ? `\n${configContents}` : ""}`;
  await writeFile(dacciManagedConfigPath, nextContents, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function sshConfigResolvesHostAlias(sshConfigPath: string, hostAlias: string): Promise<boolean> {
  try {
    const result = await execFileAsync("ssh", ["-F", sshConfigPath, "-G", hostAlias], {
      env: buildCommandEnvironment(),
      maxBuffer: 10 * 1024 * 1024,
    });
    const hostnameLine = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().startsWith("hostname "));
    const resolvedHostname = hostnameLine?.slice("hostname ".length).trim();
    return Boolean(resolvedHostname) && resolvedHostname !== hostAlias;
  } catch {
    return false;
  }
}

function buildSshHostAliasConfigBlock(hostAlias: string, githubUsername: string): string {
  return [
    `Host ${hostAlias}`,
    `  HostName ${defaultGitHubSshHost}`,
    "  User git",
    `  IdentityFile ~/.ssh/${sshDefaultKeyPrefix}${githubUsername}`,
    "",
  ].join("\n");
}

async function createRemoteRepo(input: NormalizedCreateRequest): Promise<void> {
  await runCommand(
    "gh",
    ["repo", "create", `${input.githubOwner}/${input.githubRepo}`, `--${input.visibility}`],
    {
      failurePrefix: `Failed to create GitHub repository '${input.githubOwner}/${input.githubRepo}'`,
    },
  );
}

async function cloneExistingRemoteRepo(input: NormalizedRemoteRepoRequest): Promise<void> {
  await runCommand(
    "git",
    [
      "clone",
      "--branch",
      input.repo.releaseBranch!,
      "--single-branch",
      buildSshRemoteUrl(input),
      input.repo.repoRoot,
    ],
    {
      failurePrefix: `Failed to clone '${input.githubOwner}/${input.githubRepo}' into '${input.repo.repoRoot}'`,
    },
  );
}

async function cloneNewRemoteRepo(input: NormalizedCreateRequest): Promise<void> {
  await runCommand(
    "git",
    ["clone", buildSshRemoteUrl(input), input.repo.repoRoot],
    {
      failurePrefix: `Failed to clone '${input.githubOwner}/${input.githubRepo}' into '${input.repo.repoRoot}'`,
    },
  );
}

async function initializeRepoCheckout(input: NormalizedCreateRequest): Promise<void> {
  const repoRoot = input.repo.repoRoot;
  const branchName = input.repo.releaseBranch!;
  const dataRoot = path.join(repoRoot, dataDirectoryName);

  await runCommand("git", ["checkout", "-b", branchName], {
    cwd: repoRoot,
    failurePrefix: `Failed to create initial branch '${branchName}' in '${repoRoot}'`,
  });

  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, gitkeepFileName), "", "utf8");
  await writeFile(path.join(repoRoot, ".gitignore"), buildGitignoreContents(), "utf8");
  await writeFile(path.join(repoRoot, "README.md"), buildReadmeContents(input), "utf8");

  await runCommand("git", ["add", "--", "README.md", ".gitignore", `${dataDirectoryName}/${gitkeepFileName}`], {
    cwd: repoRoot,
    failurePrefix: `Failed to stage the initial repository files in '${repoRoot}'`,
  });
  await runCommand(
    "git",
    buildGitCommitArgs(["commit", "-m", initialCommitMessage], {
      commitAuthorEmail: input.commitAuthorEmail,
      commitAuthorName: input.commitAuthorName,
    }),
    {
      cwd: repoRoot,
      failurePrefix: `Failed to create the initial commit in '${repoRoot}'`,
    },
  );
  await runCommand("git", ["push", "-u", "origin", branchName], {
    cwd: repoRoot,
    failurePrefix: `Failed to push initial branch '${branchName}' to '${input.githubOwner}/${input.githubRepo}'`,
  });
  await runCommand("git", ["remote", "set-url", "origin", buildSshRemoteUrl(input)], {
    cwd: repoRoot,
    failurePrefix: `Failed to update origin to the GitHub SSH remote for '${input.githubOwner}/${input.githubRepo}'`,
  });
}

function buildReadmeContents(input: NormalizedCreateRequest): string {
  return [
    `# ${input.repo.name}`,
    "",
    "This repository was bootstrapped by Dacci as a Git-backed content repository.",
    "",
    "## Repository shape",
    "",
    "```text",
    `${input.githubRepo}/`,
    "  data/",
    "    .gitkeep",
    "```",
    "",
    "Add Markdown topics and documents under `data/` through Dacci or Git.",
    "",
    "## Sync defaults",
    "",
    `- GitHub repo: \`${input.githubOwner}/${input.githubRepo}\``,
    `- Branch: \`${input.repo.releaseBranch}\``,
    `- SSH host alias: \`${input.sshHostAlias}\``,
    "",
  ].join("\n");
}

function buildGitignoreContents(): string {
  return [".DS_Store", "Thumbs.db", "*~", ".obsidian/", ""].join("\n");
}

function buildSshRemoteUrl(input: NormalizedRemoteRepoRequest): string {
  return `git@${input.sshHostAlias}:${input.githubOwner}/${input.githubRepo}.git`;
}

function buildGitCommitArgs(
  args: string[],
  identity: { commitAuthorEmail: string; commitAuthorName: string },
): string[] {
  return [
    "-c",
    `user.name=${identity.commitAuthorName}`,
    "-c",
    `user.email=${identity.commitAuthorEmail}`,
    ...args,
  ];
}

async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    failurePrefix?: string;
  },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options?.cwd,
      env: buildCommandEnvironment(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    throw buildCommandError(command, error, options?.failurePrefix);
  }
}

function buildCommandEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
}

function buildCommandError(command: string, error: unknown, failurePrefix?: string): GitHubSyncError {
  if (isMissingCommandError(error)) {
    return new GitHubSyncError("invalid_configuration", `Required command '${command}' is not available in this runtime.`);
  }

  const stderr =
    typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
  const stdout =
    typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string"
      ? error.stdout.trim()
      : "";
  const detail = stderr || stdout || (error instanceof Error ? error.message : `Command '${command}' failed.`);
  const message = failurePrefix ? `${failurePrefix}: ${detail}` : detail;
  const code = /\balready exists\b/i.test(detail) ? "conflict" : "invalid_configuration";
  return new GitHubSyncError(code, message);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isMissingCommandError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isCommandExitCode(error: unknown, expectedExitCode: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === expectedExitCode;
}
