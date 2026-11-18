#!/usr/bin/env node
/**
 * Brings Claude to the table on its own. It runs on the computer where Claude
 * Code is signed in, asks the Tavern Master server which campaigns run by
 * Claude have players at the table, and starts Claude Code in the background
 * for each one (`claude -p /dm`). When a table empties, or Claude goes quiet
 * while players wait, it stops that run. The next player to sit down starts a
 * new one.
 *
 * For an admin's token it answers the game system workshop too: when an admin
 * writes in a workshop that Claude answers, it starts a run (`claude -p
 * /workshop`) that answers and leaves once nothing is waiting.
 *
 *   node scripts/dm-launcher.mjs setup --server https://tavern.example --token tmc_...
 *   node scripts/dm-launcher.mjs              keep tables staffed (Ctrl+C to stop)
 *   node scripts/dm-launcher.mjs watch [name] follow what Claude is doing at a table or workshop
 *   node scripts/dm-launcher.mjs status       what the server says about each table
 *
 * Make the token in the app under You → Claude → Use a token instead. Settings
 * live in ~/.tavern-dm/config.json; TAVERN_URL, TAVERN_TOKEN, TAVERN_IDLE_MINUTES,
 * TAVERN_ECHO (also print what Claude does to the console) and
 * CLAUDE_CODE_OAUTH_TOKEN_BACKUP (a second Claude Code sign-in, used while the
 * main one is out of usage or failing) override them.
 * No dependencies: Node 20 or later.
 */
/* eslint-disable no-console -- a command-line tool: the console is its interface. */
import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  watchFile,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

const HOME = join(homedir(), '.tavern-dm');
const CONFIG = join(HOME, 'config.json');
const LOGS = join(HOME, 'logs');
const MCP = join(HOME, 'mcp');
const SERVER_NAME = 'tavern-master';
const WIN = process.platform === 'win32';

const DEFAULTS = {
  server: '',
  token: '',
  /** Where campaign folders go. */
  dir: join(homedir(), 'Tavern'),
  /** Stop a run after this long with nobody at the table, or with no word from Claude while players wait. */
  idleMinutes: 15,
  pollSeconds: 15,
  /** The claude executable; found on PATH when empty. */
  claude: '',
  /** Also print what Claude is doing to the console, not only to the log (for `docker compose logs`). */
  echo: false,
  /** A second Claude Code token (`claude setup-token`), for when the main sign-in runs out or fails. */
  claudeBackupToken: '',
};

// ------------------------------------------------------------ settings

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    } else out._.push(a);
  }
  return out;
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function settings(f) {
  const s = { ...DEFAULTS, ...readConfig() };
  if (process.env.TAVERN_URL) s.server = process.env.TAVERN_URL;
  if (process.env.TAVERN_TOKEN) s.token = process.env.TAVERN_TOKEN;
  if (process.env.TAVERN_ECHO) s.echo = process.env.TAVERN_ECHO;
  if (process.env.TAVERN_IDLE_MINUTES) s.idleMinutes = process.env.TAVERN_IDLE_MINUTES;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN_BACKUP)
    s.claudeBackupToken = process.env.CLAUDE_CODE_OAUTH_TOKEN_BACKUP;
  for (const k of Object.keys(DEFAULTS)) if (f[k] !== undefined) s[k] = f[k];
  s.idleMinutes = Number(s.idleMinutes) || DEFAULTS.idleMinutes;
  s.echo = ['1', 'true', 'yes', true].includes(s.echo);
  s.pollSeconds = Math.max(5, Number(s.pollSeconds) || DEFAULTS.pollSeconds);
  s.server = String(s.server).replace(/\/+$/, '');
  // The app shows it as a header value; take it with or without "Bearer ".
  s.token = String(s.token)
    .trim()
    .replace(/^Bearer\s+/i, '');
  s.claudeBackupToken = String(s.claudeBackupToken ?? '').trim();
  s.dir = resolve(s.dir);
  return s;
}

function requireServer(s) {
  if (!s.server || !s.token) {
    console.error(
      'Not set up. Run: node scripts/dm-launcher.mjs setup --server <address> --token <tmc_ token>',
    );
    process.exit(1);
  }
}

// ------------------------------------------------------------ the server

async function api(s, path) {
  const res = await fetch(`${s.server}${path}`, {
    headers: { authorization: `Bearer ${s.token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `${res.status} ${res.statusText}`);
  return body;
}

/** Write the campaign folder if it is missing. Files already there are left alone. */
async function ensureFolder(s, c) {
  const root = join(s.dir, c.folder);
  if (existsSync(join(root, 'CLAUDE.md'))) return root;
  const kit = await api(s, `/api/summon/${c.id}/kit`);
  for (const f of kit.files) {
    const target = resolve(root, f.path);
    if (!target.startsWith(root + sep)) throw new Error(`Refusing a kit path outside the folder: ${f.path}`);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, f.text);
  }
  log(c, `Made the campaign folder at ${root}`);
  return root;
}

/**
 * The folder a workshop run works in: no campaign, only the skill that says
 * how to answer this system's workshop. The launcher owns it and rewrites it,
 * so a renamed system is picked up.
 */
function workshopFolder(s, w) {
  const root = join(s.dir, w.folder);
  const skill = `---
name: workshop
description: Answer the Tavern Master workshop for ${w.system} in the app until nothing is waiting.
---
Answer the admins' messages in the Tavern Master workshop for the game system ${w.system}.
Every workshop tool takes the system's name: ${w.system}

1. Call \`open_workshop\` with the system and follow the instructions it returns.
2. Call \`workshop_wait\` with the system. Do what the messages ask with the workshop tools, then
   answer with \`workshop_reply\`, giving the number of the last message you answer.
3. Call \`workshop_wait\` again. Repeat.
4. Write nothing between calls. No status lines, no summaries.
5. Stop when \`workshop_wait\` says nothing is waiting twice in a row. End with one line: why you stopped.
`;
  const claudeMd = `# The ${w.system} workshop

The DM launcher runs Claude here to answer the Tavern Master workshop for ${w.system}, through
the \`tavern-master\` tools only. \`/workshop\` answers it. Do not create or edit files here.
`;
  const files = { 'CLAUDE.md': claudeMd, '.claude/skills/workshop/SKILL.md': skill };
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

/**
 * The connector for one run, signed in with the launcher's token, so a
 * background run needs no browser sign-in. It sits beside the config, which
 * already holds the token, rather than in the campaign folder. A campaign's
 * run gets that campaign's address; a workshop's the account-wide one, as the
 * workshop tools refuse a connection for one campaign.
 */
function mcpConfig(s, c) {
  mkdirSync(MCP, { recursive: true });
  const path = join(MCP, `${c.folder}.json`);
  const server = {
    type: 'http',
    url: c.kind === 'workshop' ? `${s.server}/mcp` : `${s.server}/mcp/c/${c.id}`,
    headers: { Authorization: `Bearer ${s.token}` },
  };
  writeFileSync(path, JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2), { mode: 0o600 });
  return path;
}

// ------------------------------------------------------------ claude

let claudeCmd = null;
function findClaude(s) {
  if (claudeCmd) return claudeCmd;
  if (s.claude) return (claudeCmd = { file: s.claude, shell: /\.(cmd|bat)$/i.test(s.claude) });
  if (WIN) {
    const found =
      spawnSync('where', ['claude'], { encoding: 'utf8' }).stdout?.split(/\r?\n/).filter(Boolean) ?? [];
    const exe = found.find((p) => /\.exe$/i.test(p));
    const cmd = found.find((p) => /\.cmd$/i.test(p));
    if (exe) return (claudeCmd = { file: exe, shell: false });
    if (cmd) return (claudeCmd = { file: cmd, shell: true });
  }
  // The native installer's home, which is not always on PATH.
  const native = join(homedir(), '.local', 'bin', WIN ? 'claude.exe' : 'claude');
  if (existsSync(native)) return (claudeCmd = { file: native, shell: false });
  if (WIN)
    throw new Error('Claude Code was not found. Install it, or set "claude" in the config to its path.');
  return (claudeCmd = { file: 'claude', shell: false });
}

function spawnClaude(s, cwd, mcpPath, signIn, command) {
  const args = [
    '-p',
    command,
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    mcpPath,
    '--strict-mcp-config',
    // The folder's .claude/settings.json allows these too, but Claude Code ignores a
    // folder's permissions until someone trusts it interactively. A flag needs no trust.
    '--allowedTools',
    `mcp__${SERVER_NAME}`,
  ];
  const { file, shell } = findClaude(s);
  const opts = {
    cwd,
    env: { ...process.env, ...signIn.env },
    windowsHide: true,
    detached: !WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  // A .cmd shim only runs through the shell; quote everything for it.
  if (shell) return spawn([file, ...args].map((a) => `"${a}"`).join(' '), { ...opts, shell: true });
  return spawn(file, args, opts);
}

/** Stop a run and everything it started (subagents, the shell around a .cmd shim). */
function killTree(proc) {
  if (!proc.pid || proc.exitCode !== null) return;
  if (WIN) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  }
}

// ------------------------------------------------------------ Claude's sign-ins

/** How long a sign-in sits out when it is out of usage or signed out, unless Claude says when its limit resets. */
const SIGN_IN_REST_MS = 30 * 60_000;

/**
 * Claude Code's sign-ins, best first: the main one (CLAUDE_CODE_OAUTH_TOKEN, or
 * the /login kept on this computer), then the backup token when there is one.
 * A sign-in that runs out of usage or is signed out sits out for a while, so new runs use the other.
 */
let signIns = [];
function setSignIns(s) {
  signIns = [{ name: 'main sign-in', env: {}, restUntil: 0 }];
  if (s.claudeBackupToken)
    signIns.push({
      name: 'backup token',
      env: { CLAUDE_CODE_OAUTH_TOKEN: s.claudeBackupToken },
      restUntil: 0,
    });
}

/** The first sign-in not sitting out; when every one is, the one back soonest. */
function pickSignIn(now = Date.now()) {
  return (
    signIns.find((x) => x.restUntil <= now) ?? signIns.reduce((a, b) => (b.restUntil < a.restUntil ? b : a))
  );
}

/**
 * Sit a sign-in out after a run on it failed. A usage limit that names its reset
 * ("…limit reached|1731888000") sits out until then; anything else for a while.
 */
function restSignIn(signIn, error) {
  const now = Date.now();
  const resetAt = Number(/\|(\d{10})\b/.exec(error ?? '')?.[1]) * 1000;
  const until =
    resetAt > now ? Math.min(resetAt + 60_000, now + 7 * 24 * 60 * 60_000) : now + SIGN_IN_REST_MS;
  signIn.restUntil = Math.max(signIn.restUntil, until);
}

// ------------------------------------------------------------ the log

const logs = new Map();
function logFile(folder) {
  return join(LOGS, `${folder}.log`);
}
function logStream(folder) {
  let out = logs.get(folder);
  if (out) return out;
  mkdirSync(LOGS, { recursive: true });
  const path = logFile(folder);
  try {
    if (statSync(path).size > 5 * 1024 * 1024) renameSync(path, `${path}.old`);
  } catch {
    /* no log yet */
  }
  out = createWriteStream(path, { flags: 'a' });
  logs.set(folder, out);
  return out;
}

const stamp = () => new Date().toLocaleTimeString([], { hour12: false });

/** A line in the campaign's log, and on the console. */
function log(c, line) {
  const text = `${stamp()}  ${line}`;
  logStream(c.folder).write(`${text}\n`);
  console.log(`[${c.name}] ${line}`);
}
/** A line in the campaign's log only: what Claude is doing, for `watch`. */
function trace(c, line) {
  logStream(c.folder).write(`${stamp()}  ${line}\n`);
  if (echo) console.log(`[${c.name}]   ${line}`);
}
let echo = false;

/** Claude Code's answer when it has no sign-in, or one that no longer works. */
const SIGNED_OUT = /not logged in|\/login|invalid api key|oauth token|authenticat/i;
/**
 * A sign-in out of usage until its limit resets: "Claude AI usage limit
 * reached|1731888000", "You've hit your limit · resets 3pm", "You've hit your
 * org's monthly spend limit … your weekly limit resets Nov 20".
 */
const OUT_OF_USAGE =
  /usage limit|limit reached|hit your [\w’' ]*limit|limit (will )?resets?|spend(ing)? limit|out of (extra )?usage|credit balance/i;

const short = (v, n = 160) => {
  const s = (typeof v === 'string' ? v : JSON.stringify(v ?? '')).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const toolName = (n) => n.replace(`mcp__${SERVER_NAME}__`, '');

/**
 * One line of Claude's stream-json, made readable. Returns the connector's
 * status from the start-up line, and the error when the run ends in one.
 */
function readEvent(c, raw) {
  let e;
  try {
    e = JSON.parse(raw);
  } catch {
    if (raw.trim()) trace(c, raw.trim());
    return;
  }
  if (e.type === 'system' && e.subtype === 'init') {
    const mcp = e.mcp_servers?.find((m) => m.name === SERVER_NAME);
    trace(c, `Claude started (${e.model ?? 'model unknown'}); ${SERVER_NAME}: ${mcp?.status ?? 'missing'}`);
    return { mcp: mcp?.status ?? 'missing' };
  }
  if (e.type === 'assistant') {
    for (const part of e.message?.content ?? []) {
      if (part.type === 'text' && part.text.trim()) trace(c, `Claude: ${short(part.text, 400)}`);
      if (part.type === 'tool_use') trace(c, `→ ${toolName(part.name)} ${short(part.input, 200)}`);
    }
  } else if (e.type === 'user') {
    for (const part of e.message?.content ?? []) {
      if (part.type !== 'tool_result') continue;
      const text = Array.isArray(part.content)
        ? part.content.map((p) => p.text ?? '').join(' ')
        : part.content;
      trace(c, `${part.is_error ? '  ✗' : '  ←'} ${short(text)}`);
    }
  } else if (e.type === 'result') {
    const cost = typeof e.total_cost_usd === 'number' ? `, $${e.total_cost_usd.toFixed(2)}` : '';
    trace(c, `Run ended: ${e.subtype}, ${e.num_turns ?? '?'} turns${cost}. ${short(e.result ?? '', 300)}`);
    if (e.is_error) {
      const error = String(e.result ?? e.subtype ?? 'error');
      return { error, signedOut: SIGNED_OUT.test(error) };
    }
    // Claude Code can end a run out of usage as a "success" and then exit 1:
    // keep the text, so runEnded can tell why when the exit code says it failed.
    return { result: String(e.result ?? '') };
  }
}

// ------------------------------------------------------------ keeping tables staffed

/** Per campaign: the run in progress, and when the next may start. */
const tables = new Map();

function startRun(s, c, t) {
  const workshop = c.kind === 'workshop';
  (workshop ? Promise.resolve().then(() => workshopFolder(s, c)) : ensureFolder(s, c))
    .then((cwd) => {
      t.preparing = false;
      if (t.proc || stopping) return;
      const signIn = pickSignIn();
      const proc = spawnClaude(s, cwd, mcpConfig(s, c), signIn, workshop ? '/workshop' : '/dm');
      Object.assign(t, {
        proc,
        signIn,
        startedAt: Date.now(),
        unwantedSince: null,
        quietSince: null,
        stopReason: null,
        mcpProblem: null,
        claudeError: null,
        lastResult: null,
      });
      const on = signIns.length > 1 ? `, on the ${signIn.name}` : '';
      log(
        c,
        workshop
          ? `Claude is coming to the workshop (${c.waiting} message${c.waiting === 1 ? '' : 's'} waiting${on}).`
          : `Claude is coming to the table (${c.players} player${c.players === 1 ? '' : 's'} there${on}).`,
      );
      createInterface({ input: proc.stdout }).on('line', (line) => {
        const r = readEvent(c, line);
        if (r?.error) t.claudeError = r.error;
        if (r?.result !== undefined) t.lastResult = r.result;
        if (r?.signedOut) {
          t.mcpProblem = 'signed-out';
          const fix =
            signIn === signIns[0]
              ? 'Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), or run `claude` once and type /login.'
              : 'Make a new one with `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN_BACKUP.';
          log(c, `Claude Code's ${signIn.name} does not work ("${short(r.error, 200)}"). ${fix}`);
        }
        // 'pending' means still connecting; only a definite failure is worth stopping for.
        if (r?.mcp && ['failed', 'needs-auth', 'missing'].includes(r.mcp)) {
          t.mcpProblem = r.mcp;
          stopRun(
            c,
            t,
            `the connector is ${r.mcp}. Check the server address and token, then it retries in 5 min`,
          );
        }
      });
      createInterface({ input: proc.stderr }).on(
        'line',
        (line) => line.trim() && trace(c, `! ${line.trim()}`),
      );
      proc.on('error', (err) => log(c, `Could not start Claude: ${err.message}`));
      proc.on('close', (code) => runEnded(c, t, code));
    })
    .catch((err) => {
      t.preparing = false;
      t.holdUntil = Date.now() + 60_000;
      log(c, `Could not prepare the folder: ${err.message}`);
    });
  t.preparing = true;
}

function stopRun(c, t, reason) {
  if (!t.proc || t.stopReason) return;
  t.stopReason = reason;
  log(c, `Stopping Claude: ${reason}.`);
  killTree(t.proc);
}

function runEnded(c, t, code) {
  const ran = Date.now() - (t.startedAt ?? Date.now());
  const why = t.stopReason
    ? 'stopped'
    : code === 0
      ? `Claude left the ${c.kind === 'workshop' ? 'workshop' : 'table'}`
      : `Claude exited with code ${code}`;
  t.proc = null;
  // A run that exits non-zero after a "success" result failed for the reason that result gives.
  if (!t.claudeError && code !== 0 && t.lastResult) t.claudeError = t.lastResult;
  // The sign-in itself failing (out of usage, signed out): sit it out and use
  // another. A passing API error or a crash is not the sign-in's fault, and
  // backs off below instead of spending the backup's usage.
  const claudeFailed =
    !t.stopReason &&
    (t.mcpProblem === 'signed-out' || (!t.mcpProblem && OUT_OF_USAGE.test(t.claudeError ?? '')));
  if (claudeFailed && t.signIn) {
    restSignIn(t.signIn, t.claudeError);
    const next = pickSignIn();
    if (next !== t.signIn && next.restUntil <= Date.now()) {
      t.holdUntil = Date.now() + 5_000;
      const back = new Date(t.signIn.restUntil).toLocaleTimeString([], { hour12: false });
      log(
        c,
        `${why} on the ${t.signIn.name}${t.claudeError ? ` ("${short(t.claudeError, 200)}")` : ''}. ` +
          `Switching to the ${next.name}; the ${t.signIn.name} is tried again after ${back}.`,
      );
      return;
    }
  }
  if (t.mcpProblem) {
    t.holdUntil = Date.now() + 5 * 60_000;
    if (t.mcpProblem === 'signed-out') log(c, 'Trying again in 5 min.');
  } else if (!t.stopReason && (code !== 0 || ran < 60_000)) {
    // Failing fast: back off so a broken setup does not spin.
    t.failures = (t.failures ?? 0) + 1;
    const wait = Math.min(30_000 * 2 ** (t.failures - 1), 10 * 60_000);
    t.holdUntil = Date.now() + wait;
    log(
      c,
      `${why} after ${Math.round(ran / 1000)}s; trying again in ${Math.round(wait / 1000)}s. See: dm-launcher watch "${c.folder}"`,
    );
    return;
  } else {
    t.failures = 0;
    t.holdUntil = Date.now() + 10_000;
  }
  log(c, `${why} after ${Math.round(ran / 60_000)} min.`);
}

let stopping = false;
let lastError = '';

/** A workshop as the launcher keeps it: beside the campaigns, under its own key. */
const asWorkshop = (w) => ({
  ...w,
  kind: 'workshop',
  key: `workshop:${w.id}`,
  system: w.name,
  name: `${w.name} workshop`,
});

/** Start or stop the run for one game system's workshop. */
function tendWorkshop(s, w, now, idleMs) {
  const t = tables.get(w.key) ?? { holdUntil: 0 };
  tables.set(w.key, t);
  t.c = w;
  const wanted = w.waiting > 0;
  if (t.proc) {
    t.preparing = false;
    // The run leaves on its own once nothing waits; these catch one that does not.
    t.unwantedSince = wanted ? null : (t.unwantedSince ?? now);
    t.quietSince = wanted ? (t.quietSince ?? now) : null;
    if (t.unwantedSince && now - t.unwantedSince > idleMs)
      stopRun(w, t, `nothing waiting in the workshop for ${s.idleMinutes} min`);
    else if (t.quietSince && now - t.quietSince > idleMs)
      stopRun(w, t, `no answer from Claude for ${s.idleMinutes} min while an admin waits`);
  } else if (wanted && !t.preparing && now >= t.holdUntil) {
    startRun(s, w, t);
  }
}

async function tick(s) {
  let campaigns;
  let workshops;
  try {
    ({ campaigns, workshops = [] } = await api(s, '/api/summon'));
    if (lastError) console.log('Server reachable again.');
    lastError = '';
  } catch (err) {
    if (err.message !== lastError) console.error(`Cannot reach ${s.server}: ${err.message}`);
    lastError = err.message;
    return;
  }
  const now = Date.now();
  const idleMs = s.idleMinutes * 60_000;
  const seen = new Set();
  for (const c of campaigns) {
    seen.add(c.id);
    const t = tables.get(c.id) ?? { holdUntil: 0 };
    tables.set(c.id, t);
    t.c = c;
    if (t.proc) {
      t.preparing = false;
      const busy = c.dm.state === 'working';
      t.unwantedSince = c.wanted ? null : (t.unwantedSince ?? now);
      t.quietSince = c.wanted && !busy && c.dm.state !== 'listening' ? (t.quietSince ?? now) : null;
      if (t.unwantedSince && !busy && now - t.unwantedSince > idleMs)
        stopRun(c, t, `nobody at the table for ${s.idleMinutes} min`);
      else if (t.quietSince && now - t.quietSince > idleMs)
        stopRun(c, t, `no word from Claude for ${s.idleMinutes} min while players wait`);
    } else if (c.wanted && !t.preparing && now >= t.holdUntil) {
      startRun(s, c, t);
    } else if (!c.wanted) {
      t.preparing = false;
    }
  }
  for (const raw of workshops) {
    const w = asWorkshop(raw);
    seen.add(w.key);
    tendWorkshop(s, w, now, idleMs);
  }
  // Switched back to the built-in AI, archived or deleted: no reason to stay.
  for (const [id, t] of tables)
    if (!seen.has(id) && t.proc)
      stopRun(
        t.c,
        t,
        t.c.kind === 'workshop'
          ? 'the workshop is no longer answered by Claude'
          : 'the campaign is no longer run by Claude',
      );
}

async function run(s) {
  requireServer(s);
  echo = s.echo;
  setSignIns(s);
  findClaude(s);
  mkdirSync(s.dir, { recursive: true });
  console.log(`Watching ${s.server} for tables that need Claude. Campaign folders: ${s.dir}`);
  if (s.claudeBackupToken)
    console.log('A backup Claude Code token is set; runs move to it when the main sign-in fails.');
  console.log(`Logs: ${LOGS}  (follow one with: node scripts/dm-launcher.mjs watch <name>)`);
  const shutdown = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('Stopping every run…');
    for (const t of tables.values()) if (t.proc) stopRun(t.c, t, 'the launcher is shutting down');
    setTimeout(() => process.exit(0), 3000).unref();
    const left = () => [...tables.values()].some((t) => t.proc);
    const check = setInterval(() => !left() && process.exit(0), 200);
    check.unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  for (;;) {
    if (stopping) return;
    await tick(s);
    await new Promise((r) => setTimeout(r, s.pollSeconds * 1000));
  }
}

// ------------------------------------------------------------ the other commands

function setup(f) {
  const s = settings(f);
  requireServer(s);
  mkdirSync(HOME, { recursive: true });
  const keep = { ...readConfig() };
  for (const k of Object.keys(DEFAULTS)) if (f[k] !== undefined) keep[k] = s[k];
  keep.server = s.server;
  keep.token = s.token;
  writeFileSync(CONFIG, `${JSON.stringify(keep, null, 2)}\n`, { mode: 0o600 });
  console.log(`Saved ${CONFIG}. Checking the server…`);
  return status(s);
}

async function status(s) {
  requireServer(s);
  const { campaigns, workshops = [] } = await api(s, '/api/summon');
  if (!campaigns.length) console.log('No active campaigns of yours are run by Claude.');
  for (const c of campaigns) {
    const seen = c.dm.lastSeenAt ? `, last seen ${new Date(c.dm.lastSeenAt).toLocaleString()}` : '';
    console.log(
      `${c.name}  [${c.folder}]  players: ${c.players}  Claude: ${c.dm.state}${seen}${c.wanted ? '  ← wanted' : ''}`,
    );
  }
  for (const w of workshops)
    console.log(`${w.name} workshop  [${w.folder}]  waiting: ${w.waiting}${w.waiting ? '  ← wanted' : ''}`);
}

/** Follow a campaign's log: the last lines, then everything new as it is written. */
function watch(f) {
  const want = f._[1]?.toLowerCase();
  const files = existsSync(LOGS) ? readdirSync(LOGS).filter((n) => n.endsWith('.log')) : [];
  const pick = want
    ? (files.find((n) => n === `${want}.log`) ??
      files.find((n) => n.startsWith(want.replace(/[^a-z0-9]+/g, '-'))))
    : files.sort((a, b) => statSync(join(LOGS, b)).mtimeMs - statSync(join(LOGS, a)).mtimeMs)[0];
  if (!pick) {
    console.error(
      files.length ? `No log matches "${want}". There are: ${files.join(', ')}` : 'No runs logged yet.',
    );
    process.exit(1);
  }
  const path = join(LOGS, pick);
  const text = readFileSync(path, 'utf8');
  console.log(`— ${pick} (Ctrl+C to stop watching; Claude keeps running) —`);
  process.stdout.write(text.split('\n').slice(-40).join('\n'));
  let pos = statSync(path).size;
  watchFile(path, { interval: 500 }, (cur) => {
    if (cur.size < pos) pos = 0; // rotated
    if (cur.size === pos) return;
    createReadStream(path, { start: pos, end: cur.size - 1 }).pipe(process.stdout, { end: false });
    pos = cur.size;
  });
}

const f = flags(process.argv.slice(2));
const cmd = f._[0] ?? 'run';
const main = {
  run: () => run(settings(f)),
  setup: () => setup(f),
  status: () => status(settings(f)),
  watch: () => watch(f),
}[cmd];
if (!main) {
  console.error(`Unknown command "${cmd}". Use run, setup, status or watch.`);
  process.exit(1);
}
Promise.resolve(main()).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
