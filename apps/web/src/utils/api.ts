import { authSessionHeaderName, repoSelectionHeaderName } from "@dacci/shared-types";
import type { RepoSelection } from "@dacci/shared-types";

import { encodeRepoSelectionHeaderValue } from "./libraryRepos";

export class ApiRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface RequestContext {
  authSessionId?: string | null;
  repoSelection?: RepoSelection;
}

export function buildApiUnavailableMessage(apiBaseUrl: string, resource: string): string {
  return `Could not complete the browser request to the API at ${apiBaseUrl} while requesting '${resource}'. Confirm 'npm run dev' started the API, that port 3000 is available, and that the API allows this cross-origin request.`;
}

export function buildApiUrl(apiBaseUrl: string, resource: string): string {
  if (!apiBaseUrl) {
    return resource;
  }

  if (apiBaseUrl.endsWith("/") && resource.startsWith("/")) {
    return `${apiBaseUrl.slice(0, -1)}${resource}`;
  }

  if (!apiBaseUrl.endsWith("/") && !resource.startsWith("/")) {
    return `${apiBaseUrl}/${resource}`;
  }

  return `${apiBaseUrl}${resource}`;
}

export async function requestApi<T>(
  apiBaseUrl: string,
  resource: string,
  init?: RequestInit,
  context?: RequestContext,
): Promise<T> {
  try {
    const headers = buildRequestHeaders(init?.headers, context);
    const response = await fetch(buildApiUrl(apiBaseUrl, resource), {
      ...init,
      credentials: "include",
      headers,
    });
    return await parseJsonResponse<T>(response);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(buildApiUnavailableMessage(apiBaseUrl, resource));
    }

    throw error;
  }
}

export async function requestApiNoContent(
  apiBaseUrl: string,
  resource: string,
  init?: RequestInit,
  context?: RequestContext,
): Promise<void> {
  try {
    const headers = buildRequestHeaders(init?.headers, context);
    const response = await fetch(buildApiUrl(apiBaseUrl, resource), {
      ...init,
      credentials: "include",
      headers,
    });
    if (!response.ok) {
      await parseJsonResponse(response);
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(buildApiUnavailableMessage(apiBaseUrl, resource));
    }

    throw error;
  }
}

function buildRequestHeaders(headersInit: HeadersInit | undefined, context: RequestContext | undefined): Headers {
  const headers = new Headers(headersInit);
  if (context?.repoSelection) {
    headers.set(repoSelectionHeaderName, encodeRepoSelectionHeaderValue(context.repoSelection));
  }
  if (context?.authSessionId) {
    headers.set(authSessionHeaderName, context.authSessionId);
  }
  return headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let code: string | undefined;

    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (body.message) {
        message = body.message;
      }
      if (body.error) {
        code = body.error;
      }
    } catch {
      // Keep the generic message when the body is not JSON.
    }

    throw new ApiRequestError(message, response.status, code);
  }

  return (await response.json()) as T;
}
