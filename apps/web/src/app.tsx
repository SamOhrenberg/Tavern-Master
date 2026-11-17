import type { Me, ServerMeta } from '@tavern/protocol';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
} from 'react';
import { api, errorMessage, setCsrfToken, setUnauthorizedHandler } from './api';

// ---------- session ----------

interface AuthState {
  /** undefined while the first /me call is in flight. */
  me: Me | null | undefined;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null | undefined>(undefined);

  const setMe = useCallback((next: Me | null) => {
    setCsrfToken(next?.csrfToken ?? '');
    if (next?.id !== metaFor) resetMeta(next?.id ?? null);
    setMeState(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setMe((await api<{ user: Me | null }>('/auth/me')).user);
    } catch {
      setMe(null);
    }
  }, [setMe]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setMe(null);
  }, [setMe]);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    void refresh();
  }, [refresh, setMe]);

  const value = useMemo(() => ({ me, setMe, refresh, logout }), [me, setMe, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** The signed-in user. Only call beneath a route that requires sign-in. */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('not signed in');
  return me;
}

// ---------- what this server can do ----------

let metaFor: string | null = null;
let metaValue: ServerMeta | undefined;
let metaLoad: Promise<void> | null = null;
const metaListeners = new Set<(meta: ServerMeta) => void>();

function resetMeta(userId: string | null): void {
  metaFor = userId;
  metaValue = undefined;
  metaLoad = null;
}

/** Load the server's capabilities again, e.g. after Claude connects. */
export function reloadMeta(): Promise<void> {
  metaLoad = api<ServerMeta>('/meta')
    .then((meta) => {
      metaValue = meta;
      for (const fn of metaListeners) fn(meta);
    })
    .catch(() => {
      metaLoad = null;
    });
  return metaLoad;
}

/** What this server can do for the signed-in user. Loaded once per session; undefined until it arrives. */
export function useMeta(): ServerMeta | undefined {
  const [meta, setMeta] = useState(metaValue);
  useEffect(() => {
    metaListeners.add(setMeta);
    if (metaValue) setMeta(metaValue);
    else if (!metaLoad) void reloadMeta();
    return () => {
      metaListeners.delete(setMeta);
    };
  }, []);
  return meta;
}

// ---------- toasts ----------

interface Toast {
  id: number;
  text: string;
  error: boolean;
}
type Notify = (text: string, kind?: 'ok' | 'error') => void;
const ToastContext = createContext<Notify>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const notify = useCallback<Notify>((text, kind = 'ok') => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-2), { id, text, error: kind === 'error' }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 5000 : 2600);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      {/* Left out of feedback screenshots. */}
      <div className="toasts" role="status" aria-live="polite" data-feedback-hide="">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = (): Notify => useContext(ToastContext);

// ---------- data loading ----------

export interface Query<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (next: T) => void;
}

/** Load something on mount and whenever `deps` change. `reload` refreshes without flashing a spinner. */
export function useQuery<T>(load: () => Promise<T>, deps: DependencyList): Query<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;
  const run = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++run.current;
    try {
      const out = await loader.current();
      if (mine === run.current) {
        setData(out);
        setError(undefined);
      }
    } catch (err) {
      if (mine === run.current) setError(errorMessage(err));
    } finally {
      if (mine === run.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    // The caller's dependency list decides when to load again.
  }, deps);

  return { data, error, loading, reload, setData };
}

/** Run an async action with a busy flag and error toast. */
export function useAction(): [boolean, (fn: () => Promise<void>, done?: string) => Promise<boolean>] {
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const run = useCallback(
    async (fn: () => Promise<void>, done?: string) => {
      setBusy(true);
      try {
        await fn();
        if (done) notify(done);
        return true;
      } catch (err) {
        notify(errorMessage(err), 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );
  return [busy, run];
}

/**
 * Track the visual viewport so layouts can sit exactly above the on-screen
 * keyboard. iOS does not shrink the layout viewport when the keyboard opens;
 * it shrinks the visual one and scrolls the page instead.
 */
export function useVisualViewport(lockScroll = false): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const apply = () => {
      const height = Math.round(vv?.height ?? window.innerHeight);
      root.style.setProperty('--vvh', `${height}px`);
      // iOS may pan the visual viewport down instead of scrolling the page; sheets follow it.
      root.style.setProperty('--vvt', `${Math.max(0, Math.round(vv?.offsetTop ?? 0))}px`);
      // With the keyboard up there is no home indicator to leave room for.
      root.classList.toggle('kb', window.innerHeight - height > 120);
      if (lockScroll && window.scrollY !== 0) window.scrollTo(0, 0);
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('orientationchange', apply);
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvt');
      root.classList.remove('kb');
    };
  }, [lockScroll]);
}
