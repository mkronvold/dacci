import { configuredRepoId } from "@dacci/shared-types";
import type {
  LibraryRepoDefinition,
  RepoContextSummary,
  RepoSelection,
  SavedLibraryRepoDefinition,
} from "@dacci/shared-types";

const libraryStateStorageKeyPrefix = "dacci.library.state";
const legacyDefaultRepoSelectionId = "default";
const legacyLibraryWorkspacePrefix = "/library-workspace";
const runtimeWorkspacePrefix = "/workspace";

export interface PersistedLibraryState {
  entries: SavedLibraryRepoDefinition[];
  lastViewedRepoId: string;
}

export function buildLibraryStateStorageKey(apiBaseUrl: string): string {
  return `${libraryStateStorageKeyPrefix}:${apiBaseUrl}`;
}

export function readPersistedLibraryState(apiBaseUrl: string): PersistedLibraryState {
  const defaultState: PersistedLibraryState = {
    entries: [],
    lastViewedRepoId: "",
  };

  if (typeof window === "undefined") {
    return defaultState;
  }

  const rawValue = window.localStorage.getItem(buildLibraryStateStorageKey(apiBaseUrl));
  if (!rawValue) {
    return defaultState;
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;
    if (!parsedValue || typeof parsedValue !== "object") {
      console.warn("Ignoring invalid saved library state from localStorage.");
      return defaultState;
    }

    const candidate = parsedValue as Record<string, unknown>;
    const entries = Array.isArray(candidate.entries)
      ? candidate.entries.map(parseSavedLibraryRepoDefinition).filter((entry): entry is SavedLibraryRepoDefinition => entry !== null)
      : defaultState.entries;
    const rawLastViewedRepoId =
      typeof candidate.lastViewedRepoId === "string"
        ? candidate.lastViewedRepoId
        : typeof candidate.selectedRepoId === "string"
          ? candidate.selectedRepoId
          : defaultState.lastViewedRepoId;

    return {
      entries: sortSavedLibraryRepos(entries),
      lastViewedRepoId: normalizeLastViewedRepoId(rawLastViewedRepoId, entries),
    };
  } catch (error) {
    console.warn("Failed to read saved library state from localStorage.", error);
    return defaultState;
  }
}

export function writePersistedLibraryState(apiBaseUrl: string, state: PersistedLibraryState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(buildLibraryStateStorageKey(apiBaseUrl), JSON.stringify(state));
  } catch (error) {
    console.warn("Failed to save library state to localStorage.", error);
  }
}

export function createConfiguredLibraryRepo(summary: RepoContextSummary): SavedLibraryRepoDefinition {
  const configuredRepo: SavedLibraryRepoDefinition = {
    id: configuredRepoId,
    name: summary.name.trim() || "Active repository",
    repoRoot: summary.repoRoot,
    dataRoot: summary.dataRoot,
    source: "configured",
  };
  if (summary.releaseBranch) {
    configuredRepo.releaseBranch = summary.releaseBranch;
  }
  return configuredRepo;
}

export function createDiscoveredLibraryRepo(summary: RepoContextSummary): SavedLibraryRepoDefinition {
  const discoveredRepo: SavedLibraryRepoDefinition = {
    id: summary.id,
    name: summary.name.trim() || "Discovered repository",
    repoRoot: summary.repoRoot,
    source: summary.isDefault ? "configured" : "discovered",
  };
  if (summary.dataRoot) {
    discoveredRepo.dataRoot = summary.dataRoot;
  }
  if (summary.releaseBranch) {
    discoveredRepo.releaseBranch = summary.releaseBranch;
  }
  return discoveredRepo;
}

export function reconcileLibraryState(
  entries: SavedLibraryRepoDefinition[],
  lastViewedRepoId: string,
  runtimeRepos: SavedLibraryRepoDefinition[] = [],
): PersistedLibraryState {
  const nextEntries = runtimeRepos.length > 0 ? mergeRuntimeLibraryRepos(entries, runtimeRepos) : sortSavedLibraryRepos(entries);
  return {
    entries: nextEntries,
    lastViewedRepoId: normalizeLastViewedRepoId(lastViewedRepoId, nextEntries),
  };
}

export function mergeConfiguredLibraryRepo(
  entries: SavedLibraryRepoDefinition[],
  configuredRepo: SavedLibraryRepoDefinition,
): SavedLibraryRepoDefinition[] {
  const mergedConfiguredRepo: SavedLibraryRepoDefinition = {
    ...configuredRepo,
    source: "configured",
  };
  const remainingEntries = entries.filter(
    (entry) => entry.id !== configuredRepo.id && entry.source !== "configured",
  );
  return sortSavedLibraryRepos([...remainingEntries, mergedConfiguredRepo]);
}

export function buildRepoSelection(
  selectedRepoId: string,
  entries: SavedLibraryRepoDefinition[],
): RepoSelection {
  const selectedEntry = findSavedLibraryRepo(entries, selectedRepoId);
  if (!selectedEntry) {
    return { kind: "default" };
  }

  return {
    kind: "library",
    repo: toLibraryRepoDefinition(selectedEntry),
  };
}

export function findSavedLibraryRepo(
  entries: SavedLibraryRepoDefinition[],
  repoId: string,
): SavedLibraryRepoDefinition | undefined {
  return entries.find((entry) => entry.id === repoId);
}

export function isConfiguredLibraryRepo(repo: SavedLibraryRepoDefinition): boolean {
  return repo.source === "configured" || repo.id === configuredRepoId;
}

export function toLibraryRepoDefinition(repo: SavedLibraryRepoDefinition): LibraryRepoDefinition {
  const definition: LibraryRepoDefinition = {
    id: repo.id,
    name: repo.name,
    repoRoot: repo.repoRoot,
  };
  if (repo.dataRoot) {
    definition.dataRoot = repo.dataRoot;
  }
  if (repo.releaseBranch) {
    definition.releaseBranch = repo.releaseBranch;
  }
  return definition;
}

export function encodeRepoSelectionHeaderValue(selection: RepoSelection): string {
  return encodeURIComponent(JSON.stringify(selection));
}

function parseSavedLibraryRepoDefinition(value: unknown): SavedLibraryRepoDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.trim().length === 0 ||
    typeof candidate.name !== "string" ||
    candidate.name.trim().length === 0 ||
    typeof candidate.repoRoot !== "string" ||
    candidate.repoRoot.trim().length === 0
  ) {
    return null;
  }

  const dataRoot =
    typeof candidate.dataRoot === "string" && candidate.dataRoot.trim().length > 0
      ? candidate.dataRoot.trim()
      : undefined;
  const releaseBranch =
    typeof candidate.releaseBranch === "string" && candidate.releaseBranch.trim().length > 0
      ? candidate.releaseBranch.trim()
      : undefined;
  const source =
    candidate.source === "configured" || candidate.source === "discovered" || candidate.source === "saved"
      ? candidate.source
      : undefined;

  const parsedRepo: SavedLibraryRepoDefinition = {
    id: candidate.id.trim(),
    name: candidate.name.trim(),
    repoRoot: normalizeSavedRepoPath(candidate.repoRoot.trim()),
  };
  if (dataRoot) {
    parsedRepo.dataRoot = normalizeSavedRepoPath(dataRoot);
  }
  if (releaseBranch) {
    parsedRepo.releaseBranch = releaseBranch;
  }
  if (source) {
    parsedRepo.source = source;
  }

  return parsedRepo;
}

function normalizeLastViewedRepoId(value: string, entries: SavedLibraryRepoDefinition[]): string {
  const normalizedValue = value.trim();
  const migratedValue =
    normalizedValue === legacyDefaultRepoSelectionId ? configuredRepoId : normalizedValue;

  if (migratedValue && entries.some((entry) => entry.id === migratedValue)) {
    return migratedValue;
  }

  return entries[0]?.id ?? "";
}

function sortSavedLibraryRepos(entries: SavedLibraryRepoDefinition[]): SavedLibraryRepoDefinition[] {
  return [...entries].sort((left, right) => {
    const nameComparison = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
    if (nameComparison !== 0) {
      return nameComparison;
    }

    return left.repoRoot.localeCompare(right.repoRoot);
  });
}

function normalizeSavedRepoPath(value: string): string {
  if (value === legacyLibraryWorkspacePrefix) {
    return runtimeWorkspacePrefix;
  }

  return value.startsWith(`${legacyLibraryWorkspacePrefix}/`)
    ? `${runtimeWorkspacePrefix}${value.slice(legacyLibraryWorkspacePrefix.length)}`
    : value;
}

function mergeRuntimeLibraryRepos(
  entries: SavedLibraryRepoDefinition[],
  runtimeRepos: SavedLibraryRepoDefinition[],
): SavedLibraryRepoDefinition[] {
  let nextEntries = entries.filter((entry) => entry.source !== "configured" && entry.source !== "discovered");

  for (const runtimeRepo of runtimeRepos) {
    const matchingEntry = entries.find((entry) => libraryReposReferToSameCheckout(entry, runtimeRepo));
    nextEntries = upsertRuntimeLibraryRepo(nextEntries, mergeRuntimeLibraryRepo(matchingEntry, runtimeRepo));
  }

  return sortSavedLibraryRepos(nextEntries);
}

function mergeRuntimeLibraryRepo(
  existingEntry: SavedLibraryRepoDefinition | undefined,
  runtimeRepo: SavedLibraryRepoDefinition,
): SavedLibraryRepoDefinition {
  if (!existingEntry) {
    return runtimeRepo;
  }

  if (isConfiguredLibraryRepo(runtimeRepo)) {
    return {
      ...runtimeRepo,
      source: "configured",
    };
  }

  if (existingEntry.source === "saved") {
    const mergedSavedRepo: SavedLibraryRepoDefinition = {
      id: existingEntry.id,
      source: "saved",
      name: existingEntry.name.trim() || runtimeRepo.name,
      repoRoot: runtimeRepo.repoRoot,
    };
    const dataRoot = existingEntry.dataRoot ?? runtimeRepo.dataRoot;
    if (dataRoot) {
      mergedSavedRepo.dataRoot = dataRoot;
    }
    const releaseBranch = existingEntry.releaseBranch ?? runtimeRepo.releaseBranch;
    if (releaseBranch) {
      mergedSavedRepo.releaseBranch = releaseBranch;
    }
    return mergedSavedRepo;
  }

  const mergedRuntimeRepo: SavedLibraryRepoDefinition = {
    id: existingEntry.id,
    name: runtimeRepo.name,
    repoRoot: runtimeRepo.repoRoot,
  };
  if (runtimeRepo.dataRoot) {
    mergedRuntimeRepo.dataRoot = runtimeRepo.dataRoot;
  }
  if (runtimeRepo.releaseBranch) {
    mergedRuntimeRepo.releaseBranch = runtimeRepo.releaseBranch;
  }
  const source = runtimeRepo.source ?? existingEntry.source;
  if (source) {
    mergedRuntimeRepo.source = source;
  }
  return mergedRuntimeRepo;
}

function upsertRuntimeLibraryRepo(
  entries: SavedLibraryRepoDefinition[],
  repo: SavedLibraryRepoDefinition,
): SavedLibraryRepoDefinition[] {
  const remainingEntries = entries.filter((entry) => !libraryReposReferToSameCheckout(entry, repo));
  return [...remainingEntries, repo];
}

function libraryReposReferToSameCheckout(
  left: SavedLibraryRepoDefinition,
  right: SavedLibraryRepoDefinition,
): boolean {
  if (left.id === right.id) {
    return true;
  }

  if (isConfiguredLibraryRepo(left) || isConfiguredLibraryRepo(right)) {
    return isConfiguredLibraryRepo(left) && isConfiguredLibraryRepo(right);
  }

  return left.repoRoot === right.repoRoot;
}
