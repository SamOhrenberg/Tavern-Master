import { pino, type Logger, type LoggerOptions } from 'pino';
import { config } from './config.js';

// Anything that may carry a credential is removed before a line is written.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.apiKey',
  '*.api_key',
  '*.key',
  '*.token',
  '*.secret',
  '*.code',
];

// Belt and braces: scrub provider-key-shaped strings from free text too.
const KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}|\b(ABSK[A-Za-z0-9+/=]{6})[A-Za-z0-9+/=]{10,}/g;
export function scrub(text: string): string {
  return text.replace(KEY_PATTERN, (_m, a?: string, b?: string) => `${a ?? b}…[redacted]`);
}

export function loggerOptions(): LoggerOptions {
  return {
    level: config().LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label) => ({ level: label }) },
    hooks: {
      logMethod(args, method) {
        for (let i = 0; i < args.length; i++) {
          if (typeof args[i] === 'string') args[i] = scrub(args[i] as string);
        }
        method.apply(this, args as Parameters<typeof method>);
      },
    },
    serializers: {
      err(err: Error & { status?: number; code?: string }) {
        return {
          type: err.name,
          message: scrub(err.message ?? ''),
          code: err.code,
          status: err.status,
          stack: err.stack,
        };
      },
    },
  };
}

let root: Logger | undefined;
export function log(): Logger {
  root ??= pino(loggerOptions());
  return root;
}
