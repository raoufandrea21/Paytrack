import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';

/**
 * HashRouter, not BrowserRouter: DocTrack is meant to be opened from a home
 * screen icon and served by any static host or from cache with no connection at
 * all. Hash routes never depend on a server rewrite rule.
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);

// Registered here rather than by the plugin so the app controls the timing and
// can surface failures instead of swallowing them.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const url = import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js';
    navigator.serviceWorker
      .register(url, { type: import.meta.env.DEV ? 'module' : 'classic', scope: '/' })
      .catch((error) => {
        // Most common cause: an insecure origin (plain http:// over the LAN).
        // The app still works; only offline install and background sync don't.
        console.warn('[doctrack] service worker not registered', error);
      });
  });
}
