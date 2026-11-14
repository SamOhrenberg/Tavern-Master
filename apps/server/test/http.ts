import type { FastifyInstance, InjectOptions } from 'fastify';
import { createSession, csrfToken, resolveSession, SESSION_COOKIE } from '../src/auth/sessions.js';

export interface Reply<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
  raw: string;
}

type Body = Record<string, unknown> & { error?: { code: string; message: string } };

/**
 * Requests to the app as a signed-in user, with the session cookie and the
 * CSRF header the browser would send.
 */
export async function signedIn(app: FastifyInstance, userId: string) {
  const token = await createSession(userId, '127.0.0.1', 'vitest');
  const session = (await resolveSession(token))!;
  const csrf = csrfToken(session.sessionId);
  const send = async <T = Body>(
    method: InjectOptions['method'],
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
    raw?: Buffer,
  ): Promise<Reply<T>> => {
    const res = await app.inject({
      method,
      url,
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        'x-csrf-token': csrf,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(raw ? { payload: raw } : payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = undefined;
    }
    return { status: res.statusCode, body: body as T, headers: res.headers, raw: res.body };
  };
  return {
    get: <T = Body>(url: string) => send<T>('GET', url),
    post: <T = Body>(url: string, payload: unknown = {}) => send<T>('POST', url, payload),
    patch: <T = Body>(url: string, payload: unknown) => send<T>('PATCH', url, payload),
    put: <T = Body>(url: string, payload: unknown) => send<T>('PUT', url, payload),
    del: <T = Body>(url: string) => send<T>('DELETE', url),
    send,
    token,
    csrf,
  };
}

export type SignedIn = Awaited<ReturnType<typeof signedIn>>;

interface ToolResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}

/** An MCP client on the connector, with a bearer token, at `/mcp` or a pinned address. */
export function mcpClient(app: FastifyInstance, bearer: string, path = '/mcp') {
  const rpc = async (method: string, params: unknown, token = bearer) => {
    const res = await app.inject({
      method: 'POST',
      url: path,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method, params },
    });
    let body: { result?: unknown; error?: { message: string } };
    try {
      body = res.json();
    } catch {
      body = {};
    }
    return { status: res.statusCode, headers: res.headers, body };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { body } = await rpc('tools/call', { name, arguments: args });
    if (!body.result) throw new Error(`no result from ${name}: ${JSON.stringify(body)}`);
    const result = body.result as ToolResult;
    return {
      text: result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n'),
      images: result.content.filter((c) => c.type === 'image'),
      isError: !!result.isError,
    };
  };
  return { rpc, call };
}
