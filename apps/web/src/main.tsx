import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/cinzel/latin-500.css';
import '@fontsource/cinzel/latin-600.css';
import '@fontsource/cinzel/latin-700.css';
import './styles/base.css';
import './styles/components.css';
import './styles/install.css';
import './styles/screens.css';
import './styles/play.css';
import { AuthProvider, ToastProvider } from './app';
import { InstallPrompt } from './install';
import { AppRoutes } from './routes';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AppRoutes />
          <InstallPrompt />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);

// The service worker only exists in a build, and browsers only allow one on
// HTTPS or localhost. Without it the app still installs to the Home Screen.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // The first visit loaded its scripts before the worker existed. Hand
        // it those URLs so the next launch starts from cache.
        const urls = performance
          .getEntriesByType('resource')
          .map((e) => new URL(e.name))
          .filter((u) => u.origin === window.location.origin && u.pathname.startsWith('/assets/'))
          .map((u) => u.pathname);
        reg.active?.postMessage({ type: 'cache', urls });
      })
      .catch(() => undefined);
  });
}
