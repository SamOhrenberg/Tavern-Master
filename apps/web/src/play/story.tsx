import type { ChatMessage, Citation, DiceRoll, EntityRef, HpChange } from '@tavern/protocol';
import { Fragment, memo, type ReactNode } from 'react';
import { IconAlert, IconD20, IconDots } from '../icons';
import { Avatar, ruleSource } from '../ui';
import type { DmStream } from './socket';

type OnCite = (ref: string) => void;
type OnRef = (entityId: string) => void;

/** The interactive markup a line of narration may carry: citations and codex links. */
interface Marks {
  onCite?: OnCite;
  onRef?: OnRef;
  refs?: EntityRef[];
}

/** Bold, italics, rule citations and codex links inside one line of narration. */
function inline(text: string, m: Marks, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[\[[^\]\n]+\]\]|\[R\d+\])/g;
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(re)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const tok = match[0];
    const k = `${key}-${n++}`;
    if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('[[')) {
      const inner = tok.slice(2, -2);
      const ref = m.refs?.find((r) => r.text.toLowerCase() === inner.toLowerCase());
      out.push(
        ref && m.onRef ? (
          <button
            key={k}
            type="button"
            className="ref"
            onClick={() => m.onRef!(ref.entityId)}
            title={ref.name}
          >
            {inner}
          </button>
        ) : (
          // No resolved entry (or mid-stream): read it as plain text.
          <Fragment key={k}>{inner}</Fragment>
        ),
      );
    } else if (tok.startsWith('[')) {
      const ref = tok.slice(1, -1);
      out.push(
        m.onCite ? (
          <button key={k} type="button" className="cite" onClick={() => m.onCite!(ref)}>
            {ref}
          </button>
        ) : (
          <span key={k} className="cite">
            {ref}
          </span>
        ),
      );
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function lines(block: string, m: Marks, key: string): ReactNode[] {
  return block.split('\n').map((line, i) => (
    <Fragment key={`${key}-l${i}`}>
      {i > 0 && <br />}
      {inline(line, m, `${key}-l${i}`)}
    </Fragment>
  ));
}

/**
 * The small slice of Markdown a narrator actually uses: paragraphs, emphasis,
 * lists, headings and quotes. Built as React nodes, so model output is never
 * treated as HTML.
 */
export function Story({
  text,
  onCite,
  onRef,
  refs,
}: {
  text: string;
  onCite?: OnCite;
  onRef?: OnRef;
  refs?: EntityRef[];
}) {
  const m: Marks = { onCite, onRef, refs };
  // A DM writing through a tool call sometimes escapes its quotes twice ("Priss" arrives as \"Priss\").
  const blocks = text
    .replace(/\\(["'])/g, '$1')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (
    <>
      {blocks.map((block, i) => {
        const key = `b${i}`;
        const rows = block.split('\n');
        if (/^(-{3,}|\*{3,})$/.test(block)) return <hr key={key} />;
        if (/^#{1,4}\s/.test(block)) return <h3 key={key}>{inline(block.replace(/^#+\s*/, ''), m, key)}</h3>;
        if (rows.every((r) => /^\s*[-*•]\s+/.test(r))) {
          return (
            <ul key={key}>
              {rows.map((r, j) => (
                <li key={j}>{inline(r.replace(/^\s*[-*•]\s+/, ''), m, `${key}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        if (rows.every((r) => /^\s*\d+[.)]\s+/.test(r))) {
          return (
            <ol key={key}>
              {rows.map((r, j) => (
                <li key={j}>{inline(r.replace(/^\s*\d+[.)]\s+/, ''), m, `${key}-${j}`)}</li>
              ))}
            </ol>
          );
        }
        if (rows.every((r) => r.startsWith('>'))) {
          return <blockquote key={key}>{lines(block.replace(/^>\s?/gm, ''), m, key)}</blockquote>;
        }
        return <p key={key}>{lines(block, m, key)}</p>;
      })}
    </>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const ROLL_KIND_LABEL: Record<string, string> = {
  attack: 'To hit',
  damage: 'Damage',
  check: 'Check',
  save: 'Save',
  initiative: 'Initiative',
};

/** "Hit" or "Miss" for an attack, "Success" or "Failure" for anything else. */
const outcomeWord = (roll: DiceRoll) =>
  roll.kind === 'attack' ? (roll.success ? 'Hit' : 'Miss') : roll.success ? 'Success' : 'Failure';

/** One roll the server made: what it was for, the faces, whether it succeeded, and the total. */
export function RollChip({ roll }: { roll: DiceRoll }) {
  const d20 = roll.dice.find((d) => d.kept && d.sides === 20);
  const tone = d20?.value === 20 ? ' crit' : d20?.value === 1 ? ' fumble' : '';
  const kindLabel = roll.kind ? ROLL_KIND_LABEL[roll.kind] : undefined;
  const judged = roll.success === undefined ? '' : roll.success ? ' passed' : ' failed';
  return (
    <div className={`roll${tone}${judged}`}>
      <IconD20 />
      <div className="grow roll-body">
        <div className="roll-why">
          {roll.character && <b>{roll.character} · </b>}
          {kindLabel && <span className={`roll-kind ${roll.kind}`}>{kindLabel}</span>}
          {roll.reason || 'Roll'}
        </div>
        <div className="roll-math">
          <span className="mono">{roll.expression}</span>
          {roll.dice.map((d, i) => (
            <span key={i} className={`face${d.kept ? '' : ' dropped'}`}>
              {d.value}
            </span>
          ))}
          {roll.success !== undefined && roll.target !== undefined && (
            <span className={`roll-outcome ${roll.success ? 'pass' : 'fail'}`}>
              {outcomeWord(roll)}
              <span className="roll-need">
                {roll.under ? `≤ ${roll.target}` : `${roll.kind === 'attack' ? 'AC' : 'DC'} ${roll.target}`}
              </span>
            </span>
          )}
        </div>
      </div>
      <span className="roll-total">{roll.total}</span>
    </div>
  );
}

/** A party member's hit points over the turn: who, by how much, and where that leaves them. */
function HpLine({ change: h }: { change: HpChange }) {
  const delta = h.to - h.from;
  const tone = delta < 0 ? 'hurt' : 'healed';
  return (
    <li className={`hp-change ${tone}`}>
      <b className="truncate">{h.character}</b>
      <span className={`hp-delta ${tone}`}>{delta < 0 ? `−${-delta}` : `+${delta}`} HP</span>
      <span className="hp-now mono">
        {h.from} → {h.to}/{h.max}
      </span>
    </li>
  );
}

/** The button that opens what can be done with a message: edit it, or rewind the story to it. */
function MoreButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="msg-more" onClick={onClick} aria-label="Edit or rewind">
      <IconDots />
    </button>
  );
}

function DmHead({
  live,
  time,
  edited,
  onMore,
}: {
  live?: boolean;
  time?: string;
  edited?: boolean;
  onMore?: () => void;
}) {
  return (
    <header className="dm-head">
      <span className={`dm-mark${live ? ' live' : ''}`}>
        <IconD20 />
      </span>
      <span className="dm-name">Dungeon Master</span>
      {time && (
        <time className="msg-time">
          {edited ? 'edited · ' : ''}
          {time}
        </time>
      )}
      {onMore && <MoreButton onClick={onMore} />}
    </header>
  );
}

const TOOL_LABEL: Record<string, string> = {
  roll_dice: 'Rolling the dice',
  lookup_rules: 'Consulting the rulebook',
  get_state: 'Checking the party',
  update_character: 'Updating a character',
  modify_inventory: 'Sorting through packs',
  upsert_entity: 'Making a note of the world',
  reveal_secret: 'Revealing a secret',
  set_flag: 'Recording what happened',
  set_scene: 'Setting the scene',
  remember: 'Committing it to memory',
  write_note: 'Writing in the notebook',
  recall: 'Leafing back through the chronicle',
  search_documents: 'Consulting the campaign documents',
  edit_sheet: 'Updating a character sheet',
  search_setting: 'Drawing on the setting',
  request_roll: 'Calling for a roll',
  polish: 'Polishing the narration',
};

/** The reply in flight: tool activity first, then the words as they arrive. */
export function LiveDm({
  stream,
  waitingOn,
  children,
}: {
  stream: DmStream;
  /** Why nothing is happening yet, when the DM is not there to answer. */
  waitingOn?: string;
  children?: ReactNode;
}) {
  const latest = stream.tools[stream.tools.length - 1];
  return (
    <article className="msg dm live" aria-live="polite">
      <DmHead live />
      {latest && (
        <div className="dm-tool">
          <span className="live-dot" />
          <span className="truncate">{TOOL_LABEL[latest.tool] ?? 'Working'}…</span>
        </div>
      )}
      {stream.text ? (
        <div className="story">
          <Story text={stream.text} />
        </div>
      ) : (
        !latest && (
          <div className="dm-tool">
            <span className="live-dot" />
            <span>
              {waitingOn ??
                (stream.turnId === 'opening' ? 'Preparing the opening scene…' : 'Weighing your actions…')}
            </span>
          </div>
        )
      )}
      {children}
    </article>
  );
}

/**
 * Whether two messages come from the same speaker, so the second can drop its
 * name row. Both the author and the character must match: AI companions have
 * no author at all, and one player may run more than one character.
 */
export function sameSpeaker(a: ChatMessage, b: ChatMessage): boolean {
  return (
    (a.user?.id ?? null) === (b.user?.id ?? null) && (a.characterName ?? null) === (b.characterName ?? null)
  );
}

interface ItemProps {
  message: ChatMessage;
  mine: boolean;
  /** Hide the name row when the previous message came from the same player. */
  joined: boolean;
  /** The picture of the character who acted, if it has one. */
  portrait?: string;
  onCite: (citation: Citation) => void;
  /** Open the codex entry a narration link points to. */
  onRef?: (entityId: string) => void;
  /** This viewer may edit the message, or rewind to it: show its menu button. */
  canEdit?: boolean;
  /** Open the menu for a message. Stable, so the list does not re-render for it. */
  onMenu?: (message: ChatMessage) => void;
}

export const MessageItem = memo(function MessageItem({
  message: m,
  mine,
  joined,
  portrait,
  onCite,
  onRef,
  canEdit,
  onMenu,
}: ItemProps) {
  const more = canEdit && onMenu ? () => onMenu(m) : undefined;
  if (m.kind === 'dm') {
    const cite = (ref: string) => {
      const hit = m.citations?.find((c) => c.ref === ref);
      if (hit) onCite(hit);
    };
    return (
      <article className="msg dm">
        <DmHead time={clock(m.createdAt)} edited={m.edited} onMore={more} />
        {((m.rolls && m.rolls.length > 0) || (m.hp && m.hp.length > 0)) && (
          <div className="rolls">
            {m.rolls?.map((r) => (
              <RollChip key={r.id} roll={r} />
            ))}
            {m.hp && m.hp.length > 0 && (
              <ul className="hp-changes" aria-label="Hit points">
                {m.hp.map((h) => (
                  <HpLine key={h.character} change={h} />
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="story">
          <Story text={m.content} onCite={cite} onRef={onRef} refs={m.refs} />
        </div>
        {m.citations && m.citations.length > 0 && (
          <div className="sources">
            {m.citations.map((c) => (
              <button key={c.ref} type="button" className="source" onClick={() => onCite(c)}>
                <b>{c.ref}</b>
                <span className="truncate">{ruleSource(c.document, c.heading, c.page)}</span>
              </button>
            ))}
          </div>
        )}
        {m.redacted && <p className="small faint">Part of this reply was withheld to protect a secret.</p>}
      </article>
    );
  }

  if (m.kind === 'system') {
    return (
      <div className="msg system" role="note">
        <IconAlert />
        <span>{m.content}</span>
      </div>
    );
  }

  // An action with no author came from a party member that an AI plays.
  const player = m.user?.displayName ?? (m.ai ? 'AI companion' : 'Someone');
  if (m.kind === 'ooc') {
    return (
      <div className={`msg ooc${mine ? ' mine' : ''}`}>
        <span className="ooc-who">{mine ? 'You' : player}</span>
        <span className="ooc-text">{m.content}</span>
      </div>
    );
  }

  const who = m.characterName ?? player;
  return (
    <div className={`msg action${mine ? ' mine' : ''}${joined ? ' joined' : ''}${m.ai ? ' ai' : ''}`}>
      {!mine && (
        <div className="action-avatar">
          {!joined && <Avatar name={who} seed={m.user?.id ?? who} src={portrait} small />}
        </div>
      )}
      <div className="action-body">
        {!joined && (
          <div className="action-who">
            <b>{who}</b>
            {m.characterName && !mine && <span>{player}</span>}
            <time className="msg-time">{clock(m.createdAt)}</time>
          </div>
        )}
        <div className="bubble-row">
          <div className="bubble">{m.content}</div>
          {more && <MoreButton onClick={more} />}
        </div>
        {m.edited && <span className="edited-note">edited</span>}
      </div>
    </div>
  );
});
