// Types shared by the API server and the web client.
// This package is type-only: import it with `import type`.

export type Role = 'admin' | 'user';

export interface UserRef {
  id: string;
  username: string;
  displayName: string;
}

export interface Me extends UserRef {
  email: string | null;
  role: Role;
  totpEnabled: boolean;
  /** True when this account must enrol 2FA before it can use admin routes. */
  totpRequired: boolean;
  csrfToken: string;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ---------- rules library ----------

export type DocumentStatus = 'queued' | 'parsing' | 'embedding' | 'ready' | 'failed';

export interface GameSystem {
  id: string;
  slug: string;
  name: string;
  description: string;
  sheetTemplate: SheetTemplate;
  documentCount: number;
  chunkCount: number;
  /** How many of the system's library documents are setting/flavour material. */
  settingDocumentCount: number;
  /** Progress of the setting distillation (feature: setting packs). */
  loreStatus: LoreStatus;
  /** The distilled voice of this world, once read; null until ready. */
  lore: SettingLore | null;
  /**
   * A homebrew system: tables that play it get a rules desk, where players
   * talk rules over with the GM and the rulings they settle on are kept.
   */
  homebrew: boolean;
}

export type LoreStatus = 'none' | 'queued' | 'reading' | 'ready' | 'failed';

/**
 * A system's distilled "voice": how it sounds, how it moves, and the in-universe
 * vocabulary and motifs a DM may lean on for colour. Flavour, never rules.
 */
export interface SettingLore {
  version: 1;
  /** A few sentences on how this world sounds. */
  voice: string;
  /** How scenes move; what a beat feels like. */
  pacing: string;
  /** In-universe vocabulary the DM may borrow. */
  glossary: { term: string; meaning: string; soundsLike?: string }[];
  /** Recurring devices, e.g. "System messages in boxes". */
  presentation: string[];
  /** Names, places and motifs safe to reference as known. */
  touchstones: string[];
  /** Spoilers / plot the DM must NOT pre-empt. */
  cautions: string[];
}

export interface SheetTemplate {
  abilities: string[];
  fields: { key: string; label: string }[];
}

export interface RuleDocument {
  id: string;
  systemId: string;
  title: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  pageCount: number | null;
  chunkCount: number;
  createdAt: string;
  /** 'rules' (default) or 'setting'. Setting documents feed the system's lore, not its rules. */
  kind: 'rules' | 'setting';
}

export interface RuleHit {
  chunkId: number;
  document: string;
  heading: string;
  page: number | null;
  text: string;
  score: number;
}

// ---------- social ----------

export interface Friend {
  friendshipId: string;
  user: UserRef;
  status: 'pending' | 'accepted';
  /** 'incoming' when the other user sent the request. */
  direction: 'incoming' | 'outgoing';
}

// ---------- campaigns ----------

/** 'prep' is the lobby before play: party, sheets, documents and wishes. */
export type CampaignPhase = 'prep' | 'active';

export interface CampaignSummary {
  id: string;
  name: string;
  premise: string;
  systemId: string;
  systemName: string;
  ownerId: string;
  status: 'active' | 'archived';
  phase: CampaignPhase;
  memberCount: number;
  role: 'owner' | 'player';
  /** Who is every AI for this campaign. */
  dm: DmMode;
  /** The campaign's system is homebrew, so the table has a rules desk. */
  homebrew: boolean;
}

export interface CampaignMember extends UserRef {
  role: 'owner' | 'player';
  /** The first character this member runs, if any. */
  characterName: string | null;
}

export interface CampaignDetail extends CampaignSummary {
  settings: CampaignSettings;
  scene: string;
  members: CampaignMember[];
  pendingInvites: { id: string; invitee: UserRef }[];
  /** Your own wishes for the story. Only you and the GM read them. */
  myWishes: string;
  /** Where the campaign's AI is right now. */
  dmStatus: DmStatus;
}

export interface CampaignSettings {
  gatherWindowSeconds: number;
  tone: string;
  /** 'gm' lets the GM edit sheets itself as the story changes the characters. */
  sheets: 'players' | 'gm';
  /**
   * Who is every AI for this campaign: 'server' is the built-in one on the
   * configured model; 'claude' is the owner's Claude, through the connector,
   * and then the server calls no model for this campaign at all.
   */
  dm: DmMode;
}

/** Who is every AI for a campaign: the server's built-in model, or the owner's Claude. */
export type DmMode = 'server' | 'claude';

/** Where a campaign's AI is right now. For the built-in DM it is always listening. */
export interface DmStatus {
  mode: DmMode;
  /**
   * listening: Claude is polling for work now, or called a tool in the last 75 s.
   * working:   Claude holds a turn or another request.
   * away:      Claude has run this campaign before but is not here now.
   * never:     Claude has not opened this campaign yet.
   */
  state: 'listening' | 'working' | 'away' | 'never';
  lastSeenAt: string | null;
  /** Requests waiting for Claude, a gathered turn counting as one. */
  waiting: number;
}

/** What this server can do, for screens that offer a choice. */
export interface ServerMeta {
  /** A built-in model is usable: the server has one configured, or you stored your own key. */
  builtInAi: boolean;
  connectorUrl: string;
  /** You have a connection (approved sign-in or hand-made token) that has been used at least once. */
  claudeConnected: boolean;
}

/** A sign-in request from an MCP client, shown on the approval screen. */
export interface ConnectRequest {
  id: string;
  /** The name the client registered with, e.g. "Claude". Untrusted text. */
  clientName: string;
  /** Where the client will be sent back to: its host only, e.g. "claude.ai" or "localhost". */
  redirectHost: string;
  /** Set when the request is for one campaign's pinned address. */
  campaign: { id: string; name: string } | null;
}

/**
 * A connection that lets an MCP client, such as the Claude app, run your
 * campaigns: one made by signing in, or a hand-made token. Never includes a secret.
 */
export interface ConnectorToken {
  id: string;
  kind: 'signin' | 'token';
  label: string;
  /** The name the client signed in with. Untrusted text. */
  clientName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** The campaign it last opened. */
  campaignName: string | null;
  /** The one campaign this connection is limited to, when it was made for a pinned address. */
  scope: string | null;
}

export interface CampaignInvite {
  id: string;
  campaignId: string;
  campaignName: string;
  inviter: UserRef;
}

export interface InventoryItem {
  name: string;
  qty: number;
  notes?: string;
}

export type CharacterKind = 'pc' | 'npc';

/**
 * Who speaks for a party member: one or more players, the GM itself, or a
 * separate AI that knows only what the character knows.
 */
export type CharacterController = 'player' | 'gm' | 'agent';

export interface Character {
  id: string;
  campaignId: string;
  kind: CharacterKind;
  controller: CharacterController;
  /** The players who run it. Empty unless `controller` is 'player'. */
  playerIds: string[];
  name: string;
  sheet: Record<string, unknown>;
  hp: number;
  maxHp: number;
  tempHp: number;
  conditions: string[];
  inventory: InventoryItem[];
  /** Personality, looks, history and goals. */
  persona: string;
  /** Only present for the players who run the character. */
  privateNotes?: string;
}

/** A sheet read from an upload, for the player to check before saving. */
export interface CharacterDraft {
  name: string;
  maxHp: number;
  sheet: Record<string, string | number>;
  inventory: InventoryItem[];
  persona: string;
}

/** An uploaded sheet waiting for, or read by, Claude. */
export interface PendingSheet {
  id: string;
  fileName: string;
  status: 'waiting' | 'claimed' | 'done' | 'failed';
  /** Who will run the character, as chosen when it was uploaded. */
  control: { kind: CharacterKind; controller: CharacterController; playerIds: string[] };
  draft?: CharacterDraft;
  error?: string;
}

// ---------- campaign documents ----------

export type CampaignDocKind = 'rules' | 'setting' | 'adventure' | 'character' | 'handout' | 'other';

export interface CampaignDocument {
  id: string;
  title: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  /** null until the GM has catalogued it. */
  kind: CampaignDocKind | null;
  /** 'gm' keeps it away from the players' side of the table. */
  audience: 'table' | 'gm';
  /** The GM's own note on what it holds. Empty for a GM-only document you did not upload. */
  summary: string;
  uploadedBy: UserRef | null;
  canEdit: boolean;
  createdAt: string;
}

// ---------- character builder ----------

export interface BuilderMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  rolls?: DiceRoll[];
  createdAt: string;
}

export interface BuilderThread {
  id: string;
  characterId: string | null;
  messages: BuilderMessage[];
}

/** One line of the builder's streamed reply. */
export type BuilderEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; tool: string; summary: string }
  | { type: 'done'; message: BuilderMessage; characterId: string | null }
  /** The message was stored and handed to Claude; the reply arrives later. */
  | { type: 'queued' }
  | { type: 'error'; message: string };

// ---------- rules desk (homebrew systems) ----------

/**
 * What a table settled on with its GM. rule: a house rule or a change to the
 * system's rules. direction: how the table wants the campaign to play out.
 * correction: a call the GM got wrong, and how the story stands now.
 */
export type RulingKind = 'rule' | 'direction' | 'correction';

export interface Ruling {
  id: string;
  kind: RulingKind;
  content: string;
  /** The player whose conversation led to it. */
  requestedBy: UserRef | null;
  createdAt: string;
}

export interface RulesMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** Who said it; null for the GM. */
  author: UserRef | null;
  createdAt: string;
}

export interface RulesDesk {
  messages: RulesMessage[];
  rulings: Ruling[];
  /** Someone's message is waiting for the GM's answer. */
  waiting: boolean;
}

/**
 * One line of the GM's answer at the rules desk, streamed as it works. The
 * text itself arrives whole, after secrets are checked, never word by word.
 */
export type RulesEvent =
  | { type: 'tool'; tool: string; summary: string }
  /** An answer was stored. The desk may hold more than this one message now. */
  | { type: 'done'; message: RulesMessage }
  /** The message was stored; the answer arrives later (Claude, or the GM is answering someone else). */
  | { type: 'queued' }
  | { type: 'error'; message: string };

export type EntityKind = 'npc' | 'location' | 'quest' | 'item' | 'faction' | 'event' | 'term';

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  /** Other names the DM may use for this entry; drives codex search and linking. */
  aliases: string[];
  /** Player-visible one-liner for chips and cards. */
  summary: string;
  /** Player-visible longer codex entry; '' when none has been written yet. */
  article: string;
  status: string;
  /** Present only once revealed. Never sent while unrevealed, for anyone. */
  secret?: string;
  /** DM-only extension of the article; shipped with `secret` once revealed. */
  articleSecret?: string;
  secretRevealed: boolean;
  /** ISO time players first met this entry, or null if not yet recorded. */
  firstSeenAt: string | null;
}

export interface StateEvent {
  id: number;
  turnId: string | null;
  actor: string;
  tool: string;
  summary: string;
  createdAt: string;
}

export interface GameState {
  scene: string;
  characters: Character[];
  entities: Entity[];
  flags: Record<string, unknown>;
  events: StateEvent[];
}

// ---------- chat ----------

export type MessageKind = 'action' | 'ooc' | 'dm' | 'system';

export interface Citation {
  ref: string;
  chunkId: number;
  document: string;
  heading: string;
  page: number | null;
  excerpt: string;
}

export type RollKind =
  | 'attack' // to hit
  | 'damage'
  | 'check' // ability/skill check
  | 'save'
  | 'initiative'
  | 'other';

export interface DiceRoll {
  id: string;
  expression: string;
  reason: string;
  character: string | null;
  dice: { sides: number; value: number; kept: boolean }[];
  total: number;
  /** What the roll is for. Defaults to 'other' for older rows / unspecified. */
  kind: RollKind;
}

/** A codex entry the DM named in a line of narration, resolved server-side. */
export interface EntityRef {
  /** The exact text wrapped in the narration, e.g. "the Ashen Crown". */
  text: string;
  entityId: string;
  /** Canonical entry name, which may differ from `text` when an alias was used. */
  name: string;
  kind: EntityKind;
}

export interface ChatMessage {
  id: number;
  kind: MessageKind;
  turnId: string | null;
  user: UserRef | null;
  characterName: string | null;
  content: string;
  citations?: Citation[];
  rolls?: DiceRoll[];
  /** Codex references the DM marked in `content` with `[[name]]`. */
  refs?: EntityRef[];
  redacted?: boolean;
  /** An action taken by an AI-run party member. */
  ai?: boolean;
  createdAt: string;
}

/** A place in the turn order: a player-run character, or a player without one. */
export interface TurnSeat {
  id: string;
  name: string;
  userIds: string[];
  characterId: string | null;
}

export interface TurnState {
  status: 'idle' | 'collecting' | 'resolving';
  number: number | null;
  /** Epoch milliseconds when the gather window closes. */
  deadline: number | null;
  /** Seat ids. */
  expected: string[];
  acted: string[];
  passed: string[];
  seats: TurnSeat[];
}

// ---------- websocket ----------

export type ClientMessage =
  | { type: 'action'; text: string; characterId?: string }
  | { type: 'ooc'; text: string }
  /** A player rolling their own dice. `kind` and `characterId` are optional. */
  | { type: 'roll'; expression: string; reason?: string; characterId?: string; kind?: RollKind }
  | { type: 'pass' }
  | { type: 'force' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'hello'; you: UserRef; present: UserRef[]; turn: TurnState; dm: DmStatus }
  | { type: 'presence'; present: UserRef[] }
  | { type: 'message'; message: ChatMessage }
  /** A standalone dice roll (a player rolled), to animate and append to the log. */
  | { type: 'roll'; roll: DiceRoll }
  | { type: 'turn'; turn: TurnState }
  | { type: 'dm_start'; turnId: string }
  | { type: 'dm_delta'; turnId: string; text: string }
  | { type: 'dm_tool'; turnId: string; tool: string; summary: string }
  | { type: 'dm_end'; turnId: string; ok: boolean }
  | { type: 'state_changed' }
  /** Where the campaign's AI is changed. */
  | { type: 'dm_status'; dm: DmStatus }
  /** Your guide chat has a new reply. Sent only to the thread's owner. */
  | { type: 'guide'; threadId: string }
  /** The rules desk has a new message or ruling. */
  | { type: 'rules' }
  /** An uploaded sheet of yours moved on. Sent only to the uploader. */
  | { type: 'sheet'; id: string; status: PendingSheet['status'] }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

// ---------- usage ----------

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface UsageReport {
  window: '24h' | '30d';
  byUser: ({ user: UserRef } & UsageTotals)[];
  byCampaign: ({ campaignId: string; name: string } & UsageTotals)[];
}
