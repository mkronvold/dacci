import type { GitSyncStatus } from "@dacci/shared-types";

import { SyncStatusSummary } from "./SyncStatusSummary";

interface SyncPaneProps {
  busy: boolean;
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
  const pushAvailable =
    Boolean(props.syncStatus) &&
    !props.busy &&
    props.syncPushMessage.trim().length > 0 &&
    (props.syncStatus?.pushBlockers.length ?? 0) === 0;
  const hasContentToPush = (props.syncStatus?.changedFiles.length ?? 0) > 0;
  const syncPushButtonClassName = pushAvailable
    ? hasContentToPush
      ? "primary-button sync-push-button ready"
      : "ghost-button sync-push-button available"
    : "ghost-button sync-push-button unavailable";

  return (
    <aside className="panel sync-pane open">
      <div className="management-pane-header">
        <div>
          <p className="eyebrow viewer-eyebrow">Sync</p>
          <h2>Content sync status</h2>
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

      <div className="management-pane-scroll">
        <section className="management-card">
          <div className="panel-header">
            <div>
              <h3>Content sync</h3>
            </div>
            <div className="inline-actions panel-header-actions">
              <button className="ghost-button" disabled={props.busy} onClick={props.onRefreshSync} type="button">
                Refresh status
              </button>
              <button
                className={syncPushButtonClassName}
                disabled={!pushAvailable}
                onClick={props.onSyncPush}
                type="button"
              >
                Push sync
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
            <h3>Push and schedule</h3>
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
                  className="ghost-button"
                  disabled={props.busy || props.syncStatus.pullBlockers.length > 0}
                  onClick={props.onSyncPull}
                  type="button"
                >
                  Pull content
                </button>
                <button
                  className={syncPushButtonClassName}
                  disabled={!pushAvailable}
                  onClick={props.onSyncPush}
                  type="button"
                >
                  Push content
                </button>
              </div>

              <label>
                <span>Background sync</span>
                <select
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
                  inputMode="numeric"
                  max={1440}
                  min={1}
                  onChange={(event) => props.onSyncScheduleIntervalChange(event.target.value)}
                  type="number"
                  value={props.syncScheduleForm.intervalMinutes}
                />
              </label>

              <div className="inline-actions">
                <button className="ghost-button" disabled={props.busy} onClick={props.onConfigureSyncSchedule} type="button">
                  Save schedule
                </button>
                {props.syncStatus.scheduler?.enabled ? (
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
                Background sync only performs guarded pulls. Push remains manual, and conflicts or blockers pause the schedule.
              </p>
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
