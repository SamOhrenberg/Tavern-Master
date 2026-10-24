import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { hashPassword, passwordSchema, verifyPassword } from '../auth/password.js';
import { revokeAllSessions, revokeSession, toMe } from '../auth/sessions.js';
import { newRecoveryCodes, newTotpSecret, verifyTotp } from '../auth/totp.js';
import { q, q1 } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../errors.js';
import { enforceLimit, rateLimiters, requireUser } from '../http/security.js';
import { usageTotals } from '../llm/usage.js';
import { decryptSecret, encryptSecret } from '../security/crypto.js';
import { displayNameSchema } from './auth.js';

const profileSchema = z.object({
  displayName: displayNameSchema.optional(),
  email: z.union([z.string().trim().email().max(200), z.literal('')]).optional(),
});
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
const codeSchema = z.object({ code: z.string().trim().min(6).max(10) });
const disableTotpSchema = z.object({ password: z.string().min(1).max(200) });
const apiKeySchema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'openrouter']),
    apiKey: z.string().trim().min(16).max(400),
    modelNarration: z.string().trim().max(120).optional(),
    modelUtility: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.provider === 'anthropic' || (!!v.modelNarration && !!v.modelUtility), {
    message: 'Model names are required for this provider',
  });

async function checkPassword(userId: string, password: string): Promise<boolean> {
  const row = await q1<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  return !!row && (await verifyPassword(row.password_hash, password));
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/account/profile', async (req) => {
    const auth = requireUser(req);
    const body = parse(profileSchema, req.body);
    try {
      await q(
        `UPDATE users SET display_name = coalesce($2, display_name),
                          email = CASE WHEN $3::text IS NULL THEN email ELSE nullif($3, '') END
          WHERE id = $1`,
        [auth.user.id, body.displayName ?? null, body.email ?? null],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('That email is already in use.');
      throw err;
    }
    auth.user.displayName = body.displayName ?? auth.user.displayName;
    if (body.email !== undefined) auth.user.email = body.email || null;
    return { user: toMe(auth) };
  });

  app.post('/api/account/password', async (req) => {
    const auth = requireUser(req);
    enforceLimit(rateLimiters().auth, `password:${auth.user.id}`);
    const body = parse(passwordChangeSchema, req.body);
    if (!(await checkPassword(auth.user.id, body.currentPassword))) {
      throw forbidden('Current password is wrong', 'bad_credentials');
    }
    await q('UPDATE users SET password_hash = $2 WHERE id = $1', [
      auth.user.id,
      await hashPassword(body.newPassword),
    ]);
    // Everyone else holding a session for this account is signed out.
    await revokeAllSessions(auth.user.id, auth.sessionId);
    await audit('user.password_changed', { actorId: auth.user.id, ip: req.ip });
    return { ok: true };
  });

  // ---- sessions ----
  app.get('/api/account/sessions', async (req) => {
    const auth = requireUser(req);
    const rows = await q<{
      id: string;
      created_at: Date;
      last_seen_at: Date;
      ip: string | null;
      user_agent: string | null;
    }>(
      `SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
      [auth.user.id],
    );
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        ip: r.ip,
        userAgent: r.user_agent,
        current: r.id === auth.sessionId,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>('/api/account/sessions/:id', async (req) => {
    const auth = requireUser(req);
    const id = parse(z.string().uuid(), req.params.id);
    if (!(await revokeSession(id, auth.user.id))) throw notFound();
    await audit('session.revoked', { actorId: auth.user.id, ip: req.ip });
    return { ok: true };
  });

  // ---- two-factor ----
  app.post('/api/account/totp/setup', async (req) => {
    const auth = requireUser(req);
    if (auth.user.totpEnabled) throw conflict('Two-factor authentication is already enabled.');
    const { secret, uri } = newTotpSecret(auth.user.username);
    // Stored encrypted but not active until a code proves the app was set up.
    await q('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [auth.user.id, encryptSecret(secret)]);
    return { secret, uri };
  });

  app.post('/api/account/totp/enable', async (req) => {
    const auth = requireUser(req);
    enforceLimit(rateLimiters().auth, `totp:${auth.user.id}`);
    const { code } = parse(codeSchema, req.body);
    const row = await q1<{ totp_secret_enc: string | null }>(
      'SELECT totp_secret_enc FROM users WHERE id = $1',
      [auth.user.id],
    );
    if (auth.user.totpEnabled || !row?.totp_secret_enc) throw badRequest('Start two-factor setup first.');
    if (!verifyTotp(decryptSecret(row.totp_secret_enc), code))
      throw badRequest('That code is not valid.', 'bad_totp');
    const recovery = newRecoveryCodes();
    await q('UPDATE users SET totp_enabled_at = now(), recovery_codes = $2 WHERE id = $1', [
      auth.user.id,
      JSON.stringify(recovery.hashed),
    ]);
    await audit('user.totp_enabled', { actorId: auth.user.id, ip: req.ip });
    return { recoveryCodes: recovery.plain };
  });

  app.post('/api/account/totp/disable', async (req) => {
    const auth = requireUser(req);
    enforceLimit(rateLimiters().auth, `totp:${auth.user.id}`);
    const { password } = parse(disableTotpSchema, req.body);
    if (!(await checkPassword(auth.user.id, password)))
      throw forbidden('Password is wrong', 'bad_credentials');
    await q(
      `UPDATE users SET totp_enabled_at = NULL, totp_secret_enc = NULL, recovery_codes = '[]' WHERE id = $1`,
      [auth.user.id],
    );
    await audit('user.totp_disabled', { actorId: auth.user.id, ip: req.ip });
    return { ok: true };
  });

  // ---- bring-your-own API key: only a hint ever leaves the server ----
  app.get('/api/account/api-key', async (req) => {
    const auth = requireUser(req);
    const row = await q1<{
      provider: string;
      key_hint: string;
      model_narration: string | null;
      model_utility: string | null;
    }>('SELECT provider, key_hint, model_narration, model_utility FROM user_api_keys WHERE user_id = $1', [
      auth.user.id,
    ]);
    return {
      apiKey: row
        ? {
            provider: row.provider,
            hint: row.key_hint,
            modelNarration: row.model_narration,
            modelUtility: row.model_utility,
          }
        : null,
    };
  });

  app.put('/api/account/api-key', async (req) => {
    const auth = requireUser(req);
    const body = parse(apiKeySchema, req.body);
    await q(
      `INSERT INTO user_api_keys (user_id, provider, key_enc, key_hint, model_narration, model_utility)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET provider = $2, key_enc = $3, key_hint = $4,
                                           model_narration = $5, model_utility = $6, enabled = true`,
      [
        auth.user.id,
        body.provider,
        encryptSecret(body.apiKey),
        `…${body.apiKey.slice(-4)}`,
        body.modelNarration || null,
        body.modelUtility || null,
      ],
    );
    await audit('user.api_key_set', { actorId: auth.user.id, ip: req.ip, meta: { provider: body.provider } });
    return { ok: true };
  });

  app.delete('/api/account/api-key', async (req) => {
    const auth = requireUser(req);
    await q('DELETE FROM user_api_keys WHERE user_id = $1', [auth.user.id]);
    await audit('user.api_key_removed', { actorId: auth.user.id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/account/usage', async (req) => {
    const auth = requireUser(req);
    return {
      day: await usageTotals({ userId: auth.user.id, hours: 24 }),
      month: await usageTotals({ userId: auth.user.id, hours: 24 * 30 }),
    };
  });
}
