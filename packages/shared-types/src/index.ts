export type ContentTag = string;

export interface ContentDocumentSummary {
  kind: "document";
  id: string;
  name: string;
  path: string;
  topicName: string;
  subtopicName?: string;
  tags: ContentTag[];
  parseError?: string | null;
  modifiedAt: string;
  size: number;
}

export interface ContentDocument extends ContentDocumentSummary {
  body: string;
}

export const docsStatuses = ["draft", "published", "archive"] as const;

export type DocsStatus = (typeof docsStatuses)[number];

export interface DocsDocumentVariantSummary {
  status: DocsStatus;
  repoPath: string;
  modifiedAt: string;
  size: number;
}

export interface DocsLogicalDocumentSummary {
  kind: "logical-document";
  id: string;
  name: string;
  slug: string;
  logicalPath: string;
  layer: string;
  domainPath: string;
  title?: string;
  tags: ContentTag[];
  parseError?: string | null;
  availableStatuses: DocsStatus[];
  variants: DocsDocumentVariantSummary[];
}

export interface DocsDocumentVariant extends DocsDocumentVariantSummary {
  logicalPath: string;
  name: string;
  slug: string;
  layer: string;
  domainPath: string;
  title?: string;
  tags: ContentTag[];
  parseError?: string | null;
  body: string;
}

export interface DocsDomainNode {
  kind: "domain";
  name: string;
  path: string;
  documents: DocsLogicalDocumentSummary[];
}

export interface DocsLayerNode {
  kind: "layer";
  name: string;
  path: string;
  domains: DocsDomainNode[];
}

export interface DocsStatusNode {
  kind: "status";
  status: DocsStatus;
  path: string;
  layers: DocsLayerNode[];
}

export interface DocsTree {
  generatedAt: string;
  documents: DocsLogicalDocumentSummary[];
  statuses: DocsStatusNode[];
}

export interface CreateDocsDraftInput {
  layer: string;
  domainPath: string;
  name: string;
  body: string;
}

export interface UpdateDocsDraftRequest {
  logicalPath: string;
  body: string;
  expectedModifiedAt?: string;
}

export interface SavePublishedEditRequest {
  logicalPath: string;
  body: string;
  expectedModifiedAt?: string;
}

export interface PublishDocsDraftRequest {
  logicalPath: string;
  expectedModifiedAt?: string;
}

export interface ArchiveDocsDocumentRequest {
  logicalPath: string;
  sourceStatus?: Exclude<DocsStatus, "archive">;
  expectedModifiedAt?: string;
}

export interface DeleteArchivedDocsDocumentRequest {
  logicalPath: string;
  expectedModifiedAt?: string;
}

export interface CreateTopicRequest {
  name: string;
}

export interface RenameTopicRequest {
  nextName: string;
}

export interface CreateSubtopicRequest {
  topicName: string;
  name: string;
}

export interface RenameSubtopicRequest {
  topicName: string;
  currentName: string;
  nextName: string;
}

export interface CreateDocumentRequest {
  topicName: string;
  subtopicName?: string;
  name: string;
  body: string;
}

export interface UpdateDocumentRequest {
  path: string;
  body: string;
}

export interface RenameDocumentRequest {
  path: string;
  nextName: string;
}

export interface MoveDocumentRequest {
  path: string;
  topicName: string;
  subtopicName?: string;
}

export interface DeleteDocumentRequest {
  path: string;
}

export interface DeleteSubtopicRequest {
  topicName: string;
  name: string;
}

export interface DeleteTopicRequest {
  name: string;
}

export type ContentSearchMatchField = "path" | "name" | "body" | "tag";

export interface ContentSearchResult {
  kind: "document";
  document: ContentDocumentSummary;
  matchedField: ContentSearchMatchField;
  excerpt: string;
}

export interface ContentSearchResponse {
  query: string;
  generatedAt: string;
  results: ContentSearchResult[];
}

export interface ImportDocumentInput {
  name: string;
  body: string;
  sourcePath?: string;
}

export const importConflictModes = ["fail", "skip", "overwrite"] as const;

export type ImportConflictMode = (typeof importConflictModes)[number];

export const importFolderMappingModes = ["flat", "folders-to-subtopic"] as const;

export type ImportFolderMappingMode = (typeof importFolderMappingModes)[number];

export const exportFormats = ["bundle-json", "bundle-zip"] as const;

export type ExportFormat = (typeof exportFormats)[number];

export const importFormats = ["documents", ...exportFormats] as const;

export type ImportFormat = (typeof importFormats)[number];

export interface DirectImportDocumentsRequest {
  format?: "documents";
  topicName: string;
  subtopicName?: string;
  documents: ImportDocumentInput[];
  conflictMode?: ImportConflictMode;
  folderMappingMode?: ImportFolderMappingMode;
}

export interface JsonBundleImportRequest {
  format: "bundle-json";
  bundle: ContentExportBundle;
  conflictMode?: ImportConflictMode;
}

export interface ZipArchiveImportRequest {
  format: "bundle-zip";
  archiveBase64: string;
  fileName?: string;
  conflictMode?: ImportConflictMode;
}

export type ImportDocumentsRequest =
  | DirectImportDocumentsRequest
  | JsonBundleImportRequest
  | ZipArchiveImportRequest;

export interface ImportDocumentsResponse {
  format: ImportFormat;
  conflictMode: ImportConflictMode;
  folderMappingMode?: ImportFolderMappingMode;
  imported: ContentDocument[];
  importedCount: number;
  skipped: ContentDocumentSummary[];
  skippedCount: number;
}

export interface ExportDocumentScope {
  scope: "document";
  path: string;
}

export interface ExportTopicScope {
  scope: "topic";
  topicName: string;
}

export interface ExportSubtopicScope {
  scope: "subtopic";
  topicName: string;
  subtopicName: string;
}

export type ExportScope = ExportDocumentScope | ExportTopicScope | ExportSubtopicScope;

export type ExportDocumentsRequest = ExportScope & {
  format?: ExportFormat;
};

export interface ContentExportBundle {
  generatedAt: string;
  exportName: string;
  scope: ExportScope;
  documents: ContentDocument[];
}

export interface JsonBundleExportResponse extends ContentExportBundle {
  format: "bundle-json";
  fileName: string;
}

export interface ZipArchiveExportResponse {
  format: "bundle-zip";
  exportName: string;
  fileName: string;
  mediaType: "application/zip";
  contentBase64: string;
  documentCount: number;
  scope: ExportScope;
}

export type ExportDocumentsResponse = JsonBundleExportResponse | ZipArchiveExportResponse;

export interface GitSyncChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitSyncCommitSummary {
  sha: string;
  message: string;
  committedAt: string;
}

export interface GitSyncScheduleState {
  enabled: boolean;
  paused: boolean;
  intervalMinutes: number;
  consecutiveFailures: number;
  releaseBranch?: string;
  lastRunAt?: string;
  lastStatusCheckAt?: string;
  lastPullAt?: string;
  nextRunAt?: string;
  pauseReason?: string;
  lastError?: string;
}

export interface GitSyncStatus {
  repo?: RepoContextSummary;
  repoRoot: string;
  contentRoot: string;
  contentPath: string;
  currentBranch: string;
  releaseBranch: string;
  isReleaseBranch: boolean;
  remoteName: string;
  remoteUrl?: string;
  upstreamBranch?: string;
  ahead: number;
  behind: number;
  hasContentChanges: boolean;
  hasRepoChanges: boolean;
  changedFiles: GitSyncChange[];
  nonContentChangedFiles: GitSyncChange[];
  nonContentCommittedFiles: string[];
  pullBlockers: string[];
  pushBlockers: string[];
  recommendedActions: string[];
  lastContentCommit?: GitSyncCommitSummary;
  scheduler?: GitSyncScheduleState;
  schedulerSupported?: boolean;
  schedulerUnsupportedReason?: string;
}

export interface GitSyncPushRequest {
  message: string;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
}

export interface GitSyncScheduleConfigureRequest {
  enabled?: boolean;
  intervalMinutes?: number;
}

export interface GitSyncOperationResponse {
  action: "pull" | "push";
  summary: string;
  commitSha?: string;
  status: GitSyncStatus;
}

export interface GitSyncScheduleResponse {
  action: "configure" | "pause" | "resume";
  summary: string;
  status: GitSyncStatus;
}

export interface ContentSubtopicNode {
  kind: "subtopic";
  name: string;
  path: string;
  documents: ContentDocumentSummary[];
}

export interface ContentTopicNode {
  kind: "topic";
  name: string;
  path: string;
  documents: ContentDocumentSummary[];
  subtopics: ContentSubtopicNode[];
}

export interface ContentTree {
  generatedAt: string;
  topics: ContentTopicNode[];
}

export interface ContentEngineSummary {
  dataRoot: string;
  topicCount: number;
  documentCount: number;
}

export const configuredRepoId = "configured-repo";
export const repoSelectionHeaderName = "x-dacci-repo-selection";
export const authSessionHeaderName = "x-dacci-auth-session";

export interface LibraryRepoDefinition {
  id: string;
  name: string;
  repoRoot: string;
  dataRoot?: string;
  releaseBranch?: string;
}

export const libraryRepoSources = ["configured", "registered", "discovered", "saved"] as const;

export type LibraryRepoSource = (typeof libraryRepoSources)[number];

export interface SavedLibraryRepoDefinition extends LibraryRepoDefinition {
  source?: LibraryRepoSource;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
}

export interface DefaultRepoSelection {
  kind: "default";
}

export interface LibraryRepoSelection {
  kind: "library";
  repo: LibraryRepoDefinition;
}

export type RepoSelection = DefaultRepoSelection | LibraryRepoSelection;

export interface RepoContextSummary {
  id: string;
  kind: "default" | "library";
  name: string;
  repoRoot: string;
  dataRoot: string;
  isDefault: boolean;
  source?: Extract<LibraryRepoSource, "configured" | "registered" | "discovered">;
  releaseBranch?: string;
}

export interface HealthCheckResponse {
  status: "ok";
  service: string;
  dataRoot: string;
}

export interface ApiInfoResponse {
  phase: string;
  service: string;
  endpoints: string[];
  configuredRepo: RepoContextSummary | null;
  capabilities: ApiCapabilities;
}

export interface ApiErrorResponse {
  error: string;
  message: string;
}

export interface ApiCapabilities {
  ghCliAvailable: boolean;
  ghCliVersion?: string;
}

export interface LibraryRepoTestRequest {
  repo: LibraryRepoDefinition;
}

export interface LibraryRepoOnboardingDefinition {
  id: string;
  name: string;
  releaseBranch: string;
}

export const libraryRepoCreateVisibilities = ["private", "public", "internal"] as const;

export type LibraryRepoCreateVisibility = (typeof libraryRepoCreateVisibilities)[number];

export interface LibraryRepoCreateRequest {
  repo: LibraryRepoOnboardingDefinition;
  githubOwner: string;
  githubRepo: string;
  githubUsername: string;
  visibility: LibraryRepoCreateVisibility;
  sshHostAlias?: string;
  commitAuthorName: string;
  commitAuthorEmail: string;
}

export interface LibraryRepoRemoteAdoptRequest {
  repo: LibraryRepoOnboardingDefinition;
  githubOwner: string;
  githubRepo: string;
  githubUsername: string;
  sshHostAlias?: string;
}

export interface LibraryRepoTestResponse {
  repo: RepoContextSummary;
  content: ContentEngineSummary;
  git: {
    repoRoot: string;
    contentRoot: string;
    contentPath: string;
    currentBranch: string;
  };
}

export interface LibraryRepoDiscoveryResponse {
  libraryRoots: string[];
  repos: RepoContextSummary[];
}

export const repoPermissionRoles = ["viewer", "editor", "manage", "direct-publish"] as const;

export type RepoPermissionRole = (typeof repoPermissionRoles)[number];

export interface AuthenticatedGitHubUser {
  id: number;
  login: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface RepoPermissionSummary {
  repoId: string;
  repoName: string;
  roles: RepoPermissionRole[];
  canEditDrafts: boolean;
  canManage: boolean;
  canDirectPublish: boolean;
  sourceTeams: string[];
  sourceOverride?: string;
}

export interface AuthSessionSummary {
  sessionId: string;
  user: AuthenticatedGitHubUser;
  permissions: RepoPermissionSummary[];
}

export interface GitHubDeviceAuthorizationStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface GitHubDeviceAuthorizationPollRequest {
  deviceCode: string;
}

export interface GitHubDeviceAuthorizationPendingResponse {
  status: "pending";
  intervalSeconds: number;
}

export interface GitHubDeviceAuthorizationAuthorizedResponse {
  status: "authorized";
  session: AuthSessionSummary;
}

export type GitHubDeviceAuthorizationPollResponse =
  | GitHubDeviceAuthorizationPendingResponse
  | GitHubDeviceAuthorizationAuthorizedResponse;

export interface AuthSessionResponse {
  authenticated: boolean;
  session?: AuthSessionSummary;
}
