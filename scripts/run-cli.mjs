#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const nodeCommand = process.execPath;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const sharedInputs = ["tsconfig.base.json"];

const buildTargets = [
  {
    output: "packages/shared-types/dist/index.js",
    buildInfo: "packages/shared-types/tsconfig.tsbuildinfo",
    inputs: [...sharedInputs, "packages/shared-types/package.json", "packages/shared-types/tsconfig.json", "packages/shared-types/src"],
  },
  {
    output: "packages/content-engine/dist/index.js",
    buildInfo: "packages/content-engine/tsconfig.tsbuildinfo",
    inputs: [...sharedInputs, "packages/content-engine/package.json", "packages/content-engine/tsconfig.json", "packages/content-engine/src"],
  },
  {
    output: "packages/github-sync/dist/index.js",
    buildInfo: "packages/github-sync/tsconfig.tsbuildinfo",
    inputs: [...sharedInputs, "packages/github-sync/package.json", "packages/github-sync/tsconfig.json", "packages/github-sync/src"],
  },
  {
    output: "apps/cli/dist/index.js",
    buildInfo: "apps/cli/tsconfig.tsbuildinfo",
    inputs: [...sharedInputs, "apps/cli/package.json", "apps/cli/tsconfig.json", "apps/cli/src"],
  },
];

export async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function getLatestModifiedTime(targetPath) {
  const targetStats = await stat(targetPath);
  let latestModifiedTime = targetStats.mtimeMs;

  if (!targetStats.isDirectory()) {
    return latestModifiedTime;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    const entryModifiedTime = await getLatestModifiedTime(entryPath);
    if (entryModifiedTime > latestModifiedTime) {
      latestModifiedTime = entryModifiedTime;
    }
  }

  return latestModifiedTime;
}

export async function isBuildRequiredForTarget(target, rootDir = repoRoot) {
  const outputPath = path.join(rootDir, target.output);

  if (!(await exists(outputPath))) {
    return true;
  }

  const outputModifiedTime = await getLatestModifiedTime(outputPath);

  for (const input of target.inputs) {
    const inputPath = path.join(rootDir, input);
    if (!(await exists(inputPath))) {
      continue;
    }

    const inputModifiedTime = await getLatestModifiedTime(inputPath);
    if (inputModifiedTime > outputModifiedTime) {
      return true;
    }
  }

  return false;
}

export async function isCliBuildRequired(rootDir = repoRoot) {
  for (const target of buildTargets) {
    if (await isBuildRequiredForTarget(target, rootDir)) {
      return true;
    }
  }

  return false;
}

async function invalidateBuildMetadata(rootDir = repoRoot) {
  for (const target of buildTargets) {
    const buildInfoPath = path.join(rootDir, target.buildInfo);
    await rm(buildInfoPath, { force: true });
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited from signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

async function main() {
  if (await isCliBuildRequired()) {
    await invalidateBuildMetadata();
    const buildExitCode = await runCommand(npmCommand, ["run", "build:cli"]);
    if (buildExitCode !== 0) {
      process.exit(buildExitCode);
    }
  }

  const cliExitCode = await runCommand(nodeCommand, ["apps/cli/dist/index.js", ...process.argv.slice(2)]);
  process.exit(cliExitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
