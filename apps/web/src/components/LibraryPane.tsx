import type { RefObject } from "react";

import type { LibraryRepoTestResponse, SavedLibraryRepoDefinition } from "@dacci/shared-types";

import { GitAccessGuidance } from "./GitAccessGuidance";

interface LibraryPaneProps {
  activeRepoLabel: string;
  busy: boolean;
  createContentRepoGuideUrl: string;
  editSectionRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  form: {
    id: string | null;
    source: "configured" | "saved" | null;
    name: string;
    repoRoot: string;
    dataRoot: string;
    releaseBranch: string;
  };
  importInputKey: number;
  savedRepos: SavedLibraryRepoDefinition[];
  selectedRepoId: string;
  testResult: LibraryRepoTestResponse | null;
  onCancelEdit: () => void;
  onEditRepo: (repo: SavedLibraryRepoDefinition) => void;
  onExportLibrary: () => void;
  onFormDataRootChange: (value: string) => void;
  onFormNameChange: (value: string) => void;
  onFormReleaseBranchChange: (value: string) => void;
  onFormRepoRootChange: (value: string) => void;
  onImportLibrary: (file: File | null) => void;
  onRemoveRepo: (repoId: string) => void;
  onSaveRepo: () => void;
  onSelectRepo: (repoId: string) => void;
  onTestRepo: () => void;
  onToggleOpen: () => void;
}

export function LibraryPane(props: LibraryPaneProps) {
  const editing = props.form.id !== null;
  const editingConfiguredRepo = props.form.source === "configured";
  const saveDisabled = props.busy || !props.form.name.trim() || !props.form.repoRoot.trim();

  return (
    <aside className="panel library-pane open">
      <div className="management-pane-header">
        <div>
          <p className="eyebrow viewer-eyebrow">Library</p>
          <h2>Content repositories</h2>
          <p className="muted">
            Active repository: <strong>{props.activeRepoLabel}</strong>
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

      <div className="management-pane-scroll" ref={props.scrollContainerRef}>
        <section className="management-card">
          <h3>Saved repositories</h3>
          <p className="muted">
            Library entries point to existing local content-repo checkouts. Dacci keeps the configured runtime repo here too, so every repository is selected the same way.
          </p>

          <div className="library-repo-list">
            {props.savedRepos.length === 0 ? (
              <p className="muted">Loading saved repositories...</p>
            ) : (
              props.savedRepos.map((repo) => {
                const configuredRepo = repo.source === "configured";
                return (
                  <article className="library-repo-item" key={repo.id}>
                    <div>
                       <strong>{repo.name}</strong>
                       <p className="muted">{repo.repoRoot}</p>
                       {repo.dataRoot ? <p className="muted">Content root override: {repo.dataRoot}</p> : null}
                       {repo.releaseBranch ? <p className="muted">Sync branch: {repo.releaseBranch}</p> : null}
                       {configuredRepo ? (
                         <p className="muted">Configured by the running Dacci backend.</p>
                       ) : null}
                    </div>
                    <div className="inline-actions">
                      <button
                        className={repo.id === props.selectedRepoId ? "primary-button" : "ghost-button"}
                        disabled={props.busy || repo.id === props.selectedRepoId}
                        onClick={() => props.onSelectRepo(repo.id)}
                        type="button"
                      >
                        {repo.id === props.selectedRepoId ? "Active" : "Use"}
                      </button>
                      <button className="ghost-button" disabled={props.busy} onClick={() => props.onEditRepo(repo)} type="button">
                        Edit
                      </button>
                      {!configuredRepo ? (
                        <button
                          className="ghost-button danger"
                          disabled={props.busy}
                          onClick={() => props.onRemoveRepo(repo.id)}
                          type="button"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>

        <section className="management-card" ref={props.editSectionRef}>
          <h3>{editing ? "Edit repository" : "Add repository"}</h3>
          <p className="muted">
            Add an existing content repository. To create a Content Repo:{" "}
            <a href={props.createContentRepoGuideUrl} rel="noreferrer" target="_blank">
              Dacci example repo README
            </a>
            .
          </p>
          {editingConfiguredRepo ? (
            <p className="muted">
              This repository is managed by the running Dacci backend, so its paths and branch stay fixed.
            </p>
          ) : null}
          <div className="form-grid">
            <label>
              <span>Name</span>
              <input
                disabled={editingConfiguredRepo}
                onChange={(event) => props.onFormNameChange(event.target.value)}
                placeholder="Example content"
                value={props.form.name}
              />
            </label>

            <label>
              <span>Repository root</span>
              <input
                disabled={editingConfiguredRepo}
                onChange={(event) => props.onFormRepoRootChange(event.target.value)}
                placeholder="/absolute/path/to/content-repo"
                value={props.form.repoRoot}
              />
            </label>

            <label>
              <span>Content root override</span>
              <input
                disabled={editingConfiguredRepo}
                onChange={(event) => props.onFormDataRootChange(event.target.value)}
                placeholder="Leave blank to use repoRoot/data"
                value={props.form.dataRoot}
              />
            </label>

            <label>
              <span>Sync branch</span>
              <input
                disabled={editingConfiguredRepo}
                onChange={(event) => props.onFormReleaseBranchChange(event.target.value)}
                placeholder="main"
                value={props.form.releaseBranch}
              />
            </label>

            <p className="muted">
              Choose the branch Dacci should use for sync for this repository, such as <code>main</code>. Leave the
              field blank to use the running Dacci default branch.
            </p>
            <GitAccessGuidance />
            <p className="muted">No GitHub username is stored in the browser.</p>

            <div className="inline-actions">
              <button className="primary-button" disabled={saveDisabled} onClick={props.onSaveRepo} type="button">
                {editing ? "Save changes" : "Save repository"}
              </button>
              <button className="ghost-button" disabled={saveDisabled} onClick={props.onTestRepo} type="button">
                Test repository
              </button>
              {editing ? (
                <button className="ghost-button" disabled={props.busy} onClick={props.onCancelEdit} type="button">
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="management-card">
          <h3>Import and export</h3>
          <div className="form-grid">
            <label>
              <span>Import library JSON</span>
              <input
                accept=".json,application/json"
                key={props.importInputKey}
                onChange={(event) => props.onImportLibrary(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <div className="inline-actions">
              <button className="ghost-button" disabled={props.busy} onClick={props.onExportLibrary} type="button">
                Export saved repositories
              </button>
            </div>
          </div>
        </section>

        {props.testResult ? (
          <section className="management-card">
            <h3>Last validation</h3>
            <dl className="status-grid compact">
              <div>
                <dt>Repository</dt>
                <dd>{props.testResult.repo.name}</dd>
              </div>
              <div>
                <dt>Git branch</dt>
                <dd>{props.testResult.git.currentBranch}</dd>
              </div>
              <div>
                <dt>Sync branch</dt>
                <dd>{props.testResult.repo.releaseBranch ?? "default"}</dd>
              </div>
              <div>
                <dt>Topics</dt>
                <dd>{props.testResult.content.topicCount}</dd>
              </div>
              <div>
                <dt>Documents</dt>
                <dd>{props.testResult.content.documentCount}</dd>
              </div>
              <div>
                <dt>Repository root</dt>
                <dd>{props.testResult.repo.repoRoot}</dd>
              </div>
              <div>
                <dt>Content root</dt>
                <dd>{props.testResult.repo.dataRoot}</dd>
              </div>
            </dl>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
