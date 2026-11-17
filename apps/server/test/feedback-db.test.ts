import type { FeedbackList, ServerMeta } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { clearFeedbackCacheForTests, issueBody, scrubPath, statusOf } from '../src/feedback/feedback.js';
import { resetFeedbackLimiterForTests } from '../src/routes/feedback.js';
import { signedIn, type SignedIn } from './http.js';

/** Just enough of GitHub's issues API, in memory. */
function fakeGitHub() {
  const issues = new Map<
    number,
    { title: string; body: string; labels: string[]; state: string; state_reason: string | null }
  >();
  const comments = new Map<number, { user: { login: string }; body: string; created_at: string }[]>();
  const calls: { method: string; path: string; body?: Record<string, unknown>; auth: string }[] = [];
  let down = false;
  let refuseLabels = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const raw = (n: number) => {
    const i = issues.get(n)!;
    return {
      number: n,
      html_url: `https://github.com/acme/tavern/issues/${n}`,
      state: i.state,
      state_reason: i.state_reason,
      labels: i.labels.map((name) => ({ name })),
      comments: comments.get(n)?.length ?? 0,
      updated_at: '2026-11-17T10:00:00Z',
    };
  };
  const impl = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body, auth: (init.headers as Record<string, string>).authorization ?? '' });
    if (down) return json({ message: 'Server Error' }, 502);
    if (method === 'POST' && path === '/repos/acme/tavern/issues') {
      const labels = (body?.labels as string[]) ?? [];
      if (refuseLabels && labels.length) return json({ message: 'Validation Failed' }, 422);
      const n = issues.size + 1;
      issues.set(n, {
        title: String(body?.title),
        body: String(body?.body),
        labels,
        state: 'open',
        state_reason: null,
      });
      return json(raw(n), 201);
    }
    const one = /^\/repos\/acme\/tavern\/issues\/(\d+)$/.exec(path);
    if (one) return json(raw(Number(one[1])));
    const comm = /^\/repos\/acme\/tavern\/issues\/(\d+)\/comments$/.exec(path);
    if (comm) return json(comments.get(Number(comm[1])) ?? []);
    if (path === '/repos/acme/tavern') return json({ private: false });
    return json({ message: 'Not Found' }, 404);
  };
  return {
    issues,
    comments,
    calls,
    impl,
    set down(v: boolean) {
      down = v;
    },
    set refuseLabels(v: boolean) {
      refuseLabels = v;
    },
  };
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('not really the rest of a png'),
]).toString('base64');

describe('feedback, unit', () => {
  it('takes ids out of the page path', () => {
    expect(scrubPath('/c/0f8fad5b-d9cb-469f-a165-70867728950e?x=1')).toBe('/c/:id');
    expect(scrubPath('/library/12/rules')).toBe('/library/:n/rules');
  });

  it('writes an issue with the context and links, and without who sent it', () => {
    setConfigForTests(testConfig({ BASE_URL: 'https://tavern.example' }));
    const body = issueBody({
      id: 'f-1',
      kind: 'bug',
      body: 'The pass button | does nothing',
      context: { path: '/c/:id', viewport: '393×852 @3x', standalone: true, userAgent: 'Safari|`x`' },
      images: [{ n: 1, source: 'screenshot' }],
    });
    expect(body).toContain('The pass button | does nothing');
    expect(body).toContain('| Page | `/c/:id` |');
    expect(body).toContain('393×852 @3x (installed app)');
    expect(body).toContain('| Browser | Safari  x |');
    expect(body).toContain('[Screenshot of the page 1](https://tavern.example/api/feedback/f-1/images/1)');
  });

  it('reads the status off the issue', () => {
    const info = { number: 1, url: '', labels: [], comments: 0, updatedAt: '' };
    expect(statusOf(null)).toBe('sending');
    expect(statusOf({ ...info, state: 'open', stateReason: null })).toBe('open');
    expect(statusOf({ ...info, state: 'closed', stateReason: 'completed' })).toBe('done');
    expect(statusOf({ ...info, state: 'closed', stateReason: 'not_planned' })).toBe('closed');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('feedback (database)', () => {
  const tag = `fb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let app: FastifyInstance;
  let asAnn: SignedIn;
  let asBob: SignedIn;
  let asAdmin: SignedIn;
  let ann = '';
  let gh: ReturnType<typeof fakeGitHub>;

  const user = async (name: string, role = 'user') =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
      [`${name}-${tag}`, name, role],
    ))!.id;

  const configure = (feedback: boolean) =>
    setConfigForTests(
      testConfig({
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        ADMIN_REQUIRE_TOTP: 'false',
        BASE_URL: 'https://tavern.example',
        ...(feedback
          ? { GITHUB_FEEDBACK_REPO: 'acme/tavern', GITHUB_FEEDBACK_TOKEN: 'github_pat_test' }
          : {}),
      }),
    );

  beforeAll(async () => {
    configure(true);
    await migrate();
    ann = await user('Ann');
    const bob = await user('Bob');
    const admin = await user('Admin', 'admin');
    app = await buildApp();
    asAnn = await signedIn(app, ann);
    asBob = await signedIn(app, bob);
    asAdmin = await signedIn(app, admin);
  });

  beforeEach(() => {
    configure(true);
    gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.impl);
    clearFeedbackCacheForTests();
    resetFeedbackLimiterForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    await app?.close();
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await closeDb();
  });

  it('is off, and the button hidden, until a repository and token are set', async () => {
    configure(false);
    expect((await asAnn.get<ServerMeta>('/api/meta')).body.feedback).toBe(false);
    expect((await asAnn.get('/api/feedback')).status).toBe(404);
    configure(true);
    expect((await asAnn.get<ServerMeta>('/api/meta')).body.feedback).toBe(true);
  });

  it('opens an issue with the token, keeping the picture on the server', async () => {
    const sent = await asAnn.post<{ issueNumber: number }>('/api/feedback', {
      kind: 'bug',
      title: 'Pass does nothing',
      body: 'I tapped it twice.',
      context: { path: '/c/0f8fad5b-d9cb-469f-a165-70867728950e', viewport: '393×852 @3x', standalone: true },
      images: [{ source: 'screenshot', data: png }],
    });
    expect(sent.status).toBe(200);
    expect(sent.body.issueNumber).toBe(1);
    const issue = gh.issues.get(1)!;
    expect(issue.title).toBe('[Bug] Pass does nothing');
    expect(issue.labels).toEqual(['bug', 'from app']);
    expect(issue.body).toContain('`/c/:id`');
    expect(issue.body).toMatch(/https:\/\/tavern\.example\/api\/feedback\/[0-9a-f-]+\/images\/1/);
    // Nobody is named on GitHub.
    expect(issue.body).not.toContain('Ann');
    expect(gh.calls[0]!.auth).toBe('Bearer github_pat_test');

    const list = await asAnn.get<FeedbackList>('/api/feedback');
    const mine = list.body.items.find((i) => i.issueNumber === 1)!;
    expect(mine).toMatchObject({
      status: 'open',
      title: 'Pass does nothing',
      images: [{ n: 1, source: 'screenshot' }],
    });
    expect(list.body.publicRepo).toBe(true);

    // The picture: for Ann and for admins, nobody else.
    const id = mine.id;
    const img = await asAnn.get(`/api/feedback/${id}/images/1`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await asAdmin.get(`/api/feedback/${id}/images/1`)).status).toBe(200);
    expect((await asBob.get(`/api/feedback/${id}/images/1`)).status).toBe(404);
    // Nor does Bob see Ann's feedback.
    expect((await asBob.get<FeedbackList>('/api/feedback')).body.items).toEqual([]);
  });

  it('shows replies and the outcome from the issue', async () => {
    const sent = await asAnn.post<{ issueNumber: number }>('/api/feedback', {
      kind: 'idea',
      title: 'Mute talk',
    });
    const n = sent.body.issueNumber;
    gh.comments.set(n, [
      { user: { login: 'maintainer' }, body: 'Good idea, shipping it.', created_at: '2026-11-17T09:00:00Z' },
    ]);
    Object.assign(gh.issues.get(n)!, {
      state: 'closed',
      state_reason: 'completed',
      labels: ['enhancement', 'from app', 'shipped'],
    });
    clearFeedbackCacheForTests();
    const item = (await asAnn.get<FeedbackList>('/api/feedback')).body.items.find(
      (i) => i.issueNumber === n,
    )!;
    expect(item.status).toBe('done');
    // Labels the app set itself are not news to the sender.
    expect(item.labels).toEqual(['shipped']);
    expect(item.replies).toEqual([
      { author: 'maintainer', body: 'Good idea, shipping it.', createdAt: '2026-11-17T09:00:00Z' },
    ]);
  });

  it('keeps feedback when GitHub is down and sends it later', async () => {
    gh.down = true;
    const sent = await asAnn.post<{ id: string; issueNumber: number | null }>('/api/feedback', {
      kind: 'feedback',
      title: 'Love the dice',
    });
    expect(sent.status).toBe(200);
    expect(sent.body.issueNumber).toBeNull();
    const waiting = (await asAnn.get<FeedbackList>('/api/feedback')).body.items.find(
      (i) => i.id === sent.body.id,
    )!;
    expect(waiting.status).toBe('sending');

    gh.down = false;
    clearFeedbackCacheForTests();
    const later = (await asAnn.get<FeedbackList>('/api/feedback')).body.items.find(
      (i) => i.id === sent.body.id,
    )!;
    expect(later.status).toBe('open');
    expect(later.issueNumber).toBe(1);
  });

  it('still opens the issue when the token may not set labels', async () => {
    gh.refuseLabels = true;
    const sent = await asAnn.post<{ issueNumber: number }>('/api/feedback', {
      kind: 'bug',
      title: 'No labels',
    });
    expect(sent.body.issueNumber).toBe(1);
    expect(gh.issues.get(1)!.labels).toEqual([]);
  });

  it('refuses something that is not an image, and too many in an hour', async () => {
    const bad = await asAnn.post('/api/feedback', {
      kind: 'bug',
      title: 'Bad picture',
      images: [{ source: 'photo', data: Buffer.from('<svg/>').toString('base64') }],
    });
    expect(bad.status).toBe(400);
    for (let i = 0; i < 10; i++) await asBob.post('/api/feedback', { kind: 'idea', title: `Idea ${i}` });
    expect((await asBob.post('/api/feedback', { kind: 'idea', title: 'One more' })).status).toBe(429);
  });
});
