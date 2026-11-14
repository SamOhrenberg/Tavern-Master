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
- **A party, not just a player.** Each campaign has its own characters. Fill
  the party out with companions that are played by a player (or several), by
  the DM, or by a separate AI that knows only what the character has seen.
- **A prep phase.** Before the first scene, build characters by hand, in a
  chat with a guide that knows the rules, or from an uploaded sheet; add
  campaign documents; and tell the DM what you hope the story holds, or leave
  it all to the DM.
- **Long campaigns.** The DM keeps a notebook, durable facts and rolling
  summaries, and can search everything ever said at the table, so the prompt
  stays small and the story stays consistent.
- **An app on your phone.** The client is built phone-first and installs to
  the Home Screen on iOS and Android, where it runs full screen.
- **Bring any model.** Anthropic API, AWS Bedrock, Azure AI Foundry or any
  OpenAI-compatible endpoint, with per-task model routing, prompt caching,
  token budgets and cost tracking.
- **Or run the DM from the Claude app.** The server is also a remote MCP
  connector: add it to Claude, and the host runs a campaign's DM from a chat
  on their own Claude plan while friends play in the app as usual.
- **Built for the open internet.** Invite-only sign-up, argon2id, TOTP,
  rate limiting, CSRF protection, strict headers, non-root read-only
  containers.

## Quick start

Requirements: Docker with the Compose plugin, and either an LLM API key or a
Claude plan (to run the DM from the Claude app, see below).

```bash
git clone https://github.com/SamOhrenberg/tavern-master.git tavern && cd tavern
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
3. **Campaigns → New campaign**, pick the system. You land in the campaign's
   lobby: invite friends from the menu, build the party, add documents.
4. **Begin the adventure.** The DM plans the story, writes the opening scene,
   and from then on answers the whole table at once.

No API key yet? Set `LLM_PROVIDER=mock` to try the full flow with a scripted
DM that still rolls real dice and searches your rules.

Every setting is an environment variable; `.env.example` documents all of
them.

### On a server, behind a reverse proxy

The image is published to GHCR, so a server needs only `docker-compose.yml`
and a `.env`, not the source:

```bash
mkdir tavern && cd tavern
curl -fsSLO https://raw.githubusercontent.com/SamOhrenberg/tavern-master/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/SamOhrenberg/tavern-master/main/.env.example -o .env
# edit .env, then:
docker compose pull && docker compose up -d
```

The web container serves the app, the API, the websocket and the Claude
connector on one address. With Nginx Proxy Manager:

1. Point a DNS record (say `tavern.example.com`) at your server, with port 443
   forwarded to the proxy.
2. In `.env`, set `BASE_URL=https://tavern.example.com` and `TRUSTED_PROXIES`
   to the proxy's address or Docker network range (`docker network inspect`
   shows it), so rate limits see real client IPs.
3. Let the proxy reach the web container, either through the published port
   (`APP_BIND` set to an address the proxy can reach, forward to that host and
   `APP_PORT`) or by joining the proxy's Docker network with
   [`docker/compose.proxy.example.yml`](docker/compose.proxy.example.yml)
   (forward to `tavern-web-1:8080`).
4. Add a proxy host for the domain: scheme `http`, **Websockets Support** on,
   and a Let's Encrypt certificate with **Force SSL**.

Upgrade with `docker compose pull && docker compose up -d`; migrations run on
start.

### Running the DM from the Claude app

Set a campaign's Dungeon Master to *Claude app* in its Manage menu, and the
host's Claude chat runs the table on their own Claude plan, with no API key
needed for play. Make a token under *You → Claude connector*, then in Claude
add a custom connector with the URL `BASE_URL/mcp` (for example
`https://tavern.example.com/mcp`) and a request header `Authorization` whose
value is `Bearer ` followed by the token. The server must be reachable over
public HTTPS on port 443, since Anthropic's cloud makes the connection. The
campaign's Manage menu gives you the instructions to paste into a Claude
Project for that campaign.

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

**A campaign starts in a lobby.** New campaigns are in a `prep` phase. Players
make characters three ways: a sheet editor drawn from the game system's
template, a private chat with a character-building guide (a separate agent
with the rules, the premise and the table's public documents, which rolls real
dice and writes to the sheet as it goes), or an uploaded sheet (PDF, text or a
photo) that a model reads into a draft for the player to check. The owner
decides whether players keep the sheets or the DM does, and begins the
campaign; the DM then plans in its notebook and writes the opening scene.

**Who plays whom.** Every party member has a controller: one or more players,
the DM, or an AI of its own. A turn waits on *seats*, one per player-run
character, so someone running two characters acts with each. A companion with
its own AI is asked what it does in a separate model call that contains only
its sheet, the story as the players have seen it and this turn's actions. None
of the DM's notes, secrets or DM-only documents are in that call, so it cannot
act on them. Its action then reaches the DM like a player's.

**The DM can live in the Claude app instead.** A campaign's owner can set its
Dungeon Master to *Claude app*. The server then calls no model for play: a
closed turn waits on a *desk* until the owner's Claude chat collects it through
the connector at `BASE_URL/mcp` (`take_turn`), resolves it with the same GM
tools the built-in DM uses, and posts it with `narrate`, which applies the same
secret redaction and codex linking before the table sees it. `open_campaign`
hands a new chat the full DM guide, the brief, the state and the latest play,
so long campaigns survive the chat's context limit, and Claude writes the
rolling summaries itself (`review_chronicle`, `save_chronicle`). The connector
authenticates with per-user bearer tokens made under *You → Claude connector*,
acts only on campaigns that user owns, and needs the server reachable over
public HTTPS on port 443, since Anthropic's cloud makes the connection. Setup
steps are in the app, on that screen and in the campaign's Manage menu.

**Campaign documents.** Any player can upload setting notes, an adventure or
house rules to a campaign. They go through the same ingestion as rulebooks and
are scoped to that one campaign. A cheap model catalogues each one (what it
holds, what kind of thing it is); the DM carries that one-line entry and
searches the document when it is relevant. Documents marked for the DM only
are never shown to the guide or to companions.

**Memory is layered, and cached.** Recent turns are kept verbatim; older ones
are folded into rolling summaries and durable facts by a cheaper model, old
sessions into arcs, and the list of facts is tidied as it grows, so the prompt
stays roughly the same size however long the campaign runs. The DM also keeps
a private notebook (story plan, NPC agendas) and can search the full
transcript when it needs a detail it can no longer see.

All of that is compiled into one *brief* that is stored and left alone between
summaries, which keeps the front of the prompt byte-identical from turn to
turn: instructions, then the brief, then recent history are read from the
provider's prompt cache at a tenth of the price, and only the notes written
since, the state snapshot and the new turn are paid for in full. Per-task
models (`LLM_MODEL_NARRATION`, `_UTILITY`, `_COMPANION`, `_PREP`) keep the
small jobs on a small model, and `LLM_CACHE_TTL` trades cache lifetime against
write cost for slower tables.

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
