interface ViewerHeaderProps {
  documentName: string;
  documentPath: string;
  lineCount: number;
  wordCount: number;
  changeCount: number;
  hasFrontMatter: boolean;
  hasTags: boolean;
  showTags: boolean;
  showTagToggle: boolean;
  showOutlineToggle: boolean;
  showHidden: boolean;
  showHiddenToggle: boolean;
  outlineOpen: boolean;
  mode: "view" | "edit";
  isDirty: boolean;
  busy: boolean;
  activeTool: "rename" | "move" | null;
  onToggleMode: () => void;
  onSave: () => void;
  onToggleRename: () => void;
  onToggleMove: () => void;
  onToggleTags: () => void;
  onToggleHidden: () => void;
  onToggleOutline: () => void;
  onDelete: () => void;
}

export function ViewerHeader(props: ViewerHeaderProps) {
  const changeLabel = `${props.changeCount} ${props.changeCount === 1 ? "change" : "changes"}`;

  return (
    <header className="viewer-header">
      <div className="viewer-header-main">
        <p className="eyebrow viewer-eyebrow">Workspace</p>
        <h2>{props.documentName}</h2>
        <p className="muted path-label">{props.documentPath}</p>
      </div>

      <div className="viewer-toolbar">
        <button
          className={props.isDirty ? "primary-button save-button dirty" : "ghost-button save-button clean"}
          disabled={props.busy || !props.isDirty}
          onClick={props.onSave}
          type="button"
        >
          Save
        </button>
        <button
          aria-pressed={props.activeTool === "rename"}
          className="ghost-button"
          disabled={props.busy}
          onClick={props.onToggleRename}
          type="button"
        >
          {props.activeTool === "rename" ? "Hide rename" : "Rename"}
        </button>
        <button
          aria-pressed={props.activeTool === "move"}
          className="ghost-button"
          disabled={props.busy}
          onClick={props.onToggleMove}
          type="button"
        >
          {props.activeTool === "move" ? "Hide move" : "Move"}
        </button>
        <button className="ghost-button danger" disabled={props.busy} onClick={props.onDelete} type="button">
          Delete
        </button>
        <button
          aria-pressed={props.mode === "edit"}
          className="ghost-button"
          disabled={props.busy}
          onClick={props.onToggleMode}
          type="button"
        >
          {props.mode === "view" ? "Edit" : "View"}
        </button>
      </div>

      <div className="viewer-header-meta">
        <div className="sync-chip-row">
          <span className="metadata-pill">{props.lineCount} lines</span>
          <span className="metadata-pill">{props.wordCount} words</span>
          <span className="metadata-pill">{changeLabel}</span>
          <span className={props.isDirty ? "metadata-pill warn" : "metadata-pill success"}>
            {props.isDirty ? "Unsaved changes" : "Saved"}
          </span>
        </div>
        <div className="viewer-display-toggles">
          {props.showHiddenToggle ? (
            <button
              aria-pressed={props.showHidden}
              className="ghost-button viewer-hidden-toggle"
              disabled={!props.hasFrontMatter}
              onClick={props.onToggleHidden}
              type="button"
            >
              {props.showHidden ? "Hide Hidden" : "Show Hidden"}
            </button>
          ) : null}
          {props.showTagToggle ? (
            <button
              aria-pressed={props.showTags}
              className={props.hasTags ? "primary-button viewer-tag-toggle" : "ghost-button viewer-tag-toggle"}
              onClick={props.onToggleTags}
              type="button"
            >
              {props.showTags ? "Hide Tags" : "Show Tags"}
            </button>
          ) : null}
          {props.showOutlineToggle ? (
            <button
              aria-pressed={props.outlineOpen}
              className="ghost-button viewer-outline-toggle"
              onClick={props.onToggleOutline}
              type="button"
            >
              {props.outlineOpen ? "Hide Outline" : "Show Outline"}
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
