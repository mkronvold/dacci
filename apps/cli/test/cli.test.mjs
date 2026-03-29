import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function runCli(args, env = {}, cwd = undefined) {
  const { stdout } = await execFileAsync("node", [cliPath, ...args], {
    ...(cwd !== undefined ? { cwd } : {}),
    env: {
      ...process.env,
      ...env,
    },
    maxBuffer: 10 * 1024 * 1024,
  });

  return JSON.parse(stdout);
}

async function runCliText(args, env = {}, cwd = undefined) {
  return execFileAsync("node", [cliPath, ...args], {
    ...(cwd !== undefined ? { cwd } : {}),
    env: {
      ...process.env,
      ...env,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function runGit(args, cwd) {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("cli creates content and prints the logical tree", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-"));
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await runCli(["--data-root", dataRoot, "topic", "create", "Operations"]);
  await runCli(["--data-root", dataRoot, "subtopic", "create", "Operations", "Runbooks"]);
  await runCli([
    "--data-root",
    dataRoot,
    "document",
    "create",
    "--topic",
    "Operations",
    "--subtopic",
    "Runbooks",
    "--name",
    "Deploy Guide",
    "--body",
    "# Deploy\n",
  ]);
  await runCli([
    "--data-root",
    dataRoot,
    "document",
    "move",
    "Operations/Runbooks/Deploy Guide.md",
    "--topic",
    "Operations",
  ]);

  const tree = await runCli(["--data-root", dataRoot, "tree"]);
  assert.equal(tree.topics[0].documents[0].path, "Operations/Deploy Guide.md");
});

test("cli reports sync status for git-backed content", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-sync-"));
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, "Guide.md"), "# Guide\n", "utf8");

  await runGit(["init", "--initial-branch=main"], repoRoot);
  await runGit(["config", "user.name", "CLI Test"], repoRoot);
  await runGit(["config", "user.email", "cli-test@example.com"], repoRoot);
  await runGit(["add", "data/Guide.md"], repoRoot);
  await runGit(["commit", "-m", "Initial content"], repoRoot);

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const status = await runCli([
    "--data-root",
    dataRoot,
    "--repo-root",
    repoRoot,
    "sync",
    "status",
  ]);

  assert.equal(status.currentBranch, "main");
  assert.equal(status.releaseBranch, "default");
  assert.equal(status.isReleaseBranch, false);
  assert.equal(status.contentPath, "data");
  assert.equal(status.hasContentChanges, false);
  assert.equal(status.nonContentChangedFiles.length, 0);
  assert.equal(status.pushBlockers.length, 0);
  assert.ok(status.pullBlockers.length > 0);
  assert.equal(status.scheduler.enabled, false);
  assert.equal(status.scheduler.intervalMinutes, 15);
});

test("cli help documents explicit split-repo path overrides", async () => {
  const { stdout } = await runCliText(["--help"]);

  assert.match(stdout, /Dacci CLI/);
  assert.match(stdout, /dacci \[global-options\]/);
  assert.match(stdout, /DATA_ROOT=..\/E2Open\.KPE\.Content\/data/);
  assert.match(stdout, /GIT_SYNC_REPO_ROOT=..\/E2Open\.KPE\.Content/);
});

test("cli reports a clear error when sync repo root is not a git repository", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-invalid-repo-"));
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    runCliText(["--data-root", dataRoot, "--repo-root", repoRoot, "sync", "status"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /is not a Git repository/);
      return true;
    },
  );
});

test("cli configures and reports background sync schedule state", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-schedule-"));
  const dataRoot = path.join(repoRoot, "data");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, "Guide.md"), "# Guide\n", "utf8");

  await runGit(["init", "--initial-branch=main"], repoRoot);
  await runGit(["config", "user.name", "CLI Schedule Test"], repoRoot);
  await runGit(["config", "user.email", "cli-schedule@example.com"], repoRoot);
  await runGit(["add", "data/Guide.md"], repoRoot);
  await runGit(["commit", "-m", "Initial content"], repoRoot);

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const configured = await runCli([
    "--data-root",
    dataRoot,
    "--repo-root",
    repoRoot,
    "sync",
    "schedule",
    "configure",
    "--enable",
    "--interval-minutes",
    "20",
  ]);

  assert.equal(configured.status.scheduler.enabled, true);
  assert.equal(configured.status.scheduler.intervalMinutes, 20);

  const paused = await runCli([
    "--data-root",
    dataRoot,
    "--repo-root",
    repoRoot,
    "sync",
    "schedule",
    "pause",
  ]);
  assert.equal(paused.status.scheduler.paused, true);

  const resumed = await runCli([
    "--data-root",
    dataRoot,
    "--repo-root",
    repoRoot,
    "sync",
    "schedule",
    "resume",
  ]);
  assert.equal(resumed.status.scheduler.paused, false);

  const status = await runCli([
    "--data-root",
    dataRoot,
    "--repo-root",
    repoRoot,
    "sync",
    "schedule",
    "status",
  ]);
  assert.equal(status.scheduler.enabled, true);
  assert.equal(status.scheduler.intervalMinutes, 20);
});

test("cli accepts npm_config_message fallback for sync push", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-push-"));
  const remoteRepo = path.join(root, "remote.git");
  const repoRoot = path.join(root, "work");
  const dataRoot = path.join(repoRoot, "data");

  await runGit(["init", "--bare", "--initial-branch=main", remoteRepo], root);
  await runGit(["clone", remoteRepo, repoRoot], root);
  await runGit(["config", "user.name", "CLI Push Test"], repoRoot);
  await runGit(["config", "user.email", "cli-push@example.com"], repoRoot);
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, "Guide.md"), "# Guide\n", "utf8");
  await runGit(["add", "data/Guide.md"], repoRoot);
  await runGit(["commit", "-m", "Initial content"], repoRoot);
  await runGit(["push", "-u", "origin", "main"], repoRoot);

  await writeFile(path.join(dataRoot, "Guide.md"), "# Guide\n\nUpdated\n", "utf8");

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const result = await runCli(
    [
      "--data-root",
      dataRoot,
      "--repo-root",
      repoRoot,
      "sync",
      "push",
    ],
    {
      npm_config_message: "Initial sync",
    },
  );

  assert.equal(result.action, "push");
  assert.equal(result.status.hasContentChanges, false);
});

test("cli searches imported content and exports a topic bundle to disk", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-discovery-"));
  const dataRoot = path.join(repoRoot, "data");
  const importRoot = path.join(repoRoot, "imports");
  const exportRoot = path.join(repoRoot, "exports");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(importRoot, { recursive: true });
  await writeFile(path.join(importRoot, "Release Guide.md"), "# Release\n\nFreeze starts Friday.\n", "utf8");

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await runCli(["--data-root", dataRoot, "topic", "create", "Operations"]);
  await runCli([
    "--data-root",
    dataRoot,
    "import",
    "file",
    "--topic",
    "Operations",
    "--file",
    path.join(importRoot, "Release Guide.md"),
  ]);

  const searchResults = await runCli(["--data-root", dataRoot, "search", "freeze"]);
  assert.equal(searchResults.results.length, 1);
  assert.equal(searchResults.results[0].document.path, "Operations/Release Guide.md");

  const exportResult = await runCli([
    "--data-root",
    dataRoot,
    "export",
    "topic",
    "Operations",
    "--output",
    exportRoot,
  ]);

  assert.equal(exportResult.exported, true);
  assert.equal(exportResult.format, "directory");

  const exportedBody = await readFile(
    path.join(exportRoot, "Operations", "Release Guide.md"),
    "utf8",
  );
  assert.equal(exportedBody, "# Release\n\nFreeze starts Friday.\n");
});

test("cli exposes document tags and tag-aware search", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-tags-"));
  const dataRoot = path.join(repoRoot, "data");
  const sourceFile = path.join(repoRoot, "Release Guide.md");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(
    sourceFile,
    "---\ntags:\n  - Release Notes\n  - Ops_Urgent\n---\n# Release\n\nFreeze starts Friday.\n",
    "utf8",
  );

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await runCli(["--data-root", dataRoot, "topic", "create", "Operations"]);
  await runCli([
    "--data-root",
    dataRoot,
    "document",
    "create",
    "--topic",
    "Operations",
    "--name",
    "Release Guide",
    "--file",
    sourceFile,
  ]);

  const document = await runCli([
    "--data-root",
    dataRoot,
    "document",
    "read",
    "Operations/Release Guide.md",
  ]);
  assert.deepEqual(document.tags, ["release-notes", "ops-urgent"]);

  const searchResults = await runCli(["--data-root", dataRoot, "search", "tag:ops-urgent"]);
  assert.equal(searchResults.results.length, 1);
  assert.equal(searchResults.results[0].matchedField, "tag");
  assert.match(searchResults.results[0].excerpt, /ops-urgent/);
});

test("cli round-trips JSON bundles and zip archives", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-transfer-"));
  const sourceDataRoot = path.join(root, "source-data");
  const targetJsonDataRoot = path.join(root, "target-json-data");
  const targetZipDataRoot = path.join(root, "target-zip-data");
  const exportsRoot = path.join(root, "exports");

  await mkdir(sourceDataRoot, { recursive: true });
  await mkdir(targetJsonDataRoot, { recursive: true });
  await mkdir(targetZipDataRoot, { recursive: true });
  await mkdir(exportsRoot, { recursive: true });

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await runCli(["--data-root", sourceDataRoot, "topic", "create", "Operations"]);
  await runCli(["--data-root", sourceDataRoot, "subtopic", "create", "Operations", "Runbooks"]);
  await runCli([
    "--data-root",
    sourceDataRoot,
    "document",
    "create",
    "--topic",
    "Operations",
    "--name",
    "Release Guide",
    "--body",
    "# Release\n",
  ]);
  await runCli([
    "--data-root",
    sourceDataRoot,
    "document",
    "create",
    "--topic",
    "Operations",
    "--subtopic",
    "Runbooks",
    "--name",
    "Deploy Guide",
    "--body",
    "# Deploy\n",
  ]);

  const jsonBundlePath = path.join(exportsRoot, "operations.json");
  const zipBundlePath = path.join(exportsRoot, "operations.zip");

  const jsonExport = await runCli([
    "--data-root",
    sourceDataRoot,
    "export",
    "topic",
    "Operations",
    "--format",
    "bundle-json",
    "--output",
    jsonBundlePath,
  ]);
  assert.equal(jsonExport.exported, true);
  assert.equal(jsonExport.format, "bundle-json");

  const jsonBundle = JSON.parse(await readFile(jsonBundlePath, "utf8"));
  assert.equal(jsonBundle.format, "bundle-json");
  assert.equal(jsonBundle.documents.length, 2);

  const jsonImport = await runCli([
    "--data-root",
    targetJsonDataRoot,
    "import",
    "bundle",
    "--file",
    jsonBundlePath,
  ]);
  assert.equal(jsonImport.format, "bundle-json");
  assert.equal(jsonImport.importedCount, 2);

  const jsonTree = await runCli(["--data-root", targetJsonDataRoot, "tree"]);
  assert.equal(jsonTree.topics[0].documents[0].path, "Operations/Release Guide.md");
  assert.equal(jsonTree.topics[0].subtopics[0].documents[0].path, "Operations/Runbooks/Deploy Guide.md");

  const zipExport = await runCli([
    "--data-root",
    sourceDataRoot,
    "export",
    "topic",
    "Operations",
    "--format",
    "bundle-zip",
    "--output",
    zipBundlePath,
  ]);
  assert.equal(zipExport.exported, true);
  assert.equal(zipExport.format, "bundle-zip");
  await access(zipBundlePath);

  const zipImport = await runCli([
    "--data-root",
    targetZipDataRoot,
    "import",
    "bundle",
    "--file",
    zipBundlePath,
  ]);
  assert.equal(zipImport.format, "bundle-zip");
  assert.equal(zipImport.importedCount, 2);

  const zipTree = await runCli(["--data-root", targetZipDataRoot, "tree"]);
  assert.equal(zipTree.topics[0].documents[0].path, "Operations/Release Guide.md");
  assert.equal(zipTree.topics[0].subtopics[0].documents[0].path, "Operations/Runbooks/Deploy Guide.md");
});

test("cli supports skip conflict mode for directory imports", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-import-skip-"));
  const dataRoot = path.join(repoRoot, "data");
  const importRoot = path.join(repoRoot, "imports");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(importRoot, { recursive: true });
  await writeFile(path.join(importRoot, "Deploy Guide.md"), "# Updated\n", "utf8");
  await writeFile(path.join(importRoot, "Rollback Guide.md"), "# Rollback\n", "utf8");

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await runCli(["--data-root", dataRoot, "topic", "create", "Operations"]);
  await runCli(["--data-root", dataRoot, "subtopic", "create", "Operations", "Runbooks"]);
  await runCli([
    "--data-root",
    dataRoot,
    "document",
    "create",
    "--topic",
    "Operations",
    "--subtopic",
    "Runbooks",
    "--name",
    "Deploy Guide",
    "--body",
    "# Existing\n",
  ]);

  const result = await runCli([
    "--data-root",
    dataRoot,
    "import",
    "directory",
    "--topic",
    "Operations",
    "--subtopic",
    "Runbooks",
    "--dir",
    importRoot,
    "--conflict-mode",
    "skip",
  ]);

  assert.equal(result.conflictMode, "skip");
  assert.equal(result.importedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.skipped[0].path, "Operations/Runbooks/Deploy Guide.md");

  const existingBody = await readFile(
    path.join(dataRoot, "Operations", "Runbooks", "Deploy Guide.md"),
    "utf8",
  );
  assert.equal(existingBody, "# Existing\n");
});

test("cli maps recursive directory imports into flattened visible subtopics by default", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dacci-cli-import-recursive-"));
  const dataRoot = path.join(repoRoot, "data");
  const importRoot = path.join(repoRoot, "imports");
  await mkdir(path.join(importRoot, "Deploy", "API"), { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(importRoot, "Deploy", "API", "Guide.md"), "# API Guide\n", "utf8");
  await writeFile(path.join(importRoot, "Overview.md"), "# Overview\n", "utf8");

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await runCli(["--data-root", dataRoot, "topic", "create", "Operations"]);
  await runCli(["--data-root", dataRoot, "subtopic", "create", "Operations", "Runbooks"]);

  const result = await runCli([
    "--data-root",
    dataRoot,
    "import",
    "directory",
    "--topic",
    "Operations",
    "--subtopic",
    "Runbooks",
    "--dir",
    importRoot,
  ]);

  assert.equal(result.folderMappingMode, "folders-to-subtopic");
  assert.equal(result.importedCount, 2);

  const tree = await runCli(["--data-root", dataRoot, "tree"]);
  const operationsTopic = tree.topics.find((topic) => topic.name === "Operations");
  assert.ok(operationsTopic);
  assert.equal(operationsTopic.subtopics.some((subtopic) => subtopic.name === "Runbooks - Deploy - API"), true);
  assert.equal(operationsTopic.subtopics.some((subtopic) => subtopic.name === "Runbooks"), true);
});
