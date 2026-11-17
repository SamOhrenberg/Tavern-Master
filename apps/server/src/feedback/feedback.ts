import type { FeedbackItem, FeedbackKind, FeedbackStatus } from '@tavern/protocol';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import { log } from '../log.js';
import {
  createIssue,
  getIssue,
  GitHubError,
  issueComments,
  repoIsPublic,
  type GitHubTarget,
  type IssueComment,
  type IssueInfo,
} from './github.js';

/**
 * Feedback sent from the app. It is saved here first, so nothing is lost when
 * GitHub is unreachable, and then opened as an issue. Its status and the
 * replies on the issue are read back from GitHub, cached briefly so a player
 * opening the list again and again does not spend the token's rate limit.
 */

/** Where it was sent from. Only these fields, each checked, reach the issue. */
export interface FeedbackContext {
  /** The page, with ids replaced, e.g. /c/:id. */
  path?: string;
  viewport?: string;
  standalone?: boolean;
  userAgent?: string;
  version?: string;
}

const KIND_TITLE: Record<FeedbackKind, string> = { bug: 'Bug', idea: 'Idea', feedback: 'Feedback' };
const KIND_LABEL: Record<FeedbackKind, string> = { bug: 'bug', idea: 'enhancement', feedback: 'feedback' };
/** Every issue from the app carries this label too, so they are easy to find. */
export const APP_LABEL = 'from app';

const CACHE_MS = 60_000;
const RETRY_MS = 60_000;

/** A page path with anything that identifies a campaign or record taken out. */
export function scrubPath(path: string): string {
  return (
    path
      .split(/[?#]/)[0]!
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+(?=\/|$)/g, '/:n')
      .slice(0, 120) || '/'
  );
}

export function issueTitle(kind: FeedbackKind, title: string): string {
  return `[${KIND_TITLE[kind]}] ${title}`.slice(0, 200);
}

/**
 * The issue's text. Who sent it is left out (the server keeps that), and
 * images are links back to this server rather than uploads, so a screenshot of
 * someone's game is never published with the issue.
 */
export function issueBody(f: {
  id: string;
  kind: FeedbackKind;
  body: string;
  context: FeedbackContext;
  images: { n: number; source: 'screenshot' | 'photo' }[];
}): string {
  const base = config().baseUrl;
  const ctx = f.context;
  const cell = (s: string) => s.replace(/[|`\r\n]/g, ' ').trim();
  const rows = [
    `| Kind | ${KIND_TITLE[f.kind]} |`,
    ctx.path ? `| Page | \`${cell(ctx.path)}\` |` : null,
    ctx.viewport ? `| Screen | ${cell(ctx.viewport)}${ctx.standalone ? ' (installed app)' : ''} |` : null,
    ctx.userAgent ? `| Browser | ${cell(ctx.userAgent).slice(0, 200)} |` : null,
    ctx.version ? `| App | ${cell(ctx.version)} |` : null,
  ].filter((r): r is string => r !== null);
  const lines = [f.body.trim() || '_No description._', '', '---', '', '| | |', '|---|---|', ...rows];
  if (f.images.length) {
    lines.push('', '**Attachments** (on the server; sign in to Tavern Master as an admin to open them)', '');
    for (const img of f.images) {
      const url = new URL(`/api/feedback/${f.id}/images/${img.n}`, base).toString();
      lines.push(`- [${img.source === 'screenshot' ? 'Screenshot of the page' : 'Photo'} ${img.n}](${url})`);
    }
  }
  lines.push('', `<sub>Sent from the in-app feedback button · ${f.id}</sub>`);
  return lines.join('\n');
}

export function statusOf(info: IssueInfo | null): FeedbackStatus {
  if (!info) return 'sending';
  if (info.state === 'open') return 'open';
  return info.stateReason === 'completed' ? 'done' : 'closed';
}

interface Row {
  id: string;
  user_id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  context: FeedbackContext;
  issue_number: number | null;
  issue_url: string | null;
  created_at: Date;
  images: { n: number; source: 'screenshot' | 'photo' }[];
}

const ROW_SQL = `SELECT f.id, f.user_id, f.kind, f.title, f.body, f.context, f.issue_number, f.issue_url, f.created_at,
                        coalesce((SELECT json_agg(json_build_object('n', i.n, 'source', i.source) ORDER BY i.n)
                                    FROM feedback_images i WHERE i.feedback_id = f.id), '[]') AS images
                   FROM feedback f`;

const lastTry = new Map<string, number>();

/** Open the issue for a piece of feedback that has none yet. Failures are recorded, not thrown. */
export async function sendFeedback(
  t: GitHubTarget,
  id: string,
  fetchImpl?: typeof fetch,
): Promise<IssueInfo | null> {
  // Claimed before the first await: two requests at once must not open two issues.
  if (sending.has(id)) return null;
  sending.add(id);
  lastTry.set(id, Date.now());
  try {
    return await openIssue(t, id, fetchImpl);
  } finally {
    sending.delete(id);
  }
}

const sending = new Set<string>();

async function openIssue(t: GitHubTarget, id: string, fetchImpl?: typeof fetch): Promise<IssueInfo | null> {
  const f = await q1<Row>(`${ROW_SQL} WHERE f.id = $1`, [id]);
  if (!f || f.issue_number) return null;
  const issue = {
    title: issueTitle(f.kind, f.title),
    body: issueBody({ ...f, images: f.images }),
    labels: [KIND_LABEL[f.kind], APP_LABEL],
  };
  try {
    let info: IssueInfo;
    try {
      info = await createIssue(t, issue, fetchImpl);
    } catch (err) {
      // A token that may not create labels is refused outright; the issue matters more than its labels.
      if (!(err instanceof GitHubError) || err.status !== 422) throw err;
      info = await createIssue(t, { ...issue, labels: [] }, fetchImpl);
    }
    await q(
      `UPDATE feedback SET issue_number = $2, issue_url = $3, send_error = NULL, sent_at = now()
        WHERE id = $1 AND issue_number IS NULL`,
      [id, info.number, info.url],
    );
    cache.set(info.number, { at: Date.now(), info, comments: [] });
    return info;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log().warn({ err: message, feedback: id }, 'could not open a GitHub issue for feedback');
    await q(`UPDATE feedback SET send_error = $2 WHERE id = $1`, [id, message.slice(0, 300)]);
    return null;
  }
}

const cache = new Map<number, { at: number; info: IssueInfo; comments: IssueComment[] }>();

async function issueState(
  t: GitHubTarget,
  n: number,
  fetchImpl?: typeof fetch,
): Promise<{ info: IssueInfo; comments: IssueComment[] } | null> {
  const hit = cache.get(n);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  try {
    const info = await getIssue(t, n, fetchImpl);
    const comments = info.comments > 0 ? await issueComments(t, n, fetchImpl) : [];
    const entry = { at: Date.now(), info, comments };
    cache.set(n, entry);
    return entry;
  } catch (err) {
    log().warn(
      { err: err instanceof Error ? err.message : err, issue: n },
      'could not read a feedback issue',
    );
    // What was last known beats nothing.
    return hit ?? null;
  }
}

export function clearFeedbackCacheForTests(): void {
  cache.clear();
  lastTry.clear();
  publicRepo = undefined;
}

let publicRepo: { at: number; value: boolean | null } | undefined;
export async function isPublicRepo(t: GitHubTarget, fetchImpl?: typeof fetch): Promise<boolean | null> {
  if (publicRepo && Date.now() - publicRepo.at < 60 * 60_000) return publicRepo.value;
  publicRepo = { at: Date.now(), value: await repoIsPublic(t, fetchImpl) };
  return publicRepo.value;
}

/** A user's feedback, newest first, with where each stands on GitHub. Unsent ones are tried again. */
export async function listFeedback(
  t: GitHubTarget,
  userId: string,
  fetchImpl?: typeof fetch,
): Promise<FeedbackItem[]> {
  const rows = await q<Row>(`${ROW_SQL} WHERE f.user_id = $1 ORDER BY f.created_at DESC LIMIT 50`, [userId]);
  return Promise.all(
    rows.map(async (f): Promise<FeedbackItem> => {
      let number = f.issue_number;
      let url = f.issue_url;
      if (!number && Date.now() - (lastTry.get(f.id) ?? 0) > RETRY_MS) {
        const sent = await sendFeedback(t, f.id, fetchImpl);
        if (sent) {
          number = sent.number;
          url = sent.url;
        }
      }
      const state = number ? await issueState(t, number, fetchImpl) : null;
      return {
        id: f.id,
        kind: f.kind,
        title: f.title,
        body: f.body,
        createdAt: f.created_at.toISOString(),
        status: number ? (state ? statusOf(state.info) : 'open') : 'sending',
        labels: (state?.info.labels ?? []).filter((l) => l !== APP_LABEL && l !== KIND_LABEL[f.kind]),
        issueNumber: number,
        issueUrl: url,
        replies: (state?.comments ?? []).map((c) => ({
          author: c.author,
          body: c.body,
          createdAt: c.createdAt,
        })),
        updatedAt: state?.info.updatedAt ?? null,
        images: f.images,
      };
    }),
  );
}
