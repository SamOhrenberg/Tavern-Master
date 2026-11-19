# Tavern Master

> [!IMPORTANT]
> **A note on how this was built.** This repository is more "vibe-coded" than
> my others. It started as a test of Fable 5.2, and I let it generate large
> swaths of the code freely. I still direct and approve every change, but I'm
> more hands-off here than elsewhere. I use this project as a test bed for
> experimenting with Claude Code features, functions and best practices, so
> expect the code to reflect that.

A self-hosted AI Dungeon Master for you and a few friends. Upload the rules of
the game you play, start a campaign, and play together in real time with a DM
that looks rules up instead of guessing, rolls real dice, and keeps track of
the party in structured state rather than in its memory.

To see it on a phone, from sign-in to a turn at the table, look through the
screenshots in [portfolio.md](portfolio.md).

- **Self-hosted first.** One `docker compose up -d` on a home server. Only the
  LLM is an external API; the database, vector search, embeddings, uploads and
  job queue all run on your hardware.
- **Any rules system.** Admins create game systems and upload PDFs, Markdown
  or text. The DM retrieves from the campaign's system only, and cites it.
  An admin can make a player an owner of one system, who can then shape it
  as an admin would.
- **Homebrew that grows at the table.** Mark a system homebrew and every
  table playing it gets a rules desk: a side chat where the players talk
  rules over with the DM, change them, steer the campaign or point out a bad
  call. What they settle becomes a ruling the DM follows from then on.
- **Sheets shaped by the system.** Each game system defines what its
  character sheet holds: typed fields, tracks like stress or sanity, lists
  like spells and attacks, values the rules work out. The AI drafts the sheet
  from the rulebooks, and admins review it change by change.
- **A workshop for each system.** Before anyone plays, admins talk a system
  over with the AI (built-in, or Claude through the connector). It proposes
  sheet changes and writes a GM guide and rulings that every table follows.
- **Multiplayer.** Friends, campaign invites, real-time play. Actions from
  several players are gathered into one turn with clear attribution. The
  host can make any player an owner, with the host's own access to the
  table; who runs it (the host's AI or Claude) stays the host's.
- **A party, not just a player.** Each campaign has its own characters. Fill
  the party out with companions that are played by a player (or several), by
  the DM, or by a separate AI that knows only what the character has seen.
  Any player can add a companion and choose who plays it.
- **Everyone you have met.** The NPCs tab lists the people and creatures the
  party has run into, with a search and the stat block the DM keeps for each.
  Players see only what the party has learned: lines the DM marks hidden,
  unrevealed secrets and anyone not met yet never leave the server for them.
  Owners can add and edit entries, and can turn on the spoilers to see it all.
- **A prep phase.** Before the first scene, build characters by hand, in a
  chat with a guide that knows the rules, or from an uploaded sheet; add
  campaign documents; and tell the DM what you hope the story holds, or leave
  it all to the DM.
- **Long campaigns.** The DM keeps a notebook, durable facts and rolling
  summaries, and can search everything ever said at the table, so the prompt
  stays small and the story stays consistent.
- **Sessions, and a way back.** Ending a session takes the table to a recap
  of the story so far, and the next one starts once everyone has readied up.
  The host can edit what was said, rewind the story to any of the DM's
  scenes, or restart a session, and the whole game state goes back with it.
- **An app on your phone.** The client is built phone-first and installs to
  the Home Screen on iOS and Android, where it runs full screen.
- **Notifications when the table moves.** Push notifications (Web Push, no
  third-party account) when the DM narrates, someone acts or chats, the DM
  asks you for a roll, a turn has been waiting on you for a few minutes, a
  session starts, or you are invited somewhere. Nothing is sent about a
  campaign you have open on screen, busy tables are spaced out, each
  campaign's notifications replace each other instead of piling up, and each
  kind can be switched off, or a whole campaign muted. Quiet hours hold
  everything overnight and send one summary per campaign in the morning.
- **Bring any model.** Anthropic API, AWS Bedrock, Azure AI Foundry or any
  OpenAI-compatible endpoint, with per-task model routing, prompt caching,
  token budgets and cost tracking.
- **Ask another AI for what it does best.** Admins add other AIs (Gemini or
  any OpenAI-compatible endpoint) with their own keys, and write standing GM
  instructions per game system, such as "ask Gemini to write every
  achievement". In play the DM, built-in or Claude, sends the request with
  the `ask_ai` tool and works the answer into its narration. A host can also
  have one of them polish every scene: the DM writes the narration, the other
  AI rewrites it for style, and what the players said stays word for word.
- **Or let Claude run the whole table.** Choose Claude when you make a
  campaign and the host's Claude is every AI at it, on their own Claude plan:
  the Dungeon Master, the character guide, the sheet reader and the
  chronicler. Friends play in the app as usual. A server with no API key at
  all is a supported install.
- **Feedback from inside the app.** A quiet icon in every screen's header
  opens a sheet to report a bug, suggest an idea or say what you think, with
  a screenshot of the page you were on or a picture from your device. Each
  one becomes a GitHub issue on the repository you configure (with a
  fine-grained token), and players follow its status and replies in the app.
  Pictures stay on your server; the issue links to them for admins.
- **Built for the open internet.** Invite-only sign-up, argon2id, TOTP,
  rate limiting, CSRF protection, strict headers, non-root read-only
  containers.

## Quick start

Requirements: Docker with the Compose plugin, and either an LLM API key or a
Claude plan (to run campaigns with Claude and no key at all, see below).

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

### Running a campaign with Claude

When you make a campaign, *Who runs the game?* offers **Claude** beside
**Built-in AI**. With Claude, the server calls no model for that campaign:
the host's Claude narrates, plays companions, guides players through making
characters, reads uploaded sheets, catalogues documents and writes the
chronicle, all through the connector. Set `LLM_PROVIDER=none` and the server
needs no API key; every campaign is then run with Claude.

After creating the campaign the app opens **Connect Claude**, three steps
that tick themselves off:

1. **Add Tavern Master to Claude.** In Claude, open *Customize → Connectors*,
   choose *Add custom connector*, paste `BASE_URL/mcp` (for example
   `https://tavern.example.com/mcp`) and press Connect. Claude sends you to
   Tavern Master to approve the connection. There is nothing to paste but
   the address.
2. **Give Claude the campaign**, one of two ways:
   - *Claude app*: make a Claude Project for the campaign and paste the
     instructions the sheet gives you. A chat runs the table while you keep
     it going: say *run the table*, and again when Claude stops.
   - *Runs by itself*: download the campaign's folder, open it in Claude
     Code (the terminal, or the Code tab of Claude Desktop) and type
     `/loop /dm`. Claude runs the table until it goes quiet and checks back
     on its own. This is the setup where a companion with an AI of its own
     is played by a separate, blind Claude.
3. **Say hello.** Everyone at the table sees whether Claude is there, and
   what is waiting for it.

#### Claude on call

To have Claude come and go with the players, run the DM launcher on the
computer where Claude Code is signed in. It asks the server which of your
Claude campaigns have someone at the table, starts Claude Code in the
background for each (`claude -p /dm`, in the campaign's folder, which it
downloads the first time), and stops it once the table has been empty, or
Claude silent while players wait, for 15 minutes. It signs in with a
hand-made token, so there is no browser step. It needs Node 20 or later and
nothing else.

When the token belongs to an admin, the launcher answers the game system
workshop too. When a message waits in a workshop that Claude answers, it
starts `claude -p /workshop` in a `workshop-<system>` folder, on the
account-wide connector address. That run answers, then leaves once nothing
is waiting. The workshop in the app says Claude is on its way while a
launcher is running.

```bash
node scripts/dm-launcher.mjs setup --server https://tavern.example.com --token tmc_...
node scripts/dm-launcher.mjs              # keep tables staffed; Ctrl+C stops every run
node scripts/dm-launcher.mjs watch        # follow what Claude is doing (add a name to pick a table)
node scripts/dm-launcher.mjs status       # who is at each table, and where Claude is
```

Settings live in `~/.tavern-dm/config.json` (`dir` for the campaign
folders, `idleMinutes`, `quietMinutes`, `pollSeconds`, `claude` for the
executable's path, `claudeBackupToken`); `TAVERN_URL`, `TAVERN_TOKEN`,
`TAVERN_IDLE_MINUTES`, `TAVERN_QUIET_MINUTES` and
`CLAUDE_CODE_OAUTH_TOKEN_BACKUP` override them. A table with players
connected but nothing happening for `quietMinutes` (30 by default) lets
Claude go, since every minute it waits costs usage; it comes back as soon
as someone opens the table, acts or asks for something. Run logs are in
`~/.tavern-dm/logs`. To talk with Claude as your co-DM, open the folder in
Claude Code as usual, but do not start `/dm` there while the launcher runs
it too.

The launcher can also run as a container in this stack, with Claude Code
inside it. It reaches the web container directly, so it needs no HTTPS:

1. In `.env`, uncomment `COMPOSE_PROFILES=claude`.
2. Copy `.env.dm-launcher.example` to `.env.dm-launcher` and set
   `TAVERN_TOKEN`. For Claude Code's sign-in, run `claude setup-token` on any
   computer with Claude Code and set `CLAUDE_CODE_OAUTH_TOKEN` to what it
   prints (it lasts about a year and uses your Claude plan). Only this
   container reads that file.
3. `docker compose pull && docker compose up -d`, then
   `docker compose logs -f dm-launcher` to see tables filling and what Claude
   does at them.

Without `CLAUDE_CODE_OAUTH_TOKEN`, sign in inside the container once instead:
`docker compose run --rm dm-launcher claude`, type `/login`, and follow the
link. The sign-in is kept in the `dm-home` volume with the campaign folders
and logs. Updating Claude Code means pulling or rebuilding the image.

To keep Claude at the table when a plan runs out, set
`CLAUDE_CODE_OAUTH_TOKEN_BACKUP` to a second `claude setup-token` token
(`claudeBackupToken` in the config when the launcher runs outside Docker).
When the main sign-in runs out of usage or is signed out, the table
restarts on the backup a few seconds later; other errors just retry. New
runs go back to the main sign-in once its limit resets, or after 30 minutes
when Claude's error does not say when.

The server must be reachable over public HTTPS, since Anthropic's cloud makes
the connection for claude.ai, and Claude Code signs in only over HTTPS or to
localhost. Clients that cannot sign in, or servers on plain HTTP, can use a
hand-made token instead: *You → Claude → Use a token instead*, sent as an
`Authorization: Bearer` header.

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
| Notifications | Web Push with a VAPID key pair made on first start | works in the installed iPhone app; push payloads are end-to-end encrypted |
| Files | a local volume, random names, never served back | no object store to run |
| Jobs | a `jobs` table claimed with `FOR UPDATE SKIP LOCKED` | no Redis |
| LLM | a small provider interface with per-task models | swap providers by env var |

**The DM is a tool-calling loop.** The model writes prose; everything that
must be true is done by a tool. Dice are rolled by the server. When a player
character makes a roll, the DM asks for it with `request_roll`: only the
players of that character are shown the dice, the server rolls the expression
the DM set when they tap Roll, and the result joins the next turn as that
character's action (a roll nobody made is dropped, and the DM is told). Rules come from
retrieval scoped to the campaign's system, and characters, inventory, NPCs,
quests and flags change only through validated writes that are logged and
shown to the players. Player messages and uploaded documents are treated as
untrusted data: tools enforce campaign scoping and ownership themselves, so a
prompt injection cannot do anything the tools do not allow.

**Turns are "ready-or-timeout".** A turn opens on the first action. Players can
send several messages, then tap Done. Pass is always there, even before anyone
has acted: it puts "<character> does nothing this turn." in the story and
finishes that player's turn, opening one if none is open. The turn closes
when every present player is done or has passed, when the gather window
expires, or when the owner sends it early. Set to wait until everyone is
ready, it waits for every player's character, including players who are
away, until the owner sends it. The server serialises the turn with each
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
act on them. Companions go one after another, after the players: one someone
spoke to goes first, the rest in a random order, and each sees what the ones
before it did, so they play along with the table instead of each doing
something of its own. Their actions then reach the DM like a player's.

**Companions answer mid-turn.** While a turn is still gathering, each line a
player writes is shown (a moment later, so a few lines in a row go together)
to the companions no player runs who are in the same place. Each decides in
its own call, built the same blind way, whether the line calls for an answer
right now: it was spoken to, asked something, or is in a conversation. Most
of the time it passes. One that answers is shown typing, its line joins the
turn, and every player who had tapped Done is waited on again, so the table
can talk with a companion before the DM narrates. The turn is held open while
they decide, only players' lines start a round, and a turn takes a few
answers at most. Players can also take back Done themselves. When Claude runs
the table, the question goes to Claude instead: `wait_for_work` shows it the
turn so far and who heard the line, it answers with `answer_in_turn`, and
calling `wait_for_work` again lets the line pass. The turn waits a minute at
most, and only while Claude is listening.

**Polished narration.** A campaign can name one of the admin's other AIs to
polish with. The DM's finished narration has secrets blacked out, then every
line a player wrote, codex link and rule citation is swapped for a numbered
marker before the draft goes to that AI for a rewrite. The markers are put
back afterwards; if any is lost, repeated or invented, or the length strays
far from the draft's, or the AI fails, the draft is posted as written.

**Or Claude is every AI at the table.** A campaign's one switch is who its AI
is. When it is Claude, the server calls no model for that campaign at all. A
closed turn waits on an in-memory *desk*; everything else that needs an AI (a
player's message to the character guide, an uploaded sheet, a new document,
the chronicle) waits in a *work queue* in Postgres. Claude takes both from one
tool, `wait_for_work`, does what it is handed with the same GM tools the
built-in DM uses, and answers with the tool the request names (`narrate`,
`reply_guide`, `submit_sheet`, `catalogue_document`, `save_chronicle`).
Narration and guide replies get the same secret redaction as the built-in DM.
Claude does one thing at a time, and the server enforces it: while it holds a
request, tools that do not belong to that request are refused, so a player's
words to the guide can never make a DM-only tool run. A claim left alone for
`CONNECTOR_CLAIM_TIMEOUT_MINUTES` goes back to waiting, and a turn handed out
again lists what was already applied. The room tracks *presence* (listening,
working, away, never) from the connector's calls and tells the table.

The connector has two kinds of address. `BASE_URL/mcp` is account-wide and
acts on the campaign the client last opened, and every result starts with that
campaign's name, so a chat can tell when another chat moved it.
`BASE_URL/mcp/c/<campaign id>` is pinned to one campaign; the downloadable
folder uses it. Clients connect by signing in: the server is an OAuth 2.1
protected resource and its own authorization server (dynamic client
registration, PKCE, rotating refresh tokens), and a connection is valid only
on the address it was approved for, so one approved for a pinned address can
never touch another campaign. Hand-made tokens still work on both.

**Homebrew and the rules desk.** A system marked homebrew gives each of its
campaigns a rules desk: one out-of-character chat the whole table shares
with the GM. The GM there is a separate agent (`agent/rules-desk.ts`) with
the rules, the house rulings, recent play and the party, but not the DM's
notebook or DM-only documents, and anything secret it repeats is blacked
out. It can put a mistake right with the same validated state tools the DM
uses, and keeps what the table settles with `record_ruling`: a house rule,
direction for the story, or a correction. Rulings are stored per campaign and
reach the DM like its own notes: at the top of the brief, and in the notes
since the brief until the next rebuild. In a Claude campaign the desk is a
work-queue request like the guide, every turn handed to Claude carries the
rulings, and the host can record one by telling Claude directly. They live on
the server rather than in a Claude Code `CLAUDE.md`, so they reach every
route, survive a compacted conversation and stay the same on every machine.

**Character sheets and the workshop.** A system's `sheet_template` holds a
typed sheet schema (`sheet-schema.ts`): sections of fields, each a number,
text, choice, yes/no, track, list of rows, or a value the rules work out. A
sheet is still a flat map of field name to value, so rewinds and older sheets
work unchanged; every write (the form, the guide, the sheet reader, the GM)
goes through `checkSheet`, and fields the GM keeps cannot be changed by a
player once they hold a value. Sheets made on the original template are read
as a schema with the same field names. The tools that write a sheet for an AI
(`edit_sheet`, `save_character`) match a field by its name or its label, and
tell the AI when a name is not one the system defines (with the field it most
likely meant) or when a field the GM keeps was left as it was. The sheet drafter
(`agent/sheet-drafter.ts`) reads a system's rulebooks and writes a whole
schema; the workshop (`agent/workshop.ts`) changes it in small steps
(`sheet-ops.ts`). Neither touches the sheet in use: both write the system's
draft, which an admin reviews as separate proposals (`sheet-proposals.ts`) and
applies in part or in full. The workshop also writes the system's GM guide
(`gm-guide.ts`): how to run the game, topic by topic, and rulings that reach
the GM of every table on the system. Claude can do all of this through the
connector: `open_workshop` and the `workshop_*` tools, admin-only and on the
account-wide address, are the built-in workshop's own tools, and
`workshop_wait` / `workshop_reply` answer the workshop chat in the app when
the admins hand it to Claude.

**Sheet versions.** Applying a draft (or saving the sheet as JSON) publishes a
new version of the system's sheet (`sheet-versions.ts`, table
`sheet_versions`). New campaigns start on the latest; a campaign with a party
stays on its own version until its host updates from the campaign menu, which
shows what changes and what happens to each character first. The update
carries every sheet across: a field the new version replaces moves its value
to the new name (a rename, paired in the draft review), each value takes its
field's new kind, and one that cannot (text where a number now goes) is kept
beside it as "Previous …" rather than lost. Rewinding past an update carries
the restored sheets forward the same way. Tracks other than hit points
(stress, sanity, spell slots) move in play with the GM's `adjust_track`, which
keeps them within their maximum and gives the GM its note on the track when it
fills or empties.

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
scripts/           Dev runner, and the DM launcher that brings Claude to the table
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
makes the app open instantly from cache and receives push notifications, needs
HTTPS and so is only active behind a TLS-terminating proxy or on `localhost`.
On iPhone and iPad, notifications also need the app added to the Home Screen
(iOS 16.4 or later); turn them on under You, Notifications.

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
