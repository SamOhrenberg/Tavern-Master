import type { ZodType } from 'zod';

/** An error that is safe to show to the client. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Sign in required', code = 'unauthorized') =>
  new HttpError(401, code, message);
export const forbidden = (message = 'Not allowed', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const tooMany = (retryAfterSeconds: number) =>
  new HttpError(429, 'rate_limited', 'Too many requests. Try again shortly.', { retryAfter: retryAfterSeconds });

/** Validate untrusted input at the API boundary. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const res = schema.safeParse(data);
  if (res.success) return res.data;
  const details = res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const first = details[0];
  throw badRequest(first ? `${first.path || 'input'}: ${first.message}` : 'Invalid input', 'validation_failed', details);
}
