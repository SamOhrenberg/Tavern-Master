import type { ChatMessage, ClientMessage, ServerMessage, TurnState, UserRef } from '@tavern/protocol';
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
  /** Returns false when the socket is not open and nothing was sent. */
  send: (msg: ClientMessage) => boolean;
}

interface Handlers {
  onMessage: (message: ChatMessage) => void;
  onStateChanged: () => void;
  onError: (text: string) => void;
  /** The socket came back after a drop: history may have gaps. */
  onReconnect: () => void;
  onSignedOut: () => void;
}

const IDLE: TurnState = { status: 'idle', number: null, deadline: null, expected: [], acted: [], passed: [] };

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
        case 'state_changed':
          h.current.onStateChanged();
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
      const ws = new WebSocket(`${scheme}//${window.location.host}/ws/campaigns/${campaignId}`);
      socket.current = ws;

      ws.onopen = () => {
        attempt = 0;
        lastHeard = Date.now();
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
      if (document.visibilityState !== 'visible' || stopped) return;
      const ws = socket.current;
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

  return { link, present, turn, stream, send };
}
