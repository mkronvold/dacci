import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { DocsLibraryEngine } from "../dist/index.js";

async function createTempRepoRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeRepoFile(repoRoot, relativePath, body) {
  const absolutePath = path.join(repoRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, body, "utf8");
}

test("docs library engine groups draft and published files into one logical document", async (t) => {
  const repoRoot = await createTempRepoRoot("dacci-docs-tree-");
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await writeRepoFile(
    repoRoot,
    "published/platform/kubernetes/core-design.md",
    "---\ntitle: Core Design\ntags:\n  - Platform\n---\n## Published\n",
  );
  await writeRepoFile(
    repoRoot,
    "draft/platform/kubernetes/core-design.md",
    "---\ntitle: Core Design Draft\ntags:\n  - Platform\n  - Draft\n---\n## Draft\n",
  );

  const engine = new DocsLibraryEngine({ repoRoot });
  const tree = await engine.getTree();

  assert.equal(tree.documents.length, 1);
  assert.deepEqual(tree.documents[0]?.availableStatuses, ["draft", "published"]);
  assert.equal(tree.documents[0]?.logicalPath, "platform/kubernetes/core-design.md");
  assert.equal(tree.documents[0]?.title, "Core Design Draft");
  assert.deepEqual(tree.documents[0]?.tags, ["platform", "draft"]);
  assert.equal(tree.statuses[0]?.status, "draft");
  assert.equal(tree.statuses[0]?.layers[0]?.domains[0]?.documents[0]?.logicalPath, "platform/kubernetes/core-design.md");
  assert.equal(tree.statuses[1]?.status, "published");
  assert.equal(tree.statuses[1]?.layers[0]?.domains[0]?.documents[0]?.logicalPath, "platform/kubernetes/core-design.md");
});

test("docs library engine saves edits to published content as a draft while preserving the published file", async (t) => {
  const repoRoot = await createTempRepoRoot("dacci-docs-published-edit-");
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const publishedPath = "published/platform/kubernetes/core-design.md";
  await writeRepoFile(repoRoot, publishedPath, "---\ntitle: Core Design\n---\n## Published\n");

  const engine = new DocsLibraryEngine({ repoRoot });
  const draftVariant = await engine.savePublishedEdit(
    "platform/kubernetes/core-design.md",
    "---\ntitle: Core Design Draft\n---\n## Draft revision\n",
  );

  assert.equal(draftVariant.status, "draft");
  assert.equal(draftVariant.repoPath, "draft/platform/kubernetes/core-design.md");
  assert.equal(
    await readFile(path.join(repoRoot, publishedPath), "utf8"),
    "---\ntitle: Core Design\n---\n## Published\n",
  );
  assert.equal(
    await readFile(path.join(repoRoot, draftVariant.repoPath), "utf8"),
    "---\ntitle: Core Design Draft\n---\n## Draft revision\n",
  );
});

test("docs library engine publishes a draft by replacing the published file and removing the draft file", async (t) => {
  const repoRoot = await createTempRepoRoot("dacci-docs-publish-");
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await writeRepoFile(
    repoRoot,
    "published/platform/kubernetes/core-design.md",
    "---\ntitle: Core Design\n---\n## Published\n",
  );
  await writeRepoFile(
    repoRoot,
    "draft/platform/kubernetes/core-design.md",
    "---\ntitle: Core Design Draft\n---\n## Published replacement\n",
  );

  const engine = new DocsLibraryEngine({ repoRoot });
  const publishedVariant = await engine.publishDraft("platform/kubernetes/core-design.md");

  assert.equal(publishedVariant.status, "published");
  assert.equal(
    await readFile(path.join(repoRoot, "published/platform/kubernetes/core-design.md"), "utf8"),
    "---\ntitle: Core Design Draft\n---\n## Published replacement\n",
  );
  await assert.rejects(
    access(path.join(repoRoot, "draft/platform/kubernetes/core-design.md")),
  );
});

test("docs library engine creates new drafts under status-first taxonomy paths", async (t) => {
  const repoRoot = await createTempRepoRoot("dacci-docs-create-");
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const engine = new DocsLibraryEngine({ repoRoot });
  const draftVariant = await engine.createDraft({
    layer: "Platform",
    domainPath: "Kubernetes/Guides",
    name: "Deploy Guide",
    body: "---\ntitle: Deploy Guide\n---\n## Draft\n",
  });

  assert.equal(draftVariant.status, "draft");
  assert.equal(draftVariant.logicalPath, "platform/kubernetes/guides/deploy-guide.md");
  assert.equal(draftVariant.repoPath, "draft/platform/kubernetes/guides/deploy-guide.md");
  assert.equal(
    await readFile(path.join(repoRoot, draftVariant.repoPath), "utf8"),
    "---\ntitle: Deploy Guide\n---\n## Draft\n",
  );
});

test("docs library engine archives published content into the archive status folder", async (t) => {
  const repoRoot = await createTempRepoRoot("dacci-docs-archive-");
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  await writeRepoFile(
    repoRoot,
    "published/operations/migrations/move-doc.md",
    "---\ntitle: Move Doc\n---\n## Published\n",
  );

  const engine = new DocsLibraryEngine({ repoRoot });
  const archivedVariant = await engine.archiveDocument("operations/migrations/move-doc.md");

  assert.equal(archivedVariant.status, "archive");
  assert.equal(archivedVariant.repoPath, "archive/operations/migrations/move-doc.md");
  await assert.rejects(
    access(path.join(repoRoot, "published/operations/migrations/move-doc.md")),
  );
  assert.equal(
    await readFile(path.join(repoRoot, "archive/operations/migrations/move-doc.md"), "utf8"),
    "---\ntitle: Move Doc\n---\n## Published\n",
  );
});

test("docs library engine rejects stale draft saves when the variant changed after it was loaded", async (t) => {
  const repoRoot = await createTempRepoRoot("dacci-docs-stale-save-");
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const engine = new DocsLibraryEngine({ repoRoot });
  const draftVariant = await engine.createDraft({
    layer: "Platform",
    domainPath: "Kubernetes",
    name: "Core Design",
    body: "---\ntitle: Core Design\n---\n## Draft\n",
  });

  await delay(20);
  await writeRepoFile(
    repoRoot,
    draftVariant.repoPath,
    "---\ntitle: Core Design\n---\n## Another revision\n",
  );

  await assert.rejects(
    engine.updateDraft(
      draftVariant.logicalPath,
      "---\ntitle: Core Design\n---\n## My stale revision\n",
      draftVariant.modifiedAt,
    ),
    (error) => {
      assert.equal(error?.code, "conflict");
      assert.match(error.message, /changed after it was loaded/i);
      return true;
    },
  );
});
