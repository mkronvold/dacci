import { access } from "node:fs/promises";

import {
  ContentEngine,
  ContentEngineError,
  isContentEngineError,
} from "@dacci/content-engine";
import {
  GitHubSync,
  GitHubSyncScheduler,
  type GitHubSyncOptions,
  isGitHubSyncError,
} from "@dacci/github-sync";
import type {
  ApiInfoResponse,
  CreateDocumentRequest,
  CreateSubtopicRequest,
  CreateTopicRequest,
  DeleteDocumentRequest,
  DeleteSubtopicRequest,
  DeleteTopicRequest,
  ExportDocumentsRequest,
  ExportDocumentsResponse,
  GitSyncPushRequest,
  GitSyncScheduleConfigureRequest,
  GitSyncScheduleResponse,
  HealthCheckResponse,
  ImportDocumentsRequest,
  MoveDocumentRequest,
  RenameDocumentRequest,
  RenameSubtopicRequest,
  RenameTopicRequest,
  UpdateDocumentRequest,
} from "@dacci/shared-types";
import cors from "@fastify/cors";
import Fastify from "fastify";

export interface BuildAppOptions {
  dataRoot: string;
  gitSyncRepoRoot: string;
  gitSyncRemoteName?: string;
  gitSyncRemoteUrl?: string;
  gitSshCommand?: string;
  gitSyncReleaseBranch?: string;
}

const apiServiceSlug = "dacci-api";
const apiServiceName = "Dacci API";

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: true,
  });
  const engine = new ContentEngine({
    dataRoot: options.dataRoot,
  });
  const gitSync = createGitSync(options);
  const gitSyncScheduler = new GitHubSyncScheduler(gitSync, {
    logger: {
      info: (message) => app.log.info({ subsystem: "background-sync" }, message),
      warn: (message) => app.log.warn({ subsystem: "background-sync" }, message),
      error: (message) => app.log.error({ subsystem: "background-sync" }, message),
    },
  });

  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await gitSyncScheduler.start();
  app.addHook("onClose", async () => {
    await gitSyncScheduler.stop();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isContentEngineError(error)) {
      const statusCode =
        error.code === "invalid_input" ? 400 : error.code === "conflict" ? 409 : 404;
      void reply.status(statusCode).send({
        error: error.code,
        message: error.message,
      });
      return;
    }

    if (isGitHubSyncError(error)) {
      const statusCode =
        error.code === "invalid_configuration" ? 400 : error.code === "conflict" ? 409 : 500;
      void reply.status(statusCode).send({
        error: error.code,
        message: error.message,
      });
      return;
    }

    app.log.error(error);
    void reply.status(500).send({
      error: "internal_error",
      message: "An unexpected error occurred.",
    });
  });

  app.get("/health", async (): Promise<HealthCheckResponse> => ({
    status: "ok",
    service: apiServiceSlug,
    dataRoot: options.dataRoot,
  }));

  app.get("/ready", async (): Promise<HealthCheckResponse> => {
    await validateReadyRuntime(engine, gitSync, options.gitSshCommand);
    return {
      status: "ok",
      service: apiServiceSlug,
      dataRoot: options.dataRoot,
    };
  });

  app.get("/api", async (): Promise<ApiInfoResponse> => ({
    phase: "dacci-public-seed",
    service: apiServiceName,
    endpoints: [
      "/health",
      "/ready",
      "/api",
      "/api/tree",
      "/api/search",
      "/api/summary",
      "/api/documents",
      "/api/import/documents",
      "/api/export",
      "/api/topics",
      "/api/subtopics",
      "/api/sync/status",
      "/api/sync/pull",
      "/api/sync/push",
      "/api/sync/schedule",
      "/api/sync/schedule/pause",
      "/api/sync/schedule/resume",
    ],
  }));

  app.get("/api/tree", async () => engine.getTree());

  app.get<{ Querystring: { query?: string } }>("/api/search", async (request) => {
    if (!request.query.query) {
      throw new ContentEngineError("invalid_input", "The 'query' query parameter is required.");
    }

    return engine.searchDocuments(request.query.query);
  });

  app.get<{ Querystring: { path?: string } }>("/api/documents", async (request) => {
    if (!request.query.path) {
      throw new ContentEngineError("invalid_input", "The 'path' query parameter is required.");
    }

    return engine.getDocument(request.query.path);
  });

  app.get("/api/summary", async () => engine.getSummary());

  app.get<{ Querystring: { refresh?: string } }>("/api/sync/status", async (request) =>
    gitSyncScheduler.getStatus({
      refreshRemote: request.query.refresh === "true",
    }),
  );

  app.post("/api/sync/pull", async () => gitSyncScheduler.pullContent());

  app.post<{ Body: GitSyncPushRequest }>("/api/sync/push", async (request) =>
    gitSyncScheduler.pushContent(request.body),
  );

  app.post<{ Body: GitSyncScheduleConfigureRequest }>(
    "/api/sync/schedule",
    async (request): Promise<GitSyncScheduleResponse> =>
      gitSyncScheduler.configureSchedule(request.body ?? {}),
  );

  app.post("/api/sync/schedule/pause", async (): Promise<GitSyncScheduleResponse> =>
    gitSyncScheduler.pauseSchedule(),
  );

  app.post("/api/sync/schedule/resume", async (): Promise<GitSyncScheduleResponse> =>
    gitSyncScheduler.resumeSchedule(),
  );

  app.post<{ Body: CreateTopicRequest }>("/api/topics", async (request, reply) => {
    const topic = await engine.createTopic(request.body.name);
    return reply.status(201).send(topic);
  });

  app.patch<{ Params: { topicName: string }; Body: RenameTopicRequest }>(
    "/api/topics/:topicName",
    async (request) => engine.renameTopic(request.params.topicName, request.body.nextName),
  );

  app.delete<{ Body: DeleteTopicRequest }>("/api/topics", async (request, reply) => {
    await engine.deleteTopic(request.body.name);
    return reply.status(204).send();
  });

  app.post<{ Body: CreateSubtopicRequest }>("/api/subtopics", async (request, reply) => {
    const subtopic = await engine.createSubtopic(request.body.topicName, request.body.name);
    return reply.status(201).send(subtopic);
  });

  app.patch<{ Body: RenameSubtopicRequest }>("/api/subtopics", async (request) =>
    engine.renameSubtopic(
      request.body.topicName,
      request.body.currentName,
      request.body.nextName,
    ),
  );

  app.delete<{ Body: DeleteSubtopicRequest }>("/api/subtopics", async (request, reply) => {
    await engine.deleteSubtopic(request.body.topicName, request.body.name);
    return reply.status(204).send();
  });

  app.post<{ Body: CreateDocumentRequest }>("/api/documents", async (request, reply) => {
    const document = await engine.createDocument(request.body);
    return reply.status(201).send(document);
  });

  app.post<{ Body: ImportDocumentsRequest }>("/api/import/documents", async (request, reply) => {
    const result = await engine.importDocuments(request.body);
    return reply.status(201).send(result);
  });

  app.post<{ Body: ExportDocumentsRequest }>("/api/export", async (request): Promise<ExportDocumentsResponse> =>
    engine.exportTransfer(request.body),
  );

  app.put<{ Body: UpdateDocumentRequest }>("/api/documents", async (request) =>
    engine.updateDocument(request.body.path, request.body.body),
  );

  app.patch<{ Body: RenameDocumentRequest }>("/api/documents/rename", async (request) =>
    engine.renameDocument(request.body.path, request.body.nextName),
  );

  app.patch<{ Body: MoveDocumentRequest }>("/api/documents/move", async (request) =>
    engine.moveDocument(
      request.body.path,
      request.body.subtopicName
        ? {
            topicName: request.body.topicName,
            subtopicName: request.body.subtopicName,
          }
        : {
            topicName: request.body.topicName,
          },
    ),
  );

  app.delete<{ Body: DeleteDocumentRequest }>("/api/documents", async (request, reply) => {
    await engine.deleteDocument(request.body.path);
    return reply.status(204).send();
  });

  return app;
}

export async function validateAppRuntimeConfiguration(options: BuildAppOptions): Promise<void> {
  const gitSync = createGitSync(options);
  await gitSync.validateConfiguration();
  await ensureGitSshCommandFilesPresent(options.gitSshCommand);
}

function createGitSync(options: BuildAppOptions): GitHubSync {
  const gitSyncOptions: GitHubSyncOptions = {
    repoRoot: options.gitSyncRepoRoot,
    contentRoot: options.dataRoot,
  };
  if (options.gitSyncRemoteName) {
    gitSyncOptions.remoteName = options.gitSyncRemoteName;
  }
  if (options.gitSyncRemoteUrl) {
    gitSyncOptions.remoteUrl = options.gitSyncRemoteUrl;
  }
  if (options.gitSyncReleaseBranch) {
    gitSyncOptions.releaseBranch = options.gitSyncReleaseBranch;
  }

  return new GitHubSync(gitSyncOptions);
}

async function validateReadyRuntime(
  engine: ContentEngine,
  gitSync: GitHubSync,
  gitSshCommand?: string,
): Promise<void> {
  await gitSync.validateConfiguration();
  await engine.getSummary();
  await ensureGitSshCommandFilesPresent(gitSshCommand);
}

async function ensureGitSshCommandFilesPresent(gitSshCommand?: string): Promise<void> {
  if (!gitSshCommand?.trim()) {
    return;
  }

  for (const filePath of parseGitSshCommandFilePaths(gitSshCommand)) {
    try {
      await access(filePath);
    } catch {
      throw new Error(`Configured Git SSH file is missing: ${filePath}`);
    }
  }
}

function parseGitSshCommandFilePaths(gitSshCommand: string): string[] {
  const filePaths = new Set<string>();
  const patterns = [
    /(?:^|\s)-i\s+("[^"]+"|'[^']+'|[^\s]+)/g,
    /(?:^|\s)-o\s+IdentityFile=("[^"]+"|'[^']+'|[^\s]+)/g,
    /(?:^|\s)-o\s+UserKnownHostsFile=("[^"]+"|'[^']+'|[^\s]+)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(gitSshCommand)) !== null) {
      const value = match[1];
      if (!value) {
        continue;
      }

      filePaths.add(stripOptionalQuotes(value));
    }
  }

  return [...filePaths];
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
