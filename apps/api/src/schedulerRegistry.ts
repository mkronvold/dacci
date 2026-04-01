import { GitHubSyncScheduler, type GitHubSyncSchedulerLogger } from "@dacci/github-sync";
import type { LibraryRepoDefinition, RepoContextSummary } from "@dacci/shared-types";

import { RepoContextResolver, type ResolvedRepoContext } from "./repoContext.js";
import { buildRepoSchedulerKey, buildScheduleStateFileName } from "./scheduleState.js";

interface RegisteredRepoScheduler {
  readonly releaseBranch: string | undefined;
  readonly scheduler: GitHubSyncScheduler;
}

export interface RepoSyncSchedulerRegistryOptions {
  createLogger?: (repoContext: ResolvedRepoContext) => GitHubSyncSchedulerLogger | undefined;
}

export class RepoSyncSchedulerRegistry {
  private readonly schedulers = new Map<string, RegisteredRepoScheduler>();
  private readonly pendingSchedulers = new Map<string, Promise<RegisteredRepoScheduler>>();
  private started = false;

  public constructor(
    private readonly repoContextResolver: RepoContextResolver,
    private readonly options: RepoSyncSchedulerRegistryOptions = {},
  ) {}

  public async start(): Promise<void> {
    this.started = true;
    const repoContexts = await this.discoverStartupRepoContexts();
    await Promise.all(repoContexts.map(async (repoContext) => this.getScheduler(repoContext)));
  }

  public async stop(): Promise<void> {
    this.started = false;
    const pendingSchedulers = [...this.pendingSchedulers.values()];
    if (pendingSchedulers.length > 0) {
      await Promise.allSettled(pendingSchedulers);
    }

    const schedulers = [...this.schedulers.values()].map((entry) => entry.scheduler);
    await Promise.allSettled(schedulers.map(async (scheduler) => scheduler.stop()));
    this.schedulers.clear();
  }

  public async getScheduler(repoContext: ResolvedRepoContext): Promise<GitHubSyncScheduler> {
    const schedulerKey = buildRepoSchedulerKey(repoContext);
    const requestedReleaseBranch = normalizeOptionalString(
      repoContext.summary.releaseBranch,
    );
    const existingScheduler = this.schedulers.get(schedulerKey);
    if (existingScheduler && existingScheduler.releaseBranch === requestedReleaseBranch) {
      return existingScheduler.scheduler;
    }
    if (existingScheduler) {
      await existingScheduler.scheduler.stop();
      this.schedulers.delete(schedulerKey);
    }

    const pendingScheduler = this.pendingSchedulers.get(schedulerKey);
    if (pendingScheduler) {
      const registeredScheduler = await pendingScheduler;
      if (registeredScheduler.releaseBranch === requestedReleaseBranch) {
        return registeredScheduler.scheduler;
      }
      await registeredScheduler.scheduler.stop();
      this.schedulers.delete(schedulerKey);
    }

    const schedulerPromise = this.createScheduler(repoContext, schedulerKey).finally(() => {
      this.pendingSchedulers.delete(schedulerKey);
    });
    this.pendingSchedulers.set(schedulerKey, schedulerPromise);
    return (await schedulerPromise).scheduler;
  }

  private async createScheduler(
    repoContext: ResolvedRepoContext,
    schedulerKey: string,
  ): Promise<RegisteredRepoScheduler> {
    const releaseBranch = normalizeOptionalString(repoContext.summary.releaseBranch);
    const schedulerOptions: ConstructorParameters<typeof GitHubSyncScheduler>[1] = {
      stateFileName: buildScheduleStateFileName({
        isDefault: repoContext.isDefault,
        repoRoot: repoContext.repoRoot,
        dataRoot: repoContext.dataRoot,
      }),
    };
    const logger = this.options.createLogger?.(repoContext);
    if (logger) {
      schedulerOptions.logger = logger;
    }
    if (releaseBranch) {
      schedulerOptions.releaseBranch = releaseBranch;
    }

    const scheduler = new GitHubSyncScheduler(repoContext.createGitSync(), schedulerOptions);
    const registeredScheduler: RegisteredRepoScheduler = {
      releaseBranch,
      scheduler,
    };
    this.schedulers.set(schedulerKey, registeredScheduler);

    if (this.started) {
      await scheduler.start();
    }

    return registeredScheduler;
  }

  private async discoverStartupRepoContexts(): Promise<ResolvedRepoContext[]> {
    const repoContexts = new Map<string, ResolvedRepoContext>();
    const defaultSummary = this.repoContextResolver.getDefaultSummary();
    const summaries = [
      ...(defaultSummary ? [defaultSummary] : []),
      ...(await this.repoContextResolver.discoverLibraryRepos()),
    ];

    for (const summary of summaries) {
      const repoContext = summary.isDefault
        ? this.repoContextResolver.resolveRequestSelection(undefined)
        : this.repoContextResolver.resolveLibraryRepo(buildLibraryRepoDefinition(summary));
      repoContexts.set(buildRepoSchedulerKey(repoContext), repoContext);
    }

    return [...repoContexts.values()];
  }
}

function buildLibraryRepoDefinition(summary: RepoContextSummary): LibraryRepoDefinition {
  const repo: LibraryRepoDefinition = {
    id: summary.id,
    name: summary.name,
    repoRoot: summary.repoRoot,
  };
  if (summary.dataRoot) {
    repo.dataRoot = summary.dataRoot;
  }
  if (summary.releaseBranch) {
    repo.releaseBranch = summary.releaseBranch;
  }
  return repo;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue ? normalizedValue : undefined;
}
