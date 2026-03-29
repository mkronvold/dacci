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

  if (props.variant === "compact") {
    const schedulerLabel = props.status.scheduler
      ? props.status.scheduler.enabled
        ? props.status.scheduler.paused
          ? "Background sync paused"
          : `Background sync ${props.status.scheduler.intervalMinutes}m`
        : "Background sync off"
      : "Background sync unavailable";

    return (
      <div className="sync-chip-row">
        <span className={props.selectedDocumentChanged ? "metadata-pill warn" : "metadata-pill success"}>
          {props.selectedDocumentChanged ? "Selected doc changed" : "Selected doc clean"}
        </span>
        <span className="metadata-pill">Content changes {props.status.changedFiles.length}</span>
        <span className={props.status.nonContentChangedFiles.length > 0 ? "metadata-pill warn" : "metadata-pill success"}>
          Non-content changes {props.status.nonContentChangedFiles.length}
        </span>
        <span className={props.status.isReleaseBranch ? "metadata-pill success" : "metadata-pill warn"}>
          Release branch {props.status.releaseBranch}
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
          <dt>Current branch</dt>
          <dd>{props.status.currentBranch}</dd>
        </div>
        <div>
          <dt>Release branch</dt>
          <dd>{props.status.releaseBranch}</dd>
        </div>
        <div>
          <dt>Upstream</dt>
          <dd>{props.status.upstreamBranch ?? "Not configured"}</dd>
        </div>
        <div>
          <dt>Ahead / behind</dt>
          <dd>
            {props.status.ahead} / {props.status.behind}
          </dd>
        </div>
        <div>
          <dt>Content changes</dt>
          <dd>{props.status.changedFiles.length}</dd>
        </div>
        <div>
          <dt>Non-content changes</dt>
          <dd>{props.status.nonContentChangedFiles.length}</dd>
        </div>
        <div>
          <dt>Background sync</dt>
          <dd>
            {props.status.scheduler
              ? props.status.scheduler.enabled
                ? props.status.scheduler.paused
                  ? "Paused"
                  : `Enabled every ${props.status.scheduler.intervalMinutes} min`
                : "Disabled"
              : "Unavailable"}
          </dd>
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
        tone="danger"
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
        title="Background sync pause reason"
        tone="danger"
      />
      <InfoListBlock items={props.status.recommendedActions} title="Recommended actions" />
    </div>
  );
}
