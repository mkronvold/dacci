import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildApp, validateAppRuntimeConfiguration } from "../dist/app.js";

const execFileAsync = promisify(execFile);

async function createTempDataRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runGit(args, cwd) {
  await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
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

test("api advertises the phase 12 runtime endpoints", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-api-info-");
  const app = await buildApp({ dataRoot, gitSyncRepoRoot: dataRoot });

  t.after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/api",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.phase, "dacci-public-seed");
  assert.equal(body.service, "Dacci API");
  assert.ok(body.endpoints.includes("/ready"));
  assert.ok(body.endpoints.includes("/api/search"));
  assert.ok(body.endpoints.includes("/api/import/documents"));
  assert.ok(body.endpoints.includes("/api/export"));
  assert.ok(body.endpoints.includes("/api/topics"));
  assert.ok(body.endpoints.includes("/api/subtopics"));
  assert.ok(body.endpoints.includes("/api/sync/schedule"));
  assert.ok(body.endpoints.includes("/api/sync/schedule/pause"));
  assert.ok(body.endpoints.includes("/api/sync/schedule/resume"));
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
      `ssh -i ${path.join(repoRoot, "missing-id_ed25519")} -o IdentitiesOnly=yes -o UserKnownHostsFile=${path.join(repoRoot, "missing-known_hosts")}`,
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
      "access-control-request-headers": "content-type",
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.match(response.headers["access-control-allow-methods"], /\bPUT\b/);
  assert.match(response.headers["access-control-allow-methods"], /\bPATCH\b/);
  assert.match(response.headers["access-control-allow-methods"], /\bDELETE\b/);
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
