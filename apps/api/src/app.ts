import { access } from "node:fs/promises";

import {
  ContentEngine,
  ContentEngineError,
  isContentEngineError,
} from "@dacci/content-engine";
import {
  GitHubSync,
  GitHubSyncError,
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
  GitSyncOperationResponse,
  GitSyncPushRequest,
  GitSyncScheduleConfigureRequest,
  GitSyncScheduleResponse,
  GitSyncStatus,
  HealthCheckResponse,
  ImportDocumentsRequest,
  LibraryRepoDiscoveryResponse,
  LibraryRepoTestRequest,
  LibraryRepoTestResponse,
  MoveDocumentRequest,
  RenameDocumentRequest,
  RenameSubtopicRequest,
  RenameTopicRequest,
  UpdateDocumentRequest,
} from "@dacci/shared-types";
import { repoSelectionHeaderName } from "@dacci/shared-types";
import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";

import { RepoContextResolver, type ResolvedRepoContext } from "./repoContext.js";
import { RepoSyncSchedulerRegistry } from "./schedulerRegistry.js";

export interface BuildAppOptions {
  dataRoot?: string;
  gitSyncRepoRoot?: string;
  gitSyncRemoteName?: string;
  gitSyncRemoteUrl?: string;
  gitSshCommand?: string;
  gitSyncReleaseBranch?: string;
  libraryRepoRoots?: string[];
}

const apiServiceSlug = "dacci-api";
const apiServiceName = "Dacci API";

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: true,
  });
  const repoContextResolver = createRepoContextResolver(options);
  const syncSchedulerRegistry = new RepoSyncSchedulerRegistry(repoContextResolver, {
    createLogger: (repoContext) => ({
      info: (message) =>
        app.log.info(
          {
            subsystem: "background-sync",
            repoId: repoContext.summary.id,
            repoName: repoContext.summary.name,
          },
          message,
        ),
      warn: (message) =>
        app.log.warn(
          {
            subsystem: "background-sync",
            repoId: repoContext.summary.id,
            repoName: repoContext.summary.name,
          },
          message,
        ),
      error: (message) =>
        app.log.error(
          {
            subsystem: "background-sync",
            repoId: repoContext.summary.id,
            repoName: repoContext.summary.name,
          },
          message,
        ),
    }),
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await syncSchedulerRegistry.start();
  app.addHook("onClose", async () => {
    await syncSchedulerRegistry.stop();
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
    dataRoot: repoContextResolver.getDefaultSummary()?.dataRoot ?? "",
  }));

  app.get("/ready", async (request): Promise<HealthCheckResponse> => {
    const defaultSummary = repoContextResolver.getDefaultSummary();
    const repoSelectionHeader = request.headers[repoSelectionHeaderName];
    if (hasExplicitRepoSelectionHeader(repoSelectionHeader) || defaultSummary) {
      const repoContext = resolveRepoContext(repoContextResolver, request);
      await validateReadyRuntime(
        repoContext.createEngine(),
        repoContext.createGitSync(),
        options.gitSshCommand,
      );
      return {
        status: "ok",
        service: apiServiceSlug,
        dataRoot: repoContext.dataRoot,
      };
    }

    await ensureGitSshCommandFilesPresent(options.gitSshCommand);
    return {
      status: "ok",
      service: apiServiceSlug,
      dataRoot: "",
    };
  });

  app.get("/api", async (): Promise<ApiInfoResponse> => ({
    phase: "dacci-public-seed",
    service: apiServiceName,
    configuredRepo: repoContextResolver.getDefaultSummary(),
    endpoints: [
      "/health",
      "/ready",
      "/api",
      "/api/tree",
      "/api/search",
      "/api/summary",
      "/api/documents",
      "/api/library/discover",
      "/api/library/test",
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

  app.get("/api/library/discover", async (): Promise<LibraryRepoDiscoveryResponse> => ({
    libraryRoots: repoContextResolver.getConfiguredLibraryRoots(),
    repos: await repoContextResolver.discoverLibraryRepos(),
  }));

  app.get("/api/tree", async (request) => resolveRepoContext(repoContextResolver, request).createEngine().getTree());

  app.get<{ Querystring: { query?: string } }>("/api/search", async (request) => {
    if (!request.query.query) {
      throw new ContentEngineError("invalid_input", "The 'query' query parameter is required.");
    }

    return resolveRepoContext(repoContextResolver, request).createEngine().searchDocuments(request.query.query);
  });

  app.get<{ Querystring: { path?: string } }>("/api/documents", async (request) => {
    if (!request.query.path) {
      throw new ContentEngineError("invalid_input", "The 'path' query parameter is required.");
    }

    return resolveRepoContext(repoContextResolver, request).createEngine().getDocument(request.query.path);
  });

  app.get("/api/summary", async (request) => resolveRepoContext(repoContextResolver, request).createEngine().getSummary());

  app.get<{ Querystring: { refresh?: string } }>("/api/sync/status", async (request) => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    const refreshRemote = request.query.refresh === "true";
    const gitSyncScheduler = await syncSchedulerRegistry.getScheduler(repoContext);
    return decorateGitSyncStatus(await gitSyncScheduler.getStatus({ refreshRemote }), repoContext);
  });

  app.post("/api/sync/pull", async (request): Promise<GitSyncOperationResponse> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    const gitSyncScheduler = await syncSchedulerRegistry.getScheduler(repoContext);

    return decorateGitSyncOperationResponse(await gitSyncScheduler.pullContent(), repoContext);
  });

  app.post<{ Body: GitSyncPushRequest }>("/api/sync/push", async (request): Promise<GitSyncOperationResponse> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    const gitSyncScheduler = await syncSchedulerRegistry.getScheduler(repoContext);

    return decorateGitSyncOperationResponse(await gitSyncScheduler.pushContent(request.body), repoContext);
  });

  app.post<{ Body: GitSyncScheduleConfigureRequest }>(
    "/api/sync/schedule",
    async (request): Promise<GitSyncScheduleResponse> => {
      const repoContext = resolveRepoContext(repoContextResolver, request);
      const gitSyncScheduler = await syncSchedulerRegistry.getScheduler(repoContext);
      return decorateGitSyncScheduleResponse(
        await gitSyncScheduler.configureSchedule(request.body ?? {}),
        repoContext,
      );
    },
  );

  app.post("/api/sync/schedule/pause", async (request): Promise<GitSyncScheduleResponse> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    const gitSyncScheduler = await syncSchedulerRegistry.getScheduler(repoContext);
    return decorateGitSyncScheduleResponse(await gitSyncScheduler.pauseSchedule(), repoContext);
  });

  app.post("/api/sync/schedule/resume", async (request): Promise<GitSyncScheduleResponse> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    const gitSyncScheduler = await syncSchedulerRegistry.getScheduler(repoContext);
    return decorateGitSyncScheduleResponse(await gitSyncScheduler.resumeSchedule(), repoContext);
  });

  app.post<{ Body: LibraryRepoTestRequest }>("/api/library/test", async (request): Promise<LibraryRepoTestResponse> => {
    const repoContext = repoContextResolver.resolveLibraryRepo(request.body.repo);
    const gitSync = repoContext.createGitSync();
    const [content, git] = await Promise.all([repoContext.createEngine().getSummary(), gitSync.validateConfiguration()]);
    await gitSync.getStatus({ refreshRemote: true });

    return {
      repo: repoContext.summary,
      content,
      git,
    };
  });

  app.post<{ Body: CreateTopicRequest }>("/api/topics", async (request, reply) => {
    const topic = await resolveRepoContext(repoContextResolver, request).createEngine().createTopic(request.body.name);
    return reply.status(201).send(topic);
  });

  app.patch<{ Params: { topicName: string }; Body: RenameTopicRequest }>(
    "/api/topics/:topicName",
    async (request) =>
      resolveRepoContext(repoContextResolver, request)
        .createEngine()
        .renameTopic(request.params.topicName, request.body.nextName),
  );

  app.delete<{ Body: DeleteTopicRequest }>("/api/topics", async (request, reply) => {
    await resolveRepoContext(repoContextResolver, request).createEngine().deleteTopic(request.body.name);
    return reply.status(204).send();
  });

  app.post<{ Body: CreateSubtopicRequest }>("/api/subtopics", async (request, reply) => {
    const subtopic = await resolveRepoContext(repoContextResolver, request)
      .createEngine()
      .createSubtopic(request.body.topicName, request.body.name);
    return reply.status(201).send(subtopic);
  });

  app.patch<{ Body: RenameSubtopicRequest }>("/api/subtopics", async (request) =>
    resolveRepoContext(repoContextResolver, request)
      .createEngine()
      .renameSubtopic(request.body.topicName, request.body.currentName, request.body.nextName),
  );

  app.delete<{ Body: DeleteSubtopicRequest }>("/api/subtopics", async (request, reply) => {
    await resolveRepoContext(repoContextResolver, request).createEngine().deleteSubtopic(request.body.topicName, request.body.name);
    return reply.status(204).send();
  });

  app.post<{ Body: CreateDocumentRequest }>("/api/documents", async (request, reply) => {
    const document = await resolveRepoContext(repoContextResolver, request).createEngine().createDocument(request.body);
    return reply.status(201).send(document);
  });

  app.post<{ Body: ImportDocumentsRequest }>("/api/import/documents", async (request, reply) => {
    const result = await resolveRepoContext(repoContextResolver, request).createEngine().importDocuments(request.body);
    return reply.status(201).send(result);
  });

  app.post<{ Body: ExportDocumentsRequest }>("/api/export", async (request): Promise<ExportDocumentsResponse> =>
    resolveRepoContext(repoContextResolver, request).createEngine().exportTransfer(request.body),
  );

  app.put<{ Body: UpdateDocumentRequest }>("/api/documents", async (request) =>
    resolveRepoContext(repoContextResolver, request).createEngine().updateDocument(request.body.path, request.body.body),
  );

  app.patch<{ Body: RenameDocumentRequest }>("/api/documents/rename", async (request) =>
    resolveRepoContext(repoContextResolver, request).createEngine().renameDocument(request.body.path, request.body.nextName),
  );

  app.patch<{ Body: MoveDocumentRequest }>("/api/documents/move", async (request) =>
    resolveRepoContext(repoContextResolver, request)
      .createEngine()
      .moveDocument(
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
    await resolveRepoContext(repoContextResolver, request).createEngine().deleteDocument(request.body.path);
    return reply.status(204).send();
  });

  return app;
}

export async function validateAppRuntimeConfiguration(options: BuildAppOptions): Promise<void> {
  if ((options.dataRoot && !options.gitSyncRepoRoot) || (!options.dataRoot && options.gitSyncRepoRoot)) {
    throw new Error("DATA_ROOT and GIT_SYNC_REPO_ROOT must be set together.");
  }

  const repoContextResolver = createRepoContextResolver(options);
  if (options.dataRoot && options.gitSyncRepoRoot) {
    const gitSync = createGitSync(options);
    await Promise.all([
      gitSync.validateConfiguration(),
      repoContextResolver.validateConfiguredLibraryRoots(),
    ]);
  } else {
    await repoContextResolver.validateConfiguredLibraryRoots();
  }
  await ensureGitSshCommandFilesPresent(options.gitSshCommand);
}

function createRepoContextResolver(options: BuildAppOptions): RepoContextResolver {
  const repoContextOptions: ConstructorParameters<typeof RepoContextResolver>[0] = {};
  if (options.dataRoot && options.gitSyncRepoRoot) {
    repoContextOptions.defaultDataRoot = options.dataRoot;
    repoContextOptions.defaultRepoRoot = options.gitSyncRepoRoot;
  }
  if (options.gitSyncRemoteName) {
    repoContextOptions.gitSyncRemoteName = options.gitSyncRemoteName;
  }
  if (options.gitSyncRemoteUrl) {
    repoContextOptions.gitSyncRemoteUrl = options.gitSyncRemoteUrl;
  }
  if (options.gitSyncReleaseBranch) {
    repoContextOptions.gitSyncReleaseBranch = options.gitSyncReleaseBranch;
  }
  if (options.libraryRepoRoots) {
    repoContextOptions.libraryRepoRoots = options.libraryRepoRoots;
  }

  return new RepoContextResolver(repoContextOptions);
}

function createGitSync(options: BuildAppOptions): GitHubSync {
  if (!options.gitSyncRepoRoot || !options.dataRoot) {
    throw new Error("Git sync runtime requires both DATA_ROOT and GIT_SYNC_REPO_ROOT.");
  }

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

function resolveRepoContext(
  repoContextResolver: RepoContextResolver,
  request: FastifyRequest,
): ResolvedRepoContext {
  return repoContextResolver.resolveRequestSelection(request.headers[repoSelectionHeaderName]);
}

function hasExplicitRepoSelectionHeader(headerValue: string | string[] | undefined): boolean {
  if (Array.isArray(headerValue)) {
    return headerValue.length > 0;
  }

  return Boolean(headerValue?.trim());
}

function decorateGitSyncOperationResponse(
  response: GitSyncOperationResponse,
  repoContext: ResolvedRepoContext,
): GitSyncOperationResponse {
  return {
    ...response,
    status: decorateGitSyncStatus(response.status, repoContext),
  };
}

function decorateGitSyncScheduleResponse(
  response: GitSyncScheduleResponse,
  repoContext: ResolvedRepoContext,
): GitSyncScheduleResponse {
  return {
    ...response,
    status: decorateGitSyncStatus(response.status, repoContext),
  };
}

function decorateGitSyncStatus(
  status: GitSyncStatus,
  repoContext: ResolvedRepoContext,
): GitSyncStatus {
  return {
    ...status,
    repo: repoContext.summary,
    schedulerSupported: true,
  };
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
