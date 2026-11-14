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
http/       request hooks: session lookup, CSRF, origin checks, campaign
            membership, receiving uploads
routes/     REST endpoints, one file per area
db/         connection pool and migration runner
llm/        provider interface and implementations, pricing, usage
rules/      upload parsing, chunking, embeddings, retrieval, cataloguing
agent/      dice, game state, DM tools, prompt context and brief, agent loop,
            summaries, companions, the character guide, reading sheets
realtime/   websocket rooms, turn collection, chat messages
connector/  the remote MCP endpoint that lets Claude be every AI in a
            campaign: tokens, the turn desk, the work queue, presence, the
            tool gate, one module per kind of request, the campaign folder
oauth/      sign-in for the connector: discovery, client registration,
            approval, tokens
campaign.ts creating, changing, beginning and pausing a campaign (used by
            routes and by the connector)
jobs/       background queue
party.ts    who is in a party and who may change what (used by routes and
            by the guide, so both follow the same rules)
```

There are four agents, each with its own prompt and its own slice of the data:

| Agent | File | Sees | Can change |
|---|---|---|---|
| DM | `agent/context.ts`, `agent/tools.ts` | everything in the campaign | game state through its tools |
| Companion | `agent/companion.ts` | its sheet, the public story, this turn | nothing: it returns one action |
| Guide | `agent/builder.ts` | rules, premise, table-visible documents, one sheet | that one sheet |
| Sheet reader | `agent/sheets.ts` | one upload | nothing: it returns a draft |
| Claude, in a Claude campaign | `connector/` | per request: a turn as the DM sees it, a guide chat as the guide does, one upload, one document, the chronicle | per request: game state, that one sheet, a draft, a catalogue entry, the chronicle |

Keep them separate. A companion or the guide given the DM's prompt would know
the plot.

In a Claude campaign one model the server does not control plays every one of
those roles, so the same rule applies to it as to the built-in loop: every
permission lives in the tools, never in its instructions.

- **Which campaign.** On a pinned address (`/mcp/c/<id>`) the address decides;
  on `/mcp` it is the connection's last `open_campaign`, rechecked for
  ownership on every call, and every result starts with that campaign's name.
  No tool takes a campaign as an argument.
- **Which address.** A connection made by signing in is valid only on the
  address it was approved for; a hand-made token is valid on both.
- **Which tools, now.** Each connector tool declares when it may run
  (`during`): always, only when Claude holds nothing, only during a turn, or
  only while it holds a request of one kind. `gated()` in
  `connector/tools.ts` enforces it. This is what keeps a player's words to the
  guide from ever running a DM-only tool, so a new tool needs the narrowest
  `during` that works.

A new GM tool reaches the connector automatically; give it a player-safe line
in `publicSummary` and, if it changes state, add it to `STATE_TOOLS`. A new
campaign-scoped model call must go behind `requireServerAi` (or check the
campaign's mode) and have a Claude path: a kind of request in the work queue
with its handler and tools in `connector/`.

Prompt order matters for cost. The DM request is built most-stable-first
(`buildPrompt`): instructions, the stored brief, recent history, then the
volatile tail. Anything that changes per turn belongs in the tail; putting it
earlier silently stops the prompt cache from hitting. Watch
`cache_read_tokens` in `usage_events` when you touch it.

Inside `apps/web/src`:

```
main.tsx    entry: providers, router, service worker registration
routes.tsx  route table and the tab-bar shell
app.tsx     session, toasts, data-loading hooks
api.ts      fetch wrapper (CSRF token, error shape)
ui.tsx      shared components: sheets, fields, avatars
install.tsx the "Add to Home Screen" prompt
screens/    one file per screen (prep.tsx is a campaign's lobby, play.tsx the story)
play/       the table's parts: socket, story feed, composer, party and sheet
            editor, the guide chat, campaign documents
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
  provider layer, tool dispatch, party permissions or what a companion is
  shown needs a test. Most tests are pure and need no database; the ones that
  do skip themselves when `TEST_DATABASE_URL` is not set. To run them locally,
  create a second database in the dev container and point at it:

  ```bash
  docker compose -f docker-compose.dev.yml exec db createdb -U tavern tavern_test
  TEST_DATABASE_URL=postgres://tavern:tavern@localhost:55432/tavern_test npm test
  ```
- **Migrations** are append-only SQL files in `apps/server/migrations`. Never
  edit one that has been released; add a new one.
- **Configuration** is by environment variable only. A new variable needs an
  entry in `apps/server/src/config.ts` and a commented line in
  `.env.example`.
- **Security-sensitive changes** (auth, sessions, `oauth/`, uploads, tool
  permissions and the connector's tool gate, anything that widens what the
  DM's tools can do) should say so in the pull request description.
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
