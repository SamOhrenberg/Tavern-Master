# Contributing

Thanks for taking an interest. This is a small hobby project; the bar for
contributions is "it works, it is tested where it matters, and it does not
make self-hosting harder".

## Getting set up

- Node 20.19+ (22 recommended) and Docker.
- `npm install` at the repo root installs all workspaces.
- `docker compose -f docker-compose.dev.yml up -d` starts Postgres with
  pgvector on `localhost:5432`.
- `npm run dev:server`, `npm run dev:worker`, `npm run dev:web`.

Set `LLM_PROVIDER=mock` in `.env` to work without an API key.

## Layout

```
apps/server        API, websocket hub, DM agent, worker, SQL migrations
apps/web           React client
packages/protocol  Types shared between the two (type-only)
docker/            Dockerfile and reverse-proxy examples
```

Inside `apps/server/src`:

```
auth/       passwords, sessions, TOTP
security/   crypto helpers, rate limiter, response headers
http/       request hooks: session lookup, CSRF, origin checks
routes/     REST endpoints, one file per area
db/         connection pool and migration runner
llm/        provider interface and implementations, pricing, usage
embeddings/ local and remote embedding providers
ingest/     upload validation, parsing, chunking
rag/        rules retrieval
game/       dice, turn collection, state, DM tools and agent loop
realtime/   websocket rooms
jobs/       background queue
```

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
