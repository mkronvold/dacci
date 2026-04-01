import type { GitSyncStatus } from "@dacci/shared-types";

interface SyncStatusSummaryProps {
  status: GitSyncStatus | null;
  syncError: string | null;
  selectedDocumentChanged: boolean;
  variant: "compact" | "detail";
}

interface InfoListBlockProps {
  title: string;
  items: string[];
  tone?: "default" | "danger";
}

function getBranchLabel(status: GitSyncStatus): string {
  return status.currentBranch === status.releaseBranch
    ? status.currentBranch
    : `${status.currentBranch} (release: ${status.releaseBranch})`;
}

function getBackgroundPullLabel(status: GitSyncStatus): string {
  if (status.scheduler) {
    if (!status.scheduler.enabled) {
      return "Background pull off";
    }

    return status.scheduler.paused ? "Background pull paused" : `Background pull ${status.scheduler.intervalMinutes}m`;
  }

  if (status.schedulerSupported === false) {
    return "Background pull unavailable";
  }

  return "Background pull unavailable";
}

function getBackgroundPullFieldValue(status: GitSyncStatus): string {
  if (status.scheduler) {
    if (!status.scheduler.enabled) {
      return "Disabled";
    }

    return status.scheduler.paused ? "Paused" : `Enabled every ${status.scheduler.intervalMinutes} min`;
  }

  if (status.schedulerSupported === false) {
    return "Unavailable";
  }

  return "Unavailable";
}

function InfoListBlock(props: InfoListBlockProps) {
  if (props.items.length === 0) {
    return null;
  }

  return (
    <div className={props.tone === "danger" ? "info-block danger" : "info-block"}>
      <strong>{props.title}</strong>
      <ul className="issue-list">
        {props.items.map((item) => (
          <li key={`${props.title}-${item}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function SyncStatusSummary(props: SyncStatusSummaryProps) {
  if (!props.status) {
    return (
      <p className="muted">
        {props.syncError ? `Sync status is unavailable: ${props.syncError}` : "Loading the git sync status..."}
      </p>
    );
  }

  const nonContentChangesBlockPush = props.status.pushBlockers.includes(
    "Dacci sync push only supports content. Commit or clear non-content changes first.",
  );
  const branchLabel = getBranchLabel(props.status);
  const schedulerLabel = getBackgroundPullLabel(props.status);

  if (props.variant === "compact") {
    const repoLabel = props.status.repo?.name ?? "Active repository";

    return (
      <div className="sync-chip-row">
        <span className="metadata-pill">Repository {repoLabel}</span>
        <span className={props.selectedDocumentChanged ? "metadata-pill warn" : "metadata-pill success"}>
          {props.selectedDocumentChanged ? "Selected doc changed" : "Selected doc clean"}
        </span>
        <span className="metadata-pill">Content changes {props.status.changedFiles.length}</span>
        <span className={nonContentChangesBlockPush ? "metadata-pill danger" : "metadata-pill success"}>
          Non-content changes {props.status.nonContentChangedFiles.length}
        </span>
        <span className={props.status.isReleaseBranch ? "metadata-pill success" : "metadata-pill warn"}>
          Branch {branchLabel}
        </span>
        <span
          className={
            props.status.scheduler?.enabled
              ? props.status.scheduler.paused
                ? "metadata-pill warn"
                : "metadata-pill success"
              : "metadata-pill"
          }
        >
          {schedulerLabel}
        </span>
      </div>
    );
  }

  return (
    <div className="form-grid">
      <dl className="status-grid compact">
        <div>
          <dt>Repository name</dt>
          <dd>{props.status.repo?.name ?? "Active repository"}</dd>
        </div>
        <div>
          <dt>Repository root</dt>
          <dd>{props.status.repo?.repoRoot ?? props.status.repoRoot}</dd>
        </div>
        <div>
          <dt>Content root</dt>
          <dd>{props.status.repo?.dataRoot ?? props.status.contentRoot}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{branchLabel}</dd>
        </div>
        <div>
          <dt>Remote</dt>
          <dd>{props.status.remoteName}</dd>
        </div>
        <div>
          <dt>Remote URL</dt>
          <dd>{props.status.remoteUrl ? <code>{props.status.remoteUrl}</code> : "Not configured"}</dd>
        </div>
        <div>
          <dt>Content changes</dt>
          <dd>{props.status.changedFiles.length}</dd>
        </div>
        <div>
          <dt>Non-content changes</dt>
          <dd className={nonContentChangesBlockPush ? "danger" : undefined}>{props.status.nonContentChangedFiles.length}</dd>
        </div>
        <div>
          <dt>Background pull</dt>
          <dd>{getBackgroundPullFieldValue(props.status)}</dd>
        </div>
        <div>
          <dt>Next scheduled run</dt>
          <dd>
            {props.status.scheduler?.nextRunAt
              ? new Date(props.status.scheduler.nextRunAt).toLocaleString()
              : "Not scheduled"}
          </dd>
        </div>
      </dl>

      {props.status.lastContentCommit ? (
        <p className="muted">
          Last content commit: <strong>{props.status.lastContentCommit.message}</strong> (
          {props.status.lastContentCommit.sha.slice(0, 7)}) at{" "}
          {new Date(props.status.lastContentCommit.committedAt).toLocaleString()}
        </p>
      ) : null}

      {props.status.scheduler?.lastPullAt ? (
        <p className="muted">
          Last scheduled pull: <strong>{new Date(props.status.scheduler.lastPullAt).toLocaleString()}</strong>
        </p>
      ) : null}

      {props.status.scheduler?.lastError ? (
        <p className="muted">
          Last scheduler issue: <strong>{props.status.scheduler.lastError}</strong>
        </p>
      ) : null}

      <InfoListBlock
        items={props.status.changedFiles.map((change) => `${change.indexStatus}${change.worktreeStatus} ${change.path}`)}
        title="Content changes"
      />

      <InfoListBlock
        items={props.status.nonContentChangedFiles.map(
          (change) => `${change.indexStatus}${change.worktreeStatus} ${change.path}`,
        )}
        title="Non-content working tree changes"
        tone={nonContentChangesBlockPush ? "danger" : "default"}
      />

      <InfoListBlock
        items={props.status.nonContentCommittedFiles}
        title="Committed non-content branch changes"
        tone="danger"
      />

      <InfoListBlock items={props.status.pullBlockers} title="Pull blockers" tone="danger" />
      <InfoListBlock items={props.status.pushBlockers} title="Push blockers" tone="danger" />
      <InfoListBlock
        items={
          props.status.scheduler?.pauseReason
            ? [props.status.scheduler.pauseReason]
            : []
        }
        title="Background pull pause reason"
        tone="danger"
      />
      <InfoListBlock items={props.status.recommendedActions} title="Recommended actions" />
    </div>
  );
}
