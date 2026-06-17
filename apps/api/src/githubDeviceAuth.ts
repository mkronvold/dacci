import { randomUUID } from "node:crypto";

import type {
  AuthSessionSummary,
  AuthenticatedGitHubUser,
  GitHubDeviceAuthorizationStartResponse,
  RepoContextSummary,
  RepoPermissionRole,
  RepoPermissionSummary,
} from "@dacci/shared-types";

const githubDeviceCodeUrl = "https://github.com/login/device/code";
const githubDeviceAccessTokenUrl = "https://github.com/login/oauth/access_token";
const githubApiBaseUrl = "https://api.github.com";
const defaultGitHubScopes = ["repo", "read:org"];

export type GitHubTeamMembership = {
  org: string;
  slug: string;
};

export type GitHubTeamRoleBinding = {
  org: string;
  teamSlug: string;
  repoIds?: string[];
  roles: RepoPermissionRole[];
};

export type RepoRoleOverride = {
  repoId: string;
  login: string;
  roles: RepoPermissionRole[];
  reason?: string;
};

export type GitHubDeviceAuthorizationResult =
  | {
      status: "pending";
      intervalSeconds: number;
    }
  | {
      status: "authorized";
      accessToken: string;
    };

export interface GitHubDeviceAuthProvider {
  startDeviceAuthorization(): Promise<GitHubDeviceAuthorizationStartResponse>;
  pollDeviceAuthorization(deviceCode: string): Promise<GitHubDeviceAuthorizationResult>;
  getAuthenticatedUser(accessToken: string): Promise<AuthenticatedGitHubUser>;
  getTeamMemberships(accessToken: string): Promise<GitHubTeamMembership[]>;
}

export interface GitHubDeviceAuthProviderOptions {
  clientId: string;
  scopes?: string[];
}

type StoredAuthSession = {
  sessionId: string;
  user: AuthenticatedGitHubUser;
  permissions: RepoPermissionSummary[];
  accessToken: string;
  teams: GitHubTeamMembership[];
  createdAt: string;
};

export class GitHubDeviceAuthError extends Error {
  public constructor(
    public readonly code: "invalid_configuration" | "authorization_pending" | "authorization_denied" | "upstream_error",
    message: string,
  ) {
    super(message);
    this.name = "GitHubDeviceAuthError";
  }
}

export function isGitHubDeviceAuthError(error: unknown): error is GitHubDeviceAuthError {
  return error instanceof GitHubDeviceAuthError;
}

export function createDefaultGitHubDeviceAuthProvider(
  options: GitHubDeviceAuthProviderOptions,
): GitHubDeviceAuthProvider {
  const clientId = options.clientId.trim();
  if (!clientId) {
    throw new GitHubDeviceAuthError(
      "invalid_configuration",
      "GitHub device auth requires a non-empty client id.",
    );
  }

  const scopes = (options.scopes ?? defaultGitHubScopes).join(" ");

  return {
    async startDeviceAuthorization() {
      const response = await fetch(githubDeviceCodeUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          scope: scopes,
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new GitHubDeviceAuthError(
          "upstream_error",
          readGitHubErrorMessage(payload, "GitHub device authorization could not be started."),
        );
      }

      const deviceCode = requireString(payload.device_code, "GitHub device_code");
      const userCode = requireString(payload.user_code, "GitHub user_code");
      const verificationUri = requireString(payload.verification_uri, "GitHub verification_uri");
      const expiresInSeconds = requireNumber(payload.expires_in, "GitHub expires_in");
      const intervalSeconds = requireNumber(payload.interval, "GitHub interval");
      const verificationUriComplete =
        typeof payload.verification_uri_complete === "string" && payload.verification_uri_complete.trim()
          ? payload.verification_uri_complete.trim()
          : undefined;

      return verificationUriComplete
        ? {
            deviceCode,
            userCode,
            verificationUri,
            verificationUriComplete,
            expiresInSeconds,
            intervalSeconds,
          }
        : {
            deviceCode,
            userCode,
            verificationUri,
            expiresInSeconds,
            intervalSeconds,
          };
    },

    async pollDeviceAuthorization(deviceCode: string) {
      const response = await fetch(githubDeviceAccessTokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode.trim(),
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new GitHubDeviceAuthError(
          "upstream_error",
          readGitHubErrorMessage(payload, "GitHub device authorization polling failed."),
        );
      }

      if (payload.error === "authorization_pending" || payload.error === "slow_down") {
        return {
          status: "pending",
          intervalSeconds: requireNumber(payload.interval, "GitHub interval"),
        } satisfies GitHubDeviceAuthorizationResult;
      }

      if (payload.error === "expired_token" || payload.error === "access_denied") {
        throw new GitHubDeviceAuthError(
          "authorization_denied",
          readGitHubErrorMessage(payload, "GitHub device authorization was denied or expired."),
        );
      }

      const accessToken = requireString(payload.access_token, "GitHub access_token");
      return {
        status: "authorized",
        accessToken,
      } satisfies GitHubDeviceAuthorizationResult;
    },

    async getAuthenticatedUser(accessToken: string) {
      const response = await fetch(`${githubApiBaseUrl}/user`, {
        headers: buildGitHubApiHeaders(accessToken),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new GitHubDeviceAuthError(
          "upstream_error",
          readGitHubErrorMessage(payload, "GitHub user lookup failed."),
        );
      }

      const id = requireNumber(payload.id, "GitHub user id");
      const login = requireString(payload.login, "GitHub login");
      const displayName = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined;
      const avatarUrl =
        typeof payload.avatar_url === "string" && payload.avatar_url.trim() ? payload.avatar_url.trim() : undefined;

      return {
        id,
        login,
        ...(displayName ? { displayName } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      };
    },

    async getTeamMemberships(accessToken: string) {
      const teams: GitHubTeamMembership[] = [];
      let nextUrl: string | null = `${githubApiBaseUrl}/user/teams?per_page=100`;

      while (nextUrl) {
        const response = await fetch(nextUrl, {
          headers: buildGitHubApiHeaders(accessToken),
        });
        const payload = (await response.json()) as unknown;
        if (!response.ok) {
          throw new GitHubDeviceAuthError(
            "upstream_error",
            readGitHubErrorMessage(
              payload as Record<string, unknown>,
              "GitHub team membership lookup failed.",
            ),
          );
        }

        if (!Array.isArray(payload)) {
          throw new GitHubDeviceAuthError(
            "upstream_error",
            "GitHub team membership lookup returned an unexpected payload.",
          );
        }

        for (const entry of payload) {
          if (!entry || typeof entry !== "object") {
            continue;
          }

          const candidate = entry as Record<string, unknown>;
          const slug = typeof candidate.slug === "string" && candidate.slug.trim() ? candidate.slug.trim() : null;
          const organization = candidate.organization;
          const orgLogin =
            organization && typeof organization === "object" && typeof (organization as Record<string, unknown>).login === "string"
              ? ((organization as Record<string, unknown>).login as string).trim()
              : null;
          if (slug && orgLogin) {
            teams.push({
              org: orgLogin,
              slug,
            });
          }
        }

        nextUrl = parseGitHubNextLink(response.headers.get("link"));
      }

      return teams;
    },
  };
}

export class GitHubDeviceSessionStore {
  private readonly sessions = new Map<string, StoredAuthSession>();

  public createSession(input: {
    user: AuthenticatedGitHubUser;
    permissions: RepoPermissionSummary[];
    accessToken: string;
    teams: GitHubTeamMembership[];
  }): AuthSessionSummary {
    const sessionId = randomUUID();
    const session: StoredAuthSession = {
      sessionId,
      user: input.user,
      permissions: input.permissions,
      accessToken: input.accessToken,
      teams: input.teams,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);
    return this.toSessionSummary(session);
  }

  public readSession(sessionId: string | undefined): AuthSessionSummary | null {
    if (!sessionId?.trim()) {
      return null;
    }

    const session = this.sessions.get(sessionId.trim());
    return session ? this.toSessionSummary(session) : null;
  }

  public deleteSession(sessionId: string | undefined): void {
    if (!sessionId?.trim()) {
      return;
    }

    this.sessions.delete(sessionId.trim());
  }

  private toSessionSummary(session: StoredAuthSession): AuthSessionSummary {
    return {
      sessionId: session.sessionId,
      user: session.user,
      permissions: session.permissions,
    };
  }
}

export class GitHubRepoPermissionEvaluator {
  private readonly teamBindings: GitHubTeamRoleBinding[];
  private readonly repoOverrides: RepoRoleOverride[];

  public constructor(input?: {
    teamBindings?: GitHubTeamRoleBinding[];
    repoOverrides?: RepoRoleOverride[];
  }) {
    this.teamBindings = input?.teamBindings ?? [];
    this.repoOverrides = input?.repoOverrides ?? [];
  }

  public evaluatePermissions(
    user: AuthenticatedGitHubUser,
    teams: GitHubTeamMembership[],
    repos: RepoContextSummary[],
  ): RepoPermissionSummary[] {
    return repos
      .map((repo) => this.evaluateRepoPermissions(user, teams, repo))
      .sort((left, right) => left.repoName.localeCompare(right.repoName));
  }

  private evaluateRepoPermissions(
    user: AuthenticatedGitHubUser,
    teams: GitHubTeamMembership[],
    repo: RepoContextSummary,
  ): RepoPermissionSummary {
    const roles = new Set<RepoPermissionRole>(["viewer", "editor"]);
    const sourceTeams: string[] = [];
    let sourceOverride: string | undefined;

    for (const binding of this.teamBindings) {
      if (binding.repoIds && !binding.repoIds.includes(repo.id)) {
        continue;
      }

      const matchedTeam = teams.find(
        (team) => team.org.toLowerCase() === binding.org.toLowerCase() && team.slug.toLowerCase() === binding.teamSlug.toLowerCase(),
      );
      if (!matchedTeam) {
        continue;
      }

      for (const role of binding.roles) {
        roles.add(role);
      }
      sourceTeams.push(`${matchedTeam.org}/${matchedTeam.slug}`);
    }

    for (const override of this.repoOverrides) {
      if (override.repoId !== repo.id || override.login.toLowerCase() !== user.login.toLowerCase()) {
        continue;
      }

      for (const role of override.roles) {
        roles.add(role);
      }
      sourceOverride = override.reason ?? `override:${override.repoId}`;
    }

    const sortedRoles = [...roles].sort(compareRepoPermissionRoles);
    return {
      repoId: repo.id,
      repoName: repo.name,
      roles: sortedRoles,
      canEditDrafts: true,
      canManage: roles.has("manage"),
      canDirectPublish: roles.has("manage") || roles.has("direct-publish"),
      sourceTeams: [...new Set(sourceTeams)].sort(),
      ...(sourceOverride ? { sourceOverride } : {}),
    };
  }
}

export function parseGitHubTeamRoleBindings(configuredValue?: string): GitHubTeamRoleBinding[] {
  const parsedValue = parseJsonArray(configuredValue, "DACCI_GITHUB_TEAM_ROLE_BINDINGS");
  return parsedValue.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new GitHubDeviceAuthError(
        "invalid_configuration",
        "DACCI_GITHUB_TEAM_ROLE_BINDINGS entries must be objects.",
      );
    }

    const candidate = entry as Record<string, unknown>;
    const org = requireConfiguredString(candidate.org, "DACCI_GITHUB_TEAM_ROLE_BINDINGS org");
    const teamSlug = requireConfiguredString(candidate.teamSlug, "DACCI_GITHUB_TEAM_ROLE_BINDINGS teamSlug");
    const roles = normalizeRepoPermissionRoles(candidate.roles, "DACCI_GITHUB_TEAM_ROLE_BINDINGS roles");
    const repoIds =
      Array.isArray(candidate.repoIds) && candidate.repoIds.every((value) => typeof value === "string" && value.trim())
        ? candidate.repoIds.map((value) => value.trim())
        : undefined;

    return repoIds ? { org, teamSlug, repoIds, roles } : { org, teamSlug, roles };
  });
}

export function parseRepoRoleOverrides(configuredValue?: string): RepoRoleOverride[] {
  const parsedValue = parseJsonArray(configuredValue, "DACCI_GITHUB_REPO_ROLE_OVERRIDES");
  return parsedValue.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new GitHubDeviceAuthError(
        "invalid_configuration",
        "DACCI_GITHUB_REPO_ROLE_OVERRIDES entries must be objects.",
      );
    }

    const candidate = entry as Record<string, unknown>;
    const repoId = requireConfiguredString(candidate.repoId, "DACCI_GITHUB_REPO_ROLE_OVERRIDES repoId");
    const login = requireConfiguredString(candidate.login, "DACCI_GITHUB_REPO_ROLE_OVERRIDES login");
    const roles = normalizeRepoPermissionRoles(candidate.roles, "DACCI_GITHUB_REPO_ROLE_OVERRIDES roles");
    const reason =
      typeof candidate.reason === "string" && candidate.reason.trim() ? candidate.reason.trim() : undefined;
    return reason ? { repoId, login, roles, reason } : { repoId, login, roles };
  });
}

function buildGitHubApiHeaders(accessToken: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "dacci-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function parseGitHubNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const entry of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(entry.trim());
    if (match?.[1] && match[2] === "next") {
      return match[1];
    }
  }

  return null;
}

function readGitHubErrorMessage(payload: Record<string, unknown>, fallbackMessage: string): string {
  const message = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : null;
  const description =
    typeof payload.error_description === "string" && payload.error_description.trim()
      ? payload.error_description.trim()
      : null;
  return description ?? message ?? fallbackMessage;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GitHubDeviceAuthError("upstream_error", `${label} is missing from the GitHub response.`);
  }

  return value.trim();
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GitHubDeviceAuthError("upstream_error", `${label} is missing from the GitHub response.`);
  }

  return value;
}

function compareRepoPermissionRoles(left: RepoPermissionRole, right: RepoPermissionRole): number {
  const order: RepoPermissionRole[] = ["viewer", "editor", "manage", "direct-publish"];
  return order.indexOf(left) - order.indexOf(right);
}

function parseJsonArray(configuredValue: string | undefined, label: string): unknown[] {
  const normalizedValue = configuredValue?.trim();
  if (!normalizedValue) {
    return [];
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(normalizedValue);
  } catch {
    throw new GitHubDeviceAuthError("invalid_configuration", `${label} must be valid JSON.`);
  }

  if (!Array.isArray(parsedValue)) {
    throw new GitHubDeviceAuthError("invalid_configuration", `${label} must be a JSON array.`);
  }

  return parsedValue;
}

function requireConfiguredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GitHubDeviceAuthError("invalid_configuration", `${label} must be a non-empty string.`);
  }

  return value.trim();
}

function normalizeRepoPermissionRoles(value: unknown, label: string): RepoPermissionRole[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GitHubDeviceAuthError("invalid_configuration", `${label} must be a non-empty string array.`);
  }

  const roles = value.map((entry) => {
    if (entry !== "viewer" && entry !== "editor" && entry !== "manage" && entry !== "direct-publish") {
      throw new GitHubDeviceAuthError(
        "invalid_configuration",
        `${label} contains an unsupported repo role '${String(entry)}'.`,
      );
    }

    return entry;
  });

  return [...new Set(roles)];
}
