import type {
  ContentDocument,
  ContentSubtopicNode,
  ContentTopicNode,
  ExportFormat,
  GitSyncStatus,
  HealthCheckResponse,
  ImportConflictMode,
  ImportFormat,
  ImportFolderMappingMode,
} from "@dacci/shared-types";
import { isThemeName, themeOptions, type ThemeName } from "../utils/theme";

interface ManagementPaneProps {
  open: boolean;
  busy: boolean;
  health: HealthCheckResponse | null;
  syncStatus: GitSyncStatus | null;
  syncError: string | null;
  selectedDocumentChanged: boolean;
  currentTheme: ThemeName;
  syncPushMessage: string;
  syncScheduleForm: {
    enabled: boolean;
    intervalMinutes: string;
  };
  topicOptions: ContentTopicNode[];
  renameTopicName: string;
  renameSubtopicState: {
    topicName: string;
    currentName: string;
  };
  topicFormName: string;
  subtopicForm: {
    topicName: string;
    name: string;
  };
  documentForm: {
    topicName: string;
    subtopicName: string;
    name: string;
    body: string;
  };
  importForm: {
    format: ImportFormat;
    topicName: string;
    subtopicName: string;
    conflictMode: ImportConflictMode;
    folderMappingMode: ImportFolderMappingMode;
  };
  importBundleFile: File | null;
  importFiles: File[];
  importInputKey: number;
  exportForm: {
    scope: "document" | "topic" | "subtopic";
    format: "default" | ExportFormat;
    topicName: string;
    subtopicName: string;
  };
  selectedDocument: ContentDocument | null;
  onToggleOpen: () => void;
  onSyncPushMessageChange: (value: string) => void;
  onThemeChange: (value: ThemeName) => void;
  onRefreshSync: () => void;
  onSyncPull: () => void;
  onSyncPush: () => void;
  onSyncScheduleEnabledChange: (value: boolean) => void;
  onSyncScheduleIntervalChange: (value: string) => void;
  onConfigureSyncSchedule: () => void;
  onPauseSyncSchedule: () => void;
  onResumeSyncSchedule: () => void;
  onTopicFormNameChange: (value: string) => void;
  onCreateTopic: () => void;
  onRenameTopicNameChange: (value: string) => void;
  onRenameTopic: () => void;
  onDeleteTopic: () => void;
  onSubtopicTopicChange: (value: string) => void;
  onSubtopicNameChange: (value: string) => void;
  onCreateSubtopic: () => void;
  onRenameSubtopicTopicChange: (value: string) => void;
  onRenameSubtopicNameChange: (value: string) => void;
  onRenameSubtopic: () => void;
  onDeleteSubtopic: () => void;
  onDocumentTopicChange: (value: string) => void;
  onDocumentSubtopicChange: (value: string) => void;
  onDocumentNameChange: (value: string) => void;
  onDocumentBodyChange: (value: string) => void;
  onCreateDocument: () => void;
  onImportFormatChange: (value: ImportFormat) => void;
  onImportTopicChange: (value: string) => void;
  onImportSubtopicChange: (value: string) => void;
  onImportConflictModeChange: (value: ImportConflictMode) => void;
  onImportFolderMappingModeChange: (value: ImportFolderMappingMode) => void;
  onImportBundleFileChange: (file: File | null) => void;
  onImportFilesChange: (files: File[]) => void;
  onImportFiles: () => void;
  onExportFormatChange: (value: "default" | ExportFormat) => void;
  onExportScopeChange: (value: "document" | "topic" | "subtopic") => void;
  onExportTopicChange: (value: string) => void;
  onExportSubtopicChange: (value: string) => void;
  onExport: () => void;
}

export function ManagementPane(props: ManagementPaneProps) {
  const directoryPickerAttributes: Record<string, string> = {
    webkitdirectory: "",
    directory: "",
  };
  const topicCountLabel = `${props.topicOptions.length} topic${props.topicOptions.length === 1 ? "" : "s"}`;
  const selectedImportPaths = props.importFiles.map((file) => {
    const rawRelativePath = "webkitRelativePath" in file ? file.webkitRelativePath : "";
    if (!rawRelativePath) {
      return file.name;
    }

    const segments = rawRelativePath.replaceAll("\\", "/").split("/").filter(Boolean);
    return segments.length > 1 ? segments.slice(1).join("/") : file.name;
  });
  const importSelectionPreview = selectedImportPaths.slice(0, 3).join(", ");
  const hasMoreSelectedImports = selectedImportPaths.length > 3;
  const selectedThemeDescription =
    themeOptions.find((option) => option.value === props.currentTheme)?.description ??
    "The current blue/slate Dacci palette.";

  return (
    <aside className="panel management-pane open">
      <div className="management-pane-header">
        <div>
          <p className="eyebrow viewer-eyebrow">Manage</p>
          <h2>Configuration and structure</h2>
          <div className="sync-chip-row top-gap">
            <span className="metadata-pill">{topicCountLabel}</span>
          </div>
        </div>
        <button
          aria-label="Close manage panel"
          className="ghost-button side-pane-close"
          onClick={props.onToggleOpen}
          type="button"
        >
          ×
        </button>
      </div>

      <div className="management-pane-scroll">
        <section className="management-card">
          <h3>API status</h3>
          {props.health ? (
            <dl className="status-grid compact">
              <div>
                <dt>Status</dt>
                <dd>{props.health.status}</dd>
              </div>
              <div>
                <dt>Service</dt>
                <dd>{props.health.service}</dd>
              </div>
              <div>
                <dt>Data root</dt>
                <dd>{props.health.dataRoot}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">Waiting for the local API health endpoint...</p>
          )}
        </section>

        <section className="management-card">
          <h3>Theme</h3>
          <div className="form-grid">
            <label>
              <span>Application theme</span>
              <select
                disabled={props.busy}
                onChange={(event) => {
                  const nextTheme = event.currentTarget.value;
                  if (isThemeName(nextTheme)) {
                    props.onThemeChange(nextTheme);
                  }
                }}
                value={props.currentTheme}
              >
                {themeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">{selectedThemeDescription}</p>
            <p className="muted">Applies across Workspace, Manage, Library, Sync, and shared controls.</p>
          </div>
        </section>

        <section className="management-card">
          <h3>Topic management</h3>
          <div className="form-grid">
            <label>
              <span>Topic name</span>
              <input
                onChange={(event) => props.onTopicFormNameChange(event.target.value)}
                placeholder="Operations"
                value={props.topicFormName}
              />
            </label>
            <button
              className="primary-button"
              disabled={props.busy || !props.topicFormName.trim()}
              onClick={props.onCreateTopic}
              type="button"
            >
              Create topic
            </button>
          </div>

          <div className="form-grid top-gap">
            <label>
              <span>Topic</span>
              <select onChange={(event) => props.onRenameTopicNameChange(event.target.value)} value={props.renameTopicName}>
                <option value="">Select a topic</option>
                {props.topicOptions.map((topic) => (
                  <option key={topic.path} value={topic.name}>
                    {topic.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-actions">
              <button
                className="ghost-button"
                disabled={props.busy || !props.renameTopicName}
                onClick={props.onRenameTopic}
                type="button"
              >
                Rename topic
              </button>
              <button
                className="ghost-button danger"
                disabled={props.busy || !props.renameTopicName}
                onClick={props.onDeleteTopic}
                type="button"
              >
                Delete topic
              </button>
            </div>
          </div>
        </section>

        <section className="management-card">
          <h3>Subtopic management</h3>
          <div className="form-grid">
            <label>
              <span>Topic</span>
              <select onChange={(event) => props.onSubtopicTopicChange(event.target.value)} value={props.subtopicForm.topicName}>
                <option value="">Select a topic</option>
                {props.topicOptions.map((topic) => (
                  <option key={topic.path} value={topic.name}>
                    {topic.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Subtopic name</span>
              <input
                onChange={(event) => props.onSubtopicNameChange(event.target.value)}
                placeholder="Runbooks"
                value={props.subtopicForm.name}
              />
            </label>
            <button
              className="primary-button"
              disabled={props.busy || !props.subtopicForm.topicName || !props.subtopicForm.name.trim()}
              onClick={props.onCreateSubtopic}
              type="button"
            >
              Create subtopic
            </button>
          </div>

          <div className="form-grid top-gap">
            <label>
              <span>Topic</span>
              <select
                onChange={(event) => props.onRenameSubtopicTopicChange(event.target.value)}
                value={props.renameSubtopicState.topicName}
              >
                <option value="">Select a topic</option>
                {props.topicOptions.map((topic) => (
                  <option key={topic.path} value={topic.name}>
                    {topic.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Subtopic</span>
              <select
                onChange={(event) => props.onRenameSubtopicNameChange(event.target.value)}
                value={props.renameSubtopicState.currentName}
              >
                <option value="">Select a subtopic</option>
                {getSubtopicsForTopic(props.topicOptions, props.renameSubtopicState.topicName).map((subtopic) => (
                  <option key={subtopic.path} value={subtopic.name}>
                    {subtopic.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-actions">
              <button
                className="ghost-button"
                disabled={props.busy || !props.renameSubtopicState.topicName || !props.renameSubtopicState.currentName}
                onClick={props.onRenameSubtopic}
                type="button"
              >
                Rename subtopic
              </button>
              <button
                className="ghost-button danger"
                disabled={props.busy || !props.renameSubtopicState.topicName || !props.renameSubtopicState.currentName}
                onClick={props.onDeleteSubtopic}
                type="button"
              >
                Delete subtopic
              </button>
            </div>
          </div>
        </section>

        <section className="management-card">
          <h3>Create document</h3>
          <div className="form-grid">
            <label>
              <span>Topic</span>
              <select onChange={(event) => props.onDocumentTopicChange(event.target.value)} value={props.documentForm.topicName}>
                <option value="">Select a topic</option>
                {props.topicOptions.map((topic) => (
                  <option key={topic.path} value={topic.name}>
                    {topic.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Subtopic</span>
              <select
                onChange={(event) => props.onDocumentSubtopicChange(event.target.value)}
                value={props.documentForm.subtopicName}
              >
                <option value="">Topic-level</option>
                {getSubtopicsForTopic(props.topicOptions, props.documentForm.topicName).map((subtopic) => (
                  <option key={subtopic.path} value={subtopic.name}>
                    {subtopic.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Document name</span>
              <input
                onChange={(event) => props.onDocumentNameChange(event.target.value)}
                placeholder="readme.md"
                value={props.documentForm.name}
              />
            </label>
            <label className="full-width">
              <span>Body</span>
              <textarea
                onChange={(event) => props.onDocumentBodyChange(event.target.value)}
                placeholder="# New document"
                rows={8}
                value={props.documentForm.body}
              />
            </label>
            <button
              className="primary-button"
              disabled={props.busy || !props.documentForm.topicName || !props.documentForm.name.trim()}
              onClick={props.onCreateDocument}
              type="button"
            >
              Create document
            </button>
          </div>
        </section>

        <section className="management-card">
          <h3>Import content</h3>
          <div className="form-grid">
            <label>
              <span>Import format</span>
              <select
                onChange={(event) => props.onImportFormatChange(event.target.value as ImportFormat)}
                value={props.importForm.format}
              >
                <option value="documents">Markdown files or folders</option>
                <option value="bundle-json">JSON bundle</option>
                <option value="bundle-zip">ZIP archive</option>
              </select>
            </label>
            {props.importForm.format === "documents" ? (
              <label>
                <span>Topic</span>
                <select onChange={(event) => props.onImportTopicChange(event.target.value)} value={props.importForm.topicName}>
                  <option value="">Select a topic</option>
                  {props.topicOptions.map((topic) => (
                    <option key={topic.path} value={topic.name}>
                      {topic.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {props.importForm.format === "documents" ? (
              <label>
                <span>Subtopic</span>
                <select onChange={(event) => props.onImportSubtopicChange(event.target.value)} value={props.importForm.subtopicName}>
                  <option value="">Topic-level</option>
                  {getSubtopicsForTopic(props.topicOptions, props.importForm.topicName).map((subtopic) => (
                    <option key={subtopic.path} value={subtopic.name}>
                      {subtopic.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              <span>Conflict mode</span>
              <select
                onChange={(event) => props.onImportConflictModeChange(event.target.value as ImportConflictMode)}
                value={props.importForm.conflictMode}
              >
                <option value="fail">Fail on conflict</option>
                <option value="skip">Skip existing documents</option>
                <option value="overwrite">Overwrite existing documents</option>
              </select>
            </label>
            {props.importForm.format === "documents" ? (
              <>
                <label>
                  <span>Folder mapping</span>
                  <select
                    onChange={(event) =>
                      props.onImportFolderMappingModeChange(event.target.value as ImportFolderMappingMode)
                    }
                    value={props.importForm.folderMappingMode}
                  >
                    <option value="folders-to-subtopic">Map folders into subtopics</option>
                    <option value="flat">Flatten into the selected destination</option>
                  </select>
                </label>
                <label className="full-width">
                  <span>Markdown files</span>
                  <input
                    accept=".md,text/markdown"
                    key={`files-${props.importInputKey}`}
                    multiple
                    onChange={(event) => props.onImportFilesChange(Array.from(event.target.files ?? []))}
                    type="file"
                  />
                </label>
                <label className="full-width">
                  <span>Markdown folder</span>
                  <input
                    {...directoryPickerAttributes}
                    accept=".md,text/markdown"
                    key={`folder-${props.importInputKey}`}
                    onChange={(event) => props.onImportFilesChange(Array.from(event.target.files ?? []))}
                    type="file"
                  />
                </label>
              </>
            ) : (
              <label className="full-width">
                <span>{props.importForm.format === "bundle-json" ? "JSON bundle" : "ZIP archive"}</span>
                <input
                  accept={props.importForm.format === "bundle-json" ? ".json,application/json" : ".zip,application/zip"}
                  key={`bundle-${props.importInputKey}-${props.importForm.format}`}
                  onChange={(event) => props.onImportBundleFileChange(event.target.files?.[0] ?? null)}
                  type="file"
                />
              </label>
            )}
            {props.importForm.format === "documents" && props.importFiles.length > 0 ? (
              <p className="muted">
                Selected {props.importFiles.length} file{props.importFiles.length === 1 ? "" : "s"}:{" "}
                {importSelectionPreview}
                {hasMoreSelectedImports ? ", ..." : ""}. Only <code>.md</code> files are imported.
              </p>
            ) : null}
            {props.importForm.format !== "documents" && props.importBundleFile ? (
              <p className="muted">
                Selected bundle file: <code>{props.importBundleFile.name}</code>.
              </p>
            ) : null}
            <button
              className="primary-button"
              disabled={
                props.busy ||
                (props.importForm.format === "documents"
                  ? !props.importForm.topicName || props.importFiles.length === 0
                  : !props.importBundleFile)
              }
              onClick={props.onImportFiles}
              type="button"
            >
              Import content
            </button>
            <p className="muted">
              For a single pasted document, the create-document form remains the fastest path. Markdown imports still target the selected topic/subtopic and can map folders into visible subtopics. JSON bundles and ZIP archives recreate logical document paths from the transfer package while still honoring the selected conflict mode.
            </p>
          </div>
        </section>

        <section className="management-card">
          <h3>Export content</h3>
          <div className="form-grid">
            <label>
              <span>Scope</span>
              <select
                onChange={(event) => props.onExportScopeChange(event.target.value as "document" | "topic" | "subtopic")}
                value={props.exportForm.scope}
              >
                <option value="document">Selected document</option>
                <option value="topic">Topic bundle</option>
                <option value="subtopic">Subtopic bundle</option>
              </select>
            </label>
            <label>
              <span>Export format</span>
              <select
                onChange={(event) => props.onExportFormatChange(event.target.value as "default" | ExportFormat)}
                value={props.exportForm.format}
              >
                <option value="default">Default workflow</option>
                <option value="bundle-json">JSON bundle</option>
                <option value="bundle-zip">ZIP archive</option>
              </select>
            </label>
            {props.exportForm.scope !== "document" ? (
              <label>
                <span>Topic</span>
                <select onChange={(event) => props.onExportTopicChange(event.target.value)} value={props.exportForm.topicName}>
                  <option value="">Select a topic</option>
                  {props.topicOptions.map((topic) => (
                    <option key={topic.path} value={topic.name}>
                      {topic.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {props.exportForm.scope === "subtopic" ? (
              <label>
                <span>Subtopic</span>
                <select onChange={(event) => props.onExportSubtopicChange(event.target.value)} value={props.exportForm.subtopicName}>
                  <option value="">Select a subtopic</option>
                  {getSubtopicsForTopic(props.topicOptions, props.exportForm.topicName).map((subtopic) => (
                    <option key={subtopic.path} value={subtopic.name}>
                      {subtopic.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              className="ghost-button"
              disabled={
                props.busy ||
                (props.exportForm.scope === "document" && !props.selectedDocument) ||
                (props.exportForm.scope === "topic" && !props.exportForm.topicName) ||
                (props.exportForm.scope === "subtopic" &&
                  (!props.exportForm.topicName || !props.exportForm.subtopicName))
              }
              onClick={props.onExport}
              type="button"
            >
              Export
            </button>
            <p className="muted">
              Default export keeps the existing workflow: a selected document downloads as raw Markdown, while topic and subtopic exports download JSON bundles. Choose ZIP archive when you want a packaged round-trip transfer file.
            </p>
          </div>
        </section>
      </div>
    </aside>
  );
}

function getSubtopicsForTopic(topics: ContentTopicNode[], topicName: string): ContentSubtopicNode[] {
  return topics.find((topic) => topic.name === topicName)?.subtopics ?? [];
}
