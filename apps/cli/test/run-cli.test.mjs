import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isBuildRequiredForTarget } from "../../../scripts/run-cli.mjs";

async function createWorkspace(rootDir, name) {
  const workspaceRoot = path.join(rootDir, name);
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "dist"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "package.json"), "{}\n", "utf8");
  await writeFile(path.join(workspaceRoot, "tsconfig.json"), "{}\n", "utf8");
  await writeFile(path.join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(workspaceRoot, "dist", "index.js"), "export {};\n", "utf8");

  return {
    output: `${name}/dist/index.js`,
    inputs: [`${name}/package.json`, `${name}/tsconfig.json`, `${name}/src`],
  };
}

test("lazy CLI build requires a build when an output is missing", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "dacci-run-cli-missing-"));
  const target = {
    output: "workspace/dist/index.js",
    inputs: ["workspace/package.json", "workspace/tsconfig.json", "workspace/src"],
  };

  await mkdir(path.join(rootDir, "workspace", "src"), { recursive: true });
  await writeFile(path.join(rootDir, "workspace", "package.json"), "{}\n", "utf8");
  await writeFile(path.join(rootDir, "workspace", "tsconfig.json"), "{}\n", "utf8");
  await writeFile(path.join(rootDir, "workspace", "src", "index.ts"), "export {};\n", "utf8");

  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  assert.equal(await isBuildRequiredForTarget(target, rootDir), true);
});

test("lazy CLI build skips rebuilds when outputs are current and rebuilds when sources change", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "dacci-run-cli-stale-"));
  const target = await createWorkspace(rootDir, "workspace");
  const sourceDir = path.join(rootDir, "workspace", "src");
  const sourcePath = path.join(rootDir, "workspace", "src", "index.ts");
  const outputPath = path.join(rootDir, "workspace", "dist", "index.js");
  const packagePath = path.join(rootDir, "workspace", "package.json");
  const configPath = path.join(rootDir, "workspace", "tsconfig.json");

  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const baseTime = new Date("2026-03-24T20:00:00.000Z");
  const newerTime = new Date("2026-03-24T20:00:10.000Z");
  const newestTime = new Date("2026-03-24T20:00:20.000Z");

  await utimes(sourcePath, baseTime, baseTime);
  await utimes(sourceDir, baseTime, baseTime);
  await utimes(packagePath, baseTime, baseTime);
  await utimes(configPath, baseTime, baseTime);
  await utimes(outputPath, newerTime, newerTime);

  assert.equal(await isBuildRequiredForTarget(target, rootDir), false);

  await utimes(sourcePath, newestTime, newestTime);

  assert.equal(await isBuildRequiredForTarget(target, rootDir), true);
});
