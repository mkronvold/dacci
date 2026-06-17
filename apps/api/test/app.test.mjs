import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildApp, validateAppRuntimeConfiguration } from "../dist/app.js";

const execFileAsync = promisify(execFile);
const repoSelectionHeaderName = "x-dacci-repo-selection";
const authSessionHeaderName = "x-dacci-auth-session";

async function createTempDataRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runGit(args, cwd) {
  await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.bareRepository",
      GIT_CONFIG_VALUE_0: "all",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

async function readGitStdout(args, cwd) {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.bareRepository",
      GIT_CONFIG_VALUE_0: "all",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout.trim();
}

async function createGitBackedContentRepo(prefix, files, baseDir) {
  const repoRoot = baseDir ? await mkdtemp(path.join(baseDir, prefix)) : await createTempDataRoot(prefix);
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });

  for (const file of files) {
    const absolutePath = path.join(dataRoot, file.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.body, "utf8");
  }

  await runGit(["init", "--initial-branch=main"], repoRoot);
  await runGit(["config", "user.name", "API Repo Test"], repoRoot);
  await runGit(["config", "user.email", "api-repo@example.com"], repoRoot);
  await runGit(["add", "data"], repoRoot);
  await runGit(["commit", "-m", "Initial content"], repoRoot);

  return {
    repoRoot,
    dataRoot,
  };
}

async function createGitBackedDocsRepo(prefix, files) {
  const repoRoot = await createTempDataRoot(prefix);
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });

  for (const file of files) {
    const absolutePath = path.join(repoRoot, file.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.body, "utf8");
  }

  await runGit(["init", "--initial-branch=main"], repoRoot);
  await runGit(["config", "user.name", "API Docs Test"], repoRoot);
  await runGit(["config", "user.email", "api-docs@example.com"], repoRoot);
  await runGit(["add", "."], repoRoot);
  await runGit(["commit", "-m", "Initial docs content"], repoRoot);

  return {
    repoRoot,
    dataRoot,
  };
}

function createFakeGitHubDeviceAuthProvider() {
  return {
    async startDeviceAuthorization() {
      return {
        deviceCode: "device-code-123",
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        verificationUriComplete: "https://github.com/login/device?user_code=ABCD-EFGH",
        expiresInSeconds: 900,
        intervalSeconds: 5,
      };
    },
    async pollDeviceAuthorization(deviceCode) {
      if (deviceCode === "pending-code") {
        return {
          status: "pending",
          intervalSeconds: 7,
        };
      }

      return {
        status: "authorized",
        accessToken: "gho_test_token",
      };
    },
    async getAuthenticatedUser() {
      return {
        id: 101,
        login: "octocat",
        displayName: "The Octocat",
        avatarUrl: "https://avatars.example/octocat.png",
      };
    },
    async getTeamMemberships() {
      return [
        {
          org: "who-wtg",
          slug: "docs-publishers",
        },
      ];
    },
  };
}

function createLibrarySelectionHeader(repo) {
  return encodeURIComponent(
    JSON.stringify({
      kind: "library",
      repo,
    }),
  );
}

async function addLocalOrigin(repoRoot) {
  const remoteRepo = `${repoRoot}.origin.git`;
  await runGit(["init", "--bare", "--initial-branch=main", remoteRepo], path.dirname(repoRoot));
  await runGit(["remote", "add", "origin", remoteRepo], repoRoot);
  await runGit(["push", "-u", "origin", "main"], repoRoot);
  return remoteRepo;
}

async function installFakeGh(t, options = {}) {
  const binRoot = await createTempDataRoot("dacci-api-fake-gh-bin-");
  const remoteRoot = await createTempDataRoot("dacci-api-fake-gh-remote-");
  const ghPath = path.join(binRoot, "gh");
  const versionLine = options.versionLine ?? "gh version 9.9.9-test";
  await writeFile(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail

remote_root="\${DACCI_TEST_FAKE_GH_ROOT:?}"

if [[ "\${1-}" == "--version" ]]; then
  printf '%s\n' "${versionLine}"
  exit 0
fi

if [[ "\${1-}" == "repo" && "\${2-}" == "create" ]]; then
  spec="\${3:?missing repo spec}"
  owner="\${spec%%/*}"
  repo="\${spec##*/}"
  bare_repo="\${remote_root}/\${owner}/\${repo}.git"
  if [[ -e "\${bare_repo}" ]]; then
    printf 'repository already exists: %s\n' "\${spec}" >&2
    exit 1
  fi
  mkdir -p "$(dirname "\${bare_repo}")"
  git init --bare --initial-branch=main "\${bare_repo}" >/dev/null
  exit 0
fi

if [[ "\${1-}" == "repo" && "\${2-}" == "clone" ]]; then
  spec="\${3:?missing repo spec}"
  destination="\${4:?missing destination}"
  owner="\${spec%%/*}"
  repo="\${spec##*/}"
  bare_repo="\${remote_root}/\${owner}/\${repo}.git"
  git clone "\${bare_repo}" "\${destination}" >/dev/null 2>&1
  exit 0
fi

printf 'unsupported fake gh command: %s\n' "$*" >&2
exit 1
`,
    "utf8",
  );
  await chmod(ghPath, 0o755);

  const previousPath = process.env.PATH;
  const previousRemoteRoot = process.env.DACCI_TEST_FAKE_GH_ROOT;
  process.env.PATH = `${binRoot}${path.delimiter}${previousPath ?? ""}`;
  process.env.DACCI_TEST_FAKE_GH_ROOT = remoteRoot;

  t.after(async () => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }

    if (previousRemoteRoot === undefined) {
      delete process.env.DACCI_TEST_FAKE_GH_ROOT;
    } else {
      process.env.DACCI_TEST_FAKE_GH_ROOT = previousRemoteRoot;
    }

    await rm(binRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  });

  return {
    remoteRoot,
  };
}

async function setTemporaryHome(t) {
  const homeRoot = await createTempDataRoot("dacci-api-home-");
  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;

  t.after(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    await rm(homeRoot, { recursive: true, force: true });
  });

  return homeRoot;
}

async function writeGitInsteadOfConfig(homeRoot, hostAlias, replacementRoot) {
  const replacementUrl = pathToFileURL(`${replacementRoot}${path.sep}`).href;
  await writeFile(
    path.join(homeRoot, ".gitconfig"),
    `[url "${replacementUrl}"]\n\tinsteadOf = git@${hostAlias}:\n`,
    "utf8",
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("api returns 400 when document path is missing", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-api-");
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: dataRoot });

  t.after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/documents",
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "invalid_input",
    message: "The 'path' query parameter is required.",
  });
});

test("api exposes the new docs tree grouped by status-first lifecycle folders", async (t) => {
  const { repoRoot, dataRoot } = await createGitBackedDocsRepo("dacci-api-docs-tree-", [
    {
      path: "published/platform/kubernetes/core-design.md",
      body: "---\ntitle: Core Design\n---\n## Published\n",
    },
    {
      path: "draft/platform/kubernetes/core-design.md",
      body: "---\ntitle: Core Design Draft\n---\n## Draft\n",
    },
  ]);
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: repoRoot });

  t.after(async () => {
    await app.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/docs/tree",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.documents.length, 1);
  assert.deepEqual(body.documents[0].availableStatuses, ["draft", "published"]);
  assert.equal(body.documents[0].logicalPath, "platform/kubernetes/core-design.md");
  assert.equal(body.statuses[0].status, "draft");
  assert.equal(body.statuses[1].status, "published");
});

test("api supports GitHub device authorization sessions and repo permission evaluation", async (t) => {
  const defaultRepo = await createGitBackedContentRepo(
    "dacci-api-auth-default-",
    [
      {
        path: "Default Topic/Guide.md",
        body: "# Default\n",
      },
    ],
  );
  const registeredRepo = await createGitBackedContentRepo(
    "dacci-api-auth-registered-",
    [
      {
        path: "Registered Topic/Guide.md",
        body: "# Registered\n",
      },
    ],
  );
  const app = await buildApp({
    dataRoot: defaultRepo.dataRoot,
    gitSyncRepoRoot: defaultRepo.repoRoot,
    libraryRepos: [
      {
        id: "registered-docs",
        name: "Registered Docs",
        repoRoot: registeredRepo.repoRoot,
        dataRoot: registeredRepo.dataRoot,
        releaseBranch: "main",
      },
    ],
    gitHubDeviceAuthProvider: createFakeGitHubDeviceAuthProvider(),
    gitHubTeamRoleBindings: [
      {
        org: "who-wtg",
        teamSlug: "docs-publishers",
        repoIds: ["registered-docs"],
        roles: ["direct-publish"],
      },
    ],
    gitHubRepoRoleOverrides: [
      {
        repoId: "configured-repo",
        login: "octocat",
        roles: ["manage"],
        reason: "owner override",
      },
    ],
  });

  t.after(async () => {
    await app.close();
    await rm(defaultRepo.repoRoot, { recursive: true, force: true });
    await rm(registeredRepo.repoRoot, { recursive: true, force: true });
  });

  const startResponse = await app.inject({
    method: "POST",
    url: "/api/auth/github/device/start",
  });
  assert.equal(startResponse.statusCode, 200);
  assert.equal(startResponse.json().deviceCode, "device-code-123");

  const pendingResponse = await app.inject({
    method: "POST",
    url: "/api/auth/github/device/poll",
    payload: {
      deviceCode: "pending-code",
    },
  });
  assert.equal(pendingResponse.statusCode, 200);
  assert.deepEqual(pendingResponse.json(), {
    status: "pending",
    intervalSeconds: 7,
  });

  const authorizedResponse = await app.inject({
    method: "POST",
    url: "/api/auth/github/device/poll",
    payload: {
      deviceCode: "authorized-code",
    },
  });
  assert.equal(authorizedResponse.statusCode, 200);
  const authorizedBody = authorizedResponse.json();
  assert.equal(authorizedBody.status, "authorized");
  assert.equal(authorizedBody.session.user.login, "octocat");
  assert.equal(authorizedBody.session.permissions.length, 2);

  const configuredRepoPermission = authorizedBody.session.permissions.find((entry) => entry.repoId === "configured-repo");
  assert.ok(configuredRepoPermission);
  assert.equal(configuredRepoPermission.canManage, true);
  assert.equal(configuredRepoPermission.canDirectPublish, true);
  assert.equal(configuredRepoPermission.sourceOverride, "owner override");

  const registeredRepoPermission = authorizedBody.session.permissions.find((entry) => entry.repoId === "registered-docs");
  assert.ok(registeredRepoPermission);
  assert.equal(registeredRepoPermission.canManage, false);
  assert.equal(registeredRepoPermission.canDirectPublish, true);
  assert.deepEqual(registeredRepoPermission.sourceTeams, ["who-wtg/docs-publishers"]);

  const sessionId = authorizedBody.session.sessionId;
  const sessionResponse = await app.inject({
    method: "GET",
    url: "/api/auth/session",
    headers: {
      [authSessionHeaderName]: sessionId,
    },
  });
  assert.equal(sessionResponse.statusCode, 200);
  assert.equal(sessionResponse.json().authenticated, true);
  assert.equal(sessionResponse.json().session.sessionId, sessionId);

  const logoutResponse = await app.inject({
    method: "POST",
    url: "/api/auth/session/logout",
    headers: {
      [authSessionHeaderName]: sessionId,
    },
  });
  assert.equal(logoutResponse.statusCode, 200);
  assert.deepEqual(logoutResponse.json(), {
    authenticated: false,
  });
});

test("api requires an authenticated session for docs routes when GitHub auth is enabled", async (t) => {
  const docsRepo = await createGitBackedDocsRepo("dacci-api-auth-docs-", [
    {
      path: "draft/platform/kubernetes/core-design.md",
      body: "---\ntitle: Core Design Draft\n---\n## Draft\n",
    },
  ]);
  const authProvider = createFakeGitHubDeviceAuthProvider();
  authProvider.getTeamMemberships = async () => [];
  const app = await buildApp({
    dataRoot: docsRepo.dataRoot,
    gitSyncRepoRoot: docsRepo.repoRoot,
    gitHubDeviceAuthProvider: authProvider,
  });

  t.after(async () => {
    await app.close();
    await rm(docsRepo.repoRoot, { recursive: true, force: true });
  });

  const unauthenticatedTreeResponse = await app.inject({
    method: "GET",
    url: "/api/docs/tree",
  });
  assert.equal(unauthenticatedTreeResponse.statusCode, 401);
  assert.equal(unauthenticatedTreeResponse.json().error, "authentication_required");

  const authorizedResponse = await app.inject({
    method: "POST",
    url: "/api/auth/github/device/poll",
    payload: {
      deviceCode: "authorized-code",
    },
  });
  assert.equal(authorizedResponse.statusCode, 200);
  const sessionId = authorizedResponse.json().session.sessionId;

  const authenticatedTreeResponse = await app.inject({
    method: "GET",
    url: "/api/docs/tree",
    headers: {
      [authSessionHeaderName]: sessionId,
    },
  });
  assert.equal(authenticatedTreeResponse.statusCode, 200);

  const publishResponse = await app.inject({
    method: "POST",
    url: "/api/docs/documents/publish",
    headers: {
      [authSessionHeaderName]: sessionId,
    },
    payload: {
      logicalPath: "platform/kubernetes/core-design.md",
    },
  });
  assert.equal(publishResponse.statusCode, 403);
  assert.equal(publishResponse.json().error, "forbidden");
});

test("api publishes a draft into the published status folder and removes the draft variant", async (t) => {
  const { repoRoot, dataRoot } = await createGitBackedDocsRepo("dacci-api-docs-publish-", [
    {
      path: "published/platform/kubernetes/core-design.md",
      body: "---\ntitle: Core Design\n---\n## Published\n",
    },
    {
      path: "draft/platform/kubernetes/core-design.md",
      body: "---\ntitle: Core Design Draft\n---\n## Replacement\n",
    },
  ]);
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: repoRoot });

  t.after(async () => {
    await app.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const publishResponse = await app.inject({
    method: "POST",
    url: "/api/docs/documents/publish",
    payload: {
      logicalPath: "platform/kubernetes/core-design.md",
    },
  });

  assert.equal(publishResponse.statusCode, 200);
  assert.equal(publishResponse.json().status, "published");

  const publishedDocumentResponse = await app.inject({
    method: "GET",
    url: "/api/docs/documents?status=published&path=platform/kubernetes/core-design.md",
  });

  assert.equal(publishedDocumentResponse.statusCode, 200);
  assert.match(publishedDocumentResponse.json().body, /Replacement/);

  const treeResponse = await app.inject({
    method: "GET",
    url: "/api/docs/tree",
  });

  assert.equal(treeResponse.statusCode, 200);
  assert.deepEqual(treeResponse.json().documents[0].availableStatuses, ["published"]);
});

test("api rejects stale docs draft saves with a conflict response", async (t) => {
  const { repoRoot, dataRoot } = await createGitBackedDocsRepo("dacci-api-docs-stale-draft-", [
    {
      path: "draft/platform/kubernetes/core-design.md",
      body: "---\ntitle: Core Design Draft\n---\n## Draft\n",
    },
  ]);
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: repoRoot });

  t.after(async () => {
    await app.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "PUT",
    url: "/api/docs/documents/draft",
    payload: {
      logicalPath: "platform/kubernetes/core-design.md",
      body: "---\ntitle: Core Design Draft\n---\n## Replacement\n",
      expectedModifiedAt: "1970-01-01T00:00:00.000Z",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "conflict");
  assert.match(response.json().message, /changed after it was loaded/i);
});

test("api advertises the phase 12 runtime endpoints", async (t) => {
  await installFakeGh(t, {
    versionLine: "gh version 2.99.0-test",
  });
  const repoRoot = await createTempDataRoot("dacci-api-info-");
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });
  await runGit(["init", "--initial-branch=main"], repoRoot);
  await runGit(["config", "user.name", "API Info Test"], repoRoot);
  await runGit(["config", "user.email", "api-info@example.com"], repoRoot);
  const app = await buildApp({
    dataRoot,
    gitSyncRepoRoot: repoRoot,
    gitSyncRemoteUrl: "git@github.com:mkronvold-wtg/E2open.KPE.Config.git",
  });

  t.after(async () => {
    await app.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/api",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.phase, "dacci-public-seed");
  assert.equal(body.service, "Dacci API");
  assert.equal(body.configuredRepo.id, "configured-repo");
  assert.equal(body.configuredRepo.name, "mkronvold-wtg/E2open.KPE.Config");
  assert.equal(body.configuredRepo.repoRoot, repoRoot);
  assert.equal(body.configuredRepo.dataRoot, dataRoot);
  assert.equal(body.configuredRepo.releaseBranch, "default");
  assert.equal(body.capabilities.ghCliAvailable, true);
  assert.equal(body.capabilities.ghCliVersion, "gh version 2.99.0-test");
  assert.ok(body.endpoints.includes("/ready"));
  assert.ok(body.endpoints.includes("/api/search"));
  assert.ok(body.endpoints.includes("/api/library/discover"));
  assert.ok(body.endpoints.includes("/api/library/create"));
  assert.ok(body.endpoints.includes("/api/library/adopt-remote"));
  assert.ok(body.endpoints.includes("/api/import/documents"));
  assert.ok(body.endpoints.includes("/api/export"));
  assert.ok(body.endpoints.includes("/api/topics"));
  assert.ok(body.endpoints.includes("/api/subtopics"));
  assert.ok(body.endpoints.includes("/api/sync/schedule"));
  assert.ok(body.endpoints.includes("/api/sync/schedule/pause"));
  assert.ok(body.endpoints.includes("/api/sync/schedule/resume"));
});

test("api discovers configured and sibling workspace repos", async (t) => {
  const workspaceRoot = await createTempDataRoot("dacci-api-library-discover-");
  const defaultRepo = await createGitBackedContentRepo(
    "configured-content-",
    [
      {
        path: "Default Topic/Guide.md",
        body: "# Default\n",
      },
    ],
    workspaceRoot,
  );
  const libraryRepo = await createGitBackedContentRepo(
    "library-content-",
    [
      {
        path: "Library Topic/Guide.md",
        body: "# Library\n",
      },
    ],
    workspaceRoot,
  );
  const nonRepoDirectory = path.join(workspaceRoot, "not-a-repo");
  const gitWithoutDataDirectory = path.join(workspaceRoot, "git-without-data");
  const dataWithoutGitDirectory = path.join(workspaceRoot, "data-without-git");

  await mkdir(nonRepoDirectory, { recursive: true });
  await mkdir(gitWithoutDataDirectory, { recursive: true });
  await runGit(["init", "--initial-branch=main"], gitWithoutDataDirectory);
  await mkdir(path.join(dataWithoutGitDirectory, "data"), { recursive: true });

  const app = await buildApp({
    dataRoot: defaultRepo.dataRoot,
    gitSyncRepoRoot: defaultRepo.repoRoot,
    libraryRepoRoots: [workspaceRoot],
  });

  t.after(async () => {
    await app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/library/discover",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.libraryRoots, [workspaceRoot]);
  assert.equal(body.repos.length, 2);

  const defaultSummary = body.repos.find((repo) => repo.repoRoot === defaultRepo.repoRoot);
  assert.ok(defaultSummary);
  assert.equal(defaultSummary.id, "configured-repo");
  assert.equal(defaultSummary.kind, "default");
  assert.equal(defaultSummary.source, "configured");
  assert.equal(defaultSummary.dataRoot, defaultRepo.dataRoot);

  const librarySummary = body.repos.find((repo) => repo.repoRoot === libraryRepo.repoRoot);
  assert.ok(librarySummary);
  assert.equal(librarySummary.kind, "library");
  assert.equal(librarySummary.source, "discovered");
  assert.equal(librarySummary.dataRoot, libraryRepo.dataRoot);
  assert.match(librarySummary.id, /^discovered-[0-9a-f]{12}$/);
});

test("api discovers and serves registered library repos without relying on workspace scanning", async (t) => {
  const registeredRepo = await createGitBackedContentRepo(
    "registered-content-",
    [
      {
        path: "Registered Topic/Guide.md",
        body: "# Registered\n",
      },
    ],
  );
  const app = await buildApp({
    libraryRepos: [
      {
        id: "registered-content",
        name: "Registered Content",
        repoRoot: registeredRepo.repoRoot,
        dataRoot: registeredRepo.dataRoot,
        releaseBranch: "main",
      },
    ],
  });

  t.after(async () => {
    await app.close();
    await rm(registeredRepo.repoRoot, { recursive: true, force: true });
  });

  const [discoverResponse, treeResponse] = await Promise.all([
    app.inject({
      method: "GET",
      url: "/api/library/discover",
    }),
    app.inject({
      method: "GET",
      url: "/api/tree",
      headers: {
        [repoSelectionHeaderName]: createLibrarySelectionHeader({
          id: "registered-content",
          name: "Registered Content",
          repoRoot: registeredRepo.repoRoot,
          dataRoot: registeredRepo.dataRoot,
          releaseBranch: "main",
        }),
      },
    }),
  ]);

  assert.equal(discoverResponse.statusCode, 200);
  const discoveryBody = discoverResponse.json();
  assert.deepEqual(discoveryBody.libraryRoots, []);
  assert.equal(discoveryBody.repos.length, 1);
  assert.equal(discoveryBody.repos[0].id, "registered-content");
  assert.equal(discoveryBody.repos[0].source, "registered");
  assert.equal(discoveryBody.repos[0].repoRoot, registeredRepo.repoRoot);

  assert.equal(treeResponse.statusCode, 200);
  const treeBody = treeResponse.json();
  assert.equal(treeBody.topics.length, 1);
  assert.equal(treeBody.topics[0].name, "Registered Topic");
});

test("api creates and bootstraps a new personal library repo when GitHub owner is blank", async (t) => {
  const { remoteRoot } = await installFakeGh(t);
  const workspaceRoot = await createTempDataRoot("dacci-api-library-create-");
  const homeRoot = await setTemporaryHome(t);
  await writeGitInsteadOfConfig(homeRoot, "octocat", remoteRoot);
  const app = await buildApp({
    libraryRepoRoots: [workspaceRoot],
  });

  t.after(async () => {
    await app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(workspaceRoot, "Created.Content");
  const response = await app.inject({
    method: "POST",
    url: "/api/library/create",
    payload: {
      repo: {
        id: "created-content",
        name: "Created Content",
        releaseBranch: "release/main",
      },
      commitAuthorName: "Ada Lovelace",
      commitAuthorEmail: "ada@example.com",
      githubOwner: "   ",
      githubRepo: "Created.Content",
      githubUsername: "octocat",
      visibility: "private",
    },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.repo.id, "created-content");
  assert.equal(body.repo.name, "octocat/Created.Content");
  assert.equal(body.repo.repoRoot, repoRoot);
  assert.equal(body.repo.dataRoot, path.join(repoRoot, "data"));
  assert.equal(body.repo.releaseBranch, "release/main");
  assert.equal(body.content.topicCount, 0);
  assert.equal(body.content.documentCount, 0);
  assert.equal(body.git.currentBranch, "release/main");

  const [readme, gitignore, gitConfigContents, latestCommitAuthor, originUrl, currentBranch, sshConfigContents, discoveryResponse] = await Promise.all([
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, ".gitignore"), "utf8"),
    readFile(path.join(repoRoot, ".git", "config"), "utf8"),
    readGitStdout(["log", "-1", "--format=%an <%ae>"], repoRoot),
    readGitStdout(["config", "--get", "remote.origin.url"], repoRoot),
    readGitStdout(["branch", "--show-current"], repoRoot),
    readFile(path.join(homeRoot, ".ssh", "config"), "utf8"),
    app.inject({
      method: "GET",
      url: "/api/library/discover",
    }),
  ]);

  assert.match(readme, /bootstrapped by Dacci/i);
  assert.match(readme, /octocat\/Created\.Content/);
  assert.match(gitignore, /\.obsidian\//);
  assert.equal(latestCommitAuthor, "Ada Lovelace <ada@example.com>");
  assert.doesNotMatch(gitConfigContents, /^\s*name\s*=\s*Ada Lovelace$/m);
  assert.doesNotMatch(gitConfigContents, /^\s*email\s*=\s*ada@example\.com$/m);
  assert.equal(originUrl, "git@octocat:octocat/Created.Content.git");
  assert.equal(currentBranch, "release/main");
  assert.match(sshConfigContents, /^Host octocat$/m);
  assert.match(sshConfigContents, /^\s*IdentityFile ~\/\.ssh\/id_ed25519_octocat$/m);

  const discoveryBody = discoveryResponse.json();
  const createdRepo = discoveryBody.repos.find((repo) => repo.repoRoot === repoRoot);
  assert.ok(createdRepo);

  const remoteBareRepo = path.join(remoteRoot, "octocat", "Created.Content.git");
  assert.equal(await readGitStdout(["rev-parse", "--verify", "refs/heads/release/main"], remoteBareRepo), await readGitStdout(["rev-parse", "HEAD"], repoRoot));
});

test("api adopts a personal remote repository and inserts a missing SSH host alias when GitHub owner is blank", async (t) => {
  const workspaceRoot = await createTempDataRoot("dacci-api-library-adopt-remote-");
  const remoteRoot = await createTempDataRoot("dacci-api-library-adopt-remote-origin-");
  const sourceRepo = await createGitBackedContentRepo("adopt-remote-source-", [
    {
      path: "Platform/Kubernetes/Overview.md",
      body: "# Remote overview\n",
    },
  ]);
  const homeRoot = await setTemporaryHome(t);
  await writeGitInsteadOfConfig(homeRoot, "github-work", remoteRoot);

  const remoteBareRepo = path.join(remoteRoot, "octocat", "Existing.Content.git");
  await mkdir(path.dirname(remoteBareRepo), { recursive: true });
  await runGit(["init", "--bare", "--initial-branch=main", remoteBareRepo], path.dirname(remoteBareRepo));
  await runGit(["checkout", "-b", "release/main"], sourceRepo.repoRoot);
  await runGit(["remote", "add", "origin", remoteBareRepo], sourceRepo.repoRoot);
  await runGit(["push", "-u", "origin", "main", "release/main"], sourceRepo.repoRoot);

  const app = await buildApp({
    libraryRepoRoots: [workspaceRoot],
  });

  t.after(async () => {
    await app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(sourceRepo.repoRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(workspaceRoot, "Existing.Content");
  const response = await app.inject({
    method: "POST",
    url: "/api/library/adopt-remote",
    payload: {
      repo: {
        id: "existing-content",
        name: "Existing Content",
        releaseBranch: "release/main",
      },
      githubOwner: "",
      githubRepo: "Existing.Content",
      githubUsername: "octocat",
      sshHostAlias: "github-work",
    },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.repo.id, "existing-content");
  assert.equal(body.repo.repoRoot, repoRoot);
  assert.equal(body.repo.dataRoot, path.join(repoRoot, "data"));
  assert.equal(body.repo.releaseBranch, "release/main");
  assert.equal(body.content.topicCount, 1);
  assert.equal(body.content.documentCount, 1);
  assert.equal(body.git.currentBranch, "release/main");

  const [originUrl, sshConfigContents, adoptedDocument] = await Promise.all([
    readGitStdout(["remote", "get-url", "origin"], repoRoot),
    readFile(path.join(homeRoot, ".ssh", "config"), "utf8"),
    readFile(path.join(repoRoot, "data", "Platform", "Kubernetes", "Overview.md"), "utf8"),
  ]);

  assert.equal(originUrl, pathToFileURL(remoteBareRepo).href);
  assert.match(sshConfigContents, /^Host github-work$/m);
  assert.match(sshConfigContents, /^\s*IdentityFile ~\/\.ssh\/id_ed25519_octocat$/m);
  assert.match(adoptedDocument, /Remote overview/);
});

test("api starts cleanly with an empty workspace", async (t) => {
  const workspaceRoot = await createTempDataRoot("dacci-api-empty-workspace-");
  const app = await buildApp({
    libraryRepoRoots: [workspaceRoot],
  });

  t.after(async () => {
    await app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const [apiResponse, readyResponse, discoveryResponse] = await Promise.all([
    app.inject({
      method: "GET",
      url: "/api",
    }),
    app.inject({
      method: "GET",
      url: "/ready",
    }),
    app.inject({
      method: "GET",
      url: "/api/library/discover",
    }),
  ]);

  assert.equal(apiResponse.statusCode, 200);
  assert.equal(apiResponse.json().configuredRepo, null);
  assert.equal(readyResponse.statusCode, 200);
  assert.equal(readyResponse.json().dataRoot, "");
  assert.equal(discoveryResponse.statusCode, 200);
  assert.deepEqual(discoveryResponse.json().repos, []);
});

test("api readiness reports ok when the data root is available", async (t) => {
  const repoRoot = await createTempDataRoot("dacci-api-ready-");
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });
  await runGit(["init", "--initial-branch=main"], repoRoot);
  await runGit(["config", "user.name", "API Ready Test"], repoRoot);
  await runGit(["config", "user.email", "api-ready@example.com"], repoRoot);

  const app = await buildApp({ dataRoot, gitSyncRepoRoot: repoRoot });

  t.after(async () => {
    await app.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/ready",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "dacci-api",
    dataRoot,
  });
});

test("api startup validation rejects a configured repo root that is not a git repository", async (t) => {
  const repoRoot = await createTempDataRoot("dacci-api-invalid-repo-");
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    validateAppRuntimeConfiguration({
      dataRoot,
      gitSyncRepoRoot: repoRoot,
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /is not a Git repository/);
      return true;
    },
  );
});

test("api readiness fails when configured repo root is not a git repository", async (t) => {
  const repoRoot = await createTempDataRoot("dacci-api-ready-invalid-repo-");
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });

  const app = await buildApp({ dataRoot, gitSyncRepoRoot: repoRoot });

  t.after(async () => {
    await app.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/ready",
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /is not a Git repository/);
});

test("api readiness fails when configured Git SSH files are missing", async (t) => {
  const repoRoot = await createTempDataRoot("dacci-api-ready-ssh-");
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });
  await runGit(["init", "--initial-branch=main"], repoRoot);
  await runGit(["config", "user.name", "API Ready SSH Test"], repoRoot);
  await runGit(["config", "user.email", "api-ready-ssh@example.com"], repoRoot);

  const app = await buildApp({
    dataRoot,
    gitSyncRepoRoot: repoRoot,
    gitSshCommand:
      `ssh -F ${path.join(repoRoot, "missing-config")} -i ${path.join(repoRoot, "missing-id_ed25519")} -o IdentitiesOnly=yes -o UserKnownHostsFile=${path.join(repoRoot, "missing-known_hosts")}`,
  });

  t.after(async () => {
    await app.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/ready",
  });

  assert.equal(response.statusCode, 500);
});

test("api allows browser preflight requests for document writes", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-api-cors-");
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: dataRoot });

  t.after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/documents",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "PUT",
      "access-control-request-headers": `content-type, ${repoSelectionHeaderName}`,
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.match(response.headers["access-control-allow-methods"], /\bPUT\b/);
  assert.match(response.headers["access-control-allow-methods"], /\bPATCH\b/);
  assert.match(response.headers["access-control-allow-methods"], /\bDELETE\b/);
  assert.match(response.headers["access-control-allow-headers"], /\bx-dacci-repo-selection\b/i);
});

test("api supports logical topic-level document lifecycle", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-api-lifecycle-");
  await mkdir(path.join(dataRoot, "Seed"), { recursive: true });
  await writeFile(path.join(dataRoot, "Seed", "Initial.md"), "# Seed\n", "utf8");

  const app = await buildApp({ dataRoot, gitSyncRepoRoot: dataRoot });

  t.after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  const createTopic = await app.inject({
    method: "POST",
    url: "/api/topics",
    payload: { name: "Operations" },
  });
  assert.equal(createTopic.statusCode, 201);

  const createSubtopic = await app.inject({
    method: "POST",
    url: "/api/subtopics",
    payload: { topicName: "Operations", name: "Runbooks" },
  });
  assert.equal(createSubtopic.statusCode, 201);

  const createDocument = await app.inject({
    method: "POST",
    url: "/api/documents",
    payload: {
      topicName: "Operations",
      subtopicName: "Runbooks",
      name: "Deploy Guide",
      body: "# Deploy\n\nStep 1\n",
    },
  });
  assert.equal(createDocument.statusCode, 201);
  assert.equal(createDocument.json().path, "Operations/Runbooks/Deploy Guide.md");

  const moveDocument = await app.inject({
    method: "PATCH",
    url: "/api/documents/move",
    payload: {
      path: "Operations/Runbooks/Deploy Guide.md",
      topicName: "Operations",
    },
  });
  assert.equal(moveDocument.statusCode, 200);
  assert.equal(moveDocument.json().path, "Operations/Deploy Guide.md");

  const renameDocument = await app.inject({
    method: "PATCH",
    url: "/api/documents/rename",
    payload: {
      path: "Operations/Deploy Guide.md",
      nextName: "Release Guide",
    },
  });
  assert.equal(renameDocument.statusCode, 200);
  assert.equal(renameDocument.json().path, "Operations/Release Guide.md");

  const treeResponse = await app.inject({
    method: "GET",
    url: "/api/tree",
  });
  assert.equal(treeResponse.statusCode, 200);
  const tree = treeResponse.json();
  assert.equal(tree.topics[0].documents[0].path, "Operations/Release Guide.md");

  const deleteDocument = await app.inject({
    method: "DELETE",
    url: "/api/documents",
    payload: { path: "Operations/Release Guide.md" },
  });
  assert.equal(deleteDocument.statusCode, 204);
});

test("api exposes git sync status for a git-backed content root", async (t) => {
  const repoRoot = await createTempDataRoot("dacci-api-sync-");
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, "Guide.md"), "# Guide\n", "utf8");

  await runGit(["init", "--initial-branch=main"], repoRoot);
  await runGit(["config", "user.name", "API Sync Test"], repoRoot);
  await runGit(["config", "user.email", "api-sync@example.com"], repoRoot);
  await runGit(["add", "data/Guide.md"], repoRoot);
  await runGit(["commit", "-m", "Initial content"], repoRoot);

  const app = await buildApp({
    dataRoot,
    gitSyncRepoRoot: repoRoot,
  });

  t.after(async () => {
    await app.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/sync/status",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.currentBranch, "main");
  assert.equal(body.releaseBranch, "default");
  assert.equal(body.isReleaseBranch, false);
  assert.equal(body.contentPath, "data");
  assert.equal(body.hasContentChanges, false);
  assert.equal(body.nonContentChangedFiles.length, 0);
  assert.equal(body.pushBlockers.length, 0);
  assert.ok(body.pullBlockers.length > 0);
  assert.equal(body.scheduler.enabled, false);
  assert.equal(body.scheduler.paused, false);
  assert.equal(body.scheduler.intervalMinutes, 15);
});

test("api configures, pauses, and resumes background sync", async (t) => {
  const repoRoot = await createTempDataRoot("dacci-api-sync-schedule-");
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, "Guide.md"), "# Guide\n", "utf8");

  await runGit(["init", "--initial-branch=main"], repoRoot);
  await runGit(["config", "user.name", "API Schedule Test"], repoRoot);
  await runGit(["config", "user.email", "api-schedule@example.com"], repoRoot);
  await runGit(["add", "data/Guide.md"], repoRoot);
  await runGit(["commit", "-m", "Initial content"], repoRoot);

  const app = await buildApp({
    dataRoot,
    gitSyncRepoRoot: repoRoot,
  });

  t.after(async () => {
    await app.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const configureResponse = await app.inject({
    method: "POST",
    url: "/api/sync/schedule",
    payload: {
      enabled: true,
      intervalMinutes: 20,
    },
  });

  assert.equal(configureResponse.statusCode, 200);
  assert.equal(configureResponse.json().status.scheduler.enabled, true);
  assert.equal(configureResponse.json().status.scheduler.intervalMinutes, 20);

  const pauseResponse = await app.inject({
    method: "POST",
    url: "/api/sync/schedule/pause",
  });

  assert.equal(pauseResponse.statusCode, 200);
  assert.equal(pauseResponse.json().status.scheduler.paused, true);

  const resumeResponse = await app.inject({
    method: "POST",
    url: "/api/sync/schedule/resume",
  });

  assert.equal(resumeResponse.statusCode, 200);
  assert.equal(resumeResponse.json().status.scheduler.enabled, true);
  assert.equal(resumeResponse.json().status.scheduler.paused, false);
});

test("api switches tree requests between the default repo and a selected library repo", async (t) => {
  const workspaceRoot = await createTempDataRoot("dacci-api-multirepo-");
  const defaultRepo = await createGitBackedContentRepo("dacci-api-multirepo-default-", [
    {
      path: "Default Topic/Default Guide.md",
      body: "# Default\n",
    },
  ]);
  const libraryRepo = await createGitBackedContentRepo("dacci-api-multirepo-library-", [
    {
      path: "Library Topic/Library Guide.md",
      body: "# Library\n",
    },
  ]);

  const app = await buildApp({
    dataRoot: defaultRepo.dataRoot,
    gitSyncRepoRoot: defaultRepo.repoRoot,
    libraryRepoRoots: [path.dirname(libraryRepo.repoRoot), workspaceRoot],
  });

  t.after(async () => {
    await app.close();
    await rm(defaultRepo.repoRoot, { recursive: true, force: true });
    await rm(libraryRepo.repoRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const defaultTreeResponse = await app.inject({
    method: "GET",
    url: "/api/tree",
  });
  assert.equal(defaultTreeResponse.statusCode, 200);
  assert.equal(defaultTreeResponse.json().topics[0].name, "Default Topic");

  const configuredRepoSelectionResponse = await app.inject({
    method: "GET",
    url: "/api/tree",
    headers: {
      [repoSelectionHeaderName]: createLibrarySelectionHeader({
        id: "configured-repo",
        name: "Configured repository",
        repoRoot: defaultRepo.repoRoot,
        dataRoot: defaultRepo.dataRoot,
      }),
    },
  });
  assert.equal(configuredRepoSelectionResponse.statusCode, 200);
  assert.equal(configuredRepoSelectionResponse.json().topics[0].name, "Default Topic");

  const librarySelection = {
    id: "library-example",
    name: "Library Example",
    repoRoot: libraryRepo.repoRoot,
  };
  const libraryTreeResponse = await app.inject({
    method: "GET",
    url: "/api/tree",
    headers: {
      [repoSelectionHeaderName]: createLibrarySelectionHeader(librarySelection),
    },
  });
  assert.equal(libraryTreeResponse.statusCode, 200);
  assert.equal(libraryTreeResponse.json().topics[0].name, "Library Topic");

  const defaultTreeAfterSwitchResponse = await app.inject({
    method: "GET",
    url: "/api/tree",
  });
  assert.equal(defaultTreeAfterSwitchResponse.statusCode, 200);
  assert.equal(defaultTreeAfterSwitchResponse.json().topics[0].name, "Default Topic");
});

test("api validates library repositories through the library test endpoint", async (t) => {
  const defaultRepo = await createGitBackedContentRepo("dacci-api-library-test-default-", [
    {
      path: "Default Topic/Default Guide.md",
      body: "# Default\n",
    },
  ]);
  const libraryRepo = await createGitBackedContentRepo("dacci-api-library-test-library-", [
    {
      path: "Library Topic/Library Guide.md",
      body: "# Library\n",
    },
    {
      path: "Library Topic/Runbooks/Deploy Guide.md",
      body: "# Deploy\n",
    },
  ]);
  const libraryRemoteRepo = await addLocalOrigin(libraryRepo.repoRoot);

  const app = await buildApp({
    dataRoot: defaultRepo.dataRoot,
    gitSyncRepoRoot: defaultRepo.repoRoot,
    libraryRepoRoots: [path.dirname(libraryRepo.repoRoot)],
  });

  t.after(async () => {
    await app.close();
    await rm(defaultRepo.repoRoot, { recursive: true, force: true });
    await rm(libraryRepo.repoRoot, { recursive: true, force: true });
    await rm(libraryRemoteRepo, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/library/test",
    payload: {
      repo: {
        id: "library-example",
        name: "Library Example",
        repoRoot: libraryRepo.repoRoot,
        releaseBranch: "main",
      },
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.repo.name, "Library Example");
  assert.equal(body.repo.kind, "library");
  assert.equal(body.repo.repoRoot, libraryRepo.repoRoot);
  assert.equal(body.repo.dataRoot, libraryRepo.dataRoot);
  assert.equal(body.repo.releaseBranch, "main");
  assert.equal(body.content.topicCount, 1);
  assert.equal(body.content.documentCount, 2);
  assert.equal(body.git.currentBranch, "main");
});

test("api reports repo context and schedule state for selected library repos", async (t) => {
  const defaultRepo = await createGitBackedContentRepo("dacci-api-library-status-default-", [
    {
      path: "Default Topic/Default Guide.md",
      body: "# Default\n",
    },
  ]);
  const libraryRepo = await createGitBackedContentRepo("dacci-api-library-status-library-", [
    {
      path: "Library Topic/Library Guide.md",
      body: "# Library\n",
    },
  ]);
  const libraryRemoteRepo = await addLocalOrigin(libraryRepo.repoRoot);
  await runGit(["remote", "set-url", "origin", "git@github.com:mkronvold/Dacci.Example.Content.git"], libraryRepo.repoRoot);

  const app = await buildApp({
    dataRoot: defaultRepo.dataRoot,
    gitSyncRepoRoot: defaultRepo.repoRoot,
    libraryRepoRoots: [path.dirname(libraryRepo.repoRoot)],
  });

  t.after(async () => {
    await app.close();
    await rm(defaultRepo.repoRoot, { recursive: true, force: true });
    await rm(libraryRepo.repoRoot, { recursive: true, force: true });
    await rm(libraryRemoteRepo, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/sync/status",
    headers: {
      [repoSelectionHeaderName]: createLibrarySelectionHeader({
        id: "library-example",
        name: "Library Example",
        repoRoot: libraryRepo.repoRoot,
        releaseBranch: "main",
      }),
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.repo.name, "mkronvold/Dacci.Example.Content");
  assert.equal(body.repo.kind, "library");
  assert.equal(body.repo.releaseBranch, "main");
  assert.equal(body.releaseBranch, "main");
  assert.equal(body.isReleaseBranch, true);
  assert.equal(body.remoteName, "origin");
  assert.equal(body.remoteUrl, "git@github.com:mkronvold/Dacci.Example.Content.git");
  assert.equal(body.schedulerSupported, true);
  assert.equal(body.scheduler.enabled, false);
  assert.equal(body.scheduler.paused, false);
  assert.equal(body.scheduler.intervalMinutes, 15);
});

test("api configures background sync separately for selected library repos", async (t) => {
  const defaultRepo = await createGitBackedContentRepo("dacci-api-library-schedule-default-", [
    {
      path: "Default Topic/Default Guide.md",
      body: "# Default\n",
    },
  ]);
  const libraryRepo = await createGitBackedContentRepo("dacci-api-library-schedule-library-", [
    {
      path: "Library Topic/Library Guide.md",
      body: "# Library\n",
    },
  ]);

  const app = await buildApp({
    dataRoot: defaultRepo.dataRoot,
    gitSyncRepoRoot: defaultRepo.repoRoot,
    libraryRepoRoots: [path.dirname(libraryRepo.repoRoot)],
  });

  t.after(async () => {
    await app.close();
    await rm(defaultRepo.repoRoot, { recursive: true, force: true });
    await rm(libraryRepo.repoRoot, { recursive: true, force: true });
  });

  const configureResponse = await app.inject({
    method: "POST",
    url: "/api/sync/schedule",
    headers: {
      [repoSelectionHeaderName]: createLibrarySelectionHeader({
        id: "library-example",
        name: "Library Example",
        repoRoot: libraryRepo.repoRoot,
        releaseBranch: "main",
      }),
    },
    payload: {
      enabled: true,
      intervalMinutes: 30,
    },
  });

  assert.equal(configureResponse.statusCode, 200);
  assert.equal(configureResponse.json().status.schedulerSupported, true);
  assert.equal(configureResponse.json().status.scheduler.enabled, true);
  assert.equal(configureResponse.json().status.scheduler.intervalMinutes, 30);

  const defaultStatusResponse = await app.inject({
    method: "GET",
    url: "/api/sync/status",
  });
  assert.equal(defaultStatusResponse.statusCode, 200);
  assert.equal(defaultStatusResponse.json().scheduler.enabled, false);
  assert.equal(defaultStatusResponse.json().scheduler.intervalMinutes, 15);

  const libraryStatusResponse = await app.inject({
    method: "GET",
    url: "/api/sync/status",
    headers: {
      [repoSelectionHeaderName]: createLibrarySelectionHeader({
        id: "library-example",
        name: "Library Example",
        repoRoot: libraryRepo.repoRoot,
        releaseBranch: "main",
      }),
    },
  });
  assert.equal(libraryStatusResponse.statusCode, 200);
  assert.equal(libraryStatusResponse.json().schedulerSupported, true);
  assert.equal(libraryStatusResponse.json().scheduler.enabled, true);
  assert.equal(libraryStatusResponse.json().scheduler.intervalMinutes, 30);

  const libraryGitInfoEntries = await readdir(path.join(libraryRepo.repoRoot, ".git", "info"));
  assert.ok(
    libraryGitInfoEntries.some((entry) => /^dacci-sync-schedule-[0-9a-f]{12}\.json$/.test(entry)),
    "expected a repo-specific scheduler state file in .git/info",
  );

  const discoveryResponse = await app.inject({
    method: "GET",
    url: "/api/library/discover",
  });
  assert.equal(discoveryResponse.statusCode, 200);
  const discoveredLibraryRepo = discoveryResponse
    .json()
    .repos.find((repo) => repo.repoRoot === libraryRepo.repoRoot);
  assert.equal(discoveredLibraryRepo?.releaseBranch, "main");
});

test("api rejects library repo selections outside configured library roots", async (t) => {
  const allowedParent = await createTempDataRoot("dacci-api-library-roots-allowed-parent-");
  const blockedParent = await createTempDataRoot("dacci-api-library-roots-blocked-parent-");
  const defaultRepo = await createGitBackedContentRepo("dacci-api-library-roots-default-", [
    {
      path: "Default Topic/Default Guide.md",
      body: "# Default\n",
    },
  ]);
  const allowedRepo = await createGitBackedContentRepo("dacci-api-library-roots-allowed-", [
    {
      path: "Allowed Topic/Allowed Guide.md",
      body: "# Allowed\n",
    },
  ], allowedParent);
  const blockedRepo = await createGitBackedContentRepo("dacci-api-library-roots-blocked-", [
    {
      path: "Blocked Topic/Blocked Guide.md",
      body: "# Blocked\n",
    },
  ], blockedParent);

  const app = await buildApp({
    dataRoot: defaultRepo.dataRoot,
    gitSyncRepoRoot: defaultRepo.repoRoot,
    libraryRepoRoots: [path.dirname(allowedRepo.repoRoot)],
  });

  t.after(async () => {
    await app.close();
    await rm(defaultRepo.repoRoot, { recursive: true, force: true });
    await rm(allowedRepo.repoRoot, { recursive: true, force: true });
    await rm(blockedRepo.repoRoot, { recursive: true, force: true });
    await rm(allowedParent, { recursive: true, force: true });
    await rm(blockedParent, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/tree",
    headers: {
      [repoSelectionHeaderName]: createLibrarySelectionHeader({
        id: "blocked-library",
        name: "Blocked Library",
        repoRoot: blockedRepo.repoRoot,
      }),
    },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /outside the configured library (registry and allowed roots|roots)/i);
});

test("api exposes tag-aware search results and document tags", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-api-search-");
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: dataRoot });

  t.after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  await app.inject({
    method: "POST",
    url: "/api/topics",
    payload: { name: "Operations" },
  });

  await app.inject({
    method: "POST",
    url: "/api/documents",
    payload: {
      topicName: "Operations",
      name: "Release Guide",
      body: "---\ntags:\n  - Release Notes\n  - Ops_Urgent\n---\n# Release\n\nFreeze starts Friday.\n",
    },
  });

  const documentResponse = await app.inject({
    method: "GET",
    url: "/api/documents?path=Operations/Release%20Guide.md",
  });

  assert.equal(documentResponse.statusCode, 200);
  assert.deepEqual(documentResponse.json().tags, ["release-notes", "ops-urgent"]);

  const response = await app.inject({
    method: "GET",
    url: "/api/search?query=tag:release-notes",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].document.path, "Operations/Release Guide.md");
  assert.equal(body.results[0].matchedField, "tag");
  assert.match(body.results[0].excerpt, /release-notes/);
});

test("api keeps malformed front matter documents available for navigation and editing", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-api-frontmatter-malformed-");
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: dataRoot });

  t.after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  await mkdir(path.join(dataRoot, "Internet"), { recursive: true });
  const malformedBody = "---\ntags:\n  - outage\n# Comcast outage troubleshooting\n";
  await writeFile(path.join(dataRoot, "Internet", "Comcast outtages.md"), malformedBody, "utf8");

  const treeResponse = await app.inject({
    method: "GET",
    url: "/api/tree",
  });

  assert.equal(treeResponse.statusCode, 200);
  assert.equal(treeResponse.json().topics[0].documents[0].path, "Internet/Comcast outtages.md");
  assert.equal(
    treeResponse.json().topics[0].documents[0].parseError,
    "Document 'Internet/Comcast outtages.md' starts with front matter but is missing a closing delimiter.",
  );

  const documentResponse = await app.inject({
    method: "GET",
    url: "/api/documents?path=Internet/Comcast%20outtages.md",
  });

  assert.equal(documentResponse.statusCode, 200);
  assert.equal(documentResponse.json().body, malformedBody);
  assert.equal(
    documentResponse.json().parseError,
    "Document 'Internet/Comcast outtages.md' starts with front matter but is missing a closing delimiter.",
  );

  const searchResponse = await app.inject({
    method: "GET",
    url: "/api/search?query=troubleshooting",
  });

  assert.equal(searchResponse.statusCode, 200);
  assert.equal(searchResponse.json().results[0].document.path, "Internet/Comcast outtages.md");
});

test("api imports documents and exports scoped bundles", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-api-transfer-");
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: dataRoot });

  t.after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  await app.inject({
    method: "POST",
    url: "/api/topics",
    payload: { name: "Operations" },
  });

  await app.inject({
    method: "POST",
    url: "/api/subtopics",
    payload: { topicName: "Operations", name: "Runbooks" },
  });

  const importResponse = await app.inject({
    method: "POST",
    url: "/api/import/documents",
    payload: {
      topicName: "Operations",
      subtopicName: "Runbooks",
      documents: [
        { name: "Deploy Guide", body: "# Deploy\n" },
        { name: "Rollback Guide", body: "# Rollback\n" },
      ],
    },
  });

  assert.equal(importResponse.statusCode, 201);
  assert.equal(importResponse.json().importedCount, 2);

  const exportResponse = await app.inject({
    method: "POST",
    url: "/api/export",
    payload: {
      scope: "subtopic",
      topicName: "Operations",
      subtopicName: "Runbooks",
    },
  });

  assert.equal(exportResponse.statusCode, 200);
  const exportBody = exportResponse.json();
  assert.equal(exportBody.format, "bundle-json");
  assert.equal(exportBody.scope.scope, "subtopic");
  assert.equal(exportBody.documents.length, 2);
});

test("api round-trips JSON bundles through the existing import and export endpoints", async (t) => {
  const sourceDataRoot = await createTempDataRoot("dacci-api-json-source-");
  const targetDataRoot = await createTempDataRoot("dacci-api-json-target-");
  const sourceApp = await buildApp({ dataRoot: sourceDataRoot, gitSyncRepoRoot: sourceDataRoot });
  const targetApp = await buildApp({ dataRoot: targetDataRoot, gitSyncRepoRoot: targetDataRoot });

  t.after(async () => {
    await sourceApp.close();
    await targetApp.close();
    await rm(sourceDataRoot, { recursive: true, force: true });
    await rm(targetDataRoot, { recursive: true, force: true });
  });

  await sourceApp.inject({
    method: "POST",
    url: "/api/topics",
    payload: { name: "Operations" },
  });
  await sourceApp.inject({
    method: "POST",
    url: "/api/subtopics",
    payload: { topicName: "Operations", name: "Runbooks" },
  });
  await sourceApp.inject({
    method: "POST",
    url: "/api/import/documents",
    payload: {
      topicName: "Operations",
      documents: [{ name: "Release Guide", body: "# Release\n" }],
    },
  });
  await sourceApp.inject({
    method: "POST",
    url: "/api/import/documents",
    payload: {
      topicName: "Operations",
      subtopicName: "Runbooks",
      documents: [{ name: "Deploy Guide", body: "# Deploy\n" }],
    },
  });

  const exportResponse = await sourceApp.inject({
    method: "POST",
    url: "/api/export",
    payload: {
      scope: "topic",
      topicName: "Operations",
      format: "bundle-json",
    },
  });

  assert.equal(exportResponse.statusCode, 200);
  const exportBody = exportResponse.json();
  assert.equal(exportBody.format, "bundle-json");
  assert.equal(exportBody.documents.length, 2);

  const importResponse = await targetApp.inject({
    method: "POST",
    url: "/api/import/documents",
    payload: {
      format: "bundle-json",
      bundle: exportBody,
    },
  });

  assert.equal(importResponse.statusCode, 201);
  assert.equal(importResponse.json().format, "bundle-json");
  assert.equal(importResponse.json().importedCount, 2);

  const treeResponse = await targetApp.inject({
    method: "GET",
    url: "/api/tree",
  });
  const tree = treeResponse.json();
  assert.equal(tree.topics[0].documents[0].path, "Operations/Release Guide.md");
  assert.equal(tree.topics[0].subtopics[0].documents[0].path, "Operations/Runbooks/Deploy Guide.md");
});

test("api exports and imports zip archives through the existing endpoints", async (t) => {
  const sourceDataRoot = await createTempDataRoot("dacci-api-zip-source-");
  const targetDataRoot = await createTempDataRoot("dacci-api-zip-target-");
  const sourceApp = await buildApp({ dataRoot: sourceDataRoot, gitSyncRepoRoot: sourceDataRoot });
  const targetApp = await buildApp({ dataRoot: targetDataRoot, gitSyncRepoRoot: targetDataRoot });

  t.after(async () => {
    await sourceApp.close();
    await targetApp.close();
    await rm(sourceDataRoot, { recursive: true, force: true });
    await rm(targetDataRoot, { recursive: true, force: true });
  });

  await sourceApp.inject({
    method: "POST",
    url: "/api/topics",
    payload: { name: "Operations" },
  });
  await sourceApp.inject({
    method: "POST",
    url: "/api/import/documents",
    payload: {
      topicName: "Operations",
      documents: [{ name: "Release Guide", body: "# Release\n" }],
    },
  });

  const exportResponse = await sourceApp.inject({
    method: "POST",
    url: "/api/export",
    payload: {
      scope: "topic",
      topicName: "Operations",
      format: "bundle-zip",
    },
  });

  assert.equal(exportResponse.statusCode, 200);
  const exportBody = exportResponse.json();
  assert.equal(exportBody.format, "bundle-zip");
  assert.equal(exportBody.mediaType, "application/zip");
  assert.equal(typeof exportBody.contentBase64, "string");

  const importResponse = await targetApp.inject({
    method: "POST",
    url: "/api/import/documents",
    payload: {
      format: "bundle-zip",
      archiveBase64: exportBody.contentBase64,
      fileName: exportBody.fileName,
    },
  });

  assert.equal(importResponse.statusCode, 201);
  assert.equal(importResponse.json().format, "bundle-zip");
  assert.equal(importResponse.json().importedCount, 1);

  const documentResponse = await targetApp.inject({
    method: "GET",
    url: "/api/documents?path=Operations/Release%20Guide.md",
  });
  assert.equal(documentResponse.statusCode, 200);
  assert.equal(documentResponse.json().body, "# Release\n");
});

test("api reports partial success when import skip mode encounters conflicts", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-api-import-skip-");
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: dataRoot });

  t.after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  await app.inject({
    method: "POST",
    url: "/api/topics",
    payload: { name: "Operations" },
  });

  await app.inject({
    method: "POST",
    url: "/api/subtopics",
    payload: { topicName: "Operations", name: "Runbooks" },
  });

  await app.inject({
    method: "POST",
    url: "/api/documents",
    payload: {
      topicName: "Operations",
      subtopicName: "Runbooks",
      name: "Deploy Guide",
      body: "# Existing\n",
    },
  });

  const importResponse = await app.inject({
    method: "POST",
    url: "/api/import/documents",
    payload: {
      topicName: "Operations",
      subtopicName: "Runbooks",
      conflictMode: "skip",
      documents: [
        { name: "Deploy Guide", body: "# Updated\n" },
        { name: "Rollback Guide", body: "# Rollback\n" },
      ],
    },
  });

  assert.equal(importResponse.statusCode, 201);
  const body = importResponse.json();
  assert.equal(body.conflictMode, "skip");
  assert.equal(body.importedCount, 1);
  assert.equal(body.skippedCount, 1);
  assert.equal(body.skipped[0].path, "Operations/Runbooks/Deploy Guide.md");
});

test("api maps recursive import source paths into flattened visible subtopics", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-api-import-folders-");
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: dataRoot });

  t.after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  await app.inject({
    method: "POST",
    url: "/api/topics",
    payload: { name: "Operations" },
  });

  await app.inject({
    method: "POST",
    url: "/api/subtopics",
    payload: { topicName: "Operations", name: "Runbooks" },
  });

  const importResponse = await app.inject({
    method: "POST",
    url: "/api/import/documents",
    payload: {
      topicName: "Operations",
      subtopicName: "Runbooks",
      folderMappingMode: "folders-to-subtopic",
      documents: [
        {
          name: "Deploy Guide",
          body: "# Deploy\n",
          sourcePath: "Deploy/API/Deploy Guide.md",
        },
      ],
    },
  });

  assert.equal(importResponse.statusCode, 201);
  const body = importResponse.json();
  assert.equal(body.folderMappingMode, "folders-to-subtopic");
  assert.equal(body.imported[0].path, "Operations/Runbooks - Deploy - API/Deploy Guide.md");
});
