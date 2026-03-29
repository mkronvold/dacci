#!/usr/bin/env node
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContentEngine,
  ContentEngineError,
  isContentEngineError,
} from "@dacci/content-engine";
import {
  exportFormats,
  importConflictModes,
  type ExportDocumentsResponse,
  type ExportFormat,
  importFolderMappingModes,
  type ImportConflictMode,
  type ImportFolderMappingMode,
  type ContentExportBundle,
} from "@dacci/shared-types";
import {
  GitHubSync,
  GitHubSyncScheduler,
  GitHubSyncError,
  type GitHubSyncOptions,
  isGitHubSyncError,
} from "@dacci/github-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRepoRoot = path.resolve(__dirname, "../../..");
const defaultDataRoot = path.join(resolveDefaultContentRepoRoot(appRepoRoot), "data");

const helpText = `Dacci CLI

Usage:
  dacci [global-options] <command> [subcommand] [arguments]

Global options:
  --data-root <path>   Override the content data root
  --repo-root <path>   Override the git repository root used for sync
  --remote <name>      Override the git remote used for sync (default: origin)
  --remote-url <url>   Override the git remote URL used for sync without editing repo config
  --release-branch <name>  Override the expected release branch used for sync guidance (default: default)
  --help               Show help

Path resolution:
  Flags override environment variables, which override npm config, which override local checkout defaults.
  Local defaults prefer a sibling ../E2Open.KPE.Content checkout when present.
  If your content checkout lives elsewhere, set both paths explicitly:
    DATA_ROOT=../E2Open.KPE.Content/data
    GIT_SYNC_REPO_ROOT=../E2Open.KPE.Content
    dacci sync status

Commands:
  summary
  tree
  search <query>   Use tag:<name> for explicit tag search
  document read <path>
  document create --topic <name> --name <name> [--subtopic <name>] (--body <text> | --file <path>)
  document update <path> (--body <text> | --file <path>)
  document rename <path> <next-name>
  document move <path> --topic <name> [--subtopic <name>]
  document delete <path>
  import file --topic <name> [--subtopic <name>] --file <path> [--name <name>] [--conflict-mode <mode>]
  import directory --topic <name> [--subtopic <name>] --dir <path> [--conflict-mode <mode>] [--folder-mapping <mode>]
  import bundle --file <path> [--format <bundle-json|bundle-zip>] [--conflict-mode <mode>]
  export document <path> [--format <bundle-json|bundle-zip>] [--output <path>]
  export topic <topic-name> [--format <bundle-json|bundle-zip>] [--output <path>]
  export subtopic <topic-name> <name> [--format <bundle-json|bundle-zip>] [--output <path>]
  topic create <name>
  topic rename <current-name> <next-name>
  topic delete <name>
  subtopic create <topic-name> <name>
  subtopic rename <topic-name> <current-name> <next-name>
  subtopic delete <topic-name> <name>
  sync status [--refresh]
  sync schedule status
  sync schedule configure [--enable | --disable] [--interval-minutes <minutes>]
  sync schedule pause
  sync schedule resume
  sync pull
  sync push --message <message>
`;

type GlobalOptions = {
  dataRoot: string;
  repoRoot: string;
  remoteName?: string;
  remoteUrl?: string;
  releaseBranch?: string;
};

function resolveDefaultContentRepoRoot(repoRoot: string): string {
  const siblingContentRepoRoot = path.resolve(repoRoot, "../E2Open.KPE.Content");
  if (
    existsSync(path.join(siblingContentRepoRoot, ".git")) &&
    existsSync(path.join(siblingContentRepoRoot, "data"))
  ) {
    return siblingContentRepoRoot;
  }

  return repoRoot;
}

async function main(): Promise<void> {
  const { options, positional } = parseGlobalOptions(process.argv.slice(2));

  if (positional.length === 0 || positional[0] === "help" || positional[0] === "--help") {
    process.stdout.write(helpText);
    return;
  }

  const engine = new ContentEngine({
    dataRoot: options.dataRoot,
  });
  const gitSync = createGitSync(options);
  const gitSyncScheduler = new GitHubSyncScheduler(gitSync);

  const [command, ...args] = positional;
  if (command === "sync") {
    await gitSync.validateConfiguration();
  }

  switch (command) {
    case "summary":
      printJson(await engine.getSummary());
      return;
    case "tree":
      printJson(await engine.getTree());
      return;
    case "search":
      requireExactArgs(args, 1, "search <query>");
      printJson(await engine.searchDocuments(args[0] ?? ""));
      return;
    case "topic":
      printJson(await runTopicCommand(engine, args));
      return;
    case "subtopic":
      printJson(await runSubtopicCommand(engine, args));
      return;
    case "document":
      printJson(await runDocumentCommand(engine, args));
      return;
    case "import":
      printJson(await runImportCommand(engine, args));
      return;
    case "export":
      printJson(await runExportCommand(engine, args));
      return;
    case "sync":
      printJson(await runSyncCommand(gitSyncScheduler, args));
      return;
    default:
      throw new Error(`Unknown command '${command}'. Use --help to see available commands.`);
  }
}

function createGitSync(options: GlobalOptions): GitHubSync {
  const gitSyncOptions: GitHubSyncOptions = {
    repoRoot: options.repoRoot,
    contentRoot: options.dataRoot,
  };
  if (options.remoteName) {
    gitSyncOptions.remoteName = options.remoteName;
  }
  if (options.remoteUrl) {
    gitSyncOptions.remoteUrl = options.remoteUrl;
  }
  if (options.releaseBranch) {
    gitSyncOptions.releaseBranch = options.releaseBranch;
  }

  return new GitHubSync(gitSyncOptions);
}

async function runTopicCommand(engine: ContentEngine, args: string[]) {
  const [action, ...rest] = args;
  switch (action) {
    case "create":
      requireExactArgs(rest, 1, "topic create <name>");
      return engine.createTopic(rest[0] ?? "");
    case "rename":
      requireExactArgs(rest, 2, "topic rename <current-name> <next-name>");
      return engine.renameTopic(rest[0] ?? "", rest[1] ?? "");
    case "delete":
      requireExactArgs(rest, 1, "topic delete <name>");
      await engine.deleteTopic(rest[0] ?? "");
      return { deleted: true, kind: "topic", name: rest[0] ?? "" };
    default:
      throw new Error(`Unknown topic action '${action ?? ""}'.`);
  }
}

async function runSubtopicCommand(engine: ContentEngine, args: string[]) {
  const [action, ...rest] = args;
  switch (action) {
    case "create":
      requireExactArgs(rest, 2, "subtopic create <topic-name> <name>");
      return engine.createSubtopic(rest[0] ?? "", rest[1] ?? "");
    case "rename":
      requireExactArgs(rest, 3, "subtopic rename <topic-name> <current-name> <next-name>");
      return engine.renameSubtopic(rest[0] ?? "", rest[1] ?? "", rest[2] ?? "");
    case "delete":
      requireExactArgs(rest, 2, "subtopic delete <topic-name> <name>");
      await engine.deleteSubtopic(rest[0] ?? "", rest[1] ?? "");
      return { deleted: true, kind: "subtopic", topicName: rest[0] ?? "", name: rest[1] ?? "" };
    default:
      throw new Error(`Unknown subtopic action '${action ?? ""}'.`);
  }
}

async function runDocumentCommand(engine: ContentEngine, args: string[]) {
  const [action, ...rest] = args;
  switch (action) {
    case "read":
      requireExactArgs(rest, 1, "document read <path>");
      return engine.getDocument(rest[0] ?? "");
    case "create": {
      const parsed = parseNamedOptions(rest);
      const topicName = requiredOption(parsed.options, "topic", "document create");
      const name = requiredOption(parsed.options, "name", "document create");
      const body = await resolveDocumentBody(parsed.options, "document create");
      const subtopicName = parsed.options.subtopic;
      return subtopicName
        ? engine.createDocument({ topicName, subtopicName, name, body })
        : engine.createDocument({ topicName, name, body });
    }
    case "update": {
      if (rest.length === 0) {
        throw new Error("Usage: document update <path> (--body <text> | --file <path>)");
      }
      const [documentPath, ...optionArgs] = rest;
      const parsed = parseNamedOptions(optionArgs);
      const body = await resolveDocumentBody(parsed.options, "document update");
      return engine.updateDocument(documentPath ?? "", body);
    }
    case "rename":
      requireExactArgs(rest, 2, "document rename <path> <next-name>");
      return engine.renameDocument(rest[0] ?? "", rest[1] ?? "");
    case "move": {
      if (rest.length === 0) {
        throw new Error("Usage: document move <path> --topic <name> [--subtopic <name>]");
      }
      const [documentPath, ...optionArgs] = rest;
      const parsed = parseNamedOptions(optionArgs);
      const topicName = requiredOption(parsed.options, "topic", "document move");
      const subtopicName = parsed.options.subtopic;
      return subtopicName
        ? engine.moveDocument(documentPath ?? "", { topicName, subtopicName })
        : engine.moveDocument(documentPath ?? "", { topicName });
    }
    case "delete":
      requireExactArgs(rest, 1, "document delete <path>");
      await engine.deleteDocument(rest[0] ?? "");
      return { deleted: true, kind: "document", path: rest[0] ?? "" };
    default:
      throw new Error(`Unknown document action '${action ?? ""}'.`);
  }
}

async function runSyncCommand(gitSyncScheduler: GitHubSyncScheduler, args: string[]) {
  const [action, ...rest] = args;
  switch (action) {
    case "status": {
      const parsed = parseNamedOptions(rest, new Set(["refresh"]));
      return gitSyncScheduler.getStatus({ refreshRemote: hasFlag(parsed.flags, "refresh") });
    }
    case "schedule": {
      const [scheduleAction, ...scheduleArgs] = rest;
      switch (scheduleAction) {
        case "status":
          requireExactArgs(scheduleArgs, 0, "sync schedule status");
          return gitSyncScheduler.getStatus({ refreshRemote: false });
        case "configure": {
          const parsed = parseNamedOptions(scheduleArgs, new Set(["enable", "disable"]));
          const enableFlag = hasFlag(parsed.flags, "enable");
          const disableFlag = hasFlag(parsed.flags, "disable");
          if (enableFlag && disableFlag) {
            throw new Error("sync schedule configure accepts either --enable or --disable, not both.");
          }

          const intervalMinutes = parseOptionalPositiveInteger(
            readOptionValue(parsed.options, "interval-minutes"),
            "interval-minutes",
          );
          return gitSyncScheduler.configureSchedule({
            ...(enableFlag ? { enabled: true } : {}),
            ...(disableFlag ? { enabled: false } : {}),
            ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
          });
        }
        case "pause":
          requireExactArgs(scheduleArgs, 0, "sync schedule pause");
          return gitSyncScheduler.pauseSchedule();
        case "resume":
          requireExactArgs(scheduleArgs, 0, "sync schedule resume");
          return gitSyncScheduler.resumeSchedule();
        default:
          throw new Error(`Unknown sync schedule action '${scheduleAction ?? ""}'.`);
      }
    }
    case "pull":
      requireExactArgs(rest, 0, "sync pull");
      return gitSyncScheduler.pullContent();
    case "push": {
      const parsed = parseNamedOptions(rest);
      const message = requiredOption(parsed.options, "message", "sync push");
      return gitSyncScheduler.pushContent({ message });
    }
    default:
      throw new Error(`Unknown sync action '${action ?? ""}'.`);
  }
}

async function runImportCommand(engine: ContentEngine, args: string[]) {
  const [action, ...rest] = args;
  switch (action) {
    case "file": {
      const parsed = parseNamedOptions(rest);
      const topicName = requiredOption(parsed.options, "topic", "import file");
      const filePath = requiredOption(parsed.options, "file", "import file");
      const resolvedFilePath = path.resolve(filePath);
      const body = await fs.readFile(resolvedFilePath, "utf8");
      const name = readOptionValue(parsed.options, "name") ?? path.basename(resolvedFilePath);
      const subtopicName = parsed.options.subtopic;
      const conflictMode = parseImportConflictMode(readOptionValue(parsed.options, "conflict-mode"));
      return subtopicName
        ? engine.importDocuments({
            topicName,
            subtopicName,
            documents: [{ name, body }],
            ...(conflictMode ? { conflictMode } : {}),
          })
        : engine.importDocuments({
            topicName,
            documents: [{ name, body }],
            ...(conflictMode ? { conflictMode } : {}),
          });
    }
    case "directory": {
      const parsed = parseNamedOptions(rest);
      const topicName = requiredOption(parsed.options, "topic", "import directory");
      const directoryPath = requiredOption(parsed.options, "dir", "import directory");
      const documents = await readMarkdownFilesInDirectory(directoryPath);
      const subtopicName = parsed.options.subtopic;
      const conflictMode = parseImportConflictMode(readOptionValue(parsed.options, "conflict-mode"));
      const folderMappingMode =
        parseImportFolderMappingMode(readOptionValue(parsed.options, "folder-mapping")) ??
        "folders-to-subtopic";
      return subtopicName
        ? engine.importDocuments({
            topicName,
            subtopicName,
            documents,
            ...(conflictMode ? { conflictMode } : {}),
            folderMappingMode,
          })
        : engine.importDocuments({
            topicName,
            documents,
            ...(conflictMode ? { conflictMode } : {}),
            folderMappingMode,
          });
    }
    case "bundle": {
      const parsed = parseNamedOptions(rest);
      const filePath = requiredOption(parsed.options, "file", "import bundle");
      const resolvedFilePath = path.resolve(filePath);
      const format = parseBundleImportFormat(readOptionValue(parsed.options, "format"), resolvedFilePath);
      const conflictMode = parseImportConflictMode(readOptionValue(parsed.options, "conflict-mode"));

      if (format === "bundle-json") {
        const bundle = JSON.parse(await fs.readFile(resolvedFilePath, "utf8")) as ContentExportBundle;
        return engine.importDocuments({
          format,
          bundle,
          ...(conflictMode ? { conflictMode } : {}),
        });
      }

      return engine.importDocuments({
        format,
        archiveBase64: (await fs.readFile(resolvedFilePath)).toString("base64"),
        fileName: path.basename(resolvedFilePath),
        ...(conflictMode ? { conflictMode } : {}),
      });
    }
    default:
      throw new Error(`Unknown import action '${action ?? ""}'.`);
  }
}

async function runExportCommand(engine: ContentEngine, args: string[]) {
  const [action, ...rest] = args;
  switch (action) {
    case "document": {
      if (rest.length === 0) {
        throw new Error("Usage: export document <path> [--output <path>]");
      }

      const [documentPath, ...optionArgs] = rest;
      const parsed = parseNamedOptions(optionArgs);
      const format = parseExportFormat(readOptionValue(parsed.options, "format"));
      if (format) {
        const exportResult = await engine.exportTransfer({
          scope: "document",
          path: documentPath ?? "",
          format,
        });
        return maybeWriteExportTransfer(exportResult, parsed.options.output);
      }

      const bundle = await engine.exportDocuments({
        scope: "document",
        path: documentPath ?? "",
      });

      return maybeWriteExportBundle(bundle, parsed.options.output);
    }
    case "topic": {
      if (rest.length === 0) {
        throw new Error("Usage: export topic <topic-name> [--output <path>]");
      }

      const [topicName, ...optionArgs] = rest;
      const parsed = parseNamedOptions(optionArgs);
      const format = parseExportFormat(readOptionValue(parsed.options, "format"));
      if (format) {
        const exportResult = await engine.exportTransfer({
          scope: "topic",
          topicName: topicName ?? "",
          format,
        });
        return maybeWriteExportTransfer(exportResult, parsed.options.output);
      }

      const bundle = await engine.exportDocuments({
        scope: "topic",
        topicName: topicName ?? "",
      });

      return maybeWriteExportBundle(bundle, parsed.options.output);
    }
    case "subtopic": {
      if (rest.length < 2) {
        throw new Error("Usage: export subtopic <topic-name> <name> [--output <path>]");
      }

      const [topicName, subtopicName, ...optionArgs] = rest;
      const parsed = parseNamedOptions(optionArgs);
      const format = parseExportFormat(readOptionValue(parsed.options, "format"));
      if (format) {
        const exportResult = await engine.exportTransfer({
          scope: "subtopic",
          topicName: topicName ?? "",
          subtopicName: subtopicName ?? "",
          format,
        });
        return maybeWriteExportTransfer(exportResult, parsed.options.output);
      }

      const bundle = await engine.exportDocuments({
        scope: "subtopic",
        topicName: topicName ?? "",
        subtopicName: subtopicName ?? "",
      });

      return maybeWriteExportBundle(bundle, parsed.options.output);
    }
    default:
      throw new Error(`Unknown export action '${action ?? ""}'.`);
  }
}

function parseGlobalOptions(argv: string[]): { options: GlobalOptions; positional: string[] } {
  const configuredDataRoot = process.env.DATA_ROOT ?? readNpmConfigOption("data-root");
  const configuredRepoRoot = process.env.GIT_SYNC_REPO_ROOT ?? readNpmConfigOption("repo-root");
  const resolvedDataRoot = resolvePathOption(configuredDataRoot, defaultDataRoot);
  const options: GlobalOptions = {
    dataRoot: resolvedDataRoot,
    repoRoot: resolvePathOption(configuredRepoRoot, path.resolve(resolvedDataRoot, "..")),
  };
  const remoteName = process.env.GIT_SYNC_REMOTE_NAME ?? readNpmConfigOption("remote");
  if (remoteName) {
    options.remoteName = remoteName;
  }
  const remoteUrl = process.env.GIT_SYNC_REMOTE_URL ?? readNpmConfigOption("remote-url");
  if (remoteUrl) {
    options.remoteUrl = remoteUrl;
  }
  const releaseBranch =
    process.env.GIT_SYNC_RELEASE_BRANCH ?? readNpmConfigOption("release-branch");
  if (releaseBranch) {
    options.releaseBranch = releaseBranch;
  }

  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") {
      positional.push(token);
      continue;
    }

    if (token === "--data-root") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --data-root.");
      }
      options.dataRoot = path.resolve(next);
      index += 1;
      continue;
    }

    if (token === "--repo-root") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --repo-root.");
      }
      options.repoRoot = path.resolve(next);
      index += 1;
      continue;
    }

    if (token === "--remote") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --remote.");
      }
      options.remoteName = next;
      index += 1;
      continue;
    }

    if (token === "--remote-url") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --remote-url.");
      }
      options.remoteUrl = next;
      index += 1;
      continue;
    }

    if (token === "--release-branch") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --release-branch.");
      }
      options.releaseBranch = next;
      index += 1;
      continue;
    }

    positional.push(...argv.slice(index));
    break;
  }

  return { options, positional };
}

function parseNamedOptions(
  argv: string[],
  booleanFlags = new Set<string>(),
): { options: Record<string, string>; flags: Set<string>; positional: string[] } {
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      positional.push(token ?? "");
      continue;
    }

    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      flags.add(key);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for option '${token}'.`);
    }

    options[key] = value;
    index += 1;
  }

  return { options, flags, positional };
}

async function resolveDocumentBody(options: Record<string, string>, commandName: string): Promise<string> {
  const body = readOptionValue(options, "body");
  const filePath = readOptionValue(options, "file");
  if (body && filePath) {
    throw new Error(`${commandName} accepts either --body or --file, not both.`);
  }
  if (body) {
    return body;
  }
  if (filePath) {
    return fs.readFile(path.resolve(filePath), "utf8");
  }

  throw new Error(`${commandName} requires either --body <text> or --file <path>.`);
}

async function readMarkdownFilesInDirectory(directoryPath: string): Promise<
  Array<{ name: string; body: string; sourcePath: string }>
> {
  const resolvedDirectoryPath = path.resolve(directoryPath);
  const markdownFiles = await collectMarkdownFiles(resolvedDirectoryPath, resolvedDirectoryPath);

  if (markdownFiles.length === 0) {
    throw new Error("import directory requires at least one .md file.");
  }

  return markdownFiles;
}

async function maybeWriteExportBundle(
  bundle: Awaited<ReturnType<ContentEngine["exportDocuments"]>>,
  outputPath?: string,
) {
  if (!outputPath) {
    return bundle;
  }

  const resolvedOutputPath = path.resolve(outputPath);

  if (bundle.scope.scope === "document" && bundle.documents.length === 1) {
    await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await fs.writeFile(resolvedOutputPath, bundle.documents[0]?.body ?? "", "utf8");
    return {
      exported: true,
      format: "markdown",
      outputPath: resolvedOutputPath,
      documentCount: 1,
    };
  }

  await fs.mkdir(resolvedOutputPath, { recursive: true });

  for (const document of bundle.documents) {
    const destinationPath = path.join(resolvedOutputPath, ...document.path.split("/"));
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, document.body, "utf8");
  }

  return {
    exported: true,
    format: "directory",
    outputPath: resolvedOutputPath,
    documentCount: bundle.documents.length,
  };
}

async function maybeWriteExportTransfer(
  exportResult: ExportDocumentsResponse,
  outputPath?: string,
) {
  if (!outputPath) {
    return exportResult;
  }

  const resolvedOutputPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });

  if (exportResult.format === "bundle-json") {
    await fs.writeFile(resolvedOutputPath, JSON.stringify(exportResult, null, 2), "utf8");
    return {
      exported: true,
      format: exportResult.format,
      outputPath: resolvedOutputPath,
      documentCount: exportResult.documents.length,
    };
  }

  await fs.writeFile(resolvedOutputPath, Buffer.from(exportResult.contentBase64, "base64"));
  return {
    exported: true,
    format: exportResult.format,
    outputPath: resolvedOutputPath,
    documentCount: exportResult.documentCount,
  };
}

function parseImportConflictMode(value: string | undefined): ImportConflictMode | undefined {
  if (!value) {
    return undefined;
  }

  if ((importConflictModes as readonly string[]).includes(value)) {
    return value as ImportConflictMode;
  }

  throw new Error(`Import conflict mode must be one of: ${importConflictModes.join(", ")}.`);
}

function parseImportFolderMappingMode(value: string | undefined): ImportFolderMappingMode | undefined {
  if (!value) {
    return undefined;
  }

  if ((importFolderMappingModes as readonly string[]).includes(value)) {
    return value as ImportFolderMappingMode;
  }

  throw new Error(`Import folder mapping mode must be one of: ${importFolderMappingModes.join(", ")}.`);
}

function parseExportFormat(value: string | undefined): ExportFormat | undefined {
  if (!value) {
    return undefined;
  }

  if ((exportFormats as readonly string[]).includes(value)) {
    return value as ExportFormat;
  }

  throw new Error(`Export format must be one of: ${exportFormats.join(", ")}.`);
}

function parseBundleImportFormat(value: string | undefined, filePath: string): ExportFormat {
  const explicitFormat = parseExportFormat(value);
  if (explicitFormat) {
    return explicitFormat;
  }

  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") {
    return "bundle-json";
  }

  if (extension === ".zip") {
    return "bundle-zip";
  }

  throw new Error("import bundle requires --format when the file extension is not .json or .zip.");
}

function parseOptionalPositiveInteger(value: string | undefined, optionName: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`Option '${optionName}' must be a positive integer.`);
  }

  return parsedValue;
}

async function collectMarkdownFiles(
  rootDirectoryPath: string,
  currentDirectoryPath: string,
): Promise<Array<{ name: string; body: string; sourcePath: string }>> {
  const entries = (await fs.readdir(currentDirectoryPath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const markdownFiles: Array<{ name: string; body: string; sourcePath: string }> = [];

  for (const entry of entries) {
    const entryPath = path.join(currentDirectoryPath, entry.name);
    if (entry.isDirectory()) {
      markdownFiles.push(...(await collectMarkdownFiles(rootDirectoryPath, entryPath)));
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }

    markdownFiles.push({
      name: entry.name,
      body: await fs.readFile(entryPath, "utf8"),
      sourcePath: path.relative(rootDirectoryPath, entryPath).split(path.sep).join("/"),
    });
  }

  return markdownFiles;
}

function requiredOption(options: Record<string, string>, name: string, commandName: string): string {
  const value = readOptionValue(options, name);
  if (!value) {
    throw new Error(`${commandName} requires --${name} <value>.`);
  }

  return value;
}

function readOptionValue(options: Record<string, string>, name: string): string | undefined {
  return options[name] ?? readNpmConfigOption(name);
}

function hasFlag(flags: Set<string>, name: string): boolean {
  return flags.has(name) || readNpmConfigFlag(name);
}

function readNpmConfigOption(name: string): string | undefined {
  const envKey = `npm_config_${name.replaceAll("-", "_")}`;
  const value = process.env[envKey];
  return value?.trim() ? value : undefined;
}

function readNpmConfigFlag(name: string): boolean {
  const value = readNpmConfigOption(name);
  return value === "true" || value === "1";
}

function resolvePathOption(value: string | undefined, fallback: string): string {
  return value ? path.resolve(value) : fallback;
}

function requireExactArgs(args: string[], count: number, usage: string): void {
  if (args.length !== count) {
    throw new Error(`Usage: ${usage}`);
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}

main().catch((error: unknown) => {
  if (isContentEngineError(error) || isGitHubSyncError(error)) {
    printError(error.message);
    process.exitCode = 1;
    return;
  }

  if (error instanceof ContentEngineError || error instanceof GitHubSyncError) {
    printError(error.message);
    process.exitCode = 1;
    return;
  }

  if (error instanceof Error) {
    printError(error.message);
    process.exitCode = 1;
    return;
  }

  printError("An unexpected error occurred.");
  process.exitCode = 1;
});
