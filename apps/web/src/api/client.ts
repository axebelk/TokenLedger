/**
 * Fetch wrapper: attaches the in-memory access token, parses problem+json,
 * and on 401 performs a single-flight refresh then retries once.
 * The access token never touches localStorage; the refresh token lives in an
 * httpOnly cookie scoped to /api/v1/auth.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let onSessionLost: () => void = () => {};

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setSessionLostHandler(handler: () => void): void {
  onSessionLost = handler;
}

export interface RefreshResult {
  accessToken: string;
  user: { id: string; email: string; name: string };
}

/** POST /auth/refresh using the cookie; returns the payload or null. */
export async function tryRefresh(): Promise<RefreshResult | null> {
  const res = await fetch("/api/v1/auth/refresh", { method: "POST", credentials: "include" });
  if (!res.ok) return null;
  const body = (await res.json()) as RefreshResult;
  accessToken = body.accessToken;
  return body;
}

async function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= tryRefresh()
    .then((r) => r !== null)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/** Fetches a file with auth (refreshing once on 401) and triggers a browser download. */
export async function downloadAuthed(url: string, filename: string, isRetry = false): Promise<void> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
  });
  if (res.status === 401 && !isRetry) {
    if (await refreshOnce()) return downloadAuthed(url, filename, true);
    onSessionLost();
    return;
  }
  if (!res.ok) throw new ApiError(res.status, "download_failed", `Download failed (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(objectUrl);
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
  isRetry = false,
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  if (res.status === 401 && !isRetry && !path.startsWith("/auth/")) {
    if (await refreshOnce()) return api<T>(path, options, true);
    onSessionLost();
  }

  if (!res.ok) {
    let problem: { title?: string; detail?: string; requestId?: string; errors?: { path: string; message: string }[] } = {};
    try {
      problem = (await res.json()) as typeof problem;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(
      res.status,
      problem.title ?? `http_${res.status}`,
      problem.detail ?? problem.title ?? `Request failed (${res.status})`,
      problem.requestId,
      problem.errors,
    );
  }
  return (await res.json()) as T;
}
