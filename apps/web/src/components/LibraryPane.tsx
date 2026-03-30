interface LibraryPaneProps {
  onToggleOpen: () => void;
}

export function LibraryPane(props: LibraryPaneProps) {
  return (
    <aside className="panel library-pane open">
      <div className="management-pane-header">
        <div>
          <p className="eyebrow viewer-eyebrow">Library</p>
          <h2>Content repositories</h2>
          <p className="muted">
            This panel will hold your saved content repositories. For now, the current default repository stays active.
          </p>
        </div>
        <button
          aria-label="Close library panel"
          className="ghost-button side-pane-close"
          onClick={props.onToggleOpen}
          type="button"
        >
          ×
        </button>
      </div>

      <div className="management-pane-scroll">
        <section className="management-card">
          <h3>Coming next</h3>
          <ul className="issue-list">
            <li>Add, edit, remove, and test saved repositories.</li>
            <li>Choose the active repository from the top header.</li>
            <li>Import and export repository lists between browsers.</li>
          </ul>
        </section>
      </div>
    </aside>
  );
}
