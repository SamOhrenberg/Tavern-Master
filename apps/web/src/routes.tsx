import type { CampaignInvite, Friend } from '@tavern/protocol';
import { useEffect, useRef } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useNavigate, useOutletContext } from 'react-router-dom';
import { api } from './api';
import { useAuth, useQuery } from './app';
import { IconBook, IconCampfire, IconCog, IconShield, IconUsers } from './icons';
import { FeedbackProvider } from './feedback/sheet';
import { syncPush } from './push';
import { AdminScreen } from './screens/admin';
import { AuthScreen } from './screens/auth';
import { CampaignsScreen } from './screens/campaigns';
import { ConnectScreen } from './screens/connect';
import { FriendsScreen } from './screens/friends';
import { LibraryScreen, SystemScreen } from './screens/library';
import { PlayScreen } from './screens/play';
import { SettingsScreen } from './screens/settings';

/** Things waiting on the signed-in user, shared by the tab bar and the screens. */
export interface Inbox {
  invites: CampaignInvite[];
  friends: Friend[];
  reload: () => void;
}

export const useInbox = (): Inbox => useOutletContext<Inbox>();

function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading">
      <img src="/icons/icon-192.png" width={84} height={84} alt="" />
    </div>
  );
}

function Shell() {
  const { me } = useAuth();
  const invites = useQuery(() => api<{ invites: CampaignInvite[] }>('/campaign-invites'), []);
  const friends = useQuery(() => api<{ friends: Friend[] }>('/friends'), []);

  const reloadInvites = invites.reload;
  const reloadFriends = friends.reload;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void reloadInvites();
      void reloadFriends();
    };
    const timer = window.setInterval(refresh, 45_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reloadInvites, reloadFriends]);

  const inbox: Inbox = {
    invites: invites.data?.invites ?? [],
    friends: friends.data?.friends ?? [],
    reload: () => {
      void reloadInvites();
      void reloadFriends();
    },
  };
  const requests = inbox.friends.filter((f) => f.status === 'pending' && f.direction === 'incoming').length;
  const tab = ({ isActive }: { isActive: boolean }) => `tab${isActive ? ' active' : ''}`;

  return (
    <div className="shell">
      <Outlet context={inbox} />
      <div className="tabbar">
        <nav aria-label="Main">
          <NavLink to="/" end className={tab}>
            <IconCampfire />
            Table
            {inbox.invites.length > 0 && <span className="dot" />}
          </NavLink>
          <NavLink to="/friends" className={tab}>
            <IconUsers />
            Friends
            {requests > 0 && <span className="dot" />}
          </NavLink>
          <NavLink to="/library" className={tab}>
            <IconBook />
            Library
          </NavLink>
          {me?.role === 'admin' && (
            <NavLink to="/admin" className={tab}>
              <IconShield />
              Admin
            </NavLink>
          )}
          <NavLink to="/you" className={tab}>
            <IconCog />
            You
            {me?.totpRequired && <span className="dot" />}
          </NavLink>
        </nav>
      </div>
    </div>
  );
}

export function AppRoutes() {
  const { me } = useAuth();
  if (me === undefined) return <Splash />;
  if (!me) return <AuthScreen />;
  return (
    <FeedbackProvider>
      <AppRoutesInner admin={me.role === 'admin'} />
    </FeedbackProvider>
  );
}

/** Tapping a notification while the app is open routes inside it instead of reloading. */
function usePushBridge() {
  // navigate changes with every route, and this must run once per launch.
  const navigate = useNavigate();
  const go = useRef(navigate);
  go.current = navigate;
  useEffect(() => {
    void syncPush().catch(() => undefined);
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: unknown } | null;
      if (data?.type === 'open' && typeof data.url === 'string' && data.url.startsWith('/'))
        go.current(data.url);
    };
    sw?.addEventListener('message', onMessage);
    return () => sw?.removeEventListener('message', onMessage);
  }, []);
}

function AppRoutesInner({ admin }: { admin: boolean }) {
  usePushBridge();
  return (
    <Routes>
      <Route path="/c/:id" element={<PlayScreen />} />
      <Route path="/connect" element={<ConnectScreen />} />
      <Route element={<Shell />}>
        <Route index element={<CampaignsScreen />} />
        <Route path="friends" element={<FriendsScreen />} />
        <Route path="library" element={<LibraryScreen />} />
        <Route path="library/:id" element={<SystemScreen />} />
        <Route path="you" element={<SettingsScreen />} />
        <Route path="admin" element={admin ? <AdminScreen /> : <Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
