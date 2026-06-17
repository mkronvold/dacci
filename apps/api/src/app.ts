import { access } from "node:fs/promises";

import {
  ContentEngine,
  ContentEngineError,
  DocsLibraryEngine,
  DocsLibraryError,
  isContentEngineError,
  isDocsLibraryError,
} from "@dacci/content-engine";
import {
  GitHubSync,
  GitHubSyncError,
  type GitHubSyncOptions,
  isGitHubSyncError,
} from "@dacci/github-sync";
import type {
  AuthSessionResponse,
  GitHubDeviceAuthorizationPollRequest,
  GitHubDeviceAuthorizationPollResponse,
  GitHubDeviceAuthorizationStartResponse,
  ArchiveDocsDocumentRequest,
  LibraryRepoDefinition,
  CreateDocsDraftInput,
  DeleteArchivedDocsDocumentRequest,
  DocsStatus,
  DocsTree,
  DocsDocumentVariant,
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
  LibraryRepoCreateRequest,
  LibraryRepoRemoteAdoptRequest,
  LibraryRepoTestRequest,
  LibraryRepoTestResponse,
  MoveDocumentRequest,
  PublishDocsDraftRequest,
  RenameDocumentRequest,
  RenameSubtopicRequest,
  RenameTopicRequest,
  SavePublishedEditRequest,
  UpdateDocsDraftRequest,
  UpdateDocumentRequest,
} from "@dacci/shared-types";
import { authSessionHeaderName, repoSelectionHeaderName } from "@dacci/shared-types";
import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";

import {
  createDefaultGitHubDeviceAuthProvider,
  GitHubDeviceAuthError,
  GitHubDeviceSessionStore,
  GitHubRepoPermissionEvaluator,
  isGitHubDeviceAuthError,
  type GitHubDeviceAuthProvider,
  type GitHubTeamRoleBinding,
  type RepoRoleOverride,
} from "./githubDeviceAuth.js";
import { adoptRemoteLibraryRepoCheckout, createLibraryRepoCheckout, readApiCapabilities } from "./libraryRepoCreator.js";
import { RepoContextResolver, type ResolvedRepoContext } from "./repoContext.js";
import { refreshManagedRuntimeSshState } from "./runtimeSsh.js";
import { RepoSyncSchedulerRegistry } from "./schedulerRegistry.js";

export interface BuildAppOptions {
  dataRoot?: string;
  gitSyncRepoRoot?: string;
  gitSyncRemoteName?: string;
  gitSyncRemoteUrl?: string;
  gitSshCommand?: string;
  gitSyncReleaseBranch?: string;
  libraryRepoRoots?: string[];
  libraryRepos?: LibraryRepoDefinition[];
  gitHubDeviceClientId?: string;
  gitHubDeviceAuthProvider?: GitHubDeviceAuthProvider;
  gitHubTeamRoleBindings?: GitHubTeamRoleBinding[];
  gitHubRepoRoleOverrides?: RepoRoleOverride[];
}

const apiServiceSlug = "dacci-api";
const apiServiceName = "Dacci API";

class RequestAuthorizationError extends Error {
  public constructor(
    public readonly statusCode: 401 | 403,
    public readonly code: "authentication_required" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "RequestAuthorizationError";
  }
}

class RepoMutationQueue {
  private readonly operations = new Map<string, Promise<void>>();

  public async enqueue<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
    const previousOperation = this.operations.get(repoRoot) ?? Promise.resolve();
    const resultPromise = previousOperation.then(action, action);
    const cleanupPromise = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    this.operations.set(repoRoot, cleanupPromise);

    try {
      return await resultPromise;
    } finally {
      if (this.operations.get(repoRoot) === cleanupPromise) {
        this.operations.delete(repoRoot);
      }
    }
  }
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: true,
  });
  const repoContextResolver = createRepoContextResolver(options);
  const gitHubDeviceAuthProvider = createGitHubDeviceAuthProvider(options);
  const authSessionStore = new GitHubDeviceSessionStore();
  const repoPermissionEvaluator = new GitHubRepoPermissionEvaluator({
    ...(options.gitHubTeamRoleBindings ? { teamBindings: options.gitHubTeamRoleBindings } : {}),
    ...(options.gitHubRepoRoleOverrides ? { repoOverrides: options.gitHubRepoRoleOverrides } : {}),
  });
  const repoMutationQueue = new RepoMutationQueue();
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

    if (isDocsLibraryError(error)) {
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

    if (isGitHubDeviceAuthError(error)) {
      const statusCode =
        error.code === "invalid_configuration"
          ? 400
          : error.code === "authorization_pending"
            ? 409
            : error.code === "authorization_denied"
              ? 403
              : 502;
      void reply.status(statusCode).send({
        error: error.code,
        message: error.message,
      });
      return;
    }

    if (error instanceof RequestAuthorizationError) {
      void reply.status(error.statusCode).send({
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
    capabilities: await readApiCapabilities(),
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
      "/api/library/adopt-remote",
      "/api/library/create",
      "/api/auth/session",
      "/api/auth/github/device/start",
      "/api/auth/github/device/poll",
      "/api/auth/session/logout",
      "/api/import/documents",
      "/api/export",
      "/api/docs/tree",
      "/api/docs/documents",
      "/api/docs/documents/draft",
      "/api/docs/documents/published",
      "/api/docs/documents/publish",
      "/api/docs/documents/archive",
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

  app.get("/api/auth/session", async (request): Promise<AuthSessionResponse> => {
    const session = authSessionStore.readSession(readAuthSessionId(request));
    return session
      ? {
          authenticated: true,
          session,
        }
      : {
          authenticated: false,
        };
  });

  app.post("/api/auth/github/device/start", async (): Promise<GitHubDeviceAuthorizationStartResponse> => {
    if (!gitHubDeviceAuthProvider) {
      throw new GitHubDeviceAuthError(
        "invalid_configuration",
        "GitHub device auth is not configured for this Dacci runtime.",
      );
    }

    return gitHubDeviceAuthProvider.startDeviceAuthorization();
  });

  app.post<{ Body: GitHubDeviceAuthorizationPollRequest }>(
    "/api/auth/github/device/poll",
    async (request): Promise<GitHubDeviceAuthorizationPollResponse> => {
      if (!gitHubDeviceAuthProvider) {
        throw new GitHubDeviceAuthError(
          "invalid_configuration",
          "GitHub device auth is not configured for this Dacci runtime.",
        );
      }

      const deviceCode = request.body?.deviceCode?.trim();
      if (!deviceCode) {
        throw new GitHubDeviceAuthError("invalid_configuration", "A device code is required.");
      }

      const authorizationResult = await gitHubDeviceAuthProvider.pollDeviceAuthorization(deviceCode);
      if (authorizationResult.status === "pending") {
        return {
          status: "pending",
          intervalSeconds: authorizationResult.intervalSeconds,
        };
      }

      const [user, teams, repos] = await Promise.all([
        gitHubDeviceAuthProvider.getAuthenticatedUser(authorizationResult.accessToken),
        gitHubDeviceAuthProvider.getTeamMemberships(authorizationResult.accessToken),
        readKnownRepoSummaries(repoContextResolver),
      ]);
      const permissions = repoPermissionEvaluator.evaluatePermissions(user, teams, repos);
      const session = authSessionStore.createSession({
        user,
        permissions,
        accessToken: authorizationResult.accessToken,
        teams,
      });
      return {
        status: "authorized",
        session,
      };
    },
  );

  app.post("/api/auth/session/logout", async (request, reply): Promise<AuthSessionResponse> => {
    authSessionStore.deleteSession(readAuthSessionId(request));
    return reply.status(200).send({
      authenticated: false,
    });
  });

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

  app.get("/api/docs/tree", async (request): Promise<DocsTree> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    requireRepoPermission({
      authEnabled: Boolean(gitHubDeviceAuthProvider),
      session: authSessionStore.readSession(readAuthSessionId(request)),
      repoContext,
      permission: "read",
    });
    return createDocsLibraryEngine(repoContext).getTree();
  });

  app.get<{ Querystring: { path?: string; status?: DocsStatus } }>("/api/docs/documents", async (request): Promise<DocsDocumentVariant> => {
    if (!request.query.path) {
      throw new DocsLibraryError("invalid_input", "The 'path' query parameter is required.");
    }

    if (!request.query.status) {
      throw new DocsLibraryError("invalid_input", "The 'status' query parameter is required.");
    }

    const repoContext = resolveRepoContext(repoContextResolver, request);
    requireRepoPermission({
      authEnabled: Boolean(gitHubDeviceAuthProvider),
      session: authSessionStore.readSession(readAuthSessionId(request)),
      repoContext,
      permission: "read",
    });

    return createDocsLibraryEngine(repoContext).getDocumentVariant(
      request.query.status,
      request.query.path,
    );
  });

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
    await refreshManagedRuntimeSshState({ preferLiveSource: true });
    const repoContext = repoContextResolver.resolveLibraryRepo(request.body.repo);
    return buildLibraryRepoTestResponse(repoContext, {
      refreshRemote: true,
    });
  });

  app.post<{ Body: LibraryRepoRemoteAdoptRequest }>(
    "/api/library/adopt-remote",
    async (request, reply): Promise<LibraryRepoTestResponse> => {
      const repoContext = await adoptRemoteLibraryRepoCheckout(request.body, repoContextResolver);
      return reply.status(201).send(
        await buildLibraryRepoTestResponse(repoContext, {
          refreshRemote: false,
        }),
      );
    },
  );

  app.post<{ Body: LibraryRepoCreateRequest }>(
    "/api/library/create",
    async (request, reply): Promise<LibraryRepoTestResponse> => {
      const repoContext = await createLibraryRepoCheckout(request.body, repoContextResolver);
      return reply.status(201).send(
        await buildLibraryRepoTestResponse(repoContext, {
          refreshRemote: false,
        }),
      );
    },
  );

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

  app.post<{ Body: CreateDocsDraftInput }>("/api/docs/documents", async (request, reply): Promise<DocsDocumentVariant> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    requireRepoPermission({
      authEnabled: Boolean(gitHubDeviceAuthProvider),
      session: authSessionStore.readSession(readAuthSessionId(request)),
      repoContext,
      permission: "edit",
    });
    const document = await repoMutationQueue.enqueue(repoContext.repoRoot, () =>
      createDocsLibraryEngine(repoContext).createDraft(request.body),
    );
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

  app.put<{ Body: UpdateDocsDraftRequest }>("/api/docs/documents/draft", async (request): Promise<DocsDocumentVariant> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    requireRepoPermission({
      authEnabled: Boolean(gitHubDeviceAuthProvider),
      session: authSessionStore.readSession(readAuthSessionId(request)),
      repoContext,
      permission: "edit",
    });
    return repoMutationQueue.enqueue(repoContext.repoRoot, () =>
      createDocsLibraryEngine(repoContext).updateDraft(
        request.body.logicalPath,
        request.body.body,
        request.body.expectedModifiedAt,
      ),
    );
  });

  app.put<{ Body: SavePublishedEditRequest }>("/api/docs/documents/published", async (request): Promise<DocsDocumentVariant> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    requireRepoPermission({
      authEnabled: Boolean(gitHubDeviceAuthProvider),
      session: authSessionStore.readSession(readAuthSessionId(request)),
      repoContext,
      permission: "edit",
    });
    return repoMutationQueue.enqueue(repoContext.repoRoot, () =>
      createDocsLibraryEngine(repoContext).savePublishedEdit(
        request.body.logicalPath,
        request.body.body,
        request.body.expectedModifiedAt,
      ),
    );
  });

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

  app.post<{ Body: PublishDocsDraftRequest }>("/api/docs/documents/publish", async (request): Promise<DocsDocumentVariant> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    requireRepoPermission({
      authEnabled: Boolean(gitHubDeviceAuthProvider),
      session: authSessionStore.readSession(readAuthSessionId(request)),
      repoContext,
      permission: "direct-publish",
    });
    return repoMutationQueue.enqueue(repoContext.repoRoot, () =>
      createDocsLibraryEngine(repoContext).publishDraft(
        request.body.logicalPath,
        request.body.expectedModifiedAt,
      ),
    );
  });

  app.post<{ Body: ArchiveDocsDocumentRequest }>("/api/docs/documents/archive", async (request): Promise<DocsDocumentVariant> => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    requireRepoPermission({
      authEnabled: Boolean(gitHubDeviceAuthProvider),
      session: authSessionStore.readSession(readAuthSessionId(request)),
      repoContext,
      permission: "direct-publish",
    });
    return repoMutationQueue.enqueue(repoContext.repoRoot, () =>
      createDocsLibraryEngine(repoContext).archiveDocument(
        request.body.logicalPath,
        request.body.sourceStatus,
        request.body.expectedModifiedAt,
      ),
    );
  });

  app.delete<{ Body: DeleteArchivedDocsDocumentRequest }>("/api/docs/documents/archive", async (request, reply) => {
    const repoContext = resolveRepoContext(repoContextResolver, request);
    requireRepoPermission({
      authEnabled: Boolean(gitHubDeviceAuthProvider),
      session: authSessionStore.readSession(readAuthSessionId(request)),
      repoContext,
      permission: "direct-publish",
    });
    await repoMutationQueue.enqueue(repoContext.repoRoot, () =>
      createDocsLibraryEngine(repoContext).deleteArchivedDocument(
        request.body.logicalPath,
        request.body.expectedModifiedAt,
      ),
    );
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
  if (options.libraryRepos) {
    repoContextOptions.libraryRepos = options.libraryRepos;
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

function createDocsLibraryEngine(repoContext: ResolvedRepoContext): DocsLibraryEngine {
  return new DocsLibraryEngine({
    repoRoot: repoContext.repoRoot,
  });
}

function readAuthSessionId(request: FastifyRequest): string | undefined {
  const headerValue = request.headers[authSessionHeaderName];
  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }

  return typeof headerValue === "string" ? headerValue : undefined;
}

async function readKnownRepoSummaries(repoContextResolver: RepoContextResolver) {
  const defaultSummary = repoContextResolver.getDefaultSummary();
  const discoveredRepos = await repoContextResolver.discoverLibraryRepos();
  return defaultSummary ? [defaultSummary, ...discoveredRepos.filter((repo) => repo.repoRoot !== defaultSummary.repoRoot)] : discoveredRepos;
}

function createGitHubDeviceAuthProvider(options: BuildAppOptions): GitHubDeviceAuthProvider | null {
  if (options.gitHubDeviceAuthProvider) {
    return options.gitHubDeviceAuthProvider;
  }

  if (!options.gitHubDeviceClientId?.trim()) {
    return null;
  }

  return createDefaultGitHubDeviceAuthProvider({
    clientId: options.gitHubDeviceClientId,
  });
}

function requireRepoPermission(input: {
  authEnabled: boolean;
  session: AuthSessionResponse["session"] | null;
  repoContext: ResolvedRepoContext;
  permission: "read" | "edit" | "direct-publish";
}): void {
  if (!input.authEnabled) {
    return;
  }

  if (!input.session) {
    throw new RequestAuthorizationError(
      401,
      "authentication_required",
      "Authenticate with GitHub before accessing Dacci documentation repositories.",
    );
  }

  const repoPermission = input.session.permissions.find((entry) => entry.repoId === input.repoContext.summary.id);
  if (!repoPermission) {
    throw new RequestAuthorizationError(
      403,
      "forbidden",
      `You do not have access to repository '${input.repoContext.summary.name}'.`,
    );
  }

  if (input.permission === "read" || input.permission === "edit") {
    if (!repoPermission.canEditDrafts) {
      throw new RequestAuthorizationError(
        403,
        "forbidden",
        `You cannot edit draft content in repository '${input.repoContext.summary.name}'.`,
      );
    }
    return;
  }

  if (!repoPermission.canDirectPublish) {
    throw new RequestAuthorizationError(
      403,
      "forbidden",
      `You cannot change published or archived status directly in repository '${input.repoContext.summary.name}'.`,
    );
  }
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

async function buildLibraryRepoTestResponse(
  repoContext: ResolvedRepoContext,
  options?: { refreshRemote?: boolean },
): Promise<LibraryRepoTestResponse> {
  const gitSync = repoContext.createGitSync();
  const [content, git] = await Promise.all([repoContext.createEngine().getSummary(), gitSync.validateConfiguration()]);
  if (options?.refreshRemote) {
    await gitSync.getStatus({ refreshRemote: true });
  }

  return {
    repo: repoContext.summary,
    content,
    git,
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
    /(?:^|\s)-F\s+("[^"]+"|'[^']+'|[^\s]+)/g,
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
