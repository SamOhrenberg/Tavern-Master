import { config } from '../config.js';

/**
 * The few GitHub REST calls feedback needs, with the fine-grained token from
 * the config. Nothing else in the server talks to GitHub. `fetchImpl` is for
 * tests.
 */

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GitHubTarget {
  repo: string;
  token: string;
}

/** The repository and token feedback goes to, or null when feedback is off. */
export function feedbackTarget(): GitHubTarget | null {
  const { GITHUB_FEEDBACK_REPO: repo, GITHUB_FEEDBACK_TOKEN: token } = config();
  return repo && token ? { repo, token } : null;
}

export interface IssueInfo {
  number: number;
  url: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  comments: number;
  updatedAt: string;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

async function call<T>(
  t: GitHubTarget,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${t.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'tavern-master-feedback',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      // not JSON
    }
    throw new GitHubError(
      `GitHub said ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

interface RawIssue {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  state_reason?: string | null;
  labels: (string | { name?: string })[];
  comments: number;
  updated_at: string;
}

const toInfo = (i: RawIssue): IssueInfo => ({
  number: i.number,
  url: i.html_url,
  state: i.state,
  stateReason: i.state_reason ?? null,
  labels: i.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
  comments: i.comments,
  updatedAt: i.updated_at,
});

export async function createIssue(
  t: GitHubTarget,
  issue: { title: string; body: string; labels: string[] },
  fetchImpl?: typeof fetch,
): Promise<IssueInfo> {
  return toInfo(await call<RawIssue>(t, 'POST', `/repos/${t.repo}/issues`, issue, fetchImpl));
}

export async function getIssue(t: GitHubTarget, n: number, fetchImpl?: typeof fetch): Promise<IssueInfo> {
  return toInfo(await call<RawIssue>(t, 'GET', `/repos/${t.repo}/issues/${n}`, undefined, fetchImpl));
}

export async function issueComments(
  t: GitHubTarget,
  n: number,
  fetchImpl?: typeof fetch,
): Promise<IssueComment[]> {
  const raw = await call<{ user?: { login?: string } | null; body?: string | null; created_at: string }[]>(
    t,
    'GET',
    `/repos/${t.repo}/issues/${n}/comments?per_page=50`,
    undefined,
    fetchImpl,
  );
  return raw.map((c) => ({
    author: c.user?.login ?? 'someone',
    body: (c.body ?? '').slice(0, 4000),
    createdAt: c.created_at,
  }));
}

/** Whether the repository is public; null when GitHub cannot say. */
export async function repoIsPublic(t: GitHubTarget, fetchImpl?: typeof fetch): Promise<boolean | null> {
  try {
    const r = await call<{ private?: boolean }>(t, 'GET', `/repos/${t.repo}`, undefined, fetchImpl);
    return typeof r.private === 'boolean' ? !r.private : null;
  } catch {
    return null;
  }
}
