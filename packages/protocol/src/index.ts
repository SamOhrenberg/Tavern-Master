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

export interface CampaignSummary {
  id: string;
  name: string;
  premise: string;
  systemId: string;
  systemName: string;
  ownerId: string;
  status: 'active' | 'archived';
  memberCount: number;
  role: 'owner' | 'player';
}

export interface CampaignMember extends UserRef {
  role: 'owner' | 'player';
  characterName: string | null;
}

export interface CampaignDetail extends CampaignSummary {
  settings: CampaignSettings;
  scene: string;
  members: CampaignMember[];
  pendingInvites: { id: string; invitee: UserRef }[];
}

export interface CampaignSettings {
  gatherWindowSeconds: number;
  tone: string;
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

export interface Character {
  id: string;
  campaignId: string;
  userId: string;
  name: string;
  sheet: Record<string, unknown>;
  hp: number;
  maxHp: number;
  tempHp: number;
  conditions: string[];
  inventory: InventoryItem[];
  /** Only present for the owner. */
  privateNotes?: string;
}

export type EntityKind = 'npc' | 'location' | 'quest' | 'item' | 'faction';

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  summary: string;
  status: string;
  /** Present only once revealed (or for the campaign owner). */
  secret?: string;
  secretRevealed: boolean;
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

export interface DiceRoll {
  id: string;
  expression: string;
  reason: string;
  character: string | null;
  dice: { sides: number; value: number; kept: boolean }[];
  total: number;
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
  redacted?: boolean;
  createdAt: string;
}

export interface TurnState {
  status: 'idle' | 'collecting' | 'resolving';
  number: number | null;
  /** Epoch milliseconds when the gather window closes. */
  deadline: number | null;
  expected: string[];
  acted: string[];
  passed: string[];
}

// ---------- websocket ----------

export type ClientMessage =
  | { type: 'action'; text: string }
  | { type: 'ooc'; text: string }
  | { type: 'pass' }
  | { type: 'force' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'hello'; you: UserRef; present: UserRef[]; turn: TurnState }
  | { type: 'presence'; present: UserRef[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'turn'; turn: TurnState }
  | { type: 'dm_start'; turnId: string }
  | { type: 'dm_delta'; turnId: string; text: string }
  | { type: 'dm_tool'; turnId: string; tool: string; summary: string }
  | { type: 'dm_end'; turnId: string; ok: boolean }
  | { type: 'state_changed' }
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
