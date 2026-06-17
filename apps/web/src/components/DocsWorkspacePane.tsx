import { useCallback, useEffect, useMemo, useState } from "react";

import { docsStatuses } from "@dacci/shared-types";
import type {
  ArchiveDocsDocumentRequest,
  AuthSessionResponse,
  AuthSessionSummary,
  CreateDocsDraftInput,
  DeleteArchivedDocsDocumentRequest,
  DocsDocumentVariant,
  DocsLogicalDocumentSummary,
  DocsStatus,
  DocsTree,
  GitHubDeviceAuthorizationPollResponse,
  GitHubDeviceAuthorizationStartResponse,
  PublishDocsDraftRequest,
  RepoSelection,
  SavePublishedEditRequest,
  UpdateDocsDraftRequest,
} from "@dacci/shared-types";

import type { ThemeName } from "../utils/theme";
import { ApiRequestError, requestApi, requestApiNoContent } from "../utils/api";
import { DocumentEditor } from "./DocumentEditor";
import { MarkdownViewer } from "./MarkdownViewer";

interface DocsWorkspacePaneProps {
  apiBaseUrl: string;
  repoId: string;
  repoLabel: string;
  repoSelection: RepoSelection;
  themeName: ThemeName;
}

type DocsStatusFilter = DocsStatus | "all";
type DocsEditorMode = "view" | "edit";

type DocsCreateFormState = {
  layer: string;
  domainPath: string;
  name: string;
  body: string;
};

const authSessionStorageKeyPrefix = "dacci.auth.session.v1";

export function DocsWorkspacePane(props: DocsWorkspacePaneProps) {
  const [authSessionId, setAuthSessionId] = useState<string | null>(() => readPersistedAuthSessionId(props.apiBaseUrl));
  const [authSession, setAuthSession] = useState<AuthSessionSummary | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authInfoMessage, setAuthInfoMessage] = useState<string | null>(null);
  const [deviceAuthStart, setDeviceAuthStart] = useState<GitHubDeviceAuthorizationStartResponse | null>(null);
  const [docsTree, setDocsTree] = useState<DocsTree | null>(null);
  const [docsBusy, setDocsBusy] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [docsInfoMessage, setDocsInfoMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DocsStatusFilter>("all");
  const [selectedLogicalPath, setSelectedLogicalPath] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<DocsStatus | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<DocsDocumentVariant | null>(null);
  const [editorMode, setEditorMode] = useState<DocsEditorMode>("view");
  const [editorBody, setEditorBody] = useState("");
  const [createForm, setCreateForm] = useState<DocsCreateFormState>({
    layer: "",
    domainPath: "",
    name: "",
    body: "",
  });

  const repoPermission = useMemo(
    () => authSession?.permissions.find((permission) => permission.repoId === props.repoId) ?? null,
    [authSession, props.repoId],
  );
  const authContext = useMemo(
    () => ({
      authSessionId,
      repoSelection: props.repoSelection,
    }),
    [authSessionId, props.repoSelection],
  );
  const filteredDocuments = useMemo(
    () =>
      (docsTree?.documents ?? []).filter((document) =>
        statusFilter === "all" ? true : document.availableStatuses.includes(statusFilter),
      ),
    [docsTree, statusFilter],
  );
  const groupedDocuments = useMemo(() => groupDocsByLayerAndDomain(filteredDocuments), [filteredDocuments]);
  const selectionSummary = useMemo(
    () => resolvePreferredSelection(docsTree, selectedLogicalPath, selectedStatus),
    [docsTree, selectedLogicalPath, selectedStatus],
  );
  const canCreateDrafts = repoPermission?.canEditDrafts ?? !authSession;
  const canDirectPublish = repoPermission?.canDirectPublish ?? false;
  const canEditSelectedVariant =
    (selectedVariant?.status === "draft" || selectedVariant?.status === "published") && canCreateDrafts;
  const selectedVariantIsDirty = selectedVariant ? editorBody !== selectedVariant.body : false;
  const layerSuggestions = useMemo(() => {
    const uniqueLayers = new Set<string>();
    for (const document of docsTree?.documents ?? []) {
      uniqueLayers.add(document.layer);
    }
    return [...uniqueLayers].sort((left, right) => left.localeCompare(right));
  }, [docsTree]);

  const loadAuthSession = useCallback(
    async (sessionId: string | null) => {
      if (!sessionId) {
        setAuthSession(null);
        setAuthError(null);
        return;
      }

      setAuthBusy(true);
      try {
        const response = await requestApi<AuthSessionResponse>(props.apiBaseUrl, "/api/auth/session", undefined, {
          authSessionId: sessionId,
        });
        if (!response.authenticated || !response.session) {
          persistAuthSessionId(props.apiBaseUrl, null);
          setAuthSessionId(null);
          setAuthSession(null);
          return;
        }

        setAuthSession(response.session);
        setAuthError(null);
      } catch (error) {
        persistAuthSessionId(props.apiBaseUrl, null);
        setAuthSessionId(null);
        setAuthSession(null);
        setAuthError(error instanceof Error ? error.message : "Could not load the saved Dacci session.");
      } finally {
        setAuthBusy(false);
      }
    },
    [props.apiBaseUrl],
  );

  const loadDocsTree = useCallback(
    async (preferredLogicalPath?: string | null, preferredStatus?: DocsStatus | null) => {
      setDocsBusy(true);
      try {
        const response = await requestApi<DocsTree>(props.apiBaseUrl, "/api/docs/tree", undefined, authContext);
        setDocsTree(response);
        setDocsError(null);
        setSelectedVariant(null);
        setEditorMode("view");
        const firstDocument = response.documents[0] ?? null;
        const nextSelection = resolvePreferredSelection(
          response,
          preferredLogicalPath ?? null,
          preferredStatus ?? null,
        );
        setSelectedLogicalPath(nextSelection.logicalPath);
        setSelectedStatus(nextSelection.status);
        setCreateForm((current) => ({
          ...current,
          layer: current.layer || firstDocument?.layer || "",
          domainPath: current.domainPath || firstDocument?.domainPath || "",
        }));
      } catch (error) {
        setDocsTree(null);
        setSelectedLogicalPath(null);
        setSelectedStatus(null);
        setSelectedVariant(null);
        setEditorBody("");

        if (error instanceof ApiRequestError && error.status === 401) {
          setDocsError("Sign in with GitHub to browse docs in this repository.");
          return;
        }

        setDocsError(error instanceof Error ? error.message : "Could not load the docs workspace.");
      } finally {
        setDocsBusy(false);
      }
    },
    [authContext, props.apiBaseUrl],
  );

  const loadSelectedVariant = useCallback(async () => {
    if (!selectionSummary.logicalPath || !selectionSummary.status) {
      setSelectedVariant(null);
      setEditorBody("");
      return;
    }

    setDocsBusy(true);
    try {
      const query = new URLSearchParams({
        path: selectionSummary.logicalPath,
        status: selectionSummary.status,
      });
      const response = await requestApi<DocsDocumentVariant>(
        props.apiBaseUrl,
        `/api/docs/documents?${query.toString()}`,
        undefined,
        authContext,
      );
      setSelectedVariant(response);
      setEditorBody(response.body);
      setDocsError(null);
    } catch (error) {
      setSelectedVariant(null);
      setEditorBody("");
      setDocsError(error instanceof Error ? error.message : "Could not load the selected document.");
    } finally {
      setDocsBusy(false);
    }
  }, [authContext, props.apiBaseUrl, selectionSummary.logicalPath, selectionSummary.status]);

  const handleStartDeviceFlow = useCallback(() => {
    void (async () => {
      setAuthBusy(true);
      setAuthError(null);
      setAuthInfoMessage(null);
      try {
        const response = await requestApi<GitHubDeviceAuthorizationStartResponse>(
          props.apiBaseUrl,
          "/api/auth/github/device/start",
          {
            method: "POST",
          },
        );
        setDeviceAuthStart(response);
        setAuthInfoMessage("Open the GitHub link below and enter the device code to finish sign-in.");
      } catch (error) {
        setDeviceAuthStart(null);
        setAuthError(error instanceof Error ? error.message : "Could not start GitHub device authorization.");
      } finally {
        setAuthBusy(false);
      }
    })();
  }, [props.apiBaseUrl]);

  const handleLogout = useCallback(() => {
    if (!authSessionId) {
      setAuthSession(null);
      return;
    }

    void (async () => {
      setAuthBusy(true);
      try {
        await requestApi<AuthSessionResponse>(
          props.apiBaseUrl,
          "/api/auth/session/logout",
          {
            method: "POST",
          },
          {
            authSessionId,
          },
        );
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "Could not end the Dacci session.");
      } finally {
        persistAuthSessionId(props.apiBaseUrl, null);
        setAuthSessionId(null);
        setAuthSession(null);
        setDeviceAuthStart(null);
        setAuthBusy(false);
      }
    })();
  }, [authSessionId, props.apiBaseUrl]);

  const handleCreateDraft = useCallback(() => {
    const payload: CreateDocsDraftInput = {
      layer: createForm.layer.trim(),
      domainPath: createForm.domainPath.trim(),
      name: createForm.name.trim(),
      body: createForm.body,
    };

    void (async () => {
      setDocsBusy(true);
      try {
        const response = await requestApi<DocsDocumentVariant>(
          props.apiBaseUrl,
          "/api/docs/documents",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          },
          authContext,
        );
        setDocsInfoMessage(`Created draft '${response.title ?? response.name}'.`);
        setCreateForm((current) => ({
          ...current,
          name: "",
          body: "",
        }));
        await loadDocsTree(response.logicalPath, response.status);
      } catch (error) {
        setDocsError(error instanceof Error ? error.message : "Could not create the draft.");
      } finally {
        setDocsBusy(false);
      }
    })();
  }, [authContext, createForm, loadDocsTree, props.apiBaseUrl]);

  const handleSaveVariant = useCallback(() => {
    if (!selectedVariant) {
      return;
    }

    void (async () => {
      setDocsBusy(true);
      try {
        const resource =
          selectedVariant.status === "draft"
            ? "/api/docs/documents/draft"
            : "/api/docs/documents/published";
        const payload: UpdateDocsDraftRequest | SavePublishedEditRequest = {
          logicalPath: selectedVariant.logicalPath,
          body: editorBody,
          expectedModifiedAt: selectedVariant.modifiedAt,
        };
        const response = await requestApi<DocsDocumentVariant>(
          props.apiBaseUrl,
          resource,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          },
          authContext,
        );
        setSelectedVariant(response);
        setSelectedLogicalPath(response.logicalPath);
        setSelectedStatus(response.status);
        setEditorBody(response.body);
        setEditorMode("view");
        setDocsInfoMessage(
          selectedVariant.status === "draft"
            ? `Saved draft '${response.title ?? response.name}'.`
            : `Saved a draft update for published document '${response.title ?? response.name}'.`,
        );
        await loadDocsTree(response.logicalPath, response.status);
      } catch (error) {
        setDocsError(error instanceof Error ? error.message : "Could not save the document.");
      } finally {
        setDocsBusy(false);
      }
    })();
  }, [authContext, editorBody, loadDocsTree, props.apiBaseUrl, selectedVariant]);

  const handlePublish = useCallback(() => {
    if (!selectedVariant) {
      return;
    }

    void (async () => {
      setDocsBusy(true);
      try {
        const payload: PublishDocsDraftRequest = {
          logicalPath: selectedVariant.logicalPath,
          expectedModifiedAt: selectedVariant.modifiedAt,
        };
        const response = await requestApi<DocsDocumentVariant>(
          props.apiBaseUrl,
          "/api/docs/documents/publish",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          },
          authContext,
        );
        setSelectedVariant(response);
        setSelectedLogicalPath(response.logicalPath);
        setSelectedStatus(response.status);
        setEditorBody(response.body);
        setEditorMode("view");
        setDocsInfoMessage(`Published '${response.title ?? response.name}'.`);
        await loadDocsTree(response.logicalPath, response.status);
      } catch (error) {
        setDocsError(error instanceof Error ? error.message : "Could not publish the draft.");
      } finally {
        setDocsBusy(false);
      }
    })();
  }, [authContext, loadDocsTree, props.apiBaseUrl, selectedVariant]);

  const handleArchive = useCallback(() => {
    if (!selectedVariant) {
      return;
    }

    const payload: ArchiveDocsDocumentRequest =
      selectedVariant.status === "archive"
        ? {
            logicalPath: selectedVariant.logicalPath,
          }
        : {
            logicalPath: selectedVariant.logicalPath,
            sourceStatus: selectedVariant.status,
            expectedModifiedAt: selectedVariant.modifiedAt,
          };

    void (async () => {
      setDocsBusy(true);
      try {
        const response = await requestApi<DocsDocumentVariant>(
          props.apiBaseUrl,
          "/api/docs/documents/archive",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          },
          authContext,
        );
        setSelectedVariant(response);
        setSelectedLogicalPath(response.logicalPath);
        setSelectedStatus(response.status);
        setEditorBody(response.body);
        setEditorMode("view");
        setDocsInfoMessage(`Archived '${response.title ?? response.name}'.`);
        await loadDocsTree(response.logicalPath, response.status);
      } catch (error) {
        setDocsError(error instanceof Error ? error.message : "Could not archive the document.");
      } finally {
        setDocsBusy(false);
      }
    })();
  }, [authContext, loadDocsTree, props.apiBaseUrl, selectedVariant]);

  const handleDeleteArchived = useCallback(() => {
    if (!selectedVariant) {
      return;
    }

    const payload: DeleteArchivedDocsDocumentRequest = {
      logicalPath: selectedVariant.logicalPath,
      expectedModifiedAt: selectedVariant.modifiedAt,
    };

    void (async () => {
      setDocsBusy(true);
      try {
        await requestApiNoContent(
          props.apiBaseUrl,
          "/api/docs/documents/archive",
          {
            method: "DELETE",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          },
          authContext,
        );
        setDocsInfoMessage(`Deleted archived document '${selectedVariant.title ?? selectedVariant.name}'.`);
        setSelectedVariant(null);
        setEditorBody("");
        setEditorMode("view");
        await loadDocsTree(null, null);
      } catch (error) {
        setDocsError(error instanceof Error ? error.message : "Could not delete the archived document.");
      } finally {
        setDocsBusy(false);
      }
    })();
  }, [authContext, loadDocsTree, props.apiBaseUrl, selectedVariant]);

  useEffect(() => {
    void loadAuthSession(authSessionId);
  }, [authSessionId, loadAuthSession]);

  useEffect(() => {
    void loadDocsTree(selectedLogicalPath, selectedStatus);
  }, [loadDocsTree, props.repoId]);

  useEffect(() => {
    void loadSelectedVariant();
  }, [loadSelectedVariant]);

  useEffect(() => {
    if (!deviceAuthStart) {
      return;
    }

    let cancelled = false;
    const expiresAt = Date.now() + deviceAuthStart.expiresInSeconds * 1000;
    let timeoutId: number | undefined;

    const pollAuthorization = async (deviceCode: string, delaySeconds: number) => {
      if (cancelled) {
        return;
      }

      timeoutId = window.setTimeout(async () => {
        if (cancelled) {
          return;
        }

        if (Date.now() >= expiresAt) {
          setDeviceAuthStart(null);
          setAuthError("The GitHub device code expired before sign-in completed.");
          setAuthInfoMessage(null);
          return;
        }

        try {
          const response = await requestApi<GitHubDeviceAuthorizationPollResponse>(
            props.apiBaseUrl,
            "/api/auth/github/device/poll",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify({
                deviceCode,
              }),
            },
          );

          if (response.status === "pending") {
            setAuthInfoMessage("Waiting for GitHub device authorization to finish.");
            await pollAuthorization(deviceCode, response.intervalSeconds);
            return;
          }

          persistAuthSessionId(props.apiBaseUrl, response.session.sessionId);
          setAuthSessionId(response.session.sessionId);
          setAuthSession(response.session);
          setDeviceAuthStart(null);
          setAuthError(null);
          setAuthInfoMessage(`Signed in as ${response.session.user.login}.`);
          await loadDocsTree(selectedLogicalPath, selectedStatus);
        } catch (error) {
          if (error instanceof ApiRequestError && error.code === "authorization_pending") {
            await pollAuthorization(deviceCode, deviceAuthStart.intervalSeconds);
            return;
          }

          setDeviceAuthStart(null);
          setAuthError(error instanceof Error ? error.message : "GitHub sign-in did not complete.");
          setAuthInfoMessage(null);
        }
      }, Math.max(1, delaySeconds) * 1000);
    };

    void pollAuthorization(deviceAuthStart.deviceCode, deviceAuthStart.intervalSeconds);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    deviceAuthStart,
    loadDocsTree,
    props.apiBaseUrl,
    selectedLogicalPath,
    selectedStatus,
  ]);

  return (
    <section className="panel multiuser-docs-card">
      <div className="panel-header">
        <div>
          <p className="eyebrow viewer-eyebrow">Multi-user beta</p>
          <h2>Status-first docs workspace</h2>
          <p className="muted">
            This repository uses the new GitHub auth and docs lifecycle APIs for <code>draft/</code>,{" "}
            <code>published/</code>, and <code>archive/</code> content.
          </p>
        </div>
        <div className="inline-actions docs-auth-actions">
          {authSession ? (
            <>
              <div className="docs-auth-summary">
                <strong>{authSession.user.displayName ?? authSession.user.login}</strong>
                <span className="muted">@{authSession.user.login}</span>
              </div>
              <button className="ghost-button" disabled={authBusy} onClick={handleLogout} type="button">
                Sign out
              </button>
            </>
          ) : (
            <button className="primary-button" disabled={authBusy} onClick={handleStartDeviceFlow} type="button">
              Sign in with GitHub
            </button>
          )}
        </div>
      </div>

      {authError ? <p className="notice error">{authError}</p> : null}
      {authInfoMessage ? <p className="notice success">{authInfoMessage}</p> : null}
      {docsError ? <p className="notice error">{docsError}</p> : null}
      {docsInfoMessage ? <p className="notice success">{docsInfoMessage}</p> : null}

      {deviceAuthStart ? (
        <section className="management-card device-auth-card">
          <div className="device-auth-header">
            <div>
              <h3>Finish GitHub device sign-in</h3>
              <p className="muted">
                Open GitHub, enter the code below, and Dacci will continue polling in the background.
              </p>
            </div>
            <a
              className="ghost-button"
              href={deviceAuthStart.verificationUriComplete ?? deviceAuthStart.verificationUri}
              rel="noreferrer"
              target="_blank"
            >
              Open GitHub
            </a>
          </div>
          <div className="device-auth-details">
            <div>
              <span className="muted">User code</span>
              <code className="device-auth-code">{deviceAuthStart.userCode}</code>
            </div>
            <div>
              <span className="muted">Expires in</span>
              <strong>{formatSeconds(deviceAuthStart.expiresInSeconds)}</strong>
            </div>
          </div>
        </section>
      ) : null}

      <div className="docs-workspace-grid">
        <section className="management-card">
          <div className="panel-header">
            <div>
              <h3>{props.repoLabel}</h3>
              <p className="muted">Browse logical documents and their available lifecycle variants.</p>
            </div>
            <button className="ghost-button" disabled={docsBusy} onClick={() => void loadDocsTree(selectedLogicalPath, selectedStatus)} type="button">
              Refresh
            </button>
          </div>

          <div className="docs-permission-row">
            {authSession ? (
              repoPermission ? (
                <>
                  <span className="permission-pill">{repoPermission.canEditDrafts ? "Draft edits allowed" : "Read only"}</span>
                  <span className="permission-pill">{repoPermission.canDirectPublish ? "Direct publish allowed" : "Publish via review"}</span>
                  {repoPermission.roles.map((role) => (
                    <span className="status-chip" key={role}>
                      {role}
                    </span>
                  ))}
                </>
              ) : (
                <span className="muted">This session has no explicit permission summary for the active repository.</span>
              )
            ) : (
              <span className="muted">Anonymous access works only when the runtime leaves docs routes open.</span>
            )}
          </div>

          <div className="docs-filter-row">
            <span className="muted">Status filter</span>
            <div className="inline-actions">
              <button
                className={statusFilter === "all" ? "toggle-button tone-bright" : "toggle-button tone-neutral"}
                onClick={() => setStatusFilter("all")}
                type="button"
              >
                all
              </button>
              {docsStatuses.map((status) => (
                <button
                  className={statusFilter === status ? "toggle-button tone-bright" : "toggle-button tone-neutral"}
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  type="button"
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          <div className="docs-browser-list">
            {groupedDocuments.length > 0 ? (
              groupedDocuments.map((layerGroup) => (
                <section className="docs-layer-group" key={layerGroup.layer}>
                  <div className="docs-group-heading">
                    <h4>{layerGroup.layer}</h4>
                    <span className="muted">{layerGroup.documents.length} docs</span>
                  </div>
                  {layerGroup.domains.map((domainGroup) => (
                    <div className="docs-domain-group" key={`${layerGroup.layer}:${domainGroup.domainPath}`}>
                      <p className="muted docs-domain-label">{domainGroup.domainPath || "root"}</p>
                      {domainGroup.documents.map((document) => (
                        <article className="docs-logical-document-card" key={document.id}>
                          <div>
                            <strong>{document.title ?? document.name}</strong>
                            <p className="muted">{document.logicalPath}</p>
                            {document.tags.length > 0 ? (
                              <div className="document-tag-row">
                                {document.tags.map((tag) => (
                                  <span className="document-tag-pill" key={tag}>
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="inline-actions docs-status-actions">
                            {document.availableStatuses.map((status) => {
                              const selected =
                                (selectedLogicalPath === document.logicalPath && selectedStatus === status) ||
                                (selectionSummary.logicalPath === document.logicalPath && selectionSummary.status === status);
                              return (
                                <button
                                  className={selected ? "toggle-button tone-bright" : "toggle-button tone-neutral"}
                                  key={status}
                                  onClick={() => {
                                    setSelectedLogicalPath(document.logicalPath);
                                    setSelectedStatus(status);
                                    setEditorMode("view");
                                    setDocsInfoMessage(null);
                                  }}
                                  type="button"
                                >
                                  {status}
                                </button>
                              );
                            })}
                          </div>
                        </article>
                      ))}
                    </div>
                  ))}
                </section>
              ))
            ) : (
              <p className="muted">
                {docsBusy
                  ? "Loading docs workspace."
                  : "No logical documents are available for the current filter yet."}
              </p>
            )}
          </div>

          <section className="docs-create-draft-card">
            <h3>Create draft</h3>
            <div className="form-grid two-column-grid">
              <label>
                <span>Layer</span>
                <input
                  list="docs-layer-suggestions"
                  onChange={(event) => setCreateForm((current) => ({ ...current, layer: event.target.value }))}
                  value={createForm.layer}
                />
                <datalist id="docs-layer-suggestions">
                  {layerSuggestions.map((layer) => (
                    <option key={layer} value={layer} />
                  ))}
                </datalist>
              </label>
              <label>
                <span>Domain path</span>
                <input
                  onChange={(event) => setCreateForm((current) => ({ ...current, domainPath: event.target.value }))}
                  placeholder="guides/getting-started"
                  value={createForm.domainPath}
                />
              </label>
              <label>
                <span>Name</span>
                <input
                  onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="introducing-dacci"
                  value={createForm.name}
                />
              </label>
            </div>
            <label className="docs-editor-field">
              <span>Markdown</span>
              <textarea
                className="document-editor docs-editor-textarea"
                onChange={(event) => setCreateForm((current) => ({ ...current, body: event.target.value }))}
                placeholder={"---\ntitle: Introducing Dacci\ntags:\n  - docs\n---\n\nWrite the first draft here."}
                value={createForm.body}
              />
            </label>
            <div className="inline-actions">
              <button
                className="primary-button"
                disabled={
                  docsBusy ||
                  !canCreateDrafts ||
                  !createForm.layer.trim() ||
                  !createForm.domainPath.trim() ||
                  !createForm.name.trim()
                }
                onClick={handleCreateDraft}
                type="button"
              >
                Create draft
              </button>
            </div>
          </section>
        </section>

        <section className="management-card">
          {selectedVariant ? (
            <>
              <div className="panel-header">
                <div>
                  <h3>{selectedVariant.title ?? selectedVariant.name}</h3>
                  <p className="muted">
                    {selectedVariant.status} variant for <code>{selectedVariant.logicalPath}</code>
                  </p>
                </div>
                <div className="inline-actions">
                  {canEditSelectedVariant ? (
                    <button
                      className={editorMode === "edit" ? "toggle-button tone-bright" : "toggle-button tone-neutral"}
                      onClick={() => setEditorMode((current) => (current === "view" ? "edit" : "view"))}
                      type="button"
                    >
                      {editorMode === "view" ? "Edit" : "Preview"}
                    </button>
                  ) : null}
                  {selectedVariant.status === "draft" && canDirectPublish ? (
                    <button className="primary-button" disabled={docsBusy} onClick={handlePublish} type="button">
                      Publish
                    </button>
                  ) : null}
                  {selectedVariant.status !== "archive" && canDirectPublish ? (
                    <button className="ghost-button" disabled={docsBusy} onClick={handleArchive} type="button">
                      Archive
                    </button>
                  ) : null}
                  {selectedVariant.status === "archive" && canDirectPublish ? (
                    <button className="ghost-button danger" disabled={docsBusy} onClick={handleDeleteArchived} type="button">
                      Delete archive
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="docs-metadata-grid">
                <div>
                  <span className="muted">Layer</span>
                  <strong>{selectedVariant.layer}</strong>
                </div>
                <div>
                  <span className="muted">Domain</span>
                  <strong>{selectedVariant.domainPath || "root"}</strong>
                </div>
                <div>
                  <span className="muted">Modified</span>
                  <strong>{formatTimestamp(selectedVariant.modifiedAt)}</strong>
                </div>
                <div>
                  <span className="muted">Repo path</span>
                  <strong>{selectedVariant.repoPath}</strong>
                </div>
              </div>

              {selectedVariant.tags.length > 0 ? (
                <div className="document-tag-row">
                  {selectedVariant.tags.map((tag) => (
                    <span className="document-tag-pill" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}

              {editorMode === "edit" && canEditSelectedVariant ? (
                <>
                  <DocumentEditor disabled={docsBusy} onChange={setEditorBody} value={editorBody} />
                  <div className="inline-actions docs-editor-actions">
                    <button
                      className="primary-button"
                      disabled={docsBusy || !selectedVariantIsDirty}
                      onClick={handleSaveVariant}
                      type="button"
                    >
                      {selectedVariant.status === "published" ? "Save as draft update" : "Save draft"}
                    </button>
                    <button
                      className="ghost-button"
                      disabled={docsBusy}
                      onClick={() => {
                        setEditorBody(selectedVariant.body);
                        setEditorMode("view");
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <MarkdownViewer markdown={editorBody} showFrontMatter themeName={props.themeName} />
              )}
            </>
          ) : (
            <div className="empty-viewer-state">
              <p className="eyebrow viewer-eyebrow">Docs workspace</p>
              <h3>Select a document variant</h3>
              <p className="muted">
                Pick a logical document and lifecycle state to preview or edit it.
              </p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

type DocsDomainGroup = {
  domainPath: string;
  documents: DocsLogicalDocumentSummary[];
};

type DocsLayerGroup = {
  layer: string;
  documents: DocsLogicalDocumentSummary[];
  domains: DocsDomainGroup[];
};

function groupDocsByLayerAndDomain(documents: DocsLogicalDocumentSummary[]): DocsLayerGroup[] {
  const layerMap = new Map<string, Map<string, DocsLogicalDocumentSummary[]>>();

  for (const document of documents) {
    const layerEntry = layerMap.get(document.layer) ?? new Map<string, DocsLogicalDocumentSummary[]>();
    const domainKey = document.domainPath || "";
    const domainDocuments = layerEntry.get(domainKey) ?? [];
    domainDocuments.push(document);
    layerEntry.set(domainKey, domainDocuments);
    layerMap.set(document.layer, layerEntry);
  }

  return [...layerMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([layer, domainMap]) => {
      const domains = [...domainMap.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([domainPath, layerDocuments]) => ({
          domainPath,
          documents: [...layerDocuments].sort(compareLogicalDocuments),
        }));
      return {
        layer,
        documents: domains.flatMap((domain) => domain.documents),
        domains,
      };
    });
}

function compareLogicalDocuments(left: DocsLogicalDocumentSummary, right: DocsLogicalDocumentSummary): number {
  return (left.title ?? left.name).localeCompare(right.title ?? right.name);
}

function resolvePreferredSelection(
  tree: DocsTree | null,
  preferredLogicalPath: string | null,
  preferredStatus: DocsStatus | null,
): { logicalPath: string | null; status: DocsStatus | null } {
  if (!tree || tree.documents.length === 0) {
    return { logicalPath: null, status: null };
  }

  const preferredDocument = preferredLogicalPath
    ? tree.documents.find((document) => document.logicalPath === preferredLogicalPath) ?? null
    : null;
  if (preferredDocument) {
    return {
      logicalPath: preferredDocument.logicalPath,
      status:
        preferredStatus && preferredDocument.availableStatuses.includes(preferredStatus)
          ? preferredStatus
          : preferredDocument.availableStatuses[0] ?? null,
    };
  }

  const fallbackDocument = tree.documents[0] ?? null;
  if (!fallbackDocument) {
    return { logicalPath: null, status: null };
  }

  return {
    logicalPath: fallbackDocument.logicalPath,
    status: fallbackDocument.availableStatuses[0] ?? null,
  };
}

function buildAuthSessionStorageKey(apiBaseUrl: string): string {
  return `${authSessionStorageKeyPrefix}:${apiBaseUrl}`;
}

function readPersistedAuthSessionId(apiBaseUrl: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const value = window.localStorage.getItem(buildAuthSessionStorageKey(apiBaseUrl));
    return value?.trim() ? value : null;
  } catch (error) {
    console.warn("Failed to read the saved Dacci auth session.", error);
    return null;
  }
}

function persistAuthSessionId(apiBaseUrl: string, sessionId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const storageKey = buildAuthSessionStorageKey(apiBaseUrl);
    if (sessionId?.trim()) {
      window.localStorage.setItem(storageKey, sessionId);
      return;
    }

    window.localStorage.removeItem(storageKey);
  } catch (error) {
    console.warn("Failed to persist the Dacci auth session.", error);
  }
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
