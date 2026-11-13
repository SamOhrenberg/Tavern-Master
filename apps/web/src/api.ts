import type { ApiError } from '@tavern/protocol';

/** An error response from the server, safe to show to the user. */
export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken = '';
let onUnauthorized: (() => void) | undefined;

export function setCsrfToken(token: string): void {
  csrfToken = token;
}
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
  /** Do not treat a 401 as "the session ended" (sign-in itself returns 401). */
  quiet401?: boolean;
}

/**
 * Call the JSON API. The session cookie is HttpOnly and sent by the browser;
 * the CSRF token from /auth/me is echoed on every state-changing request.
 */
export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body ?? {});
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiFailure(0, 'offline', 'Could not reach the server. Check your connection.');
  }
  if (res.ok) return (await res.json()) as T;

  let code = 'error';
  let message = `Request failed (${res.status})`;
  try {
    const json = (await res.json()) as ApiError;
    code = json.error.code;
    message = json.error.message;
  } catch {
    // non-JSON error body (e.g. from a proxy)
  }
  if (res.status === 401 && !opts.quiet401) onUnauthorized?.();
  throw new ApiFailure(res.status, code, message);
}

/**
 * POST and read the reply as it is written: one JSON value per line. Used for
 * the character guide, whose answer streams in like the DM's does.
 */
export async function apiStream<T>(path: string, body: unknown, onEvent: (event: T) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiFailure(0, 'offline', 'Could not reach the server. Check your connection.');
  }
  if (!res.ok || !res.body) {
    let code = 'error';
    let message = `Request failed (${res.status})`;
    try {
      const json = (await res.json()) as ApiError;
      code = json.error.code;
      message = json.error.message;
    } catch {
      // non-JSON error body
    }
    if (res.status === 401) onUnauthorized?.();
    throw new ApiFailure(res.status, code, message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (line: string) => {
    if (!line.trim()) return;
    try {
      onEvent(JSON.parse(line) as T);
    } catch {
      // a partial or foreign line; nothing to do with it
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      flush(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
    if (done) break;
  }
  flush(buffer);
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong.';
