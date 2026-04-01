import type { RefObject } from "react";

import type { GitSyncStatus } from "@dacci/shared-types";

import { GitAccessGuidance, isLikelyGitAuthenticationError } from "./GitAccessGuidance";
import { SyncStatusSummary } from "./SyncStatusSummary";

interface SyncPaneProps {
  busy: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  syncStatus: GitSyncStatus | null;
  syncError: string | null;
  selectedDocumentChanged: boolean;
  syncPushMessage: string;
  syncScheduleForm: {
    enabled: boolean;
    intervalMinutes: string;
  };
  onToggleOpen: () => void;
  onSyncPushMessageChange: (value: string) => void;
  onRefreshSync: () => void;
  onSyncPull: () => void;
  onSyncPush: () => void;
  onSyncScheduleEnabledChange: (value: boolean) => void;
  onSyncScheduleIntervalChange: (value: string) => void;
  onConfigureSyncSchedule: () => void;
  onPauseSyncSchedule: () => void;
  onResumeSyncSchedule: () => void;
}

export function SyncPane(props: SyncPaneProps) {
  const pullAvailable = Boolean(props.syncStatus) && !props.busy && (props.syncStatus?.pullBlockers.length ?? 0) === 0;
  const hasChangesToPull = (props.syncStatus?.behind ?? 0) > 0;
  const pushAvailable =
    Boolean(props.syncStatus) &&
    !props.busy &&
    props.syncPushMessage.trim().length > 0 &&
    (props.syncStatus?.pushBlockers.length ?? 0) === 0;
  const hasChangesToPush =
    Boolean(props.syncStatus) && ((props.syncStatus?.changedFiles.length ?? 0) > 0 || (props.syncStatus?.ahead ?? 0) > 0);
  const scheduleSupported = props.syncStatus?.schedulerSupported !== false;
  const showGitAccessGuidance = isLikelyGitAuthenticationError(props.syncError);
  const syncPullButtonClassName = pullAvailable && hasChangesToPull
    ? "primary-button sync-pull-button ready"
    : pullAvailable
      ? "ghost-button sync-pull-button available"
      : "ghost-button sync-pull-button unavailable";
  const syncPushButtonClassName = pushAvailable
    ? hasChangesToPush
      ? "primary-button sync-push-button ready"
      : "ghost-button sync-push-button available"
    : "ghost-button sync-push-button unavailable";

  return (
    <aside className="panel sync-pane open">
      <div className="management-pane-header">
        <div>
          <p className="eyebrow viewer-eyebrow">Sync</p>
          <h2>Content sync status</h2>
          {props.syncStatus?.repo ? <p className="muted">Active repository: {props.syncStatus.repo.name}</p> : null}
        </div>
        <button
          aria-label="Close sync panel"
          className="ghost-button side-pane-close"
          onClick={props.onToggleOpen}
          type="button"
        >
          ×
        </button>
      </div>

      <div className="management-pane-scroll" ref={props.scrollContainerRef}>
        {showGitAccessGuidance ? (
          <section className="management-card">
            <div className="panel-header">
              <div>
                <h3>Local Git access</h3>
                <GitAccessGuidance />
              </div>
            </div>
          </section>
        ) : null}

        <section className="management-card">
          <div className="panel-header">
            <div>
              <h3>Content sync</h3>
            </div>
            <div className="inline-actions panel-header-actions">
              <button className="ghost-button" disabled={props.busy} onClick={props.onRefreshSync} type="button">
                Refresh status
              </button>
              {hasChangesToPull ? (
                <button
                  className={syncPullButtonClassName}
                  disabled={!pullAvailable}
                  onClick={props.onSyncPull}
                  type="button"
                >
                  Pull
                </button>
              ) : null}
              <button
                className={syncPushButtonClassName}
                disabled={!pushAvailable}
                onClick={props.onSyncPush}
                type="button"
              >
                Push
              </button>
            </div>
          </div>

          <SyncStatusSummary
            selectedDocumentChanged={props.selectedDocumentChanged}
            status={props.syncStatus}
            syncError={props.syncError}
            variant="detail"
          />
        </section>

        {props.syncStatus ? (
          <section className="management-card">
            <h3>Pull, push, and background pull</h3>
            <div className="form-grid">
              <label>
                <span>Push message</span>
                <input
                  onChange={(event) => props.onSyncPushMessageChange(event.target.value)}
                  placeholder="Sync content updates"
                  value={props.syncPushMessage}
                />
              </label>

              <div className="inline-actions">
                <button
                  className={syncPullButtonClassName}
                  disabled={!pullAvailable}
                  onClick={props.onSyncPull}
                  type="button"
                >
                  Pull
                </button>
                <button
                  className={syncPushButtonClassName}
                  disabled={!pushAvailable}
                  onClick={props.onSyncPush}
                  type="button"
                >
                  Push
                </button>
              </div>

              <label>
                <span>Background pull</span>
                <select
                  disabled={!scheduleSupported || props.busy}
                  onChange={(event) => props.onSyncScheduleEnabledChange(event.target.value === "enabled")}
                  value={props.syncScheduleForm.enabled ? "enabled" : "disabled"}
                >
                  <option value="disabled">Disabled</option>
                  <option value="enabled">Enabled</option>
                </select>
              </label>

              <label>
                <span>Interval (minutes)</span>
                <input
                  disabled={!scheduleSupported || props.busy}
                  inputMode="numeric"
                  max={1440}
                  min={1}
                  onChange={(event) => props.onSyncScheduleIntervalChange(event.target.value)}
                  type="number"
                  value={props.syncScheduleForm.intervalMinutes}
                />
              </label>

              <div className="inline-actions">
                <button
                  className="ghost-button"
                  disabled={props.busy || !scheduleSupported}
                  onClick={props.onConfigureSyncSchedule}
                  type="button"
                >
                  Save schedule
                </button>
                {scheduleSupported && props.syncStatus.scheduler?.enabled ? (
                  props.syncStatus.scheduler.paused ? (
                    <button className="ghost-button" disabled={props.busy} onClick={props.onResumeSyncSchedule} type="button">
                      Resume schedule
                    </button>
                  ) : (
                    <button className="ghost-button" disabled={props.busy} onClick={props.onPauseSyncSchedule} type="button">
                      Pause schedule
                    </button>
                  )
                ) : null}
              </div>

              <p className="muted">
                {scheduleSupported
                  ? "Background pull only performs guarded pulls. Push remains manual, and conflicts or blockers pause the schedule."
                  : props.syncStatus.schedulerUnsupportedReason ?? "Background pull scheduling is unavailable in this runtime."}
              </p>
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
