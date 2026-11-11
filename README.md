# Tavern Master

A self-hosted AI Dungeon Master for you and a few friends. Upload the rules of
the game you play, start a campaign, and play together in real time with a DM
that looks rules up instead of guessing, rolls real dice, and keeps track of
the party in structured state rather than in its memory.

- **Self-hosted first.** One `docker compose up -d` on a home server. Only the
  LLM is an external API; the database, vector search, embeddings, uploads and
  job queue all run on your hardware.
- **Any rules system.** Admins create game systems and upload PDFs, Markdown
  or text. The DM retrieves from the campaign's system only, and cites it.
- **Multiplayer.** Friends, campaign invites, real-time play. Actions from
  several players are gathered into one turn with clear attribution.
- **Long campaigns.** Session summaries and a campaign memory keep the prompt
  small and the story consistent.
- **An app on your phone.** The client is built phone-first and installs to
  the Home Screen on iOS and Android, where it runs full screen.
- **Bring any model.** Anthropic API, AWS Bedrock, Azure AI Foundry or any
  OpenAI-compatible endpoint, with per-task model routing, prompt caching,
  token budgets and cost tracking.
- **Built for the open internet.** Invite-only sign-up, argon2id, TOTP,
  rate limiting, CSRF protection, strict headers, non-root read-only
  containers.

## Quick start

Requirements: Docker with the Compose plugin, and an LLM API key.

```bash
git clone https://github.com/SamOhrenberg/RPG.git tavern && cd tavern
cp .env.example .env
# edit .env: set SECRET_KEY, ENCRYPTION_KEY, POSTGRES_PASSWORD,
#            ADMIN_PASSWORD and ANTHROPIC_API_KEY
docker compose up -d
```

Open <http://localhost:8080>, sign in as the admin from `.env`, enrol 2FA when
prompted, and then:

1. **Systems → New system**, then upload a rules document. Watch it go from
   *queued* to *ready*. (A small SRD-based system is seeded for you.)
2. **Admin → Invites** to create invite codes for your friends.
3. **Campaigns → New campaign**, pick the system, invite a friend.
4. Each player creates a character and types an action. The DM answers the
   whole table at once.

No API key yet? Set `LLM_PROVIDER=mock` to try the full flow with a scripted
DM that still rolls real dice and searches your rules.

Every setting is an environment variable; `.env.example` documents all of
them. Reverse-proxy examples for Traefik, Caddy and Nginx Proxy Manager are in
[`docker/proxy/`](docker/proxy).

## Architecture

Three containers. `web` and `worker` are the same image started with
different commands.

```mermaid
flowchart LR
  browser[Browser SPA] -- HTTPS + WSS --> proxy[Your reverse proxy]
  proxy --> web
  subgraph compose[Docker Compose]
    web[web<br/>Fastify API + WebSocket<br/>serves SPA, runs the DM agent]
    worker[worker<br/>ingestion, summaries<br/>local embedding model]
    db[(db<br/>PostgreSQL + pgvector)]
    web --> db
    worker --> db
    web -- embed query --> worker
  end
  web -- streaming completions --> llm[(LLM API)]
  worker -- summaries --> llm
```

| Concern | Choice | Why |
|---|---|---|
| Backend | Node 22, TypeScript, Fastify | one runtime and one image for API, websocket and worker |
| Frontend | React + Vite, served as static files by `web` | no separate frontend container |
| Database | PostgreSQL 17 | relational data, vectors, full-text search and the job queue in one place; `pg_dump` is the backup |
| Vector search | pgvector, exact scan filtered by game system, fused with full-text rank | 100 % recall at this scale, no extra service |
| Auth | argon2id, server-side sessions in HttpOnly cookies, TOTP | revocable, nothing sensitive readable by scripts |
| Realtime | one WebSocket per open campaign | bidirectional and streams DM output |
| Files | a local volume, random names, never served back | no object store to run |
| Jobs | a `jobs` table claimed with `FOR UPDATE SKIP LOCKED` | no Redis |
| LLM | a small provider interface with per-task models | swap providers by env var |

**The DM is a tool-calling loop.** The model writes prose; everything that
must be true is done by a tool. Dice are rolled by the server, rules come from
retrieval scoped to the campaign's system, and characters, inventory, NPCs,
quests and flags change only through validated writes that are logged and
shown to the players. Player messages and uploaded documents are treated as
untrusted data: tools enforce campaign scoping and ownership themselves, so a
prompt injection cannot do anything the tools do not allow.

**Turns are "ready-or-timeout".** A turn opens on the first action and closes
when every present player has acted or passed, when the gather window expires,
or when the owner sends it early. The server serialises the turn with each
action attributed to its player and character before the DM sees it.

**Memory is layered.** Recent turns are kept verbatim; older ones are folded
into rolling summaries and durable campaign facts by a cheaper model, so the
prompt stays roughly the same size however long the campaign runs.

**Security defaults.** Only `web` is reachable from the proxy; the database is
on an internal-only network. Containers run as a non-root user with read-only
filesystems and no capabilities. The app sets its own CSP, HSTS and related
headers, trusts `X-Forwarded-For` only from configured proxy addresses, and
encrypts stored API keys with a key from the environment.

### Footprint

About 250–330 MB RAM and well under 1 % of a core at idle; around 700 MB at
peak while a rulebook is being embedded. Images are published for
`linux/amd64` and `linux/arm64`.

### Repository layout

```
apps/server        API, websocket hub, DM agent, worker, SQL migrations
apps/web           React client
packages/protocol  Types shared between the two (type-only)
docker/            Dockerfile and reverse-proxy examples
```

## Development

Requirements: Node 20.19 or newer, and Docker for the database.

```bash
npm install
npm run dev:db          # Postgres with pgvector on localhost:55432
cp .env.example .env    # set SECRET_KEY, ENCRYPTION_KEY and ADMIN_PASSWORD
```

Set `LLM_PROVIDER=mock` in `.env` to work without an API key. Then create
`.env.local` beside it for the settings that only apply to your machine; the
dev scripts load it after `.env`, so it wins:

```ini
DATABASE_URL=postgres://tavern:tavern@localhost:55432/tavern
DATA_DIR=../../data
HOST=127.0.0.1
BASE_URL=http://localhost:8080
WORKER_URL=http://127.0.0.1:8081
```

```bash
npm run dev     # API on :8080, the worker, and the web client on :5173
npm test
```

Open <http://localhost:5173> and sign in as the admin from `.env`. The three
processes can also be started one at a time with `npm run dev:server`,
`npm run dev:worker` and `npm run dev:web`.

### On a phone

The dev server listens on your network, so a phone on the same Wi-Fi can open
`http://<your computer's address>:5173` (Vite prints the address when it
starts). The first visit in Safari shows how to add the app to the Home
Screen; from there it opens full screen like any other app.

Installing works over plain HTTP on a home network. The service worker, which
makes the app open instantly from cache, needs HTTPS and so is only active
behind a TLS-terminating proxy or on `localhost`.

To try the production build instead of the dev server:

```bash
npm run build
npm run start   # serves the API and the built client on :8080
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[MIT](LICENSE). The seeded rules excerpt is from the System Reference
Document 5.1 by Wizards of the Coast LLC, available under the
[Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/legalcode).
