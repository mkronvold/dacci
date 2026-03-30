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
  const moveButtonClassName = props.activeTool === "move" ? "toggle-button tone-bright" : "toggle-button tone-neutral";
  const hiddenButtonClassName = !props.hasFrontMatter
    ? "toggle-button tone-dim viewer-hidden-toggle"
    : props.showHidden
      ? "toggle-button tone-bright viewer-hidden-toggle"
      : "toggle-button tone-neutral viewer-hidden-toggle";
  const tagButtonClassName = props.showTags
    ? "toggle-button tone-bright viewer-tag-toggle"
    : props.hasTags
      ? "toggle-button tone-neutral viewer-tag-toggle"
      : "toggle-button tone-dim viewer-tag-toggle";
  const outlineButtonClassName = props.outlineOpen
    ? "toggle-button tone-bright viewer-outline-toggle"
    : "toggle-button tone-neutral viewer-outline-toggle";

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
          className={moveButtonClassName}
          disabled={props.busy}
          onClick={props.onToggleMove}
          type="button"
        >
          Move
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
              className={hiddenButtonClassName}
              disabled={!props.hasFrontMatter}
              onClick={props.onToggleHidden}
              type="button"
            >
              Header
            </button>
          ) : null}
          {props.showTagToggle ? (
            <button
              aria-pressed={props.showTags}
              className={tagButtonClassName}
              onClick={props.onToggleTags}
              type="button"
            >
              Tags
            </button>
          ) : null}
          {props.showOutlineToggle ? (
            <button
              aria-pressed={props.outlineOpen}
              className={outlineButtonClassName}
              onClick={props.onToggleOutline}
              type="button"
            >
              Outline
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
