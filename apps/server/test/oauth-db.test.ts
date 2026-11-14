import type { ConnectRequest } from '@tavern/protocol';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { createToken } from '../src/connector/tokens.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { mcpClient, signedIn, type SignedIn } from './http.js';

const BASE = 'http://localhost:8080';
const CALLBACK = 'http://localhost:53682/callback';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

// Signing in to the connector instead of pasting a token (MCP authorization, OAuth 2.1 with PKCE).
describe.skipIf(!process.env.TEST_DATABASE_URL)('connector sign-in (database)', () => {
  const tag = `o${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let host = '';
  let eve = '';
  let campA = '';
  let campB = '';
  let asHost: SignedIn;
  let asEve: SignedIn;

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;
  const campaign = async (owner: string, name: string) => {
    const id = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, settings) VALUES ($1, $2, $3, '{"dm": "claude"}') RETURNING id`,
      [system, owner, name],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      id,
      owner,
    ]);
    return id;
  };

  const form = (body: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(body).toString(),
    });

  const register = async (redirect_uris: string[], client_name = 'Claude') =>
    app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name, redirect_uris } });

  /** Register, authorize and approve; returns the code and what is needed to exchange it. */
  const signIn = async (resource?: string, as = asHost) => {
    const client = (await register([CALLBACK])).json() as { client_id: string };
    const { verifier, challenge } = pkce();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st4te',
      ...(resource ? { resource } : {}),
    });
    const auth = await app.inject({ method: 'GET', url: `/oauth/authorize?${params}` });
    expect(auth.statusCode).toBe(302);
    const request = /\/connect\?request=([0-9a-f-]{36})/.exec(String(auth.headers.location))![1]!;
    const approved = await as.post<{ redirect: string }>(`/api/oauth/requests/${request}/approve`);
    const back = new URL(approved.body.redirect);
    return { clientId: client.client_id, verifier, code: back.searchParams.get('code')!, back, request };
  };

  const exchange = async (s: Awaited<ReturnType<typeof signIn>>, extra: Record<string, string> = {}) =>
    form({
      grant_type: 'authorization_code',
      code: s.code,
      code_verifier: s.verifier,
      client_id: s.clientId,
      redirect_uri: CALLBACK,
      ...extra,
    });

  beforeAll(async () => {
    setConfigForTests(
      testConfig({
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        BASE_URL: BASE,
        RATE_LIMIT_AUTH_PER_15M: '1000',
      }),
    );
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    eve = await user('Eve');
    campA = await campaign(host, `Alpha ${tag}`);
    campB = await campaign(host, `Beta ${tag}`);
    app = await buildApp();
    asHost = await signedIn(app, host);
    asEve = await signedIn(app, eve);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [[campA, campB]]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  it('publishes both discovery documents, and points a tokenless call at them', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    expect(res.json()).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
      scopes_supported: ['dm'],
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const pinned = await app.inject({
      method: 'GET',
      url: `/.well-known/oauth-protected-resource/mcp/c/${campA}`,
    });
    expect(pinned.json().resource).toBe(`${BASE}/mcp/c/${campA}`);
    const as = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(as).toMatchObject({
      issuer: BASE,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    const plain = await mcpClient(app, '').rpc('tools/list', {});
    expect(plain.status).toBe(401);
    expect(plain.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="dm"`,
    );
    const onPinned = await mcpClient(app, '', `/mcp/c/${campA}`).rpc('tools/list', {});
    expect(onPinned.headers['www-authenticate']).toContain(`oauth-protected-resource/mcp/c/${campA}"`);
  });

  it('registers https and loopback redirects, and nothing else', async () => {
    expect((await register(['https://claude.ai/api/mcp/auth_callback'])).statusCode).toBe(201);
    expect((await register(['http://127.0.0.1:9999/cb'])).statusCode).toBe(201);
    expect((await register(['http://example.com/cb'])).json()).toMatchObject({
      error: 'invalid_redirect_uri',
    });
    expect((await register(['https://claude.ai/cb#frag'])).statusCode).toBe(400);
    expect((await register([])).statusCode).toBe(400);
  });

  it('signs in end to end, and the connection works on the connector', async () => {
    const s = await signIn();
    expect(s.back.origin + s.back.pathname).toBe(CALLBACK);
    expect(s.back.searchParams.get('state')).toBe('st4te');
    const tok = await exchange(s);
    expect(tok.statusCode).toBe(200);
    expect(tok.headers['cache-control']).toBe('no-store');
    const body = tok.json() as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.access_token.startsWith('tma_')).toBe(true);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'dm' });
    const list = await mcpClient(app, body.access_token).rpc('tools/list', {});
    expect(list.status).toBe(200);
    const conns = await asHost.get<{ tokens: { kind: string; clientName: string }[] }>(
      '/api/account/connector',
    );
    expect(conns.body.tokens).toContainEqual(
      expect.objectContaining({ kind: 'signin', clientName: 'Claude' }),
    );
  });

  it('refuses codes that are wrong, reused or stale', async () => {
    const wrong = await signIn();
    expect((await exchange(wrong, { code_verifier: pkce().verifier })).json()).toMatchObject({
      error: 'invalid_grant',
    });
    const elsewhere = await signIn();
    expect((await exchange(elsewhere, { redirect_uri: 'http://localhost:1/other' })).json()).toMatchObject({
      error: 'invalid_grant',
    });

    // A code used twice: the second use fails and the connection the first made is ended.
    const twice = await signIn();
    const first = (await exchange(twice)).json() as { access_token: string };
    expect((await exchange(twice)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await mcpClient(app, first.access_token).rpc('tools/list', {})).status).toBe(401);

    const stale = await signIn();
    await q(`UPDATE oauth_codes SET expires_at = now() - interval '1 minute'`);
    expect((await exchange(stale)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('never redirects to a client or address it does not know', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code`,
    });
    expect(unknown.headers.location).toBe('/connect?error=bad_client');
    const client = (await register([CALLBACK])).json() as { client_id: string };
    const bad = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code`,
    });
    expect(bad.headers.location).toBe('/connect?error=bad_redirect');
    // Known client and address, broken request: back to the client with the error.
    const noPkce = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(CALLBACK)}&response_type=code&state=x`,
    });
    expect(noPkce.headers.location).toBe(`${CALLBACK}?error=invalid_request&state=x`);
  });

  it('rotates refresh tokens and ends a connection whose old one is replayed', async () => {
    const s = await signIn();
    const first = (await exchange(s)).json() as { access_token: string; refresh_token: string };
    const next = await form({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: s.clientId,
    });
    const second = next.json() as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcpClient(app, first.access_token).rpc('tools/list', {})).status).toBe(401);
    expect((await mcpClient(app, second.access_token).rpc('tools/list', {})).status).toBe(200);
    // Someone replays the rotated-out refresh token: the whole connection ends.
    const replay = await form({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: s.clientId,
    });
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await mcpClient(app, second.access_token).rpc('tools/list', {})).status).toBe(401);
  });

  it('keeps each connection to the address it was approved for', async () => {
    const s = await signIn(`${BASE}/mcp/c/${campA}`);
    const pinned = (await exchange(s)).json() as { access_token: string };
    expect((await mcpClient(app, pinned.access_token, `/mcp/c/${campA}`).rpc('tools/list', {})).status).toBe(
      200,
    );
    expect((await mcpClient(app, pinned.access_token, '/mcp').rpc('tools/list', {})).status).toBe(401);
    expect((await mcpClient(app, pinned.access_token, `/mcp/c/${campB}`).rpc('tools/list', {})).status).toBe(
      401,
    );

    const wide = (await exchange(await signIn())).json() as { access_token: string };
    expect((await mcpClient(app, wide.access_token, `/mcp/c/${campA}`).rpc('tools/list', {})).status).toBe(
      401,
    );

    const { token } = (await createToken(host, 'hand-made'))!;
    expect((await mcpClient(app, token, '/mcp').rpc('tools/list', {})).status).toBe(200);
    expect((await mcpClient(app, token, `/mcp/c/${campA}`).rpc('tools/list', {})).status).toBe(200);
  });

  it('lets only a campaign’s owner approve a connection for it', async () => {
    const client = (await register([CALLBACK])).json() as { client_id: string };
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: `${BASE}/mcp/c/${campA}`,
    });
    const auth = await app.inject({ method: 'GET', url: `/oauth/authorize?${params}` });
    const request = /request=([0-9a-f-]{36})/.exec(String(auth.headers.location))![1]!;
    const seen = await asHost.get<{ request: ConnectRequest }>(`/api/oauth/requests/${request}`);
    expect(seen.body.request).toMatchObject({
      clientName: 'Claude',
      redirectHost: 'localhost',
      campaign: { id: campA, name: `Alpha ${tag}` },
    });
    expect((await asEve.get(`/api/oauth/requests/${request}`)).status).toBe(403);
    expect((await asEve.post(`/api/oauth/requests/${request}/approve`)).status).toBe(403);
    const denied = await asHost.post<{ redirect: string }>(`/api/oauth/requests/${request}/deny`);
    expect(denied.body.redirect).toBe(`${CALLBACK}?error=access_denied`);
    expect((await asHost.get(`/api/oauth/requests/${request}`)).status).toBe(404);
  });

  it('expires access tokens, revokes on request, and guards the approval routes', async () => {
    const tok = (await exchange(await signIn())).json() as { access_token: string; refresh_token: string };
    await q(
      `UPDATE connector_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = sha256($1::bytea)`,
      [Buffer.from(tok.access_token)],
    );
    expect((await mcpClient(app, tok.access_token).rpc('tools/list', {})).status).toBe(401);

    const live = (await exchange(await signIn())).json() as { access_token: string };
    const revoked = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${live.access_token}`,
    });
    expect(revoked.statusCode).toBe(200);
    expect((await mcpClient(app, live.access_token).rpc('tools/list', {})).status).toBe(401);

    const s = await signIn();
    const anon = await app.inject({
      method: 'POST',
      url: `/api/oauth/requests/${s.request}/approve`,
      payload: {},
    });
    expect(anon.statusCode).toBe(401);
    const noCsrf = await asHost.send(
      'POST',
      `/api/oauth/requests/${s.request}/approve`,
      {},
      { 'x-csrf-token': '' },
    );
    expect(noCsrf.status).toBe(403);
  });
});
