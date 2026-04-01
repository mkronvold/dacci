import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitHubSync, GitHubSyncError, GitHubSyncScheduler } from "../dist/index.js";

const execFileAsync = promisify(execFile);

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  return stdout.trim();
}

async function configureGitIdentity(cwd) {
  await runGit(["config", "user.name", "Sync Test"], cwd);
  await runGit(["config", "user.email", "sync-test@example.com"], cwd);
}

async function createGitFixture(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const remoteRepo = path.join(root, "remote.git");
  const seedRepo = path.join(root, "seed");
  const workRepo = path.join(root, "work");
  const collaboratorRepo = path.join(root, "collaborator");

  await runGit(["init", "--bare", "--initial-branch=main", remoteRepo], root);
  await runGit(["init", "--initial-branch=main", seedRepo], root);
  await configureGitIdentity(seedRepo);
  await mkdir(path.join(seedRepo, "data"), { recursive: true });
  await writeFile(path.join(seedRepo, "data", "Guide.md"), "# Guide\n", "utf8");
  await runGit(["add", "data/Guide.md"], seedRepo);
  await runGit(["commit", "-m", "Initial content"], seedRepo);
  await runGit(["remote", "add", "origin", remoteRepo], seedRepo);
  await runGit(["push", "-u", "origin", "main"], seedRepo);

  await runGit(["clone", remoteRepo, workRepo], root);
  await configureGitIdentity(workRepo);
  await runGit(["clone", remoteRepo, collaboratorRepo], root);
  await configureGitIdentity(collaboratorRepo);

  return {
    root,
    remoteRepo,
    workRepo,
    collaboratorRepo,
    dataRoot: path.join(workRepo, "data"),
    collaboratorDataRoot: path.join(collaboratorRepo, "data"),
  };
}

test("github sync reports content changes", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-status-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeFile(path.join(fixture.dataRoot, "Guide.md"), "# Guide\n\nUpdated\n", "utf8");

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const status = await sync.getStatus();
  assert.equal(status.contentPath, "data");
  assert.equal(status.currentBranch, "main");
  assert.equal(status.releaseBranch, "default");
  assert.equal(status.isReleaseBranch, false);
  assert.equal(status.hasContentChanges, true);
  assert.equal(status.changedFiles[0]?.path, "data/Guide.md");
  assert.equal(status.nonContentChangedFiles.length, 0);
  assert.equal(status.pushBlockers.length, 0);
  assert.deepEqual(status.pullBlockers, ["Dacci sync pull requires a clean working tree. Push local changes before pulling."]);
  assert.ok(
    status.recommendedActions.includes("Push local changes before pulling."),
    "expected pull guidance in recommended actions",
  );
});

test("github sync validates split-ready repo and content roots", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-validate-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const validation = await sync.validateConfiguration();

  assert.equal(validation.repoRoot, fixture.workRepo);
  assert.equal(validation.contentRoot, fixture.dataRoot);
  assert.equal(validation.contentPath, "data");
  assert.equal(validation.currentBranch, "main");
});

test("github sync marks the configured repo as safe for Git ownership checks", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-safe-directory-");
  const originalAssumeDifferentOwner = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;

  t.after(async () => {
    if (originalAssumeDifferentOwner === undefined) {
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    } else {
      process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = originalAssumeDifferentOwner;
    }
    await rm(fixture.root, { recursive: true, force: true });
  });

  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const validation = await sync.validateConfiguration();
  assert.equal(validation.repoRoot, fixture.workRepo);
  assert.equal(validation.contentRoot, fixture.dataRoot);
  assert.equal(validation.contentPath, "data");
});

test("github sync rejects a configured repo root that is not a git repository", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dacci-github-sync-invalid-repo-"));
  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot, { recursive: true });

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const sync = new GitHubSync({
    repoRoot: root,
    contentRoot: dataRoot,
  });

  await assert.rejects(sync.validateConfiguration(), (error) => {
    assert.ok(error instanceof GitHubSyncError);
    assert.equal(error.code, "invalid_configuration");
    assert.match(error.message, /is not a Git repository/);
    return true;
  });
});

test("github sync rejects a missing content root", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-missing-content-");
  const missingContentRoot = path.join(fixture.workRepo, "missing-data");

  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: missingContentRoot,
  });

  await assert.rejects(sync.validateConfiguration(), (error) => {
    assert.ok(error instanceof GitHubSyncError);
    assert.equal(error.code, "invalid_configuration");
    assert.match(error.message, /Content root .* does not exist or is not accessible/);
    return true;
  });
});

test("github sync commits and pushes content-only changes", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-push-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeFile(path.join(fixture.dataRoot, "Guide.md"), "# Guide\n\nSynced\n", "utf8");

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const result = await sync.pushContent({
    message: "Sync content updates",
  });

  assert.equal(result.action, "push");
  assert.ok(result.commitSha);
  assert.equal(result.status.hasContentChanges, false);
  assert.equal(result.status.ahead, 0);
  assert.equal(result.status.behind, 0);

  await runGit(["pull", "--ff-only"], fixture.collaboratorRepo);
  const collaboratorBody = await readFile(path.join(fixture.collaboratorDataRoot, "Guide.md"), "utf8");
  assert.equal(collaboratorBody, "# Guide\n\nSynced\n");
});

test("github sync pushes to a local upstream when Git assumes different ownership", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-safe-remote-");
  const originalAssumeDifferentOwner = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;

  t.after(async () => {
    if (originalAssumeDifferentOwner === undefined) {
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    } else {
      process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = originalAssumeDifferentOwner;
    }
    await rm(fixture.root, { recursive: true, force: true });
  });

  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
  await writeFile(path.join(fixture.dataRoot, "Guide.md"), "# Guide\n\nSafe remote\n", "utf8");

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const result = await sync.pushContent({
    message: "Sync content updates",
  });

  assert.equal(result.action, "push");
  if (originalAssumeDifferentOwner === undefined) {
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  } else {
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = originalAssumeDifferentOwner;
  }
  await runGit(["pull", "--ff-only"], fixture.collaboratorRepo);
  const collaboratorBody = await readFile(path.join(fixture.collaboratorDataRoot, "Guide.md"), "utf8");
  assert.equal(collaboratorBody, "# Guide\n\nSafe remote\n");
});

test("github sync can override the configured remote URL at runtime", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-remote-url-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await runGit(["remote", "set-url", "origin", "https://example.invalid/not-used.git"], fixture.workRepo);
  await writeFile(path.join(fixture.dataRoot, "Guide.md"), "# Guide\n\nOverridden remote\n", "utf8");

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
    remoteUrl: fixture.remoteRepo,
  });

  const result = await sync.pushContent({
    message: "Sync content updates",
  });

  assert.equal(result.action, "push");
  assert.equal(result.status.remoteName, "origin");
  assert.equal(result.status.remoteUrl, fixture.remoteRepo);
  await runGit(["pull", "--ff-only"], fixture.collaboratorRepo);
  const collaboratorBody = await readFile(path.join(fixture.collaboratorDataRoot, "Guide.md"), "utf8");
  assert.equal(collaboratorBody, "# Guide\n\nOverridden remote\n");
});

test("github sync pushes content while leaving non-content working tree changes alone", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-guard-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeFile(path.join(fixture.workRepo, "notes.txt"), "tracked\n", "utf8");
  await runGit(["add", "notes.txt"], fixture.workRepo);
  await runGit(["commit", "-m", "Track notes"], fixture.workRepo);
  await runGit(["push", "origin", "main"], fixture.workRepo);

  await writeFile(path.join(fixture.dataRoot, "Guide.md"), "# Guide\n\nChanged\n", "utf8");
  await writeFile(path.join(fixture.workRepo, "notes.txt"), "tracked and modified\n", "utf8");

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const statusBeforePush = await sync.getStatus();
  assert.equal(statusBeforePush.nonContentChangedFiles.length, 1);
  assert.equal(statusBeforePush.pushBlockers.length, 0);

  const result = await sync.pushContent({
    message: "Push content only",
  });

  assert.equal(result.action, "push");
  assert.equal(result.status.hasContentChanges, false);
  assert.equal(result.status.nonContentChangedFiles.length, 1);
  assert.equal(result.status.pushBlockers.length, 0);

  const localNotesBody = await readFile(path.join(fixture.workRepo, "notes.txt"), "utf8");
  assert.equal(localNotesBody, "tracked and modified\n");

  await runGit(["pull", "--ff-only"], fixture.collaboratorRepo);
  const collaboratorGuideBody = await readFile(path.join(fixture.collaboratorDataRoot, "Guide.md"), "utf8");
  assert.equal(collaboratorGuideBody, "# Guide\n\nChanged\n");
  const collaboratorNotesBody = await readFile(path.join(fixture.collaboratorRepo, "notes.txt"), "utf8");
  assert.equal(collaboratorNotesBody, "tracked\n");
});

test("github sync reports Dacci wording for committed non-content changes", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-committed-guard-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeFile(path.join(fixture.workRepo, "notes.txt"), "tracked\n", "utf8");
  await runGit(["add", "notes.txt"], fixture.workRepo);
  await runGit(["commit", "-m", "Track notes"], fixture.workRepo);

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const status = await sync.getStatus();
  assert.deepEqual(status.pullBlockers, [
    "Dacci sync pull only supports content. Move non-content commits off this branch or publish them separately before pulling.",
  ]);
  assert.deepEqual(status.pushBlockers, []);
  assert.ok(
    status.recommendedActions.includes(
      "Dacci sync push leaves non-content commits local. Publish them separately if you want them on the remote branch.",
    ),
    "expected selective push guidance in recommended actions",
  );
  assert.ok(
    status.recommendedActions.includes("Publish non-content commits separately before pulling remote content."),
    "expected pull guidance for committed non-content changes",
  );
});

test("github sync pushes content while keeping committed non-content changes local", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-selective-committed-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeFile(path.join(fixture.workRepo, "notes.txt"), "tracked\n", "utf8");
  await runGit(["add", "notes.txt"], fixture.workRepo);
  await runGit(["commit", "-m", "Track notes"], fixture.workRepo);
  await runGit(["push", "origin", "main"], fixture.workRepo);

  await writeFile(path.join(fixture.workRepo, "notes.txt"), "local only\n", "utf8");
  await runGit(["add", "notes.txt"], fixture.workRepo);
  await runGit(["commit", "-m", "Local notes update"], fixture.workRepo);

  await writeFile(path.join(fixture.dataRoot, "Guide.md"), "# Guide\n\nSelective push content\n", "utf8");

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const result = await sync.pushContent({
    message: "Sync content updates",
  });

  assert.equal(result.action, "push");
  assert.equal(result.status.behind, 0);
  assert.deepEqual(result.status.pushBlockers, []);
  assert.deepEqual(result.status.nonContentCommittedFiles, ["notes.txt"]);

  const aheadFiles = await runGit(["diff", "--name-only", "origin/main..HEAD"], fixture.workRepo);
  assert.equal(aheadFiles, "notes.txt");

  const localGuideBody = await readFile(path.join(fixture.dataRoot, "Guide.md"), "utf8");
  assert.equal(localGuideBody, "# Guide\n\nSelective push content\n");
  const localNotesBody = await readFile(path.join(fixture.workRepo, "notes.txt"), "utf8");
  assert.equal(localNotesBody, "local only\n");

  await runGit(["pull", "--ff-only"], fixture.collaboratorRepo);
  const collaboratorGuideBody = await readFile(path.join(fixture.collaboratorDataRoot, "Guide.md"), "utf8");
  assert.equal(collaboratorGuideBody, "# Guide\n\nSelective push content\n");
  const collaboratorNotesBody = await readFile(path.join(fixture.collaboratorRepo, "notes.txt"), "utf8");
  assert.equal(collaboratorNotesBody, "tracked\n");
});

test("github sync allows untracked non-content files during push", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-untracked-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeFile(path.join(fixture.dataRoot, "Guide.md"), "# Guide\n\nChanged\n", "utf8");
  await writeFile(path.join(fixture.workRepo, "notes.txt"), "untracked\n", "utf8");

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const result = await sync.pushContent({
    message: "Sync content updates",
  });

  assert.equal(result.action, "push");
  assert.equal(result.status.hasContentChanges, false);
});

test("github sync pulls remote content changes", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-pull-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeFile(path.join(fixture.collaboratorDataRoot, "Guide.md"), "# Guide\n\nRemote update\n", "utf8");
  await runGit(["add", "data/Guide.md"], fixture.collaboratorRepo);
  await runGit(["commit", "-m", "Remote update"], fixture.collaboratorRepo);
  await runGit(["push", "origin", "main"], fixture.collaboratorRepo);

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });

  const result = await sync.pullContent();
  assert.equal(result.action, "pull");
  assert.equal(result.status.behind, 0);

  const localBody = await readFile(path.join(fixture.dataRoot, "Guide.md"), "utf8");
  assert.equal(localBody, "# Guide\n\nRemote update\n");
});

test("github sync scheduler pulls remote content during a scheduled run", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-scheduler-pull-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeFile(path.join(fixture.collaboratorDataRoot, "Guide.md"), "# Guide\n\nScheduled update\n", "utf8");
  await runGit(["add", "data/Guide.md"], fixture.collaboratorRepo);
  await runGit(["commit", "-m", "Scheduled remote update"], fixture.collaboratorRepo);
  await runGit(["push", "origin", "main"], fixture.collaboratorRepo);

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });
  const scheduler = new GitHubSyncScheduler(sync);

  await scheduler.configureSchedule({
    enabled: true,
    intervalMinutes: 15,
  });

  const status = await scheduler.runScheduledCycleNow();
  assert.equal(status.behind, 0);
  assert.equal(status.scheduler?.enabled, true);
  assert.equal(status.scheduler?.paused, false);
  assert.ok(status.scheduler?.lastPullAt);

  const localBody = await readFile(path.join(fixture.dataRoot, "Guide.md"), "utf8");
  assert.equal(localBody, "# Guide\n\nScheduled update\n");
});

test("github sync scheduler pauses when guarded pull blockers are present", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-scheduler-pause-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  await writeFile(path.join(fixture.collaboratorDataRoot, "Guide.md"), "# Guide\n\nRemote update\n", "utf8");
  await runGit(["add", "data/Guide.md"], fixture.collaboratorRepo);
  await runGit(["commit", "-m", "Remote update"], fixture.collaboratorRepo);
  await runGit(["push", "origin", "main"], fixture.collaboratorRepo);

  await writeFile(path.join(fixture.dataRoot, "Guide.md"), "# Guide\n\nLocal draft\n", "utf8");

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });
  const scheduler = new GitHubSyncScheduler(sync);

  await scheduler.configureSchedule({
    enabled: true,
    intervalMinutes: 15,
  });

  const status = await scheduler.runScheduledCycleNow();
  assert.equal(status.scheduler?.enabled, true);
  assert.equal(status.scheduler?.paused, true);
  assert.match(status.scheduler?.lastError ?? "", /clean working tree/i);

  const localBody = await readFile(path.join(fixture.dataRoot, "Guide.md"), "utf8");
  assert.equal(localBody, "# Guide\n\nLocal draft\n");
});

test("github sync scheduler can persist state to a custom file", async (t) => {
  const fixture = await createGitFixture("dacci-github-sync-scheduler-custom-file-");
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  const sync = new GitHubSync({
    repoRoot: fixture.workRepo,
    contentRoot: fixture.dataRoot,
  });
  const scheduler = new GitHubSyncScheduler(sync, {
    stateFileName: "dacci-sync-schedule-library.json",
  });

  await scheduler.configureSchedule({
    enabled: true,
    intervalMinutes: 20,
  });
  await scheduler.stop();

  const customStatePath = path.join(fixture.workRepo, ".git", "info", "dacci-sync-schedule-library.json");
  const persistedState = JSON.parse(await readFile(customStatePath, "utf8"));
  assert.equal(persistedState.enabled, true);
  assert.equal(persistedState.intervalMinutes, 20);

  await assert.rejects(
    readFile(path.join(fixture.workRepo, ".git", "info", "dacci-sync-schedule.json"), "utf8"),
    (error) => {
      assert.equal(error?.code, "ENOENT");
      return true;
    },
  );
});
