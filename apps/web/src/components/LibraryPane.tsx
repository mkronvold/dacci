import type { RefObject } from "react";

import type {
  LibraryRepoCreateVisibility,
  LibraryRepoTestResponse,
  SavedLibraryRepoDefinition,
} from "@dacci/shared-types";

import { isBrowserSavedLibraryRepo } from "../utils/libraryRepos";
import { GitAccessGuidance } from "./GitAccessGuidance";

interface LibraryPaneProps {
  activeRepoLabel: string;
  busy: boolean;
  createContentRepoGuideUrl: string;
  createForm: {
    commitAuthorEmail: string;
    commitAuthorName: string;
    name: string;
    githubOwner: string;
    githubUsername: string;
    githubRepo: string;
    releaseBranch: string;
    visibility: LibraryRepoCreateVisibility;
    sshHostAlias: string;
  };
  createRepoRootPreview: string;
  createRepoSupported: boolean;
  createRepoSupportMessage: string | null;
  editSectionRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  form: {
    commitAuthorEmail: string;
    commitAuthorName: string;
    id: string | null;
    source: "configured" | "discovered" | "saved" | null;
    name: string;
    repoRoot: string;
    dataRoot: string;
    releaseBranch: string;
  };
  importInputKey: number;
  remoteAdoptForm: {
    commitAuthorEmail: string;
    commitAuthorName: string;
    name: string;
    githubOwner: string;
    githubUsername: string;
    githubRepo: string;
    releaseBranch: string;
    sshHostAlias: string;
  };
  remoteAdoptRepoRootPreview: string;
  remoteAdoptRepoSupported: boolean;
  remoteAdoptRepoSupportMessage: string | null;
  repos: SavedLibraryRepoDefinition[];
  selectedRepoId: string;
  testResult: LibraryRepoTestResponse | null;
  onAdoptRemoteRepo: () => void;
  onCancelEdit: () => void;
  onCreateFormCommitAuthorEmailChange: (value: string) => void;
  onCreateFormCommitAuthorNameChange: (value: string) => void;
  onCreateFormGithubOwnerChange: (value: string) => void;
  onCreateFormGithubRepoChange: (value: string) => void;
  onCreateFormGithubUsernameChange: (value: string) => void;
  onCreateFormNameChange: (value: string) => void;
  onCreateFormReleaseBranchChange: (value: string) => void;
  onCreateFormSshHostAliasChange: (value: string) => void;
  onCreateFormVisibilityChange: (value: LibraryRepoCreateVisibility) => void;
  onCreateRepo: () => void;
  onEditRepo: (repo: SavedLibraryRepoDefinition) => void;
  onExportLibrary: () => void;
  onRefreshRepositories: () => void;
  onFormCommitAuthorEmailChange: (value: string) => void;
  onFormCommitAuthorNameChange: (value: string) => void;
  onFormDataRootChange: (value: string) => void;
  onFormNameChange: (value: string) => void;
  onFormReleaseBranchChange: (value: string) => void;
  onFormRepoRootChange: (value: string) => void;
  onImportLibrary: (file: File | null) => void;
  onRemoteAdoptFormCommitAuthorEmailChange: (value: string) => void;
  onRemoteAdoptFormCommitAuthorNameChange: (value: string) => void;
  onRemoteAdoptFormGithubOwnerChange: (value: string) => void;
  onRemoteAdoptFormGithubRepoChange: (value: string) => void;
  onRemoteAdoptFormGithubUsernameChange: (value: string) => void;
  onRemoteAdoptFormNameChange: (value: string) => void;
  onRemoteAdoptFormReleaseBranchChange: (value: string) => void;
  onRemoteAdoptFormSshHostAliasChange: (value: string) => void;
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
  const remoteAdoptInputsDisabled = props.busy || !props.remoteAdoptRepoSupported;
  const remoteAdoptDisabled =
    remoteAdoptInputsDisabled ||
    !props.remoteAdoptForm.githubUsername.trim() ||
    !props.remoteAdoptForm.githubRepo.trim() ||
    !props.remoteAdoptForm.releaseBranch.trim();
  const createInputsDisabled = props.busy || !props.createRepoSupported;
  const createDisabled =
    createInputsDisabled ||
    !props.createForm.commitAuthorEmail.trim() ||
    !props.createForm.commitAuthorName.trim() ||
    !props.createForm.githubUsername.trim() ||
    !props.createForm.githubRepo.trim() ||
    !props.createForm.releaseBranch.trim();
  const browserSavedRepos = props.repos.filter((repo) => isBrowserSavedLibraryRepo(repo));
  const runtimeRepos = props.repos.filter((repo) => !isBrowserSavedLibraryRepo(repo));

  const renderRepoList = (repos: SavedLibraryRepoDefinition[]) =>
    repos.map((repo) => {
      const configuredRepo = repo.source === "configured";
      const discoveredRepo = repo.source === "discovered";
      const browserSavedRepo = isBrowserSavedLibraryRepo(repo);

      return (
        <article className="library-repo-item" key={repo.id}>
          <div>
            <strong>{repo.name}</strong>
            <p className="muted">{repo.repoRoot}</p>
            {repo.dataRoot ? <p className="muted">Content root override: {repo.dataRoot}</p> : null}
            {repo.releaseBranch ? <p className="muted">Sync branch: {repo.releaseBranch}</p> : null}
            {repo.commitAuthorName || repo.commitAuthorEmail ? (
              <p className="muted">
                Commit identity: {repo.commitAuthorName || "Name needed"}
                {repo.commitAuthorEmail ? ` <${repo.commitAuthorEmail}>` : " <email needed>"}
              </p>
            ) : isBrowserSavedLibraryRepo(repo) ? (
              <p className="muted">Commit identity not set yet for this browser-saved repo.</p>
            ) : null}
            {browserSavedRepo ? (
              <p className="muted">Saved in this browser.</p>
            ) : configuredRepo ? (
              <p className="muted">Provided by the running Dacci backend.</p>
            ) : discoveredRepo ? (
              <p className="muted">Discovered from the current Dacci workspace.</p>
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
            {browserSavedRepo ? (
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
    });

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
          <div className="panel-header">
            <div>
              <h3>Available repositories</h3>
            </div>
            <div className="inline-actions panel-header-actions">
              <button className="ghost-button" disabled={props.busy} onClick={props.onRefreshRepositories} type="button">
                Refresh repositories
              </button>
            </div>
          </div>
          <p className="muted">
            Dacci shows repositories discovered from the current workspace alongside repositories saved in this browser.
            Only browser-saved repositories can be removed or exported.
          </p>

          <div className="library-repo-list">
            {props.repos.length === 0 ? (
              <p className="muted">
                No repositories are available yet. Adopt a local checkout below, adopt a remote content repository, or
                create a new GitHub-backed repository here.
              </p>
            ) : (
              <>
                <div className="library-repo-group">
                  <h4>Saved in this browser</h4>
                  <p className="muted">
                    These entries are browser-local. They can be edited, exported, and removed without touching the
                    underlying checkout.
                  </p>
                  {browserSavedRepos.length > 0 ? (
                    renderRepoList(browserSavedRepos)
                  ) : (
                    <p className="muted">No browser-saved repositories yet.</p>
                  )}
                </div>

                {runtimeRepos.length > 0 ? (
                  <div className="library-repo-group">
                    <h4>Available from this Dacci runtime</h4>
                    <p className="muted">
                      These entries come from the running backend or current workspace. Save an override below if you
                      want browser-local edits, export, or removal.
                    </p>
                    {renderRepoList(runtimeRepos)}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>

        <section className="management-card" ref={props.editSectionRef}>
          <h3>{editing ? "Edit repository" : "Adopt Local Repository"}</h3>
          <p className="muted">
            Use this for an existing local content checkout. In Docker, prefer the in-container path such as <code>/workspace/Dacci.Example.Content</code>. To create a Content Repo:{" "}
            <a href={props.createContentRepoGuideUrl} rel="noreferrer" target="_blank">
              Dacci example repo README
            </a>
            .
          </p>
          {editingConfiguredRepo ? (
            <p className="muted">
              This repository is provided by the running Dacci backend, so its paths and branch stay fixed.
            </p>
          ) : props.form.source === "discovered" ? (
            <p className="muted">
              This repository was discovered from the current workspace. Save changes here to keep a browser-local override.
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

            <label>
              <span>Commit name</span>
              <input
                disabled={props.busy}
                onChange={(event) => props.onFormCommitAuthorNameChange(event.target.value)}
                placeholder="Your Name"
                value={props.form.commitAuthorName}
              />
            </label>

            <label>
              <span>Commit email</span>
              <input
                disabled={props.busy}
                onChange={(event) => props.onFormCommitAuthorEmailChange(event.target.value)}
                placeholder="you@example.com"
                type="email"
                value={props.form.commitAuthorEmail}
              />
            </label>

            <p className="muted">
              Choose the branch Dacci should use for sync for this repository, such as <code>main</code>. Leave the field blank to use the running Dacci default branch.
            </p>
            <p className="muted">
              Commit name and email stay in this browser for this repository. Dacci uses them only when it needs to author a commit.
            </p>
            <GitAccessGuidance />
            <p className="muted">GitHub credentials and SSH keys are never stored in the browser.</p>

            <div className="inline-actions">
              <button className="primary-button" disabled={saveDisabled} onClick={props.onSaveRepo} type="button">
                {editing ? "Save changes" : "Adopt Local Repository"}
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
          <h3>Adopt Remote Repository</h3>
          <p className="muted">
            Clone an existing GitHub-backed content repository into the configured workspace root and save it for use in Dacci.
          </p>
          {props.remoteAdoptRepoSupportMessage ? <p className="muted">{props.remoteAdoptRepoSupportMessage}</p> : null}
          <div className="form-grid">
            <label>
              <span>Display name</span>
              <input
                disabled={remoteAdoptInputsDisabled}
                onChange={(event) => props.onRemoteAdoptFormNameChange(event.target.value)}
                placeholder="Defaults to the GitHub repository name"
                value={props.remoteAdoptForm.name}
              />
            </label>

            <label>
              <span>GitHub owner or org (optional)</span>
              <input
                disabled={remoteAdoptInputsDisabled}
                onChange={(event) => props.onRemoteAdoptFormGithubOwnerChange(event.target.value)}
                placeholder="Leave blank for personal repos"
                value={props.remoteAdoptForm.githubOwner}
              />
            </label>

            <label>
              <span>GitHub username</span>
              <input
                disabled={remoteAdoptInputsDisabled}
                onChange={(event) => props.onRemoteAdoptFormGithubUsernameChange(event.target.value)}
                placeholder="your-username"
                value={props.remoteAdoptForm.githubUsername}
              />
            </label>

            <label>
              <span>GitHub repository</span>
              <input
                disabled={remoteAdoptInputsDisabled}
                onChange={(event) => props.onRemoteAdoptFormGithubRepoChange(event.target.value)}
                placeholder="Your.Content.Repo"
                value={props.remoteAdoptForm.githubRepo}
              />
            </label>

            <label>
              <span>Repository branch</span>
              <input
                disabled={remoteAdoptInputsDisabled}
                onChange={(event) => props.onRemoteAdoptFormReleaseBranchChange(event.target.value)}
                placeholder="main"
                value={props.remoteAdoptForm.releaseBranch}
              />
            </label>

            <label>
              <span>Commit name</span>
              <input
                disabled={remoteAdoptInputsDisabled}
                onChange={(event) => props.onRemoteAdoptFormCommitAuthorNameChange(event.target.value)}
                placeholder="Optional until Dacci authors a commit"
                value={props.remoteAdoptForm.commitAuthorName}
              />
            </label>

            <label>
              <span>Commit email</span>
              <input
                disabled={remoteAdoptInputsDisabled}
                onChange={(event) => props.onRemoteAdoptFormCommitAuthorEmailChange(event.target.value)}
                placeholder="Optional until Dacci authors a commit"
                type="email"
                value={props.remoteAdoptForm.commitAuthorEmail}
              />
            </label>

            <label>
              <span>GitHub SSH host alias</span>
              <input
                disabled={remoteAdoptInputsDisabled}
                onChange={(event) => props.onRemoteAdoptFormSshHostAliasChange(event.target.value)}
                placeholder="Defaults to the GitHub username"
                value={props.remoteAdoptForm.sshHostAlias}
              />
            </label>

            <p className="muted">
              Leave GitHub owner blank to use the GitHub username for personal repositories.
            </p>
            <p className="muted">
              Checkout path: <code>{props.remoteAdoptRepoRootPreview || "Waiting for GitHub repository name"}</code>
            </p>
            <p className="muted">
              If the SSH alias is missing, Dacci adds it near the top of <code>~/.ssh/config</code> with <code>HostName github.com</code>, <code>User git</code>, and an <code>IdentityFile</code> pointing at <code>id_ed25519_&lt;github-username&gt;</code> inside the active SSH directory.
            </p>
            <p className="muted">
              If you leave commit identity blank here, save it later before Dacci creates the first commit for this repository.
            </p>
            <GitAccessGuidance />

            <div className="inline-actions">
              <button className="primary-button" disabled={remoteAdoptDisabled} onClick={props.onAdoptRemoteRepo} type="button">
                Adopt Remote Repository
              </button>
            </div>
          </div>
        </section>

        <section className="management-card">
          <h3>Create Repository</h3>
          <p className="muted">
            Create a new GitHub repository with <code>gh</code>, clone it into the configured workspace root, seed the base Dacci content layout, and push the first branch.
          </p>
          {props.createRepoSupportMessage ? <p className="muted">{props.createRepoSupportMessage}</p> : null}
          <div className="form-grid">
            <label>
              <span>Display name</span>
              <input
                disabled={createInputsDisabled}
                onChange={(event) => props.onCreateFormNameChange(event.target.value)}
                placeholder="Defaults to the GitHub repository name"
                value={props.createForm.name}
              />
            </label>

            <label>
              <span>GitHub owner or org (optional)</span>
              <input
                disabled={createInputsDisabled}
                onChange={(event) => props.onCreateFormGithubOwnerChange(event.target.value)}
                placeholder="Leave blank for personal repos"
                value={props.createForm.githubOwner}
              />
            </label>

            <label>
              <span>GitHub username</span>
              <input
                disabled={createInputsDisabled}
                onChange={(event) => props.onCreateFormGithubUsernameChange(event.target.value)}
                placeholder="your-username"
                value={props.createForm.githubUsername}
              />
            </label>

            <label>
              <span>GitHub repository</span>
              <input
                disabled={createInputsDisabled}
                onChange={(event) => props.onCreateFormGithubRepoChange(event.target.value)}
                placeholder="Your.Content.Repo"
                value={props.createForm.githubRepo}
              />
            </label>

            <label>
              <span>Initial branch</span>
              <input
                disabled={createInputsDisabled}
                onChange={(event) => props.onCreateFormReleaseBranchChange(event.target.value)}
                placeholder="main"
                value={props.createForm.releaseBranch}
              />
            </label>

            <label>
              <span>Visibility</span>
              <select
                disabled={createInputsDisabled}
                onChange={(event) => props.onCreateFormVisibilityChange(event.target.value as LibraryRepoCreateVisibility)}
                value={props.createForm.visibility}
              >
                <option value="private">private</option>
                <option value="public">public</option>
                <option value="internal">internal</option>
              </select>
            </label>

            <label>
              <span>GitHub SSH host alias</span>
              <input
                disabled={createInputsDisabled}
                onChange={(event) => props.onCreateFormSshHostAliasChange(event.target.value)}
                placeholder="Defaults to the GitHub username"
                value={props.createForm.sshHostAlias}
              />
            </label>

            <label>
              <span>Commit name</span>
              <input
                disabled={createInputsDisabled}
                onChange={(event) => props.onCreateFormCommitAuthorNameChange(event.target.value)}
                placeholder="Required for the initial commit"
                value={props.createForm.commitAuthorName}
              />
            </label>

            <label>
              <span>Commit email</span>
              <input
                disabled={createInputsDisabled}
                onChange={(event) => props.onCreateFormCommitAuthorEmailChange(event.target.value)}
                placeholder="Required for the initial commit"
                type="email"
                value={props.createForm.commitAuthorEmail}
              />
            </label>

            <p className="muted">
              Leave GitHub owner blank to use the GitHub username for personal repositories.
            </p>
            <p className="muted">
              Checkout path: <code>{props.createRepoRootPreview || "Waiting for GitHub repository name"}</code>
            </p>
            <p className="muted">
              If the SSH alias is missing, Dacci adds it near the top of <code>~/.ssh/config</code> with <code>HostName github.com</code>, <code>User git</code>, and an <code>IdentityFile</code> pointing at <code>id_ed25519_&lt;github-username&gt;</code> inside the active SSH directory.
            </p>
            <p className="muted">
              Dacci uses this commit identity for the initial repository commit and saves it only in this browser for later sync commits.
            </p>
            <GitAccessGuidance />

            <div className="inline-actions">
              <button className="primary-button" disabled={createDisabled} onClick={props.onCreateRepo} type="button">
                Create Repository
              </button>
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
