import { config } from '../config.js';

/**
 * Discovery documents. The server is both the protected resource (the
 * connector) and its own authorization server, as the MCP authorization spec
 * describes, so a client given only the connector's address can sign in.
 */

export const SCOPE = 'dm';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The issuer: BASE_URL with no path. */
export function issuer(): string {
  return config().baseUrl.origin;
}

/** The connector address a resource string names, if it names one: /mcp or /mcp/c/<uuid>. */
export function parseResource(resource: string): { path: string; campaignId: string | null } | null {
  const base = issuer();
  if (!resource.startsWith(`${base}/`)) return null;
  const path = resource.slice(base.length);
  if (path === '/mcp') return { path, campaignId: null };
  const m = /^\/mcp\/c\/([^/]+)$/.exec(path);
  if (m && UUID.test(m[1]!)) return { path, campaignId: m[1]!.toLowerCase() };
  return null;
}

export const resourceFor = (path: string) => `${issuer()}${path}`;

export function protectedResourceMetadata(path: string) {
  return {
    resource: resourceFor(path),
    authorization_servers: [issuer()],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'Tavern Master',
  };
}

export function authorizationServerMetadata() {
  const base = issuer();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

/** The WWW-Authenticate header a 401 from a connector address carries. */
export function challengeHeader(path: string): string {
  return `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource${path}", scope="${SCOPE}"`;
}
