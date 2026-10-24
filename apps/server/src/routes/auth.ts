import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { redeemInvite } from '../auth/invites.js';
import { burnPasswordCheck, hashPassword, passwordSchema, verifyPassword } from '../auth/password.js';
import {
  SESSION_COOKIE,
  cookieOptions,
  createSession,
  resolveSession,
  revokeSession,
  toMe,
} from '../auth/sessions.js';
import { hashRecoveryCode, verifyTotp } from '../auth/totp.js';
import { config } from '../config.js';
import { q, q1, tx } from '../db/pool.js';
import { conflict, forbidden, parse, unauthorized } from '../errors.js';
import { enforceLimit, rateLimiters, requireUser } from '../http/security.js';
import { decryptSecret } from '../security/crypto.js';

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(24, 'Username is too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Use letters, numbers, - and _ only');
export const displayNameSchema = z.string().trim().min(1).max(40);

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
  code: z.string().trim().max(20).optional(),
});

const registerSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema.optional(),
  password: passwordSchema,
  inviteCode: z.string().trim().max(64).optional(),
});

interface LoginRow {
  id: string;
  password_hash: string;
  status: string;
  totp_secret_enc: string | null;
  totp_enabled: boolean;
  recovery_codes: string[];
  locked: boolean;
}

const BAD_LOGIN = 'Wrong username or password';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** What the sign-in screen needs before anyone is authenticated. */
  app.get('/api/public-config', async () => ({
    openRegistration: config().OPEN_REGISTRATION,
    name: 'Tavern Master',
  }));

  app.get('/api/auth/me', async (req) => ({ user: req.auth ? toMe(req.auth) : null }));

  app.post('/api/auth/login', async (req, reply) => {
    const cfg = config();
    const body = parse(loginSchema, req.body);
    const username = body.username.toLowerCase();
    // Two keys: one slows a single address, the other protects a single account
    // from a distributed guesser.
    enforceLimit(rateLimiters().auth, `login-ip:${req.ip}`);
    enforceLimit(rateLimiters().auth, `login-user:${username}`);

    const user = await q1<LoginRow>(
      `SELECT id, password_hash, status, totp_secret_enc, recovery_codes,
              totp_enabled_at IS NOT NULL AS totp_enabled,
              locked_until IS NOT NULL AND locked_until > now() AS locked
         FROM users WHERE username = $1`,
      [username],
    );
    if (!user) {
      await burnPasswordCheck(body.password);
      await audit('login.failed', { ip: req.ip, meta: { username, reason: 'unknown_user' } });
      throw unauthorized(BAD_LOGIN, 'bad_credentials');
    }
    if (user.locked) {
      await audit('login.failed', { actorId: user.id, ip: req.ip, meta: { reason: 'locked' } });
      throw forbidden('Too many failed attempts. This account is locked for a few minutes.', 'locked');
    }

    const fail = async (reason: string, message = BAD_LOGIN, code = 'bad_credentials') => {
      await q(
        `UPDATE users
            SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2
                                    THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`,
        [user.id, cfg.LOGIN_LOCKOUT_THRESHOLD, cfg.LOGIN_LOCKOUT_MINUTES],
      );
      await audit('login.failed', { actorId: user.id, ip: req.ip, meta: { reason } });
      return unauthorized(message, code);
    };

    if (!(await verifyPassword(user.password_hash, body.password))) throw await fail('bad_password');
    if (user.status !== 'active') throw forbidden('This account is disabled.', 'disabled');

    if (user.totp_enabled && user.totp_secret_enc) {
      if (!body.code) throw unauthorized('Enter your two-factor code', 'totp_required');
      const code = body.code.trim();
      if (/^\d{6}$/.test(code.replace(/\s+/g, ''))) {
        if (!verifyTotp(decryptSecret(user.totp_secret_enc), code)) {
          throw await fail('bad_totp', 'That code is not valid', 'bad_totp');
        }
      } else {
        // Recovery codes are single-use: remove the one that matched.
        const hashed = hashRecoveryCode(code);
        if (!user.recovery_codes.includes(hashed))
          throw await fail('bad_recovery', 'That code is not valid', 'bad_totp');
        await q('UPDATE users SET recovery_codes = recovery_codes - $2::text WHERE id = $1', [
          user.id,
          hashed,
        ]);
        await audit('login.recovery_code_used', { actorId: user.id, ip: req.ip });
      }
    }

    await q('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [
      user.id,
    ]);
    rateLimiters().auth.reset(`login-user:${username}`);
    const token = await createSession(user.id, req.ip, req.headers['user-agent']);
    await audit('login.success', { actorId: user.id, ip: req.ip });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    const auth = await resolveSession(token);
    return { user: auth ? toMe(auth) : null };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const auth = requireUser(req);
    await revokeSession(auth.sessionId, auth.user.id);
    await audit('logout', { actorId: auth.user.id, ip: req.ip });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const cfg = config();
    enforceLimit(rateLimiters().auth, `register-ip:${req.ip}`);
    const body = parse(registerSchema, req.body);
    const username = body.username.toLowerCase();
    if (!cfg.OPEN_REGISTRATION && !body.inviteCode) {
      throw forbidden(
        'Registration is invite-only. Ask an administrator for an invite code.',
        'invite_required',
      );
    }
    const hash = await hashPassword(body.password);

    const userId = await tx(async (client) => {
      let role: 'admin' | 'user' = 'user';
      if (body.inviteCode) {
        const granted = await redeemInvite(body.inviteCode, client);
        if (!granted) throw forbidden('That invite code is not valid or has expired.', 'bad_invite');
        role = granted;
      }
      const row = await q1<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING RETURNING id`,
        [username, body.displayName ?? body.username, hash, role],
        client,
      );
      // Throwing rolls the invite use back too.
      if (!row) throw conflict('That username is taken.', 'username_taken');
      return row.id;
    });

    await audit('user.registered', { actorId: userId, targetType: 'user', targetId: userId, ip: req.ip });
    const token = await createSession(userId, req.ip, req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    const auth = await resolveSession(token);
    return { user: auth ? toMe(auth) : null };
  });
}
