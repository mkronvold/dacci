import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ContentEngine } from "../dist/index.js";

async function createTempDataRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("content engine keeps topic-level document paths logical while storing them in CatchAll", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });

  await engine.createTopic("Operations");
  await engine.createSubtopic("Operations", "Runbooks");
  await engine.createDocument({
    topicName: "Operations",
    subtopicName: "Runbooks",
    name: "Deploy Guide",
    body: "# Deploy\n",
  });

  const movedDocument = await engine.moveDocument("Operations/Runbooks/Deploy Guide.md", {
    topicName: "Operations",
  });
  assert.equal(movedDocument.path, "Operations/Deploy Guide.md");
  assert.equal(movedDocument.subtopicName, undefined);

  const renamedDocument = await engine.renameDocument("Operations/Deploy Guide.md", "Release Guide");
  assert.equal(renamedDocument.path, "Operations/Release Guide.md");

  await access(path.join(dataRoot, "Operations", "CatchAll", "Release Guide.md"));

  const tree = await engine.getTree();
  assert.equal(tree.topics[0]?.documents[0]?.path, "Operations/Release Guide.md");
  assert.equal(tree.topics[0]?.subtopics[0]?.name, "Runbooks");
  assert.equal(tree.topics[0]?.subtopics[0]?.documents.length, 0);
});

test("content engine resolves legacy topic-level storage without CatchAll", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-legacy-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  await mkdir(path.join(dataRoot, "Legacy"), { recursive: true });
  await writeFile(path.join(dataRoot, "Legacy", "Overview.md"), "# Overview\n", "utf8");

  const engine = new ContentEngine({ dataRoot });
  const document = await engine.getDocument("Legacy/Overview.md");
  assert.equal(document.path, "Legacy/Overview.md");
  assert.equal(document.body, "# Overview\n");

  const updatedDocument = await engine.updateDocument("Legacy/Overview.md", "# Updated\n");
  assert.equal(updatedDocument.path, "Legacy/Overview.md");

  const fileBody = await readFile(path.join(dataRoot, "Legacy", "Overview.md"), "utf8");
  assert.equal(fileBody, "# Updated\n");
});

test("content engine searches documents and returns body excerpts", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-search-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");
  await engine.createSubtopic("Operations", "Runbooks");
  await engine.createDocument({
    topicName: "Operations",
    name: "Release Guide",
    body: "# Release\n\nDeployment freeze starts Friday.\n",
  });
  await engine.createDocument({
    topicName: "Operations",
    subtopicName: "Runbooks",
    name: "Deploy Guide",
    body: "# Deploy\n\nFollow the release checklist.\n",
  });

  const bodySearch = await engine.searchDocuments("freeze");
  assert.equal(bodySearch.results.length, 1);
  assert.equal(bodySearch.results[0]?.document.path, "Operations/Release Guide.md");
  assert.equal(bodySearch.results[0]?.matchedField, "body");
  assert.match(bodySearch.results[0]?.excerpt ?? "", /freeze/i);

  const pathSearch = await engine.searchDocuments("runbooks");
  assert.equal(pathSearch.results.length, 1);
  assert.equal(pathSearch.results[0]?.document.path, "Operations/Runbooks/Deploy Guide.md");
  assert.equal(pathSearch.results[0]?.matchedField, "path");
});

test("content engine parses normalized front matter tags and supports tag-aware search", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-tags-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");
  await engine.createDocument({
    topicName: "Operations",
    name: "Release Guide",
    body: "---\ntags:\n  - Release Notes\n  - Ops_Urgent\n  - release-notes\n---\n# Release\n\nFreeze starts Friday.\n",
  });

  const document = await engine.getDocument("Operations/Release Guide.md");
  assert.deepEqual(document.tags, ["release-notes", "ops-urgent"]);
  assert.match(document.body, /^---\n/);

  const tree = await engine.getTree();
  assert.deepEqual(tree.topics[0]?.documents[0]?.tags, ["release-notes", "ops-urgent"]);

  const explicitTagSearch = await engine.searchDocuments("tag:ops urgent");
  assert.equal(explicitTagSearch.results.length, 1);
  assert.equal(explicitTagSearch.results[0]?.matchedField, "tag");
  assert.match(explicitTagSearch.results[0]?.excerpt ?? "", /ops-urgent/);

  const generalTagSearch = await engine.searchDocuments("release-notes");
  assert.equal(generalTagSearch.results.length, 1);
  assert.equal(generalTagSearch.results[0]?.matchedField, "tag");
});

test("content engine rejects invalid front matter tag shapes", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-tags-invalid-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");
  await assert.rejects(
    () =>
      engine.createDocument({
        topicName: "Operations",
        name: "Broken Tags",
        body: "---\ntags:\n  priority: high\n---\n# Broken\n",
      }),
    /must declare tags as a string or string array/,
  );
});

test("content engine imports documents and exports scoped bundles", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-transfer-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");
  await engine.createSubtopic("Operations", "Runbooks");

  const importResult = await engine.importDocuments({
    topicName: "Operations",
    subtopicName: "Runbooks",
    documents: [
      { name: "Deploy Guide", body: "# Deploy\n" },
      { name: "Rollback Guide.md", body: "# Rollback\n" },
    ],
  });

  assert.equal(importResult.importedCount, 2);
  assert.equal(importResult.skippedCount, 0);
  assert.equal(importResult.imported[0]?.path, "Operations/Runbooks/Deploy Guide.md");
  assert.equal(importResult.imported[1]?.path, "Operations/Runbooks/Rollback Guide.md");

  const exportBundle = await engine.exportDocuments({
    scope: "subtopic",
    topicName: "Operations",
    subtopicName: "Runbooks",
  });

  assert.equal(exportBundle.scope.scope, "subtopic");
  assert.equal(exportBundle.documents.length, 2);
  assert.equal(exportBundle.documents[0]?.path, "Operations/Runbooks/Deploy Guide.md");
  assert.equal(exportBundle.documents[1]?.path, "Operations/Runbooks/Rollback Guide.md");
});

test("content engine round-trips JSON bundles across logical paths", async (t) => {
  const sourceDataRoot = await createTempDataRoot("dacci-engine-bundle-source-");
  const targetDataRoot = await createTempDataRoot("dacci-engine-bundle-target-");

  t.after(async () => {
    await rm(sourceDataRoot, { recursive: true, force: true });
    await rm(targetDataRoot, { recursive: true, force: true });
  });

  const sourceEngine = new ContentEngine({ dataRoot: sourceDataRoot });
  await sourceEngine.createTopic("Operations");
  await sourceEngine.createSubtopic("Operations", "Runbooks");
  await sourceEngine.createDocument({
    topicName: "Operations",
    name: "Release Guide",
    body: "# Release\n",
  });
  await sourceEngine.createDocument({
    topicName: "Operations",
    subtopicName: "Runbooks",
    name: "Deploy Guide",
    body: "# Deploy\n",
  });

  const exportBundle = await sourceEngine.exportTransfer({
    scope: "topic",
    topicName: "Operations",
    format: "bundle-json",
  });

  assert.equal(exportBundle.format, "bundle-json");
  assert.equal(exportBundle.documents.length, 2);

  const targetEngine = new ContentEngine({ dataRoot: targetDataRoot });
  const importResult = await targetEngine.importDocuments({
    format: "bundle-json",
    bundle: exportBundle,
  });

  assert.equal(importResult.format, "bundle-json");
  assert.equal(importResult.importedCount, 2);

  const importedTopicDocument = await targetEngine.getDocument("Operations/Release Guide.md");
  const importedSubtopicDocument = await targetEngine.getDocument("Operations/Runbooks/Deploy Guide.md");
  assert.equal(importedTopicDocument.body, "# Release\n");
  assert.equal(importedSubtopicDocument.body, "# Deploy\n");
});

test("content engine round-trips zip archives across logical paths", async (t) => {
  const sourceDataRoot = await createTempDataRoot("dacci-engine-zip-source-");
  const targetDataRoot = await createTempDataRoot("dacci-engine-zip-target-");

  t.after(async () => {
    await rm(sourceDataRoot, { recursive: true, force: true });
    await rm(targetDataRoot, { recursive: true, force: true });
  });

  const sourceEngine = new ContentEngine({ dataRoot: sourceDataRoot });
  await sourceEngine.createTopic("Operations");
  await sourceEngine.createSubtopic("Operations", "Runbooks");
  await sourceEngine.createDocument({
    topicName: "Operations",
    subtopicName: "Runbooks",
    name: "Rollback Guide",
    body: "# Rollback\n",
  });

  const exportArchive = await sourceEngine.exportTransfer({
    scope: "topic",
    topicName: "Operations",
    format: "bundle-zip",
  });

  assert.equal(exportArchive.format, "bundle-zip");
  assert.equal(exportArchive.documentCount, 1);

  const targetEngine = new ContentEngine({ dataRoot: targetDataRoot });
  const importResult = await targetEngine.importDocuments({
    format: "bundle-zip",
    archiveBase64: exportArchive.contentBase64,
    fileName: exportArchive.fileName,
  });

  assert.equal(importResult.format, "bundle-zip");
  assert.equal(importResult.importedCount, 1);

  const importedDocument = await targetEngine.getDocument("Operations/Runbooks/Rollback Guide.md");
  assert.equal(importedDocument.body, "# Rollback\n");
});

test("content engine rejects malformed zip archive imports", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-zip-invalid-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });

  await assert.rejects(
    () =>
      engine.importDocuments({
        format: "bundle-zip",
        archiveBase64: Buffer.from("not a zip archive", "utf8").toString("base64"),
      }),
    /Failed to read the supplied zip archive/,
  );
});

test("content engine keeps fail mode atomic when an import conflicts", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-import-fail-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");
  await engine.createSubtopic("Operations", "Runbooks");
  await engine.createDocument({
    topicName: "Operations",
    subtopicName: "Runbooks",
    name: "Deploy Guide",
    body: "# Original\n",
  });

  await assert.rejects(
    () =>
      engine.importDocuments({
        topicName: "Operations",
        subtopicName: "Runbooks",
        documents: [
          { name: "Deploy Guide", body: "# Updated\n" },
          { name: "Rollback Guide", body: "# Rollback\n" },
        ],
      }),
    /already exists/,
  );

  const originalDocument = await engine.getDocument("Operations/Runbooks/Deploy Guide.md");
  assert.equal(originalDocument.body, "# Original\n");

  await assert.rejects(
    () => access(path.join(dataRoot, "Operations", "Runbooks", "Rollback Guide.md")),
    /ENOENT/,
  );
});

test("content engine skips conflicting imports when skip mode is selected", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-import-skip-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");
  await engine.createSubtopic("Operations", "Runbooks");
  await engine.createDocument({
    topicName: "Operations",
    subtopicName: "Runbooks",
    name: "Deploy Guide",
    body: "# Original\n",
  });

  const result = await engine.importDocuments({
    topicName: "Operations",
    subtopicName: "Runbooks",
    conflictMode: "skip",
    documents: [
      { name: "Deploy Guide", body: "# Updated\n" },
      { name: "Rollback Guide", body: "# Rollback\n" },
    ],
  });

  assert.equal(result.conflictMode, "skip");
  assert.equal(result.importedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.imported[0]?.path, "Operations/Runbooks/Rollback Guide.md");
  assert.equal(result.skipped[0]?.path, "Operations/Runbooks/Deploy Guide.md");

  const originalDocument = await engine.getDocument("Operations/Runbooks/Deploy Guide.md");
  assert.equal(originalDocument.body, "# Original\n");
});

test("content engine skip mode tolerates malformed front matter in conflicting files", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-import-skip-malformed-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");
  await engine.createSubtopic("Operations", "Runbooks");

  const conflictingDocumentPath = path.join(dataRoot, "Operations", "Runbooks", "Deploy Guide.md");
  const malformedBody = "---\ntags:\n  - release\n# Missing closing delimiter\n";
  await writeFile(conflictingDocumentPath, malformedBody, "utf8");

  const result = await engine.importDocuments({
    topicName: "Operations",
    subtopicName: "Runbooks",
    conflictMode: "skip",
    documents: [
      { name: "Deploy Guide", body: "# Updated\n" },
      { name: "Rollback Guide", body: "# Rollback\n" },
    ],
  });

  assert.equal(result.importedCount, 1);
  assert.equal(result.imported[0]?.path, "Operations/Runbooks/Rollback Guide.md");
  assert.equal(result.skippedCount, 1);
  assert.equal(result.skipped[0]?.path, "Operations/Runbooks/Deploy Guide.md");

  const existingBody = await readFile(conflictingDocumentPath, "utf8");
  assert.equal(existingBody, malformedBody);
});

test("content engine overwrites conflicting imports when overwrite mode is selected", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-import-overwrite-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");
  await engine.createSubtopic("Operations", "Runbooks");
  await engine.createDocument({
    topicName: "Operations",
    subtopicName: "Runbooks",
    name: "Deploy Guide",
    body: "# Original\n",
  });

  const result = await engine.importDocuments({
    topicName: "Operations",
    subtopicName: "Runbooks",
    conflictMode: "overwrite",
    documents: [
      { name: "Deploy Guide", body: "# Updated\n" },
      { name: "Rollback Guide", body: "# Rollback\n" },
    ],
  });

  assert.equal(result.conflictMode, "overwrite");
  assert.equal(result.importedCount, 2);
  assert.equal(result.skippedCount, 0);

  const overwrittenDocument = await engine.getDocument("Operations/Runbooks/Deploy Guide.md");
  assert.equal(overwrittenDocument.body, "# Updated\n");
});

test("content engine maps recursive import folders into visible subtopics", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-import-folders-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");
  await engine.createSubtopic("Operations", "Runbooks");

  const result = await engine.importDocuments({
    topicName: "Operations",
    subtopicName: "Runbooks",
    folderMappingMode: "folders-to-subtopic",
    documents: [
      {
        name: "Deploy Guide",
        body: "# Deploy\n",
        sourcePath: "Deploy/API/Deploy Guide.md",
      },
      {
        name: "Overview",
        body: "# Overview\n",
        sourcePath: "Overview.md",
      },
    ],
  });

  assert.equal(result.folderMappingMode, "folders-to-subtopic");
  assert.equal(result.importedCount, 2);
  assert.equal(result.imported[0]?.path, "Operations/Runbooks - Deploy - API/Deploy Guide.md");
  assert.equal(result.imported[1]?.path, "Operations/Runbooks/Overview.md");

  const tree = await engine.getTree();
  const operationsTopic = tree.topics.find((topic) => topic.name === "Operations");
  assert.ok(operationsTopic);
  assert.equal(operationsTopic.subtopics.some((subtopic) => subtopic.name === "Runbooks - Deploy - API"), true);
});

test("content engine can flatten recursive import folders when flat mapping is selected", async (t) => {
  const dataRoot = await createTempDataRoot("dacci-engine-import-flat-");
  t.after(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const engine = new ContentEngine({ dataRoot });
  await engine.createTopic("Operations");

  const result = await engine.importDocuments({
    topicName: "Operations",
    folderMappingMode: "flat",
    documents: [
      {
        name: "Deploy Guide",
        body: "# Deploy\n",
        sourcePath: "Deploy/API/Deploy Guide.md",
      },
    ],
  });

  assert.equal(result.folderMappingMode, "flat");
  assert.equal(result.imported[0]?.path, "Operations/Deploy Guide.md");
});
