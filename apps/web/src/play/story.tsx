import type { ChatMessage, Citation, DiceRoll } from '@tavern/protocol';
import { Fragment, memo, type ReactNode } from 'react';
import { IconAlert, IconD20 } from '../icons';
import { Avatar, ruleSource } from '../ui';
import type { DmStream } from './socket';

type OnCite = (ref: string) => void;

/** Bold, italics and rule citations inside one line of narration. */
function inline(text: string, onCite: OnCite | undefined, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[R\d+\])/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('[')) {
      const ref = tok.slice(1, -1);
      out.push(
        onCite ? (
          <button key={k} type="button" className="cite" onClick={() => onCite(ref)}>
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

function lines(block: string, onCite: OnCite | undefined, key: string): ReactNode[] {
  return block.split('\n').map((line, i) => (
    <Fragment key={`${key}-l${i}`}>
      {i > 0 && <br />}
      {inline(line, onCite, `${key}-l${i}`)}
    </Fragment>
  ));
}

/**
 * The small slice of Markdown a narrator actually uses: paragraphs, emphasis,
 * lists, headings and quotes. Built as React nodes, so model output is never
 * treated as HTML.
 */
export function Story({ text, onCite }: { text: string; onCite?: OnCite }) {
  const blocks = text
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
        if (/^#{1,4}\s/.test(block))
          return <h3 key={key}>{inline(block.replace(/^#+\s*/, ''), onCite, key)}</h3>;
        if (rows.every((r) => /^\s*[-*•]\s+/.test(r))) {
          return (
            <ul key={key}>
              {rows.map((r, j) => (
                <li key={j}>{inline(r.replace(/^\s*[-*•]\s+/, ''), onCite, `${key}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        if (rows.every((r) => /^\s*\d+[.)]\s+/.test(r))) {
          return (
            <ol key={key}>
              {rows.map((r, j) => (
                <li key={j}>{inline(r.replace(/^\s*\d+[.)]\s+/, ''), onCite, `${key}-${j}`)}</li>
              ))}
            </ol>
          );
        }
        if (rows.every((r) => r.startsWith('>'))) {
          return <blockquote key={key}>{lines(block.replace(/^>\s?/gm, ''), onCite, key)}</blockquote>;
        }
        return <p key={key}>{lines(block, onCite, key)}</p>;
      })}
    </>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** One roll the server made: what it was for, the faces, and the total. */
export function RollChip({ roll }: { roll: DiceRoll }) {
  const d20 = roll.dice.find((d) => d.kept && d.sides === 20);
  const tone = d20?.value === 20 ? ' crit' : d20?.value === 1 ? ' fumble' : '';
  return (
    <div className={`roll${tone}`}>
      <IconD20 />
      <div className="grow">
        <div className="roll-why truncate">
          {roll.character && <b>{roll.character} · </b>}
          {roll.reason || 'Roll'}
        </div>
        <div className="roll-math">
          <span className="mono">{roll.expression}</span>
          {roll.dice.map((d, i) => (
            <span key={i} className={`face${d.kept ? '' : ' dropped'}`}>
              {d.value}
            </span>
          ))}
        </div>
      </div>
      <span className="roll-total">{roll.total}</span>
    </div>
  );
}

function DmHead({ live, time }: { live?: boolean; time?: string }) {
  return (
    <header className="dm-head">
      <span className={`dm-mark${live ? ' live' : ''}`}>
        <IconD20 />
      </span>
      <span className="dm-name">Dungeon Master</span>
      {time && <time className="msg-time">{time}</time>}
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
};

/** The reply in flight: tool activity first, then the words as they arrive. */
export function LiveDm({ stream }: { stream: DmStream }) {
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
            <span>Weighing your actions…</span>
          </div>
        )
      )}
    </article>
  );
}

interface ItemProps {
  message: ChatMessage;
  mine: boolean;
  /** Hide the name row when the previous message came from the same player. */
  joined: boolean;
  onCite: (citation: Citation) => void;
}

export const MessageItem = memo(function MessageItem({ message: m, mine, joined, onCite }: ItemProps) {
  if (m.kind === 'dm') {
    const cite = (ref: string) => {
      const hit = m.citations?.find((c) => c.ref === ref);
      if (hit) onCite(hit);
    };
    return (
      <article className="msg dm">
        <DmHead time={clock(m.createdAt)} />
        {m.rolls && m.rolls.length > 0 && (
          <div className="rolls">
            {m.rolls.map((r) => (
              <RollChip key={r.id} roll={r} />
            ))}
          </div>
        )}
        <div className="story">
          <Story text={m.content} onCite={cite} />
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

  const player = m.user?.displayName ?? 'Someone';
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
    <div className={`msg action${mine ? ' mine' : ''}${joined ? ' joined' : ''}`}>
      {!mine && (
        <div className="action-avatar">{!joined && <Avatar name={who} seed={m.user?.id} small />}</div>
      )}
      <div className="action-body">
        {!joined && (
          <div className="action-who">
            <b>{who}</b>
            {m.characterName && !mine && <span>{player}</span>}
            <time className="msg-time">{clock(m.createdAt)}</time>
          </div>
        )}
        <div className="bubble">{m.content}</div>
      </div>
    </div>
  );
});
