import type {
  ChatMessage,
  ClientMessage,
  DiceRoll,
  DmStatus,
  PendingSheet,
  ServerMessage,
  TurnState,
  UserRef,
} from '@tavern/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export type Link = 'connecting' | 'open' | 'reconnecting' | 'denied';

/** The DM's reply while it is still being written. */
export interface DmStream {
  turnId: string;
  text: string;
  tools: { tool: string; summary: string }[];
}

export interface Table {
  link: Link;
  present: UserRef[];
  turn: TurnState;
  stream: DmStream | null;
  /** Where the campaign's AI is; null until the table has said hello. */
  dm: DmStatus | null;
  /** Returns false when the socket is not open and nothing was sent. */
  send: (msg: ClientMessage) => boolean;
}

interface Handlers {
  onMessage: (message: ChatMessage) => void;
  /** A standalone player roll arrived, to animate and append to the log. */
  onRoll: (roll: DiceRoll) => void;
  onStateChanged: () => void;
  onError: (text: string) => void;
  /** The socket came back after a drop: history may have gaps. */
  onReconnect: () => void;
  onSignedOut: () => void;
  /** Your guide chat has a new reply. */
  onGuide?: (threadId: string) => void;
  /** The rules desk has a new message or ruling. */
  onRules?: () => void;
  /** Messages already posted changed: the story was rewound, or the DM corrected itself. */
  onHistoryChanged?: () => void;
  /** An uploaded sheet of yours moved on. */
  onSheet?: (id: string, status: PendingSheet['status']) => void;
}

const IDLE: TurnState = {
  status: 'idle',
  number: null,
  deadline: null,
  expected: [],
  acted: [],
  done: [],
  passed: [],
  seats: [],
};

/**
 * One campaign's live connection. Reconnects with backoff, and checks the
 * line as soon as the app returns to the foreground, because phones drop
 * sockets silently while a web app is in the background.
 */
export function useTable(campaignId: string, enabled: boolean, handlers: Handlers): Table {
  const [link, setLink] = useState<Link>('connecting');
  const [present, setPresent] = useState<UserRef[]>([]);
  const [turn, setTurn] = useState<TurnState>(IDLE);
  const [stream, setStream] = useState<DmStream | null>(null);
  const [dm, setDm] = useState<DmStatus | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let attempt = 0;
    let wasOpen = false;
    let lastHeard = 0;
    let retry: number | undefined;
    let ping: number | undefined;
    let probe: number | undefined;

    const receive = (msg: ServerMessage) => {
      switch (msg.type) {
        case 'hello':
          setLink('open');
          setPresent(msg.present);
          setTurn(msg.turn);
          setDm(msg.dm);
          if (msg.turn.status !== 'resolving') setStream(null);
          if (wasOpen) h.current.onReconnect();
          wasOpen = true;
          break;
        case 'presence':
          setPresent(msg.present);
          break;
        case 'turn':
          setTurn(msg.turn);
          break;
        case 'message':
          if (msg.message.kind === 'dm') setStream(null);
          h.current.onMessage(msg.message);
          break;
        case 'roll':
          h.current.onRoll(msg.roll);
          break;
        case 'dm_start':
          setStream({ turnId: msg.turnId, text: '', tools: [] });
          break;
        case 'dm_delta':
          setStream((s) => ({
            turnId: msg.turnId,
            text: (s?.turnId === msg.turnId ? s.text : '') + msg.text,
            tools: s?.turnId === msg.turnId ? s.tools : [],
          }));
          break;
        case 'dm_tool':
          setStream((s) => ({
            turnId: msg.turnId,
            text: s?.turnId === msg.turnId ? s.text : '',
            tools: [...(s?.turnId === msg.turnId ? s.tools : []), { tool: msg.tool, summary: msg.summary }],
          }));
          break;
        case 'dm_end':
          setStream(null);
          break;
        case 'history_changed':
          h.current.onHistoryChanged?.();
          break;
        case 'state_changed':
          h.current.onStateChanged();
          break;
        case 'dm_status':
          setDm(msg.dm);
          break;
        case 'guide':
          h.current.onGuide?.(msg.threadId);
          break;
        case 'rules':
          h.current.onRules?.();
          break;
        case 'sheet':
          h.current.onSheet?.(msg.id, msg.status);
          break;
        case 'error':
          h.current.onError(msg.message);
          break;
        case 'pong':
          break;
      }
    };

    const connect = () => {
      if (stopped) return;
      window.clearTimeout(retry);
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // The server must know from the start whether anyone is looking: a
      // reconnect in the background must not count as reading the table.
      const shown = document.visibilityState === 'visible' ? 1 : 0;
      const ws = new WebSocket(
        `${scheme}//${window.location.host}/ws/campaigns/${campaignId}?visible=${shown}`,
      );
      socket.current = ws;

      ws.onopen = () => {
        attempt = 0;
        lastHeard = Date.now();
        // Visibility may have changed while the socket was opening.
        const visible = document.visibilityState === 'visible';
        if (visible !== (shown === 1)) ws.send(JSON.stringify({ type: 'visible', visible }));
        ping = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, 25_000);
      };
      ws.onmessage = (event) => {
        lastHeard = Date.now();
        try {
          receive(JSON.parse(String(event.data)) as ServerMessage);
        } catch {
          // not ours to understand
        }
      };
      ws.onclose = (event) => {
        window.clearInterval(ping);
        if (socket.current !== ws) return;
        socket.current = null;
        if (stopped) return;
        if (event.code === 4401) return h.current.onSignedOut();
        if (event.code === 4403) return setLink('denied');
        setLink(wasOpen ? 'reconnecting' : 'connecting');
        retry = window.setTimeout(connect, Math.min(8000, 400 * 2 ** attempt++));
      };
    };

    /** Back in the foreground: reconnect now, or prove the open socket is still alive. */
    const onVisible = () => {
      if (stopped) return;
      const ws = socket.current;
      // The server sends push notifications only to people who are not looking at the table.
      const visible = document.visibilityState === 'visible';
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'visible', visible }));
      if (!visible) return;
      if (!ws || ws.readyState > WebSocket.OPEN) {
        attempt = 0;
        return connect();
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const asked = Date.now();
      ws.send(JSON.stringify({ type: 'ping' }));
      window.clearTimeout(probe);
      probe = window.setTimeout(() => {
        if (lastHeard < asked && socket.current === ws) ws.close();
      }, 4000);
    };

    connect();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.clearTimeout(probe);
      window.clearInterval(ping);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      socket.current?.close();
      socket.current = null;
    };
  }, [campaignId, enabled]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  return { link, present, turn, stream, dm, send };
}
