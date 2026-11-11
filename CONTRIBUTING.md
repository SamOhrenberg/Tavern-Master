# Contributing

Thanks for taking an interest. This is a small hobby project; the bar for
contributions is "it works, it is tested where it matters, and it does not
make self-hosting harder".

## Getting set up

- Node 20.19+ (22 recommended) and Docker.
- `npm install` at the repo root installs all workspaces.
- `npm run dev:db` starts Postgres with pgvector on `localhost:55432`.
- `npm run dev` starts the API, the worker and the web client together.

Set `LLM_PROVIDER=mock` in `.env` to work without an API key. Settings that
only apply to your machine go in `.env.local`, which the dev scripts load
after `.env`; the README lists the lines it needs.

## Layout

```
apps/server        API, websocket hub, DM agent, worker, SQL migrations
apps/web           React client
packages/protocol  Types shared between the two (type-only)
docker/            Dockerfile and reverse-proxy examples
```

Inside `apps/server/src`:

```
auth/       passwords, sessions, TOTP, invites
security/   crypto helpers, rate limiter, response headers
http/       request hooks: session lookup, CSRF, origin checks
routes/     REST endpoints, one file per area
db/         connection pool and migration runner
llm/        provider interface and implementations, pricing, usage
rules/      upload parsing, chunking, embeddings, retrieval
agent/      dice, game state, DM tools, prompt context, agent loop, summaries
realtime/   websocket rooms, turn collection, chat messages
jobs/       background queue
```

Inside `apps/web/src`:

```
main.tsx    entry: providers, router, service worker registration
routes.tsx  route table and the tab-bar shell
app.tsx     session, toasts, data-loading hooks
api.ts      fetch wrapper (CSRF token, error shape)
ui.tsx      shared components: sheets, fields, avatars
install.tsx the "Add to Home Screen" prompt
screens/    one file per screen
play/       the play screen's parts: socket, story feed, composer, sheets
styles/     plain CSS; tokens in base.css
```

The client is designed for a phone first. Check changes at 393 px and 430 px
wide before anything else, keep tap targets at 44 px or more, and keep form
fields at 16 px text so iOS does not zoom the page on focus. The server's
Content-Security-Policy allows no inline scripts or styles, so the production
build (`npm run build && npm run start`) is the one to test against before a
release.

## Before you open a pull request

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
```

- **Tests.** Anything touching dice, turn collection, retrieval scoping, the
  provider layer or tool dispatch needs a test. Most tests are pure and need
  no database; the ones that do skip themselves when `TEST_DATABASE_URL` is
  not set.
- **Migrations** are append-only SQL files in `apps/server/migrations`. Never
  edit one that has been released; add a new one.
- **Configuration** is by environment variable only. A new variable needs an
  entry in `apps/server/src/config.ts` and a commented line in
  `.env.example`.
- **Security-sensitive changes** (auth, sessions, uploads, tool permissions,
  anything that widens what the DM's tools can do) should say so in the pull
  request description.
- **Commits** are small, one logical change each, with a short plain-English
  subject.

## Design principles

1. Self-hosting comes first. A new container, volume or external service
   needs a strong reason.
2. The model writes prose; tools establish facts. Do not move game logic into
   prompts.
3. Player text and uploaded documents are untrusted input everywhere.
4. Prefer a finished vertical slice to broad scaffolding.

## Reporting security issues

Please do not open a public issue. Use GitHub's private vulnerability
reporting on this repository (Security → Report a vulnerability) so the
problem can be fixed before it is disclosed.
