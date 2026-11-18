import type { Config } from '../config.js';

/**
 * Security headers are set by the app on every response so they do not depend
 * on how the reverse proxy in front happens to be configured.
 */
export function securityHeaders(cfg: Pick<Config, 'baseUrl' | 'cookieSecure'>): Record<string, string> {
  const wsScheme = cfg.baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    // blob: shows a picture chosen on the device (a portrait being cropped) before it is uploaded.
    // Only this page's own scripts can make one, so it lets in nothing from elsewhere.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // 'self' does not cover websockets in every browser, so name them.
    `connect-src 'self' ${wsScheme}//${cfg.baseUrl.host}`,
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');

  const headers: Record<string, string> = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Permitted-Cross-Domain-Policies': 'none',
  };
  if (cfg.cookieSecure) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}
