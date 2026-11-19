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
  /** What a character sheet holds in this system: its latest version. */
  sheetSchema: SheetSchema;
  /**
   * Which version of the sheet that is. Each publish makes a new one; a
   * campaign stays on the version it has until its host updates it.
   */
  sheetVersion: number;
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
  /**
   * The viewer may shape this system: they are an admin, or one of the
   * players an admin made an owner of it.
   */
  canEdit: boolean;
  /**
   * Standing instructions for the GM of every table on this system, such as
   * which other AI to ask for what. Sent to those who can edit it only.
   */
  gmInstructions?: string;
  /** Where the AI's draft of this system's sheet stands. Sent to those who can edit it only. */
  sheetDraftStatus?: SheetDraftStatus;
}

/** A player an admin trusted with one game system, as the system's owners list shows them. */
export interface SystemOwner extends UserRef {
  addedAt: string;
}

export type SheetDraftStatus = 'none' | 'queued' | 'drafting' | 'ready' | 'failed';

/**
 * One change a draft proposes to a system's sheet, for an admin to apply or
 * ignore. `section` is the label of the section the field is (or would be) in.
 */
export type SheetProposal =
  | { id: string; kind: 'add'; section: string; field: SheetField }
  | {
      id: string;
      kind: 'change';
      section: string;
      field: SheetField;
      before: SheetField;
      /** What changes, one short line each ("kind: text → number"). */
      changes: string[];
    }
  | { id: string; kind: 'remove'; section: string; field: SheetField }
  | { id: string; kind: 'hp'; before: string; after: string }
  | { id: string; kind: 'steps'; before: string[]; after: string[] }
  /** The sections' names and order. */
  | { id: string; kind: 'sections'; before: string[]; after: string[] };

/** A system's sheet draft, as the review screen shows it. */
export interface SheetDraftView {
  status: SheetDraftStatus;
  error: string | null;
  /** What the drafter could not settle from the documents. */
  notes: string[];
  proposals: SheetProposal[];
  /**
   * Fields the draft seems to replace with a new one (the same label under a
   * new name). Applied with both changes, a pair carries each character's
   * value over to the new field when their campaign updates.
   */
  renames: SheetRename[];
  draftedAt: string | null;
}

/** A field replaced by another in a new version of a sheet: its values move to the new name. */
export interface SheetRename {
  from: string;
  to: string;
}

/**
 * What updating a campaign to a newer version of its system's sheet would
 * do: the changes to the sheet, and for each character what moves.
 */
export interface SheetUpdate {
  from: number;
  to: number;
  changes: SheetProposal[];
  characters: {
    name: string;
    /** Values carried to a field's new name. */
    moved: SheetRename[];
    /** Values that do not fit their field's new kind, kept beside it under another name. */
    kept: { field: string; as: string }[];
  }[];
}

/** Another AI the GM can ask for help with ask_ai, as admins see it. The key is never sent. */
export interface OutsideAi {
  id: string;
  name: string;
  provider: 'gemini' | 'openai';
  model: string;
  /** Only for 'openai': an OpenAI-compatible endpoint. Empty means api.openai.com. */
  baseUrl: string;
  /** The last characters of the key, to tell keys apart. */
  keyHint: string;
  /** What the GM is told this AI is good for. */
  note: string;
  updatedAt: string;
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

/**
 * The original sheet template: a row of ability scores and a list of text
 * fields. Still accepted wherever a schema is read, and turned into a
 * {@link SheetSchema} on the way.
 */
export interface SheetTemplate {
  abilities: string[];
  fields: { key: string; label: string }[];
}

/**
 * What a character sheet holds in one game system: its sections and typed
 * fields, how the hit points are named, and the order characters are built
 * in. The sheet form, the sheet reader, the character guide and the GM all
 * work from it.
 */
export interface SheetSchema {
  version: 2;
  /** Hit points under the system's own name ("Hit points", "Health", "Wounds"). */
  hp: { label: string };
  sections: SheetSection[];
  /** The order the character guide builds a character in, one step per line. */
  createSteps: string[];
}

export interface SheetSection {
  id: string;
  label: string;
  fields: SheetField[];
}

/**
 * - number, text, longtext, select, checkbox: a single value.
 * - track: something with a current and a maximum value (stress, sanity, spell slots, ammunition).
 * - list: repeating rows with fields of their own (attacks, spells, talents).
 * - derived: a value the rules work out from others; `derivedFrom` says how, in words.
 */
export type SheetFieldType =
  'number' | 'text' | 'longtext' | 'select' | 'checkbox' | 'track' | 'list' | 'derived';

export interface SheetField {
  /** The name the value is stored under on the sheet: letters, digits, underscores and spaces. */
  key: string;
  label: string;
  type: SheetFieldType;
  /** A line under the field telling the player what goes there. */
  help?: string;
  /** The choices of a select. */
  options?: string[];
  /** Bounds of a number or a track's maximum. */
  min?: number;
  max?: number;
  /** The fields of each row of a list. Single values only: no lists or tracks inside. */
  itemFields?: SheetField[];
  /** For a derived value: the rule that settles it, in words ("10 + Dexterity modifier"). */
  derivedFrom?: string;
  /** Settled when the character is made, or changing during play. */
  setAt?: 'creation' | 'play';
  /**
   * Who keeps it. 'gm': a player may fill it in while it is empty, and from then
   * on only the GM changes it (experience, corruption, a curse).
   */
  editableBy?: 'player' | 'gm' | 'both';
  /** Shown on the party card, not only on the full sheet. */
  showOnCard?: boolean;
  /** For the GM: what this field means in play and when it comes up. */
  gmNote?: string;
}

/** A track's value on a sheet. */
export interface TrackValue {
  current: number;
  max: number;
}
export type SheetScalar = string | number | boolean;
/** One value on a sheet: a single value, a track, or the rows of a list. */
export type SheetValue = SheetScalar | TrackValue | Record<string, SheetScalar>[];

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
  /** Marked ready to begin, in the lobby. The host begins once every player is. */
  ready: boolean;
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
  /**
   * Set when the host ended a session: the table sees the recap, every player
   * readies up, and the host starts the next session.
   */
  restingSince: string | null;
  /** The character sheet this campaign uses: the version of its system's sheet it is on. */
  sheetSchema: SheetSchema;
  sheetVersion: number;
  /** For the host: a newer version of the sheet they can update to. Null when there is none. */
  sheetUpdate: { version: number } | null;
}

/** The adventure so far, for the recap between sessions. */
export interface Recap {
  /** Older sessions, merged by the chronicler. Oldest first. */
  arcs: string[];
  /**
   * Each session with its chronicle, oldest first. `summary` is null until one is
   * written; `pending` says whether one is actually on its way (the built-in
   * chronicler is working on it, or Claude has been asked). Null with no summary
   * means none is coming: too little was played, or the job failed.
   */
  sessions: {
    number: number;
    startedAt: string;
    endedAt: string | null;
    summary: string | null;
    pending: 'chronicler' | 'claude' | null;
  }[];
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
  /**
   * The name of another AI (one an admin added, such as Gemini) that rewrites
   * the DM's narration for style before the table sees it, or '' for none.
   * What the players wrote is never changed.
   */
  polishWith: string;
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
  /** Other AIs an admin set up, by name: the ones a campaign can polish its narration with. */
  outsideAis: string[];
  /** The feedback button is on: feedback goes to the server's GitHub issue tracker. */
  feedback: boolean;
}

// ---------- notifications ----------

/**
 * What a push notification can be about. Each can be switched off on its own;
 * a missing key means on.
 */
export type NotifyCategory =
  /** The DM (the built-in AI or Claude) posted narration. */
  | 'narration'
  /** Another player, or an AI-run companion, acted in the story. */
  | 'actions'
  /** Table talk: out-of-character chat. */
  | 'chat'
  /** The DM asked one of your characters for a roll. */
  | 'rolls'
  /** A turn has been waiting on you for a while. */
  | 'waiting'
  /** The campaign began, or the host started the next session. */
  | 'sessions'
  /** A campaign invitation or a friend request. */
  | 'invites';

export type NotifyPrefs = Record<NotifyCategory, boolean>;

/**
 * A daily stretch with no notifications, in the person's own time zone.
 * What arrives meanwhile is held and sent as one summary per campaign when
 * it ends. `start` and `end` are "HH:MM"; an end before the start runs past
 * midnight.
 */
export interface QuietHours {
  start: string;
  end: string;
  /** IANA name, e.g. "America/Chicago". */
  timeZone: string;
}

export interface NotifySettings {
  prefs: NotifyPrefs;
  quiet: QuietHours | null;
  /** Devices that receive notifications. */
  devices: number;
}

/** What a push carries to the service worker. Kept small: push services cap payloads at about 4 KB. */
export interface PushPayload {
  title: string;
  body: string;
  /** In-app path to open when the notification is tapped. */
  url: string;
  /** Notifications with the same tag replace each other instead of piling up. */
  tag: string;
  category: NotifyCategory;
}

// ---------- feedback ----------

export type FeedbackKind = 'bug' | 'idea' | 'feedback';

/**
 * Where a piece of feedback stands. 'sending' has not reached GitHub yet (it
 * is retried); the rest mirror the issue: open, done (closed as completed),
 * or closed (closed as not planned or a duplicate).
 */
export type FeedbackStatus = 'sending' | 'open' | 'done' | 'closed';

export interface FeedbackReply {
  author: string;
  body: string;
  createdAt: string;
}

export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  createdAt: string;
  status: FeedbackStatus;
  /** Labels on the issue, e.g. "in progress", "needs info". */
  labels: string[];
  issueNumber: number | null;
  issueUrl: string | null;
  /** Replies on the issue, oldest first. */
  replies: FeedbackReply[];
  /** When the issue last changed, as GitHub reports it. */
  updatedAt: string | null;
  images: { n: number; source: 'screenshot' | 'photo' }[];
}

export interface FeedbackList {
  items: FeedbackItem[];
  /** owner/name of the repository feedback goes to. */
  repo: string;
  /** Whether that repository is public, when known: then titles and descriptions are public. */
  publicRepo: boolean | null;
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
  /** Where to load the character's picture from; absent when it has none. */
  portrait?: string;
  /** Where they are when the party has split; empty when with the party. */
  whereabouts?: string;
  /**
   * Who added them to the party. A player who adds a companion run by the DM
   * or its own AI looks after it, as the owners do.
   */
  createdBy?: string;
  /** Only present for the players who run the character. */
  privateNotes?: string;
}

/**
 * A change the rules check suggests on an uploaded sheet: a value that does not
 * match what the game system's rules work out (most often max hit points, which
 * the sheet reader copies as written but the rules may compute from class and an
 * ability score). The player applies or ignores each one in the draft editor.
 */
export interface SheetSuggestion {
  /** 'maxHp', or the sheet field key the change is for ("Armour Class"). */
  field: string;
  /** How it reads on the draft now, for the player to compare. */
  current: string;
  /** What the rules work out. A number for maxHp; text or a number for a field. */
  suggested: string | number;
  /** One line on why, citing the rule where it can. */
  reason: string;
}

/** A sheet read from an upload, for the player to check before saving. */
export interface CharacterDraft {
  name: string;
  maxHp: number;
  sheet: Record<string, SheetValue>;
  inventory: InventoryItem[];
  persona: string;
  /** Changes the rules check proposes, for the player to apply or ignore. */
  suggestions?: SheetSuggestion[];
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

// ---------- the workshop (shaping a game system before play) ----------

/** The topics of a system's GM guide, in the order the GM reads them. */
export type GuideTopicId = 'resolution' | 'rolls' | 'harm' | 'advancement' | 'scenes' | 'other';

/**
 * How to run a game system, written in the workshop: what the GM of every
 * table on the system reads before it plays, beside the rulebooks.
 */
export interface GmGuide {
  version: 1;
  topics: { id: GuideTopicId; text: string }[];
  /** Answers to questions the rulebooks leave open. Every table on the system follows them. */
  rulings: { id: string; text: string; createdAt: string }[];
}

export interface WorkshopMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** Who said it; null for the AI. */
  author: UserRef | null;
  createdAt: string;
}

export interface Workshop {
  messages: WorkshopMessage[];
  guide: GmGuide;
  /** The built-in AI is answering someone's message right now. */
  answering: boolean;
  /**
   * Who answers in the app: the built-in AI, or an admin's Claude through the
   * connector (open_workshop, then workshop_wait and workshop_reply).
   */
  answeredBy: 'server' | 'claude';
  /** The server has a built-in AI to answer with. Without one, Claude answers. */
  builtIn: boolean;
  /** Claude answers, and an admin's message is waiting for it. */
  waiting: boolean;
  /** Claude answers, and an admin's DM launcher is running: it starts Claude when a message waits. */
  launcher: boolean;
}

export type WorkshopEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; tool: string; summary: string }
  | { type: 'done'; message: WorkshopMessage }
  /** The message was stored for Claude to answer; the reply arrives later. */
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
  /** Rolls the DM has asked players to make and is waiting on. */
  rollRequests: RollRequest[];
}

/**
 * A roll the DM asked for. Only the players who run the character are shown
 * dice for it; the server rolls exactly this expression.
 */
export interface RollRequest {
  id: string;
  characterId: string;
  characterName: string;
  expression: string;
  reason: string;
  kind: RollKind;
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
  /**
   * The number the roll had to reach (a DC or armor class), when it decides
   * pass or fail. Absent for rolls without one, such as damage.
   */
  target?: number;
  /** Success meant rolling the target or lower, as with a percentile chance. */
  under?: boolean;
  /** Whether it succeeded. Set by the server whenever `target` is. */
  success?: boolean;
}

/**
 * A party member's hit points changing while the DM resolved a turn, shown
 * with the narration so damage and healing are on the record even when the
 * prose does not spell them out. Several changes to one character in a turn
 * are folded into one, from where it started to where it ended up.
 */
export interface HpChange {
  character: string;
  from: number;
  to: number;
  max: number;
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
  /** Hit point changes the DM made in the turn this narration resolves. */
  hp?: HpChange[];
  /** Codex references the DM marked in `content` with `[[name]]`. */
  refs?: EntityRef[];
  redacted?: boolean;
  /** An action taken by an AI-run party member. */
  ai?: boolean;
  /** Changed after it was posted, by the host or its author. */
  edited?: boolean;
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
  /** Seats that acted and said they are done. */
  done: string[];
  passed: string[];
  seats: TurnSeat[];
}

// ---------- websocket ----------

export type ClientMessage =
  | { type: 'action'; text: string; characterId?: string }
  | { type: 'ooc'; text: string }
  /** A player making a roll the DM asked for (a RollRequest). The server rolls the dice the DM set. */
  | { type: 'roll'; requestId: string }
  /** This player is finished with the turn: done if they acted, passing if not. */
  | { type: 'done' }
  /** This player takes back their Done or pass, while the turn is still gathering, to say more. */
  | { type: 'undone' }
  /**
   * This player sits the turn out: "<name> does nothing this turn." goes into
   * the story for each of their characters that has not acted, and they are
   * done. Opens a turn when none is open.
   */
  | { type: 'pass' }
  | { type: 'force' }
  | { type: 'ping' }
  /**
   * The app went to the background or came back. Someone looking at the table
   * gets no push notifications for it; a hidden tab or a phone in a pocket does.
   */
  | { type: 'visible'; visible: boolean }
  /**
   * The player is writing (sent again every few seconds while they are), or
   * stopped. `characterId` is who they are writing as, for an action.
   */
  | { type: 'typing'; typing: boolean; characterId?: string };

/** Someone writing a message the table has not seen yet: a player, or an AI-run companion. */
export interface Typist {
  /** The person's id, or the companion's character id when its AI is writing. */
  id: string;
  name: string;
  /** The character they write as, for its picture. */
  characterId: string | null;
}

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
  /** Messages already posted changed (the story was rewound, or the DM corrected itself): load them again. */
  | { type: 'history_changed' }
  /** Where the campaign's AI is changed. */
  | { type: 'dm_status'; dm: DmStatus }
  /** Your guide chat has a new reply. Sent only to the thread's owner. */
  | { type: 'guide'; threadId: string }
  /** The rules desk has a new message or ruling. */
  | { type: 'rules' }
  /** An uploaded sheet of yours moved on. Sent only to the uploader. */
  | { type: 'sheet'; id: string; status: PendingSheet['status'] }
  | { type: 'error'; code: string; message: string }
  /** Someone started or stopped writing. Never sent to the writer. A start lapses on its own after a few seconds. */
  | { type: 'typing'; who: Typist; typing: boolean }
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
