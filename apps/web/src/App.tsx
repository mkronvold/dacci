import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { repoSelectionHeaderName } from "@dacci/shared-types";
import type {
  ApiInfoResponse,
  ContentDocument,
  ContentExportBundle,
  ContentSearchResponse,
  ContentSubtopicNode,
  ContentTopicNode,
  ContentTree,
  ImportConflictMode,
  ImportFormat,
  ImportFolderMappingMode,
  CreateDocumentRequest,
  CreateSubtopicRequest,
  CreateTopicRequest,
  DeleteDocumentRequest,
  DeleteSubtopicRequest,
  DeleteTopicRequest,
  ExportDocumentsRequest,
  ExportDocumentsResponse,
  ExportFormat,
  ExportScope,
  GitSyncOperationResponse,
  GitSyncScheduleResponse,
  GitSyncStatus,
  HealthCheckResponse,
  ImportDocumentsRequest,
  ImportDocumentsResponse,
  LibraryRepoDiscoveryResponse,
  LibraryRepoTestResponse,
  MoveDocumentRequest,
  RepoContextSummary,
  RenameDocumentRequest,
  RenameSubtopicRequest,
  RenameTopicRequest,
  RepoSelection,
  SavedLibraryRepoDefinition,
  UpdateDocumentRequest,
} from "@dacci/shared-types";

import { DocumentEditor } from "./components/DocumentEditor";
import { DocumentOutlinePane } from "./components/DocumentOutlinePane";
import { LibraryPane } from "./components/LibraryPane";
import { ManagementPane } from "./components/ManagementPane";
import { MarkdownViewer, readOutlineOpenState, writeOutlineOpenState } from "./components/MarkdownViewer";
import { NavigationPane } from "./components/NavigationPane";
import { SyncPane } from "./components/SyncPane";
import { ViewerHeader } from "./components/ViewerHeader";
import {
  extractDocumentTags,
  extractFrontMatterBlock,
  extractMarkdownHeadings,
  normalizeDocumentTag,
  stripFrontMatter,
  updateDocumentTags,
} from "./utils/markdownDocument";
import {
  buildRepoSelection,
  createDiscoveredLibraryRepo,
  encodeRepoSelectionHeaderValue,
  findSavedLibraryRepo,
  isConfiguredLibraryRepo,
  readPersistedLibraryState,
  reconcileLibraryState,
  toLibraryRepoDefinition,
  writePersistedLibraryState,
} from "./utils/libraryRepos";
import { applyThemeName, readPersistedThemeName, type ThemeName, writePersistedThemeName } from "./utils/theme";

const defaultApiBaseUrl = "http://localhost:3000";
const createContentRepoGuideUrl = "https://github.com/mkronvold/Dacci.Example.Content/blob/main/README.md";
const navigationTreeStateStorageKeyPrefix = "dacci.navigation.collapsed";
const uiToggleStateStorageKeyPrefix = "dacci.ui.toggles";

interface AppProps {
  apiBaseUrl?: string;
}

type RequestRepoContext = {
  repoSelection?: RepoSelection;
};

type TopicFormState = {
  name: string;
};

type SubtopicFormState = {
  topicName: string;
  name: string;
};

type DocumentFormState = {
  topicName: string;
  subtopicName: string;
  name: string;
  body: string;
};

type RenameDocumentState = {
  nextName: string;
};

type MoveDocumentState = {
  topicName: string;
  subtopicName: string;
};

type ImportFormState = {
  format: ImportFormat;
  topicName: string;
  subtopicName: string;
  conflictMode: ImportConflictMode;
  folderMappingMode: ImportFolderMappingMode;
};

type ExportFormState = {
  scope: "document" | "topic" | "subtopic";
  format: "default" | ExportFormat;
  topicName: string;
  subtopicName: string;
};

type SyncScheduleFormState = {
  enabled: boolean;
  intervalMinutes: string;
};

type LibraryRepoFormState = {
  id: string | null;
  source: "configured" | "discovered" | "saved" | null;
  name: string;
  repoRoot: string;
  dataRoot: string;
  releaseBranch: string;
};

function createEmptyLibraryRepoFormState(): LibraryRepoFormState {
  return {
    id: null,
    source: null,
    name: "",
    repoRoot: "",
    dataRoot: "",
    releaseBranch: "",
  };
}

type DocumentMode = "view" | "edit";

type ActiveDocumentTool = "rename" | "move" | null;
type OpenSidePanel = "manage" | "library" | "sync" | null;
type PersistedUiToggleState = {
  navigationPaneOpen: boolean;
  openSidePanel: OpenSidePanel;
  showDocuments: boolean;
  showTags: boolean;
  showHidden: boolean;
  outlineOpen: boolean;
};

function isOpenSidePanel(value: unknown): value is OpenSidePanel {
  return value === null || value === "manage" || value === "library" || value === "sync";
}

function buildUiToggleStateStorageKey(apiBaseUrl: string): string {
  return `${uiToggleStateStorageKeyPrefix}:${apiBaseUrl}`;
}

function readPersistedUiToggleState(apiBaseUrl: string): PersistedUiToggleState {
  const defaultState: PersistedUiToggleState = {
    navigationPaneOpen: true,
    openSidePanel: null,
    showDocuments: true,
    showTags: false,
    showHidden: false,
    outlineOpen: readOutlineOpenState(apiBaseUrl),
  };

  if (typeof window === "undefined") {
    return defaultState;
  }

  const rawValue = window.localStorage.getItem(buildUiToggleStateStorageKey(apiBaseUrl));
  if (rawValue === null) {
    return defaultState;
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;
    if (!parsedValue || typeof parsedValue !== "object") {
      console.warn("Ignoring invalid saved UI toggle state from localStorage.");
      return defaultState;
    }

    const candidate = parsedValue as Record<string, unknown>;
    return {
      navigationPaneOpen:
        typeof candidate.navigationPaneOpen === "boolean"
          ? candidate.navigationPaneOpen
          : defaultState.navigationPaneOpen,
      openSidePanel: isOpenSidePanel(candidate.openSidePanel) ? candidate.openSidePanel : defaultState.openSidePanel,
      showDocuments: typeof candidate.showDocuments === "boolean" ? candidate.showDocuments : defaultState.showDocuments,
      showTags: typeof candidate.showTags === "boolean" ? candidate.showTags : defaultState.showTags,
      showHidden: typeof candidate.showHidden === "boolean" ? candidate.showHidden : defaultState.showHidden,
      outlineOpen: typeof candidate.outlineOpen === "boolean" ? candidate.outlineOpen : defaultState.outlineOpen,
    };
  } catch (error) {
    console.warn("Failed to read saved UI toggle state from localStorage.", error);
    return defaultState;
  }
}

function writePersistedUiToggleState(apiBaseUrl: string, state: PersistedUiToggleState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(buildUiToggleStateStorageKey(apiBaseUrl), JSON.stringify(state));
  } catch (error) {
    console.warn("Failed to save UI toggle state to localStorage.", error);
  }
}

function buildNavigationTreeStateStorageKey(apiBaseUrl: string): string {
  return `${navigationTreeStateStorageKeyPrefix}:${apiBaseUrl}`;
}

function readCollapsedTreePaths(apiBaseUrl: string): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }

  const rawValue = window.localStorage.getItem(buildNavigationTreeStateStorageKey(apiBaseUrl));
  if (!rawValue) {
    return new Set();
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;

    if (!Array.isArray(parsedValue) || parsedValue.some((value) => typeof value !== "string")) {
      console.warn("Ignoring invalid saved navigation tree state from localStorage.");
      return new Set();
    }

    return new Set(parsedValue);
  } catch (error) {
    console.warn("Failed to read saved navigation tree state from localStorage.", error);
    return new Set();
  }
}

function writeCollapsedTreePaths(apiBaseUrl: string, collapsedPaths: Set<string>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      buildNavigationTreeStateStorageKey(apiBaseUrl),
      JSON.stringify([...collapsedPaths].sort()),
    );
  } catch (error) {
    console.warn("Failed to save navigation tree state to localStorage.", error);
  }
}

function buildAllTreeNodePaths(topics: ContentTopicNode[]): Set<string> {
  const paths = new Set<string>();

  for (const topic of topics) {
    paths.add(topic.path);

    for (const subtopic of topic.subtopics) {
      paths.add(subtopic.path);
    }
  }

  return paths;
}

function buildSearchExpandedPaths(topics: ContentTopicNode[], matchedDocumentPaths: Set<string>): Set<string> {
  const expandedPaths = new Set<string>();

  for (const topic of topics) {
    const hasMatchingTopicDocument = topic.documents.some((document) => matchedDocumentPaths.has(document.path));
    let hasMatchingSubtopic = false;

    for (const subtopic of topic.subtopics) {
      const subtopicHasMatch = subtopic.documents.some((document) => matchedDocumentPaths.has(document.path));
      if (subtopicHasMatch) {
        expandedPaths.add(subtopic.path);
        hasMatchingSubtopic = true;
      }
    }

    if (hasMatchingTopicDocument || hasMatchingSubtopic) {
      expandedPaths.add(topic.path);
    }
  }

  return expandedPaths;
}

function findFirstDocument(tree: ContentTree | null) {
  if (!tree) {
    return null;
  }

  for (const topic of tree.topics) {
    if (topic.documents.length > 0) {
      return topic.documents[0] ?? null;
    }

    for (const subtopic of topic.subtopics) {
      if (subtopic.documents.length > 0) {
        return subtopic.documents[0] ?? null;
      }
    }
  }

  return null;
}

function buildSearchMatchPaths(searchResponse: ContentSearchResponse | null): Set<string> {
  return new Set(searchResponse?.results.map((result) => result.document.path) ?? []);
}

function formatDocumentCount(count: number): string {
  return `${count} document${count === 1 ? "" : "s"}`;
}

function buildImportSummaryMessage(result: ImportDocumentsResponse): string {
  if (result.skippedCount > 0) {
    return `Imported ${formatDocumentCount(result.importedCount)} and skipped ${formatDocumentCount(result.skippedCount)}.`;
  }

  return `Imported ${formatDocumentCount(result.importedCount)}.`;
}

function resolveBrowserImportSourcePath(file: File): string | undefined {
  const rawRelativePath = "webkitRelativePath" in file ? file.webkitRelativePath : "";
  if (!rawRelativePath) {
    return undefined;
  }

  const segments = rawRelativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.length <= 1) {
    return file.name;
  }

  return segments.slice(1).join("/");
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;

    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) {
        message = body.message;
      }
    } catch {
      // Keep the generic message when the body is not JSON.
    }

    throw new Error(message);
  }

  return (await response.json()) as T;
}

function buildApiUnavailableMessage(apiBaseUrl: string, resource: string): string {
  return `Could not complete the browser request to the API at ${apiBaseUrl} while requesting '${resource}'. Confirm 'npm run dev' started the API, that port 3000 is available, and that the API allows this cross-origin request.`;
}

async function requestApi<T>(
  apiBaseUrl: string,
  resource: string,
  init?: RequestInit,
  repoContext?: RequestRepoContext,
): Promise<T> {
  try {
    const headers = new Headers(init?.headers);
    if (repoContext?.repoSelection) {
      headers.set(repoSelectionHeaderName, encodeRepoSelectionHeaderValue(repoContext.repoSelection));
    }

    const response = await fetch(buildApiUrl(apiBaseUrl, resource), {
      ...init,
      credentials: "include",
      headers,
    });
    return await parseJsonResponse<T>(response);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(buildApiUnavailableMessage(apiBaseUrl, resource));
    }

    throw error;
  }
}

async function requestApiNoContent(
  apiBaseUrl: string,
  resource: string,
  init?: RequestInit,
  repoContext?: RequestRepoContext,
): Promise<void> {
  try {
    const headers = new Headers(init?.headers);
    if (repoContext?.repoSelection) {
      headers.set(repoSelectionHeaderName, encodeRepoSelectionHeaderValue(repoContext.repoSelection));
    }

    const response = await fetch(buildApiUrl(apiBaseUrl, resource), {
      ...init,
      credentials: "include",
      headers,
    });
    if (!response.ok) {
      await parseJsonResponse(response);
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(buildApiUnavailableMessage(apiBaseUrl, resource));
    }

    throw error;
  }
}

function buildApiUrl(apiBaseUrl: string, resource: string): string {
  if (!apiBaseUrl) {
    return resource;
  }

  if (apiBaseUrl.endsWith("/") && resource.startsWith("/")) {
    return `${apiBaseUrl.slice(0, -1)}${resource}`;
  }

  if (!apiBaseUrl.endsWith("/") && !resource.startsWith("/")) {
    return `${apiBaseUrl}/${resource}`;
  }

  return `${apiBaseUrl}${resource}`;
}

export function App(props: AppProps) {
  const apiBaseUrl = props.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? defaultApiBaseUrl;
  const persistedUiToggleState = useMemo(() => readPersistedUiToggleState(apiBaseUrl), [apiBaseUrl]);
  const persistedLibraryState = useMemo(() => readPersistedLibraryState(apiBaseUrl), [apiBaseUrl]);
  const [apiInfo, setApiInfo] = useState<ApiInfoResponse | null>(null);
  const [libraryDiscovery, setLibraryDiscovery] = useState<LibraryRepoDiscoveryResponse | null>(null);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [syncStatus, setSyncStatus] = useState<GitSyncStatus | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [tree, setTree] = useState<ContentTree | null>(null);
  const [selectedDocumentPath, setSelectedDocumentPath] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<ContentDocument | null>(null);
  const [selectedDocumentDraft, setSelectedDocumentDraft] = useState("");
  const [documentMode, setDocumentMode] = useState<DocumentMode>("view");
  const [navigationPaneOpen, setNavigationPaneOpen] = useState(persistedUiToggleState.navigationPaneOpen);
  const [openSidePanel, setOpenSidePanel] = useState<OpenSidePanel>(persistedUiToggleState.openSidePanel);
  const [activeDocumentTool, setActiveDocumentTool] = useState<ActiveDocumentTool>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [topicForm, setTopicForm] = useState<TopicFormState>({ name: "" });
  const [subtopicForm, setSubtopicForm] = useState<SubtopicFormState>({ topicName: "", name: "" });
  const [documentForm, setDocumentForm] = useState<DocumentFormState>({
    topicName: "",
    subtopicName: "",
    name: "",
    body: "",
  });
  const [renameTopicName, setRenameTopicName] = useState("");
  const [renameSubtopicState, setRenameSubtopicState] = useState<{
    topicName: string;
    currentName: string;
    nextName: string;
  }>({
    topicName: "",
    currentName: "",
    nextName: "",
  });
  const [renameDocumentState, setRenameDocumentState] = useState<RenameDocumentState>({ nextName: "" });
  const [moveDocumentState, setMoveDocumentState] = useState<MoveDocumentState>({
    topicName: "",
    subtopicName: "",
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResponse, setSearchResponse] = useState<ContentSearchResponse | null>(null);
  const [collapsedTreePaths, setCollapsedTreePaths] = useState<Set<string>>(() =>
    readCollapsedTreePaths(apiBaseUrl),
  );
  const [showDocuments, setShowDocuments] = useState(persistedUiToggleState.showDocuments);
  const [importForm, setImportForm] = useState<ImportFormState>({
    format: "documents",
    topicName: "",
    subtopicName: "",
    conflictMode: "fail",
    folderMappingMode: "folders-to-subtopic",
  });
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importBundleFile, setImportBundleFile] = useState<File | null>(null);
  const [importInputKey, setImportInputKey] = useState(0);
  const [exportForm, setExportForm] = useState<ExportFormState>({
    scope: "document",
    format: "default",
    topicName: "",
    subtopicName: "",
  });
  const [syncPushMessage, setSyncPushMessage] = useState("Sync content updates");
  const [syncScheduleForm, setSyncScheduleForm] = useState<SyncScheduleFormState>({
    enabled: false,
    intervalMinutes: "15",
  });
  const [libraryEntries, setLibraryEntries] = useState<SavedLibraryRepoDefinition[]>(persistedLibraryState.entries);
  const [selectedRepoId, setSelectedRepoId] = useState(persistedLibraryState.lastViewedRepoId);
  const [libraryRepoForm, setLibraryRepoForm] = useState<LibraryRepoFormState>(createEmptyLibraryRepoFormState);
  const [libraryTestResult, setLibraryTestResult] = useState<LibraryRepoTestResponse | null>(null);
  const [libraryImportInputKey, setLibraryImportInputKey] = useState(0);
  const [themeName, setThemeName] = useState<ThemeName>(() => readPersistedThemeName());
  const [outlineOpen, setOutlineOpen] = useState(persistedUiToggleState.outlineOpen);
  const [showTags, setShowTags] = useState(persistedUiToggleState.showTags);
  const [showHidden, setShowHidden] = useState(persistedUiToggleState.showHidden);
  const heroCardRef = useRef<HTMLElement | null>(null);
  const navigationPaneRef = useRef<HTMLElement | null>(null);
  const externalOutlineRef = useRef<HTMLElement | null>(null);
  const viewerPanelRef = useRef<HTMLElement | null>(null);
  const sidePanelShellRef = useRef<HTMLElement | null>(null);
  const libraryPaneScrollRef = useRef<HTMLDivElement | null>(null);
  const syncPaneScrollRef = useRef<HTMLDivElement | null>(null);
  const libraryEditSectionRef = useRef<HTMLElement | null>(null);
  const documentEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const previousNavigationPaneOpenRef = useRef(navigationPaneOpen);
  const previousOpenSidePanelRef = useRef<OpenSidePanel>(null);
  const previousOutlineOpenRef = useRef(outlineOpen);
  const [showScrollToTop, setShowScrollToTop] = useState(false);

  const topicOptions = tree?.topics ?? [];
  const busy = busyAction !== null;
  const hasActiveFilter = searchQuery.trim().length > 0;
  const matchedDocumentPaths = useMemo(() => buildSearchMatchPaths(searchResponse), [searchResponse]);
  const allTreeNodePaths = useMemo(() => buildAllTreeNodePaths(topicOptions), [topicOptions]);
  const searchExpandedPaths = useMemo(
    () => buildSearchExpandedPaths(topicOptions, matchedDocumentPaths),
    [matchedDocumentPaths, topicOptions],
  );
  const selectedDocumentIsDirty = selectedDocument ? selectedDocument.body !== selectedDocumentDraft : false;
  const selectedDocumentLineCount = Math.max(1, selectedDocumentDraft.split(/\r?\n/).length);
  const selectedDocumentWordCount = countWords(selectedDocumentDraft);
  const selectedDocumentFrontMatterBlock = useMemo(
    () => extractFrontMatterBlock(selectedDocumentDraft),
    [selectedDocumentDraft],
  );
  const selectedDocumentTagsInfo = useMemo(() => extractDocumentTags(selectedDocumentDraft), [selectedDocumentDraft]);
  const selectedDocumentVisibleMarkdown = useMemo(() => stripFrontMatter(selectedDocumentDraft), [selectedDocumentDraft]);
  const selectedDocumentHeadings = useMemo(
    () => extractMarkdownHeadings(selectedDocumentVisibleMarkdown),
    [selectedDocumentVisibleMarkdown],
  );
  const selectedDocumentTags = selectedDocumentTagsInfo.parseError ? (selectedDocument?.tags ?? []) : selectedDocumentTagsInfo.tags;

  const selectedDocumentHasPendingSync = useMemo(() => {
    if (!selectedDocument || !syncStatus) {
      return false;
    }

    const candidatePaths = new Set(buildSelectedDocumentRepoPaths(selectedDocument, syncStatus.contentPath));
    return syncStatus.changedFiles.some((change) => candidatePaths.has(normalizeRepoPath(change.path)));
  }, [selectedDocument, syncStatus]);
  const managementPaneOpen = openSidePanel === "manage";
  const libraryPaneOpen = openSidePanel === "library";
  const syncPaneOpen = openSidePanel === "sync";
  const hasOpenSidePanel = openSidePanel !== null;
  const contentChangeCount = syncStatus?.changedFiles.length ?? 0;
  const hasChangesToPull = (syncStatus?.behind ?? 0) > 0;
  const pullActionAvailable = Boolean(syncStatus) && !busy && (syncStatus?.pullBlockers.length ?? 0) === 0;
  const hasChangesToPush = Boolean(syncStatus) && (contentChangeCount > 0 || (syncStatus?.ahead ?? 0) > 0);
  const pushActionAvailable =
    Boolean(syncStatus) &&
    !busy &&
    syncPushMessage.trim().length > 0 &&
    (syncStatus?.pushBlockers.length ?? 0) === 0;
  const showOutlineToggle = documentMode === "view" && selectedDocumentHeadings.length > 1;
  const showTagToggle = documentMode === "view";
  const showHiddenToggle = documentMode === "view";
  const showDocumentOutline = documentMode === "view" && outlineOpen && selectedDocumentHeadings.length > 1;
  const showExternalOutline = showDocumentOutline;
  const showInlineOutline = showDocumentOutline;
  const selectedDocumentHasFrontMatter = selectedDocumentFrontMatterBlock !== null;
  const runtimeLibraryRepos = useMemo(
    () =>
      (libraryDiscovery?.repos ?? [])
        .map((summary) => createDiscoveredLibraryRepo(summary)),
    [libraryDiscovery],
  );
  const scrollPaneSectionIntoView = useCallback((container: HTMLDivElement | null, element: HTMLElement | null) => {
    if (!element) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (!container || container.scrollHeight <= container.clientHeight + 1) {
        element.scrollIntoView({
          behavior: "smooth",
          block: "start",
          inline: "nearest",
        });
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const scrollMarginTop = Number.parseFloat(window.getComputedStyle(element).scrollMarginTop || "0");
      const targetTop =
        container.scrollTop +
        (elementRect.top - containerRect.top) -
        (Number.isFinite(scrollMarginTop) ? scrollMarginTop : 0);

      container.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "smooth",
      });
    });
  }, []);
  const revealLibraryEditPane = useCallback(() => {
    setOpenSidePanel("library");
    scrollPaneSectionIntoView(libraryPaneScrollRef.current, libraryEditSectionRef.current);
  }, [scrollPaneSectionIntoView]);
  const workspaceShellClassName = [
    "workspace-shell",
    navigationPaneOpen ? "" : "without-navigation",
  ]
    .filter(Boolean)
    .join(" ");
  const activeRepoSelection = useMemo(
    () => buildRepoSelection(selectedRepoId, libraryEntries),
    [libraryEntries, selectedRepoId],
  );
  const hasActiveRepoSelection =
    activeRepoSelection.kind === "library" || Boolean(apiInfo?.configuredRepo);
  const activeRepoLabel =
    findSavedLibraryRepo(libraryEntries, selectedRepoId)?.name ??
    libraryEntries[0]?.name ??
    apiInfo?.configuredRepo?.name ??
    "Content repository";
  const selectedLibraryRepo =
    findSavedLibraryRepo(libraryEntries, selectedRepoId) ?? null;
  const updateSavedRepoFromSummary = useCallback((summary: RepoContextSummary) => {
    setLibraryEntries((current) => {
      const repo = findSavedLibraryRepo(current, summary.id);
      if (!repo) {
        return current;
      }

      const nextRepo = applyRepoSummaryToSavedRepo(repo, summary);
      return savedLibraryRepoEquals(repo, nextRepo) ? current : upsertLibraryRepo(current, nextRepo);
    });
  }, []);
  const requestSelectedRepoApi = useCallback(
    function requestSelectedRepoApi<T>(resource: string, init?: RequestInit): Promise<T> {
      return requestApi<T>(apiBaseUrl, resource, init, {
        repoSelection: activeRepoSelection,
      });
    },
    [activeRepoSelection, apiBaseUrl],
  );
  const requestSelectedRepoApiNoContent = useCallback(
    (resource: string, init?: RequestInit): Promise<void> => {
      return requestApiNoContent(apiBaseUrl, resource, init, {
        repoSelection: activeRepoSelection,
      });
    },
    [activeRepoSelection, apiBaseUrl],
  );

  const loadDocumentAtPath = useCallback(
    async (documentPath: string) => {
      const query = new URLSearchParams();
      query.set("path", documentPath);
      const body = await requestSelectedRepoApi<ContentDocument>(`/api/documents?${query.toString()}`);
      setSelectedDocument(body);
      setSelectedDocumentDraft(body.body);
      setRenameDocumentState({ nextName: body.name });
      setMoveDocumentState({
        topicName: body.topicName,
        subtopicName: body.subtopicName ?? "",
      });
      setExportForm((current) => ({
        ...current,
        topicName: body.topicName,
        subtopicName: body.subtopicName ?? "",
      }));
    },
    [requestSelectedRepoApi],
  );

  const loadSyncStatus = useCallback(
    async (refreshRemote = false) => {
      try {
        const query = new URLSearchParams();
        if (refreshRemote) {
          query.set("refresh", "true");
        }

        const queryString = query.toString();
        const body = await requestSelectedRepoApi<GitSyncStatus>(
          `/api/sync/status${queryString ? `?${queryString}` : ""}`,
        );
        setSyncStatus(body);
        if (body.repo) {
          updateSavedRepoFromSummary(body.repo);
        }
        setSyncError(null);
        return body;
      } catch (loadError) {
        console.warn("Failed to load sync status.", loadError);
        setSyncStatus(null);
        setSyncError(loadError instanceof Error ? loadError.message : "Unknown error");
        return null;
      }
    },
    [requestSelectedRepoApi, updateSavedRepoFromSummary],
  );

  const loadTree = useCallback(
    async (preferredDocumentPath?: string | null) => {
      const treeBody = await requestSelectedRepoApi<ContentTree>("/api/tree");
      setTree(treeBody);

      const nextSelectedDocumentPath =
        preferredDocumentPath ??
        (selectedDocumentPath && hasDocumentPath(treeBody, selectedDocumentPath)
          ? selectedDocumentPath
          : findFirstDocument(treeBody)?.path ?? null);
      setSelectedDocumentPath(nextSelectedDocumentPath);
      return treeBody;
    },
    [requestSelectedRepoApi, selectedDocumentPath],
  );

  const refreshTreeAndSelectedDocument = useCallback(
    async (preferredDocumentPath?: string | null) => {
      const treeBody = await loadTree(preferredDocumentPath);
      if (preferredDocumentPath && hasDocumentPath(treeBody, preferredDocumentPath)) {
        await loadDocumentAtPath(preferredDocumentPath);
      }
    },
    [loadDocumentAtPath, loadTree],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadRuntimeInfo() {
      try {
        const [apiInfoBody, healthBody, libraryDiscoveryBody] = await Promise.all([
          requestApi<ApiInfoResponse>(apiBaseUrl, "/api"),
          requestApi<HealthCheckResponse>(apiBaseUrl, "/health"),
          requestApi<LibraryRepoDiscoveryResponse>(apiBaseUrl, "/api/library/discover"),
        ]);

        if (cancelled) {
          return;
        }

        setApiInfo(apiInfoBody);
        setHealth(healthBody);
        setLibraryDiscovery(libraryDiscoveryBody);
        if (persistedLibraryState.entries.length === 0 && libraryDiscoveryBody.repos.length === 0) {
          setOpenSidePanel((current) => current ?? "library");
        }
      } catch (loadError) {
        if (!cancelled) {
          console.warn("Failed to load initial app state.", loadError);
          setError(loadError instanceof Error ? loadError.message : "Unknown error");
        }
      }
    }

    void loadRuntimeInfo();

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, persistedLibraryState.entries.length]);

  useEffect(() => {
    const scheduler = syncStatus?.scheduler;
    if (!scheduler) {
      return;
    }

    setSyncScheduleForm({
      enabled: scheduler.enabled,
      intervalMinutes: String(scheduler.intervalMinutes),
    });
  }, [syncStatus?.scheduler?.enabled, syncStatus?.scheduler?.intervalMinutes]);

  useEffect(() => {
    setNavigationPaneOpen(persistedUiToggleState.navigationPaneOpen);
    setOpenSidePanel(persistedUiToggleState.openSidePanel);
    setShowDocuments(persistedUiToggleState.showDocuments);
    setShowTags(persistedUiToggleState.showTags);
    setShowHidden(persistedUiToggleState.showHidden);
    setOutlineOpen(persistedUiToggleState.outlineOpen);
  }, [persistedUiToggleState]);

  useEffect(() => {
    setLibraryEntries(persistedLibraryState.entries);
    setSelectedRepoId(persistedLibraryState.lastViewedRepoId);
    setLibraryRepoForm(createEmptyLibraryRepoFormState());
    setLibraryTestResult(null);
    setLibraryImportInputKey(0);
  }, [persistedLibraryState]);

  useEffect(() => {
    if (!libraryDiscovery) {
      return;
    }

    const nextState = reconcileLibraryState(libraryEntries, selectedRepoId, runtimeLibraryRepos);
    if (!savedLibraryRepoListEquals(libraryEntries, nextState.entries)) {
      setLibraryEntries(nextState.entries);
    }
    if (nextState.lastViewedRepoId !== selectedRepoId) {
      setSelectedRepoId(nextState.lastViewedRepoId);
    }
  }, [libraryDiscovery, libraryEntries, runtimeLibraryRepos, selectedRepoId]);

  useEffect(() => {
    if (libraryEntries.some((entry) => entry.id === selectedRepoId)) {
      return;
    }

    setSelectedRepoId(libraryEntries[0]?.id ?? "");
  }, [libraryEntries, selectedRepoId]);

  useEffect(() => {
    if (!libraryPaneOpen || !libraryRepoForm.id) {
      return;
    }

    scrollPaneSectionIntoView(libraryPaneScrollRef.current, libraryEditSectionRef.current);
  }, [libraryPaneOpen, libraryRepoForm.id, scrollPaneSectionIntoView]);

  useEffect(() => {
    if (!apiInfo || !hasActiveRepoSelection) {
      return;
    }

    let cancelled = false;

    async function loadSelectedRepoState() {
      try {
        await loadTree();
        if (cancelled) {
          return;
        }
        await loadSyncStatus();
      } catch (loadError) {
        if (!cancelled) {
          console.warn("Failed to load selected repository state.", loadError);
          setError(loadError instanceof Error ? loadError.message : "Unknown error");
        }
      }
    }

    void loadSelectedRepoState();

    return () => {
      cancelled = true;
    };
  }, [apiInfo, hasActiveRepoSelection, loadSyncStatus, loadTree]);

  useEffect(() => {
    if (!selectedDocumentPath) {
      setSelectedDocument(null);
      setSelectedDocumentDraft("");
      return;
    }

    const documentPath = selectedDocumentPath;
    let cancelled = false;

    async function loadDocument() {
      try {
        const body = await requestSelectedRepoApi<ContentDocument>(
          `/api/documents?${new URLSearchParams({ path: documentPath }).toString()}`,
        );
        if (!cancelled) {
          setSelectedDocument(body);
          setSelectedDocumentDraft(body.body);
          setRenameDocumentState({ nextName: body.name });
          setMoveDocumentState({
            topicName: body.topicName,
            subtopicName: body.subtopicName ?? "",
          });
          setExportForm((current) => ({
            ...current,
            topicName: body.topicName,
            subtopicName: body.subtopicName ?? "",
          }));
        }
      } catch (loadError) {
        if (!cancelled) {
          console.warn(`Failed to load document '${documentPath}'.`, loadError);
          setSelectedDocument(null);
          setSelectedDocumentDraft("");
          setError(loadError instanceof Error ? loadError.message : "Unknown error");
        }
      }
    }

    void loadDocument();

    return () => {
      cancelled = true;
    };
  }, [requestSelectedRepoApi, selectedDocumentPath]);

  useEffect(() => {
    if (!hasActiveRepoSelection) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void (async () => {
        const previousLastPullAt = syncStatus?.scheduler?.lastPullAt ?? null;
        const nextStatus = await loadSyncStatus(false);
        const nextLastPullAt = nextStatus?.scheduler?.lastPullAt ?? null;

        if (nextLastPullAt && nextLastPullAt !== previousLastPullAt) {
          await refreshTreeAndSelectedDocument(selectedDocumentPath);
        }
      })();
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasActiveRepoSelection, loadSyncStatus, refreshTreeAndSelectedDocument, selectedDocumentPath, syncStatus?.scheduler?.lastPullAt]);

  useEffect(() => {
    if (!selectedDocument) {
      setDocumentMode("view");
      setActiveDocumentTool(null);
      return;
    }

    setDocumentMode("view");
    setActiveDocumentTool(null);
  }, [selectedDocument?.path]);

  useEffect(() => {
    const normalizedQuery = searchQuery.trim();
    if (!normalizedQuery) {
      setSearchResponse(null);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const query = new URLSearchParams();
          query.set("query", normalizedQuery);
          const body = await requestSelectedRepoApi<ContentSearchResponse>(`/api/search?${query.toString()}`);
          if (!cancelled) {
            setSearchResponse(body);
          }
        } catch (loadError) {
          if (!cancelled) {
            console.warn("Failed to search documents.", loadError);
            setError(loadError instanceof Error ? loadError.message : "Unknown error");
          }
        }
      })();
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [requestSelectedRepoApi, searchQuery]);

  useEffect(() => {
    if (!tree) {
      return;
    }

    setCollapsedTreePaths((current) => {
      const next = new Set([...current].filter((path) => allTreeNodePaths.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [allTreeNodePaths, tree]);

  useEffect(() => {
    writeCollapsedTreePaths(apiBaseUrl, collapsedTreePaths);
  }, [apiBaseUrl, collapsedTreePaths]);

  useEffect(() => {
    if (topicOptions.length === 0) {
      setSubtopicForm({ topicName: "", name: "" });
      setDocumentForm((current) => ({ ...current, topicName: "", subtopicName: "" }));
      setImportForm((current) => ({ ...current, topicName: "", subtopicName: "" }));
      setExportForm((current) => ({ ...current, topicName: "", subtopicName: "" }));
      return;
    }

    setSubtopicForm((current) => ({
      ...current,
      topicName:
        current.topicName && topicOptions.some((topic) => topic.name === current.topicName)
          ? current.topicName
          : topicOptions[0]?.name ?? "",
    }));

    setDocumentForm((current) => ({
      ...current,
      topicName:
        current.topicName && topicOptions.some((topic) => topic.name === current.topicName)
          ? current.topicName
          : topicOptions[0]?.name ?? "",
    }));

    setImportForm((current) => ({
      ...current,
      topicName:
        current.topicName && topicOptions.some((topic) => topic.name === current.topicName)
          ? current.topicName
          : topicOptions[0]?.name ?? "",
      subtopicName:
        current.subtopicName &&
        getSubtopicsForTopic(
          topicOptions,
          current.topicName && topicOptions.some((topic) => topic.name === current.topicName)
            ? current.topicName
            : topicOptions[0]?.name ?? "",
        ).some((subtopic) => subtopic.name === current.subtopicName)
          ? current.subtopicName
          : "",
    }));

    setExportForm((current) => {
      const topicName =
        current.topicName && topicOptions.some((topic) => topic.name === current.topicName)
          ? current.topicName
          : topicOptions[0]?.name ?? "";
      const subtopics = getSubtopicsForTopic(topicOptions, topicName);
      const subtopicName =
        current.subtopicName && subtopics.some((subtopic) => subtopic.name === current.subtopicName)
          ? current.subtopicName
          : subtopics[0]?.name ?? "";

      return {
        ...current,
        topicName,
        subtopicName,
      };
    });

    setRenameTopicName((current) =>
      current && topicOptions.some((topic) => topic.name === current) ? current : topicOptions[0]?.name ?? "",
    );

    setRenameSubtopicState((current) => {
      const validTopic =
        current.topicName && topicOptions.some((topic) => topic.name === current.topicName)
          ? current.topicName
          : topicOptions[0]?.name ?? "";
      const validSubtopic =
        validTopic && getSubtopicsForTopic(topicOptions, validTopic).some((subtopic) => subtopic.name === current.currentName)
          ? current.currentName
          : getSubtopicsForTopic(topicOptions, validTopic)[0]?.name ?? "";

      return {
        topicName: validTopic,
        currentName: validSubtopic,
        nextName: validSubtopic,
      };
    });
  }, [topicOptions]);

  useEffect(() => {
    if (!message) {
      return;
    }

    const timeoutId = window.setTimeout(() => setMessage(null), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [message]);

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusyAction(label);
      setError(null);
      try {
        await action();
        if (label !== "refresh-sync") {
          await loadSyncStatus(false);
        }
      } catch (actionError) {
        console.warn(`Action failed: ${label}.`, actionError);
        setError(actionError instanceof Error ? actionError.message : "Unknown error");
      } finally {
        setBusyAction(null);
      }
    },
    [loadSyncStatus],
  );

  const handleCreateTopic = useCallback(() => {
    void runAction("create-topic", async () => {
      const payload: CreateTopicRequest = { name: topicForm.name };
      await requestSelectedRepoApi("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setTopicForm({ name: "" });
      const refreshedTree = await loadTree();
      const createdTopic = refreshedTree.topics.find((topic) => topic.name === payload.name.trim());
      if (createdTopic) {
        setRenameTopicName(createdTopic.name);
      }
      setMessage(`Created topic '${payload.name}'.`);
    });
  }, [loadTree, requestSelectedRepoApi, runAction, topicForm.name]);

  const handleRenameTopic = useCallback(() => {
    void runAction("rename-topic", async () => {
      if (!renameTopicName) {
        throw new Error("Choose a topic to rename.");
      }

      const nextName = window.prompt(`Rename topic '${renameTopicName}' to:`, renameTopicName);
      if (!nextName || nextName.trim() === renameTopicName) {
        return;
      }

      const payload: RenameTopicRequest = { nextName };
      const renamedTopic = await requestSelectedRepoApi<ContentTopicNode>(`/api/topics/${encodeURIComponent(renameTopicName)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setRenameTopicName(renamedTopic.name);
      await loadTree();
      setMessage(`Renamed topic to '${renamedTopic.name}'.`);
    });
  }, [loadTree, renameTopicName, requestSelectedRepoApi, runAction]);

  const handleDeleteTopic = useCallback(
    (topicName: string) => {
      void runAction("delete-topic", async () => {
        if (!window.confirm(`Delete topic '${topicName}' and all of its content?`)) {
          return;
        }

        const payload: DeleteTopicRequest = { name: topicName };
        await requestSelectedRepoApiNoContent("/api/topics", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        await loadTree();
        setMessage(`Deleted topic '${topicName}'.`);
      });
    },
    [loadTree, requestSelectedRepoApiNoContent, runAction],
  );

  const handleDeleteSelectedTopic = useCallback(() => {
    if (!renameTopicName) {
      setError("Choose a topic before deleting it.");
      return;
    }

    handleDeleteTopic(renameTopicName);
  }, [handleDeleteTopic, renameTopicName]);

  const handleCreateSubtopic = useCallback(() => {
    void runAction("create-subtopic", async () => {
      const payload: CreateSubtopicRequest = {
        topicName: subtopicForm.topicName,
        name: subtopicForm.name,
      };
      const createdSubtopic = await requestSelectedRepoApi<ContentSubtopicNode>("/api/subtopics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSubtopicForm((current) => ({ ...current, name: "" }));
      setRenameSubtopicState({
        topicName: payload.topicName,
        currentName: createdSubtopic.name,
        nextName: createdSubtopic.name,
      });
      await loadTree();
      setMessage(`Created subtopic '${createdSubtopic.name}'.`);
    });
  }, [loadTree, requestSelectedRepoApi, runAction, subtopicForm]);

  const handleRenameSubtopic = useCallback(() => {
    void runAction("rename-subtopic", async () => {
      if (!renameSubtopicState.topicName || !renameSubtopicState.currentName) {
        throw new Error("Choose a topic and subtopic to rename.");
      }

      const nextName = window.prompt(
        `Rename subtopic '${renameSubtopicState.currentName}' to:`,
        renameSubtopicState.currentName,
      );
      if (!nextName || nextName.trim() === renameSubtopicState.currentName) {
        return;
      }

      const payload: RenameSubtopicRequest = {
        topicName: renameSubtopicState.topicName,
        currentName: renameSubtopicState.currentName,
        nextName,
      };
      const renamedSubtopic = await requestSelectedRepoApi<ContentSubtopicNode>("/api/subtopics", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setRenameSubtopicState({
        topicName: payload.topicName,
        currentName: renamedSubtopic.name,
        nextName: renamedSubtopic.name,
      });
      await loadTree();
      setMessage(`Renamed subtopic to '${renamedSubtopic.name}'.`);
    });
  }, [loadTree, renameSubtopicState, requestSelectedRepoApi, runAction]);

  const handleDeleteSubtopic = useCallback(
    (topicName: string, subtopicName: string) => {
      void runAction("delete-subtopic", async () => {
        if (!window.confirm(`Delete subtopic '${subtopicName}' and all of its documents?`)) {
          return;
        }

        const payload: DeleteSubtopicRequest = {
          topicName,
          name: subtopicName,
        };
        await requestSelectedRepoApiNoContent("/api/subtopics", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        await loadTree();
        setMessage(`Deleted subtopic '${subtopicName}'.`);
      });
    },
    [loadTree, requestSelectedRepoApiNoContent, runAction],
  );

  const handleDeleteSelectedSubtopic = useCallback(() => {
    if (!renameSubtopicState.topicName || !renameSubtopicState.currentName) {
      setError("Choose a topic and subtopic before deleting it.");
      return;
    }

    handleDeleteSubtopic(renameSubtopicState.topicName, renameSubtopicState.currentName);
  }, [handleDeleteSubtopic, renameSubtopicState.currentName, renameSubtopicState.topicName]);

  const handleCreateDocument = useCallback(() => {
    void runAction("create-document", async () => {
      const payload: CreateDocumentRequest = documentForm.subtopicName
        ? {
            topicName: documentForm.topicName,
            subtopicName: documentForm.subtopicName,
            name: documentForm.name,
            body: documentForm.body,
          }
        : {
            topicName: documentForm.topicName,
            name: documentForm.name,
            body: documentForm.body,
          };
      const createdDocument = await requestSelectedRepoApi<ContentDocument>("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setDocumentForm((current) => ({ ...current, name: "", body: "" }));
      await loadTree(createdDocument.path);
      setMessage(`Created document '${createdDocument.name}'.`);
    });
  }, [documentForm, loadTree, requestSelectedRepoApi, runAction]);

  const handleSaveDocument = useCallback(() => {
    void runAction("save-document", async () => {
      if (!selectedDocument) {
        throw new Error("Select a document before saving.");
      }

      const payload: UpdateDocumentRequest = {
        path: selectedDocument.path,
        body: selectedDocumentDraft,
      };
      const updatedDocument = await requestSelectedRepoApi<ContentDocument>("/api/documents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSelectedDocument(updatedDocument);
      setSelectedDocumentDraft(updatedDocument.body);
      setDocumentMode("view");
      await loadTree(updatedDocument.path);
      setMessage(`Saved '${updatedDocument.name}'.`);
    });
  }, [loadTree, requestSelectedRepoApi, runAction, selectedDocument, selectedDocumentDraft]);

  const handleRenameDocument = useCallback(() => {
    void runAction("rename-document", async () => {
      if (!selectedDocument) {
        throw new Error("Select a document before renaming.");
      }

      const payload: RenameDocumentRequest = {
        path: selectedDocument.path,
        nextName: renameDocumentState.nextName,
      };
      const renamedDocument = await requestSelectedRepoApi<ContentDocument>("/api/documents/rename", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSelectedDocument(renamedDocument);
      setSelectedDocumentPath(renamedDocument.path);
      setRenameDocumentState({ nextName: renamedDocument.name });
      setActiveDocumentTool(null);
      await loadTree(renamedDocument.path);
      setMessage(`Renamed document to '${renamedDocument.name}'.`);
    });
  }, [loadTree, renameDocumentState.nextName, requestSelectedRepoApi, runAction, selectedDocument]);

  const handleMoveDocument = useCallback(() => {
    void runAction("move-document", async () => {
      if (!selectedDocument) {
        throw new Error("Select a document before moving.");
      }

      const payload: MoveDocumentRequest = moveDocumentState.subtopicName
        ? {
            path: selectedDocument.path,
            topicName: moveDocumentState.topicName,
            subtopicName: moveDocumentState.subtopicName,
          }
        : {
            path: selectedDocument.path,
            topicName: moveDocumentState.topicName,
          };
      const movedDocument = await requestSelectedRepoApi<ContentDocument>("/api/documents/move", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSelectedDocument(movedDocument);
      setSelectedDocumentPath(movedDocument.path);
      setActiveDocumentTool(null);
      await loadTree(movedDocument.path);
      setMessage(`Moved document to '${movedDocument.path}'.`);
    });
  }, [loadTree, moveDocumentState, requestSelectedRepoApi, runAction, selectedDocument]);

  const handleDeleteDocument = useCallback(() => {
    void runAction("delete-document", async () => {
      if (!selectedDocument) {
        throw new Error("Select a document before deleting.");
      }

      if (!window.confirm(`Delete document '${selectedDocument.name}'?`)) {
        return;
      }

      const payload: DeleteDocumentRequest = { path: selectedDocument.path };
      await requestSelectedRepoApiNoContent("/api/documents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSelectedDocument(null);
      setSelectedDocumentDraft("");
      await loadTree();
      setMessage(`Deleted '${selectedDocument.name}'.`);
    });
  }, [loadTree, requestSelectedRepoApiNoContent, runAction, selectedDocument]);

  const handleImportFiles = useCallback(() => {
    void runAction("import-files", async () => {
      let payload: ImportDocumentsRequest;

      if (importForm.format === "documents") {
        if (!importForm.topicName) {
          throw new Error("Choose a topic before importing files.");
        }

        if (importFiles.length === 0) {
          throw new Error("Choose at least one Markdown file to import.");
        }

        const markdownFiles = importFiles.filter((file) => file.name.toLowerCase().endsWith(".md"));
        if (markdownFiles.length === 0) {
          throw new Error("Choose at least one Markdown file to import.");
        }

        const documents = await Promise.all(
          markdownFiles.map(async (file) => {
            const sourcePath = resolveBrowserImportSourcePath(file);
            return {
              name: file.name,
              body: await file.text(),
              ...(sourcePath ? { sourcePath } : {}),
            };
          }),
        );

        payload = importForm.subtopicName
          ? {
              topicName: importForm.topicName,
              subtopicName: importForm.subtopicName,
              documents,
              conflictMode: importForm.conflictMode,
              folderMappingMode: importForm.folderMappingMode,
            }
          : {
              topicName: importForm.topicName,
              documents,
              conflictMode: importForm.conflictMode,
              folderMappingMode: importForm.folderMappingMode,
            };
      } else {
        if (!importBundleFile) {
          throw new Error("Choose a JSON bundle or zip archive before importing.");
        }

        payload =
          importForm.format === "bundle-json"
            ? {
                format: "bundle-json",
                bundle: JSON.parse(await importBundleFile.text()) as ContentExportBundle,
                conflictMode: importForm.conflictMode,
              }
            : {
                format: "bundle-zip",
                archiveBase64: await readFileAsBase64(importBundleFile),
                fileName: importBundleFile.name,
                conflictMode: importForm.conflictMode,
              };
      }

      const result = await requestSelectedRepoApi<ImportDocumentsResponse>("/api/import/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setImportFiles([]);
      setImportBundleFile(null);
      setImportInputKey((current) => current + 1);
      await loadTree(result.imported[0]?.path ?? selectedDocumentPath);
      setMessage(buildImportSummaryMessage(result));
    });
  }, [importBundleFile, importFiles, importForm, loadTree, requestSelectedRepoApi, runAction, selectedDocumentPath]);

  const handleExportBundle = useCallback(() => {
    void runAction("export-bundle", async () => {
      let payload: ExportScope;

      if (exportForm.scope === "document") {
        if (!selectedDocument) {
          throw new Error("Select a document before exporting it.");
        }

        payload = {
          scope: "document",
          path: selectedDocument.path,
        };
      } else if (exportForm.scope === "topic") {
        if (!exportForm.topicName) {
          throw new Error("Choose a topic before exporting.");
        }

        payload = {
          scope: "topic",
          topicName: exportForm.topicName,
        };
      } else {
        if (!exportForm.topicName || !exportForm.subtopicName) {
          throw new Error("Choose a topic and subtopic before exporting.");
        }

        payload = {
          scope: "subtopic",
          topicName: exportForm.topicName,
          subtopicName: exportForm.subtopicName,
        };
      }

      if (exportForm.scope === "document" && exportForm.format === "default") {
        if (!selectedDocument) {
          throw new Error("Select a document before exporting it.");
        }

        downloadFile(selectedDocument.body, selectedDocument.name, "text/markdown");
        setMessage("Exported 1 document.");
        return;
      }

      const requestBody: ExportDocumentsRequest =
        exportForm.format === "default"
          ? {
              ...payload,
              format: "bundle-json",
            }
          : {
              ...payload,
              format: exportForm.format,
            };

      const exported = await requestSelectedRepoApi<ExportDocumentsResponse>("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (exported.format === "bundle-json") {
        downloadFile(JSON.stringify(exported, null, 2), exported.fileName, "application/json");
      } else {
        downloadBinaryFile(decodeBase64(exported.contentBase64), exported.fileName, exported.mediaType);
      }

      const documentCount = exported.format === "bundle-json" ? exported.documents.length : exported.documentCount;
      setMessage(`Exported ${documentCount} document${documentCount === 1 ? "" : "s"} as ${exported.format}.`);
    });
  }, [exportForm, requestSelectedRepoApi, runAction, selectedDocument]);

  const handleRevealTopNotices = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.requestAnimationFrame(() => {
      if (heroCardRef.current) {
        heroCardRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }, []);

  const resetRepoBoundState = useCallback(() => {
    setTree(null);
    setSelectedDocumentPath(null);
    setSelectedDocument(null);
    setSelectedDocumentDraft("");
    setSearchResponse(null);
    setSyncStatus(null);
    setSyncError(null);
  }, []);

  const handleRefreshSync = useCallback(() => {
    void runAction("refresh-sync", async () => {
      await loadSyncStatus(true);
      setMessage("Refreshed git sync status.");
    });
  }, [loadSyncStatus, runAction]);

  const handleSyncPull = useCallback(() => {
    void runAction("sync-pull", async () => {
      if (!syncStatus) {
        throw new Error("Sync status is not available.");
      }

      if (syncStatus.pullBlockers.length > 0) {
        throw new Error(syncStatus.pullBlockers[0] ?? "Sync pull is currently blocked.");
      }

      const remoteTargetLabel = syncStatus.remoteUrl
        ? `${syncStatus.remoteName} (${syncStatus.remoteUrl})`
        : syncStatus.remoteName;
      if (!window.confirm(`Pull remote content into '${syncStatus.currentBranch}' from ${remoteTargetLabel}?`)) {
        return;
      }

      const result = await requestSelectedRepoApi<GitSyncOperationResponse>("/api/sync/pull", {
        method: "POST",
      });
      setSyncStatus(result.status);
      await refreshTreeAndSelectedDocument(selectedDocumentPath);
      setMessage(result.summary);
    });
  }, [refreshTreeAndSelectedDocument, requestSelectedRepoApi, runAction, selectedDocumentPath, syncStatus]);

  const handleSyncPush = useCallback(() => {
    void runAction("sync-push", async () => {
      if (!syncStatus) {
        throw new Error("Sync status is not available.");
      }

      if (syncStatus.pushBlockers.length > 0) {
        throw new Error(syncStatus.pushBlockers[0] ?? "Sync push is currently blocked.");
      }

      const commitMessage = syncPushMessage.trim();
      if (!commitMessage) {
        throw new Error("Enter a sync commit message before pushing.");
      }

      const remoteTargetLabel = syncStatus.remoteUrl
        ? `${syncStatus.remoteName} (${syncStatus.remoteUrl})`
        : syncStatus.remoteName;
      if (!window.confirm(`Commit content changes and push '${syncStatus.currentBranch}' to ${remoteTargetLabel}?`)) {
        return;
      }

      try {
        const result = await requestSelectedRepoApi<GitSyncOperationResponse>("/api/sync/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: commitMessage }),
        });
        setSyncStatus(result.status);
        setMessage(result.summary);
      } finally {
        setOpenSidePanel((current) => (current === "sync" ? null : current));
        handleRevealTopNotices();
      }
    });
  }, [handleRevealTopNotices, requestSelectedRepoApi, runAction, syncPushMessage, syncStatus]);

  const handleConfigureSyncSchedule = useCallback(() => {
    void runAction("sync-schedule-configure", async () => {
      const intervalMinutes = Number.parseInt(syncScheduleForm.intervalMinutes, 10);
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
        throw new Error("Background pull interval must be a whole number of minutes between 1 and 1440.");
      }

      const result = await requestSelectedRepoApi<GitSyncScheduleResponse>("/api/sync/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: syncScheduleForm.enabled,
          intervalMinutes,
        }),
      });
      setSyncStatus(result.status);
      setMessage(result.summary);
    });
  }, [requestSelectedRepoApi, runAction, syncScheduleForm.enabled, syncScheduleForm.intervalMinutes]);

  const handlePauseSyncSchedule = useCallback(() => {
    void runAction("sync-schedule-pause", async () => {
      const result = await requestSelectedRepoApi<GitSyncScheduleResponse>("/api/sync/schedule/pause", {
        method: "POST",
      });
      setSyncStatus(result.status);
      setMessage(result.summary);
    });
  }, [requestSelectedRepoApi, runAction]);

  const handleResumeSyncSchedule = useCallback(() => {
    void runAction("sync-schedule-resume", async () => {
      const result = await requestSelectedRepoApi<GitSyncScheduleResponse>("/api/sync/schedule/resume", {
        method: "POST",
      });
      setSyncStatus(result.status);
      setMessage(result.summary);
    });
  }, [requestSelectedRepoApi, runAction]);

  const validateLibraryRepo = useCallback(
    async (repo: SavedLibraryRepoDefinition) =>
      requestApi<LibraryRepoTestResponse>(
        apiBaseUrl,
        "/api/library/test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: toLibraryRepoDefinition(repo) }),
        },
      ),
    [apiBaseUrl],
  );

  const handleRefreshLibraryRepositories = useCallback(() => {
    void runAction("refresh-library", async () => {
      const discovery = await requestApi<LibraryRepoDiscoveryResponse>(
        apiBaseUrl,
        "/api/library/discover",
      );
      setLibraryDiscovery(discovery);
      setMessage(
        `Refreshed ${discovery.repos.length} available repositor${discovery.repos.length === 1 ? "y" : "ies"}.`,
      );
    });
  }, [apiBaseUrl, runAction]);

  const handleSelectRepo = useCallback(
    (nextRepoId: string) => {
      void runAction("select-library-repo", async () => {
        if (nextRepoId === selectedRepoId) {
          return;
        }

        const nextRepo = libraryEntries.find((entry) => entry.id === nextRepoId);
        if (!nextRepo) {
          setError("Choose an available repository before switching to it.");
          return;
        }

        setError(null);
        resetRepoBoundState();
        setSelectedRepoId(nextRepo.id);
        setLibraryTestResult(null);
        setMessage(`Switched to '${nextRepo.name}'.`);
      });
    },
    [libraryEntries, resetRepoBoundState, runAction, selectedRepoId],
  );

  const handleSaveLibraryRepo = useCallback(() => {
    void runAction("save-library-repo", async () => {
      const repo = buildLibraryRepoDefinitionFromForm(libraryRepoForm);
      const result = await validateLibraryRepo(repo);
      const validatedRepo = applyRepoSummaryToSavedRepo(repo, result.repo);
      if (validatedRepo.id === selectedRepoId) {
        resetRepoBoundState();
      }
      setLibraryEntries((current) => upsertLibraryRepo(current, validatedRepo));
      setLibraryRepoForm(createEmptyLibraryRepoFormState());
      setLibraryTestResult(result);
      setMessage(`${libraryRepoForm.id ? "Updated" : "Saved"} repository '${validatedRepo.name}'.`);
    });
  }, [libraryRepoForm, resetRepoBoundState, runAction, selectedRepoId, validateLibraryRepo]);

  const handleTestLibraryRepo = useCallback(() => {
    void runAction("test-library-repo", async () => {
      const repo = buildLibraryRepoDefinitionFromForm(libraryRepoForm);
      const result = await validateLibraryRepo(repo);
      const validatedRepo = applyRepoSummaryToSavedRepo(repo, result.repo);
      setLibraryRepoForm({
        id: validatedRepo.id,
        source: validatedRepo.source ?? "saved",
        name: validatedRepo.name,
        repoRoot: validatedRepo.repoRoot,
        dataRoot: validatedRepo.dataRoot ?? "",
        releaseBranch: validatedRepo.releaseBranch ?? "",
      });
      setLibraryTestResult(result);
      setMessage(`Validated repository '${validatedRepo.name}'.`);
    });
  }, [libraryRepoForm, runAction, validateLibraryRepo]);

  const handleEditLibraryRepo = useCallback((repo: SavedLibraryRepoDefinition) => {
    setLibraryRepoForm({
      id: repo.id,
      source: isConfiguredLibraryRepo(repo) ? "configured" : (repo.source ?? "saved"),
      name: repo.name,
      repoRoot: repo.repoRoot,
      dataRoot: repo.dataRoot ?? "",
      releaseBranch: repo.releaseBranch ?? "",
    });
    setLibraryTestResult(null);
    revealLibraryEditPane();
  }, [revealLibraryEditPane]);

  const handleCancelLibraryEdit = useCallback(() => {
    setLibraryRepoForm(createEmptyLibraryRepoFormState());
    setLibraryTestResult(null);
  }, []);

  const handleRemoveLibraryRepo = useCallback(
    (repoId: string) => {
      const repo = libraryEntries.find((entry) => entry.id === repoId);
      if (!repo) {
        setError("Choose a saved repository before removing it.");
        return;
      }

      if (isConfiguredLibraryRepo(repo)) {
        setError("This runtime-provided repository cannot be removed.");
        return;
      }

      if (repo.source === "discovered") {
        setError("Discovered repositories come from the current workspace. Remove the checkout or save your own override instead.");
        return;
      }

      if (!window.confirm(`Remove saved repository '${repo.name}' from this browser?`)) {
        return;
      }

      setLibraryEntries((current) => current.filter((entry) => entry.id !== repoId));
      setLibraryTestResult((current) => (current?.repo.id === repoId ? null : current));
      setLibraryRepoForm((current) => (current.id === repoId ? createEmptyLibraryRepoFormState() : current));
      if (selectedRepoId === repoId) {
        const remainingEntries = libraryEntries.filter((entry) => entry.id !== repoId);
        const nextRepo = remainingEntries[0] ?? null;
        resetRepoBoundState();
        setSelectedRepoId(nextRepo?.id ?? "");
        setMessage(
          nextRepo
            ? `Removed '${repo.name}' and switched to '${nextRepo.name}'.`
            : `Removed saved repository '${repo.name}'.`,
        );
        return;
      }

      setMessage(`Removed saved repository '${repo.name}'.`);
    },
    [libraryEntries, resetRepoBoundState, selectedRepoId],
  );

  const handleExportLibrary = useCallback(() => {
    if (libraryEntries.length === 0) {
      setError("There are no saved repositories to export.");
      return;
    }

    downloadFile(JSON.stringify(libraryEntries, null, 2), "dacci-library-repos.json", "application/json");
    setError(null);
    setMessage(`Exported ${libraryEntries.length} saved repositor${libraryEntries.length === 1 ? "y" : "ies"}.`);
  }, [libraryEntries]);

  const handleImportLibrary = useCallback(
    (file: File | null) => {
      if (!file) {
        return;
      }

      void runAction("import-library", async () => {
        const importedEntries = parseImportedLibraryEntries(await file.text());
        if (
          libraryEntries.length > 0 &&
          !window.confirm("Replace the current saved repository list with the imported one?")
        ) {
          return;
        }

        const nextState = reconcileLibraryState(importedEntries, selectedRepoId, runtimeLibraryRepos);
        setLibraryEntries(nextState.entries);
        setSelectedRepoId(nextState.lastViewedRepoId);
        if (
          !importedEntries.some((entry) => entry.id === selectedRepoId)
        ) {
          resetRepoBoundState();
        }
        setLibraryRepoForm(createEmptyLibraryRepoFormState());
        setLibraryTestResult(null);
        setLibraryImportInputKey((current) => current + 1);
        setMessage(`Imported ${importedEntries.length} saved repositor${importedEntries.length === 1 ? "y" : "ies"}.`);
      });
    },
    [libraryEntries, resetRepoBoundState, runAction, runtimeLibraryRepos, selectedRepoId],
  );

  const handleToggleMode = useCallback(() => {
    setDocumentMode((current) => (current === "view" ? "edit" : "view"));
  }, []);

  const handleAddTag = useCallback(() => {
    if (!selectedDocument) {
      return;
    }

    const rawTag = window.prompt("Add a tag to the document front matter:", "");
    if (rawTag === null) {
      return;
    }

    const normalizedTag = normalizeDocumentTag(rawTag);
    if (!normalizedTag) {
      setMessage(null);
      setError("Tags must contain at least one letter or number.");
      return;
    }

    if (selectedDocumentTags.includes(normalizedTag)) {
      setError(null);
      setMessage(`Tag '${normalizedTag}' is already present.`);
      setShowTags(true);
      return;
    }

    try {
      setSelectedDocumentDraft(updateDocumentTags(selectedDocumentDraft, [...selectedDocumentTags, normalizedTag]));
      setError(null);
      setMessage(`Added tag '${normalizedTag}'. Save the document to persist it.`);
      setShowTags(true);
    } catch (error) {
      setMessage(null);
      setError(error instanceof Error ? error.message : "Could not add the requested tag.");
    }
  }, [selectedDocument, selectedDocumentDraft, selectedDocumentTags]);

  const handleRemoveTag = useCallback(
    (tag: string) => {
      if (!selectedDocument) {
        return;
      }

      if (!window.confirm(`Remove tag '${tag}' from the document front matter?`)) {
        return;
      }

      try {
        setSelectedDocumentDraft(updateDocumentTags(selectedDocumentDraft, selectedDocumentTags.filter((entry) => entry !== tag)));
        setError(null);
        setMessage(`Removed tag '${tag}'. Save the document to persist it.`);
      } catch (error) {
        setMessage(null);
        setError(error instanceof Error ? error.message : "Could not remove the requested tag.");
      }
    },
    [selectedDocument, selectedDocumentDraft, selectedDocumentTags],
  );

  const handleToggleManagementPane = useCallback(() => {
    setOpenSidePanel((current) => (current === "manage" ? null : "manage"));
  }, []);

  const handleToggleLibraryPane = useCallback(() => {
    setOpenSidePanel((current) => (current === "library" ? null : "library"));
  }, []);

  const handleToggleSyncPane = useCallback(() => {
    setOpenSidePanel((current) => (current === "sync" ? null : "sync"));
  }, []);

  const handleExpandAllTreeNodes = useCallback(() => {
    setCollapsedTreePaths(new Set());
  }, []);

  const handleCollapseAllTreeNodes = useCallback(() => {
    setCollapsedTreePaths(new Set(allTreeNodePaths));
  }, [allTreeNodePaths]);

  const handleToggleTreeNode = useCallback((nodePath: string) => {
    setCollapsedTreePaths((current) => {
      const next = new Set(current);
      if (next.has(nodePath)) {
        next.delete(nodePath);
      } else {
        next.add(nodePath);
      }
      return next;
    });
  }, []);

  const handleToggleDocumentTool = useCallback((tool: Exclude<ActiveDocumentTool, null>) => {
    setActiveDocumentTool((current) => (current === tool ? null : tool));
  }, []);

  const handleScrollWorkspaceToTop = useCallback(() => {
    documentEditorRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    viewerPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    const updateScrollToTopVisibility = () => {
      const workspaceScrolled =
        viewerPanelRef.current !== null && viewerPanelRef.current.getBoundingClientRect().top < -120;
      const editorScrolled = (documentEditorRef.current?.scrollTop ?? 0) > 120;
      setShowScrollToTop(workspaceScrolled || editorScrolled);
    };

    updateScrollToTopVisibility();

    window.addEventListener("scroll", updateScrollToTopVisibility, { passive: true });
    const activeEditor = documentEditorRef.current;
    activeEditor?.addEventListener("scroll", updateScrollToTopVisibility, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateScrollToTopVisibility);
      activeEditor?.removeEventListener("scroll", updateScrollToTopVisibility);
    };
  }, [documentMode, selectedDocumentPath]);

  useEffect(() => {
    writeOutlineOpenState(apiBaseUrl, outlineOpen);
  }, [apiBaseUrl, outlineOpen]);

  useEffect(() => {
    applyThemeName(themeName);
    writePersistedThemeName(themeName);
  }, [themeName]);

  useEffect(() => {
    writePersistedUiToggleState(apiBaseUrl, {
      navigationPaneOpen,
      openSidePanel,
      showDocuments,
      showTags,
      showHidden,
      outlineOpen,
    });
  }, [apiBaseUrl, navigationPaneOpen, openSidePanel, showDocuments, showTags, showHidden, outlineOpen]);

  useEffect(() => {
    writePersistedLibraryState(apiBaseUrl, {
      entries: libraryEntries,
      lastViewedRepoId: selectedRepoId,
    });
  }, [apiBaseUrl, libraryEntries, selectedRepoId]);

  useEffect(() => {
    if (!selectedDocumentHasFrontMatter && showHidden) {
      setShowHidden(false);
    }
  }, [selectedDocumentHasFrontMatter, showHidden]);

  useEffect(() => {
    const previousPanel = previousOpenSidePanelRef.current;
    if (previousPanel === openSidePanel) {
      return;
    }

    previousOpenSidePanelRef.current = openSidePanel;

    if (typeof window === "undefined" || !window.matchMedia("(max-width: 1380px)").matches) {
      return;
    }

    const targetElement = openSidePanel ? sidePanelShellRef.current : previousPanel ? heroCardRef.current : null;
    if (!targetElement) {
      return;
    }

    window.requestAnimationFrame(() => {
      targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [openSidePanel]);

  useEffect(() => {
    const previousNavigationPaneOpen = previousNavigationPaneOpenRef.current;
    if (previousNavigationPaneOpen === navigationPaneOpen) {
      return;
    }

    previousNavigationPaneOpenRef.current = navigationPaneOpen;

    if (typeof window === "undefined" || !window.matchMedia("(max-width: 1380px)").matches) {
      return;
    }

    const targetElement = navigationPaneOpen ? navigationPaneRef.current : viewerPanelRef.current;
    if (!targetElement) {
      return;
    }

    window.requestAnimationFrame(() => {
      targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [navigationPaneOpen]);

  useEffect(() => {
    const previousOutlineOpen = previousOutlineOpenRef.current;
    if (previousOutlineOpen === outlineOpen) {
      return;
    }

    previousOutlineOpenRef.current = outlineOpen;

    if (!outlineOpen || !showDocumentOutline || typeof window === "undefined") {
      return;
    }

    const targetElement = window.matchMedia("(max-width: 1100px)").matches
      ? externalOutlineRef.current ?? viewerPanelRef.current
      : viewerPanelRef.current;
    if (!targetElement) {
      return;
    }

    scrollPaneSectionIntoView(null, targetElement);
  }, [outlineOpen, scrollPaneSectionIntoView, showDocumentOutline]);

  return (
    <main className="app-shell" data-theme={themeName}>
      <section className="hero-card" ref={heroCardRef}>
        <div className="hero-card-header">
          <div className="hero-copy">
            <div className="hero-title-row">
              <h1 className="hero-title">Dacci</h1>
              <p className="tagline">Docs as Code. Context Included.</p>
            </div>
          </div>
          <div className="hero-header-actions">
            <label className="hero-repo-selector">
              <span>Repository</span>
              <select disabled={busy} onChange={(event) => handleSelectRepo(event.target.value)} value={selectedRepoId}>
                {libraryEntries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="hero-toggle-group">
              <button
                aria-pressed={navigationPaneOpen}
                className={navigationPaneOpen ? "toggle-button tone-bright" : "toggle-button tone-neutral"}
                onClick={() => setNavigationPaneOpen((current) => !current)}
                type="button"
              >
                Navigation
              </button>
              <button
                aria-pressed={managementPaneOpen}
                className={managementPaneOpen ? "toggle-button tone-bright" : "toggle-button tone-neutral"}
                onClick={handleToggleManagementPane}
                type="button"
              >
                Manage
              </button>
              <button
                aria-pressed={libraryPaneOpen}
                className={libraryPaneOpen ? "toggle-button tone-bright" : "toggle-button tone-neutral"}
                onClick={handleToggleLibraryPane}
                type="button"
              >
                Library
              </button>
              <button
                aria-pressed={syncPaneOpen}
                className={syncPaneOpen ? "toggle-button tone-bright" : "toggle-button tone-neutral"}
                onClick={handleToggleSyncPane}
                type="button"
              >
                Sync
              </button>
              {hasChangesToPull ? (
                <button
                  className={pullActionAvailable ? "toggle-button tone-bright" : "toggle-button tone-dim"}
                  disabled={!pullActionAvailable}
                  onClick={handleSyncPull}
                  type="button"
                >
                  Pull
                </button>
              ) : null}
              {hasChangesToPush ? (
                <button
                  className={pushActionAvailable ? "toggle-button tone-bright" : "toggle-button tone-dim"}
                  disabled={!pushActionAvailable}
                  onClick={handleSyncPush}
                  type="button"
                >
                  Push
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {error ? <p className="notice error">{error}</p> : null}
      {message ? <p className="notice success">{message}</p> : null}

      <section className={workspaceShellClassName}>
        {navigationPaneOpen ? (
          <NavigationPane
            hasActiveFilter={hasActiveFilter}
            collapsedTreePaths={collapsedTreePaths}
            matchedDocumentPaths={matchedDocumentPaths}
            panelRef={navigationPaneRef}
            searchQuery={searchQuery}
            searchExpandedPaths={searchExpandedPaths}
            searchResponse={searchResponse}
            selectedDocumentPath={selectedDocumentPath}
            showDocuments={showDocuments}
            topics={topicOptions}
            onClose={() => setNavigationPaneOpen(false)}
            onCollapseAll={handleCollapseAllTreeNodes}
            onSearchQueryChange={setSearchQuery}
            onSelectDocument={setSelectedDocumentPath}
            onExpandAll={handleExpandAllTreeNodes}
            onToggleTreeNode={handleToggleTreeNode}
            onToggleDocuments={() => setShowDocuments((current) => !current)}
          />
        ) : null}

        {showExternalOutline ? (
          <DocumentOutlinePane
            className="document-outline-panel"
            closeLabel="Close outline panel"
            headings={selectedDocumentHeadings}
            onClose={() => setOutlineOpen(false)}
            panelRef={externalOutlineRef}
          />
        ) : null}

        <section className="panel viewer-panel" ref={viewerPanelRef}>
          {selectedDocument ? (
            <div className="viewer-surface">
              <ViewerHeader
                activeTool={activeDocumentTool}
                busy={busy}
                changeCount={contentChangeCount}
                documentName={selectedDocument.name}
                documentPath={selectedDocument.path}
                hasFrontMatter={selectedDocumentHasFrontMatter}
                hasTags={selectedDocumentTags.length > 0}
                isDirty={selectedDocumentIsDirty}
                lineCount={selectedDocumentLineCount}
                mode={documentMode}
                outlineOpen={outlineOpen}
                showHidden={showHidden}
                showHiddenToggle={showHiddenToggle}
                showOutlineToggle={showOutlineToggle}
                showTags={showTags}
                showTagToggle={showTagToggle}
                wordCount={selectedDocumentWordCount}
                onDelete={handleDeleteDocument}
                onSave={handleSaveDocument}
                onToggleHidden={() => setShowHidden((current) => !current)}
                onToggleMode={handleToggleMode}
                onToggleMove={() => handleToggleDocumentTool("move")}
                onToggleOutline={() => setOutlineOpen((current) => !current)}
                onToggleRename={() => handleToggleDocumentTool("rename")}
                onToggleTags={() => setShowTags((current) => !current)}
              />

              {activeDocumentTool === "rename" ? (
                <section className="inline-tool-panel">
                  <h3>Rename document</h3>
                  <div className="form-grid">
                    <label>
                      <span>Next name</span>
                      <input
                        onChange={(event) => setRenameDocumentState({ nextName: event.target.value })}
                        value={renameDocumentState.nextName}
                      />
                    </label>
                    <div className="inline-actions">
                      <button
                        className="ghost-button"
                        disabled={busy || !renameDocumentState.nextName.trim()}
                        onClick={handleRenameDocument}
                        type="button"
                      >
                        Rename document
                      </button>
                      <button className="ghost-button" disabled={busy} onClick={() => setActiveDocumentTool(null)} type="button">
                        Cancel
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}

              {activeDocumentTool === "move" ? (
                <section className="inline-tool-panel">
                  <h3>Move document</h3>
                  <div className="form-grid two-column-grid">
                    <label>
                      <span>Move to topic</span>
                      <select
                        onChange={(event) =>
                          setMoveDocumentState((current) => ({
                            ...current,
                            topicName: event.target.value,
                            subtopicName: "",
                          }))
                        }
                        value={moveDocumentState.topicName}
                      >
                        <option value="">Select a topic</option>
                        {topicOptions.map((topic) => (
                          <option key={topic.path} value={topic.name}>
                            {topic.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>Move to subtopic</span>
                      <select
                        onChange={(event) =>
                          setMoveDocumentState((current) => ({ ...current, subtopicName: event.target.value }))
                        }
                        value={moveDocumentState.subtopicName}
                      >
                        <option value="">CatchAll (topic-level)</option>
                        {getSubtopicsForTopic(topicOptions, moveDocumentState.topicName).map((subtopic) => (
                          <option key={subtopic.path} value={subtopic.name}>
                            {subtopic.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="inline-actions">
                    <button className="ghost-button" disabled={busy || !moveDocumentState.topicName} onClick={handleMoveDocument} type="button">
                      Move document
                    </button>
                    <button className="ghost-button" disabled={busy} onClick={() => setActiveDocumentTool(null)} type="button">
                      Cancel
                    </button>
                  </div>
                </section>
              ) : null}

              <div
                className={
                  documentMode === "view"
                    ? "document-surface-card document-surface-view"
                    : "document-surface-card document-surface-edit"
                }
              >
                {documentMode === "view" && showTags ? (
                  <div className="document-tag-row editable" aria-label="Document tags">
                    {selectedDocumentTags.map((tag) => (
                      <span className="document-tag-pill editable" key={tag}>
                        <span>{tag}</span>
                        <button
                          aria-label={`Remove tag ${tag}`}
                          className="document-tag-pill-remove"
                          onClick={() => handleRemoveTag(tag)}
                          type="button"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <button className="document-tag-pill document-tag-pill-action" onClick={handleAddTag} type="button">
                      Add tag
                    </button>
                  </div>
                ) : null}
                {documentMode === "view" ? (
                  <div className={showInlineOutline ? "document-reader-layout with-outline" : "document-reader-layout"}>
                    <MarkdownViewer markdown={selectedDocumentDraft} showFrontMatter={showHidden} />
                    {showInlineOutline ? (
                      <DocumentOutlinePane className="inline-outline-panel" headings={selectedDocumentHeadings} />
                    ) : null}
                  </div>
                ) : (
                  <DocumentEditor
                    disabled={busy}
                    onChange={setSelectedDocumentDraft}
                    textareaRef={documentEditorRef}
                    value={selectedDocumentDraft}
                  />
                )}
                {showScrollToTop ? (
                  <button className="ghost-button scroll-top-button" onClick={handleScrollWorkspaceToTop} type="button">
                    Back to top
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="empty-viewer-state">
              <p className="eyebrow viewer-eyebrow">Workspace</p>
              <h2>Select a document</h2>
              <p className="muted">
                {tree && tree.topics.length > 0
                  ? "Choose a document from the navigation tree to read or edit it. Structural actions stay in the Manage panel."
                  : "Add topic folders and Markdown files under data/ to start populating the tree."}
              </p>
            </div>
          )}
        </section>

        {hasOpenSidePanel ? (
          <section className="side-panel-shell" ref={sidePanelShellRef}>
            {managementPaneOpen ? (
              <ManagementPane
                busy={busy}
                currentTheme={themeName}
                documentForm={documentForm}
                exportForm={exportForm}
                health={health}
                importBundleFile={importBundleFile}
                importFiles={importFiles}
                importForm={importForm}
                importInputKey={importInputKey}
                open={managementPaneOpen}
                renameSubtopicState={{
                  topicName: renameSubtopicState.topicName,
                  currentName: renameSubtopicState.currentName,
                }}
                renameTopicName={renameTopicName}
                selectedDocument={selectedDocument}
                selectedDocumentChanged={selectedDocumentHasPendingSync}
                subtopicForm={subtopicForm}
                syncError={syncError}
                syncScheduleForm={syncScheduleForm}
                syncPushMessage={syncPushMessage}
                syncStatus={syncStatus}
                topicFormName={topicForm.name}
                topicOptions={topicOptions}
                onCreateDocument={handleCreateDocument}
                onCreateSubtopic={handleCreateSubtopic}
                onCreateTopic={handleCreateTopic}
                onDeleteSubtopic={handleDeleteSelectedSubtopic}
                onDeleteTopic={handleDeleteSelectedTopic}
                onDocumentBodyChange={(value) => setDocumentForm((current) => ({ ...current, body: value }))}
                onDocumentNameChange={(value) => setDocumentForm((current) => ({ ...current, name: value }))}
                onDocumentSubtopicChange={(value) => setDocumentForm((current) => ({ ...current, subtopicName: value }))}
                onDocumentTopicChange={(value) =>
                  setDocumentForm((current) => ({
                    ...current,
                    topicName: value,
                    subtopicName: "",
                  }))
                }
                onExport={handleExportBundle}
                onExportFormatChange={(value) => setExportForm((current) => ({ ...current, format: value }))}
                onExportScopeChange={(value) => setExportForm((current) => ({ ...current, scope: value }))}
                onExportSubtopicChange={(value) => setExportForm((current) => ({ ...current, subtopicName: value }))}
                onExportTopicChange={(value) =>
                  setExportForm((current) => ({
                    ...current,
                    topicName: value,
                    subtopicName: "",
                  }))
                }
                onImportBundleFileChange={setImportBundleFile}
                onImportFiles={handleImportFiles}
                onImportFilesChange={setImportFiles}
                onImportConflictModeChange={(value) =>
                  setImportForm((current) => ({
                    ...current,
                    conflictMode: value,
                  }))
                }
                onImportFormatChange={(value) =>
                  setImportForm((current) => ({
                    ...current,
                    format: value,
                  }))
                }
                onImportFolderMappingModeChange={(value) =>
                  setImportForm((current) => ({
                    ...current,
                    folderMappingMode: value,
                  }))
                }
                onImportSubtopicChange={(value) => setImportForm((current) => ({ ...current, subtopicName: value }))}
                onImportTopicChange={(value) =>
                  setImportForm((current) => ({
                    ...current,
                    topicName: value,
                    subtopicName: "",
                  }))
                }
                onRefreshSync={handleRefreshSync}
                onRenameSubtopic={handleRenameSubtopic}
                onRenameSubtopicNameChange={(value) =>
                  setRenameSubtopicState((current) => ({
                    ...current,
                    currentName: value,
                    nextName: value,
                  }))
                }
                onRenameSubtopicTopicChange={(value) => {
                  const firstSubtopic = getSubtopicsForTopic(topicOptions, value)[0];
                  setRenameSubtopicState({
                    topicName: value,
                    currentName: firstSubtopic?.name ?? "",
                    nextName: firstSubtopic?.name ?? "",
                  });
                }}
                onRenameTopic={handleRenameTopic}
                onRenameTopicNameChange={setRenameTopicName}
                onSubtopicNameChange={(value) => setSubtopicForm((current) => ({ ...current, name: value }))}
                onSubtopicTopicChange={(value) => setSubtopicForm((current) => ({ ...current, topicName: value }))}
                onSyncScheduleEnabledChange={(value) =>
                  setSyncScheduleForm((current) => ({
                    ...current,
                    enabled: value,
                  }))
                }
                onSyncScheduleIntervalChange={(value) =>
                  setSyncScheduleForm((current) => ({
                    ...current,
                    intervalMinutes: value,
                  }))
                }
                onConfigureSyncSchedule={handleConfigureSyncSchedule}
                onPauseSyncSchedule={handlePauseSyncSchedule}
                onResumeSyncSchedule={handleResumeSyncSchedule}
                onSyncPull={handleSyncPull}
                onSyncPush={handleSyncPush}
                onSyncPushMessageChange={setSyncPushMessage}
                onThemeChange={setThemeName}
                onToggleOpen={handleToggleManagementPane}
                onTopicFormNameChange={(value) => setTopicForm({ name: value })}
              />
            ) : null}

            {libraryPaneOpen ? (
              <LibraryPane
                activeRepoLabel={activeRepoLabel}
                busy={busy}
                createContentRepoGuideUrl={createContentRepoGuideUrl}
                editSectionRef={libraryEditSectionRef}
                scrollContainerRef={libraryPaneScrollRef}
                form={libraryRepoForm}
                importInputKey={libraryImportInputKey}
                savedRepos={libraryEntries}
                selectedRepoId={selectedRepoId}
                testResult={libraryTestResult}
                onCancelEdit={handleCancelLibraryEdit}
                onEditRepo={handleEditLibraryRepo}
                onExportLibrary={handleExportLibrary}
                onRefreshRepositories={handleRefreshLibraryRepositories}
                onFormDataRootChange={(value) =>
                  setLibraryRepoForm((current) => ({
                    ...current,
                    dataRoot: value,
                  }))
                }
                onFormNameChange={(value) =>
                  setLibraryRepoForm((current) => ({
                    ...current,
                    name: value,
                  }))
                }
                onFormReleaseBranchChange={(value) =>
                  setLibraryRepoForm((current) => ({
                    ...current,
                    releaseBranch: value,
                  }))
                }
                onFormRepoRootChange={(value) =>
                  setLibraryRepoForm((current) => ({
                    ...current,
                    repoRoot: value,
                  }))
                }
                onImportLibrary={handleImportLibrary}
                onRemoveRepo={handleRemoveLibraryRepo}
                onSaveRepo={handleSaveLibraryRepo}
                onSelectRepo={handleSelectRepo}
                onTestRepo={handleTestLibraryRepo}
                onToggleOpen={handleToggleLibraryPane}
              />
            ) : null}

            {syncPaneOpen ? (
              <SyncPane
                busy={busy}
                scrollContainerRef={syncPaneScrollRef}
                selectedDocumentChanged={selectedDocumentHasPendingSync}
                syncError={syncError}
                syncPushMessage={syncPushMessage}
                syncScheduleForm={syncScheduleForm}
                syncStatus={syncStatus}
                onConfigureSyncSchedule={handleConfigureSyncSchedule}
                onPauseSyncSchedule={handlePauseSyncSchedule}
                onRefreshSync={handleRefreshSync}
                onResumeSyncSchedule={handleResumeSyncSchedule}
                onSyncPull={handleSyncPull}
                onSyncPush={handleSyncPush}
                onSyncPushMessageChange={setSyncPushMessage}
                onSyncScheduleEnabledChange={(value) =>
                  setSyncScheduleForm((current) => ({
                    ...current,
                    enabled: value,
                  }))
                }
                onSyncScheduleIntervalChange={(value) =>
                  setSyncScheduleForm((current) => ({
                    ...current,
                    intervalMinutes: value,
                  }))
                }
                onToggleOpen={handleToggleSyncPane}
              />
            ) : null}
          </section>
        ) : null}
      </section>
    </main>
  );
}

function hasDocumentPath(tree: ContentTree, documentPath: string): boolean {
  return tree.topics.some((topic) => {
    if (topic.documents.some((document) => document.path === documentPath)) {
      return true;
    }

    return topic.subtopics.some((subtopic) => subtopic.documents.some((document) => document.path === documentPath));
  });
}

function getSubtopicsForTopic(topics: ContentTopicNode[], topicName: string): ContentSubtopicNode[] {
  return topics.find((topic) => topic.name === topicName)?.subtopics ?? [];
}

function downloadFile(contents: string, fileName: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  downloadBlob(blob, fileName);
}

function downloadBinaryFile(contents: Uint8Array, fileName: string, mimeType: string): void {
  const buffer = new ArrayBuffer(contents.byteLength);
  new Uint8Array(buffer).set(contents);
  const blob = new Blob([buffer], { type: mimeType });
  downloadBlob(blob, fileName);
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function readFileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return window.btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function countWords(value: string): number {
  const words = value.trim().match(/\S+/g);
  return words?.length ?? 0;
}

function buildSelectedDocumentRepoPaths(document: ContentDocument, contentPath: string): string[] {
  const normalizedContentPath = normalizeRepoPath(contentPath || "data");
  const physicalPath = normalizeRepoPath(
    `${normalizedContentPath}/${document.topicName}/${document.subtopicName ?? "CatchAll"}/${document.name}`,
  );

  return [physicalPath, normalizeRepoPath(document.path)];
}

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function buildLibraryRepoDefinitionFromForm(form: LibraryRepoFormState): SavedLibraryRepoDefinition {
  const name = form.name.trim();
  if (!name) {
    throw new Error("Repository name is required.");
  }

  const repoRoot = form.repoRoot.trim();
  if (!repoRoot) {
    throw new Error("Repository root is required.");
  }

  if (!looksLikeAbsolutePath(repoRoot)) {
    throw new Error("Repository root must be an absolute path.");
  }

  const dataRoot = form.dataRoot.trim();
  if (dataRoot && !looksLikeAbsolutePath(dataRoot)) {
    throw new Error("Content root override must be an absolute path.");
  }
  const releaseBranch = form.releaseBranch.trim();

  const source = form.source === "configured" ? "configured" : "saved";
  const baseRepo: SavedLibraryRepoDefinition = {
    id: form.id ?? createLibraryRepoId(),
    source,
    name,
    repoRoot,
  };

  if (dataRoot) {
    baseRepo.dataRoot = dataRoot;
  }
  if (releaseBranch) {
    baseRepo.releaseBranch = releaseBranch;
  }

  return baseRepo;
}

function upsertLibraryRepo(
  entries: SavedLibraryRepoDefinition[],
  repo: SavedLibraryRepoDefinition,
): SavedLibraryRepoDefinition[] {
  const remainingEntries = entries.filter(
    (entry) =>
      entry.id !== repo.id &&
      !(isConfiguredLibraryRepo(entry) && isConfiguredLibraryRepo(repo)) &&
      (isConfiguredLibraryRepo(entry) || isConfiguredLibraryRepo(repo) || entry.repoRoot !== repo.repoRoot),
  );
  return [...remainingEntries, repo].sort((left, right) => left.name.localeCompare(right.name));
}

function parseImportedLibraryEntries(rawValue: string): SavedLibraryRepoDefinition[] {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rawValue);
  } catch {
    throw new Error("Library import file is not valid JSON.");
  }

  const sourceEntries =
    Array.isArray(parsedValue)
      ? parsedValue
      : parsedValue && typeof parsedValue === "object" && Array.isArray((parsedValue as { entries?: unknown }).entries)
        ? (parsedValue as { entries: unknown[] }).entries
        : null;
  if (!sourceEntries) {
    throw new Error("Library import must be a JSON array of repository definitions.");
  }

  const importedEntries = sourceEntries.map((entry) => parseImportedLibraryRepo(entry));
  const seenIds = new Set<string>();
  for (const entry of importedEntries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Library import contains a duplicate repository id: ${entry.id}`);
    }
    seenIds.add(entry.id);
  }

  return importedEntries.sort((left, right) => left.name.localeCompare(right.name));
}

function parseImportedLibraryRepo(value: unknown): SavedLibraryRepoDefinition {
  if (!value || typeof value !== "object") {
    throw new Error("Each imported repository must be an object.");
  }

  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const repoRoot = typeof candidate.repoRoot === "string" ? candidate.repoRoot.trim() : "";
  if (!name) {
    throw new Error("Each imported repository requires a name.");
  }
  if (!repoRoot) {
    throw new Error(`Imported repository '${name}' is missing its repository root.`);
  }

  const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : createLibraryRepoId();
  const dataRoot = typeof candidate.dataRoot === "string" ? candidate.dataRoot.trim() : "";
  const source =
    candidate.source === "configured" || candidate.source === "discovered" || candidate.source === "saved"
      ? candidate.source
      : "saved";
  const releaseBranch = typeof candidate.releaseBranch === "string" ? candidate.releaseBranch.trim() : "";

  const repo: SavedLibraryRepoDefinition = {
    id,
    source,
    name,
    repoRoot,
  };
  if (dataRoot) {
    repo.dataRoot = dataRoot;
  }
  if (releaseBranch) {
    repo.releaseBranch = releaseBranch;
  }

  return repo;
}

function applyRepoSummaryToSavedRepo(
  repo: SavedLibraryRepoDefinition,
  summary: RepoContextSummary,
): SavedLibraryRepoDefinition {
  const runtimeSource = summary.isDefault ? "configured" : "discovered";
  const preserveSavedOverrides = repo.source === "saved";
  const nextRepo: SavedLibraryRepoDefinition = {
    id: repo.id,
    source: preserveSavedOverrides ? "saved" : runtimeSource,
    name: preserveSavedOverrides ? (repo.name.trim() || summary.name) : summary.name,
    repoRoot: summary.repoRoot,
  };

  if (summary.dataRoot) {
    nextRepo.dataRoot = summary.dataRoot;
  }
  if (!preserveSavedOverrides && summary.releaseBranch) {
    nextRepo.releaseBranch = summary.releaseBranch;
  } else if (repo.releaseBranch) {
    nextRepo.releaseBranch = repo.releaseBranch;
  }

  return nextRepo;
}

function savedLibraryRepoEquals(left: SavedLibraryRepoDefinition, right: SavedLibraryRepoDefinition): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.repoRoot === right.repoRoot &&
    (left.dataRoot ?? "") === (right.dataRoot ?? "") &&
    (left.releaseBranch ?? "") === (right.releaseBranch ?? "") &&
    (left.source ?? "") === (right.source ?? "")
  );
}

function savedLibraryRepoListEquals(
  left: SavedLibraryRepoDefinition[],
  right: SavedLibraryRepoDefinition[],
): boolean {
  return left.length === right.length && left.every((entry, index) => savedLibraryRepoEquals(entry, right[index]!));
}

function createLibraryRepoId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `repo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
