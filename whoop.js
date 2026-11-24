// ============================================================
// Shared WHOOP client used by health.html, index.html, caffeine.html.
//
// WHOOP rotates refresh tokens: every successful refresh returns a
// NEW refresh_token and invalidates the old one. If two requests
// refresh at the same time with the same token, the second one is
// rejected (400) and the session dies. This module makes sure only
// ONE refresh is ever in flight, and always re-reads the latest
// tokens from localStorage before refreshing (another page/tab may
// already have rotated them).
// ============================================================
(function () {
  const KEY = 'whoop_tokens_v1';

  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
  function save(t) { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch {} }
  function wipe() { try { localStorage.removeItem(KEY); } catch {} }

  let inflight = null;

  async function doRefresh(stale) {
    // Another page/tab may have rotated already — use the newer token if so.
    const cur = load();
    if (cur && cur.access && stale && cur.access !== stale.access && cur.expires > Date.now() + 60000) return cur;
    const t = cur || stale;
    if (!t || !t.refresh) return null;
    try {
      const r = await fetch('/api/whoop-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: t.refresh }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) {
        const next = {
          access: j.access_token,
          refresh: j.refresh_token || t.refresh,
          expires: Date.now() + (j.expires_in || 3600) * 1000,
        };
        save(next);
        return next;
      }
      // 400/401 from WHOOP = refresh token is dead; force a reconnect.
      if (r.status === 400 || r.status === 401) wipe();
      console.error('[whoop] refresh failed', r.status, j && j.error);
    } catch (e) {
      console.error('[whoop] refresh error', e && e.message);
    }
    return null;
  }

  function refresh(stale) {
    if (!inflight) inflight = doRefresh(stale).finally(() => { inflight = null; });
    return inflight;
  }

  async function getTokens() {
    const t = load();
    if (!t || !t.access) return null;
    if (t.expires && Date.now() > t.expires - 60000) return (await refresh(t)) || null;
    return t;
  }

  async function api(path, retried) {
    const t = await getTokens();
    if (!t) throw new Error('not connected');
    const [p, qs] = path.split('?');
    const params = new URLSearchParams(qs || '');
    params.set('path', p);
    const r = await fetch('/api/whoop-data?' + params.toString(), {
      headers: { 'Authorization': 'Bearer ' + t.access, 'Accept': 'application/json' },
    });
    if (r.status === 401 && !retried) {
      const n = await refresh(t);
      if (n) return api(path, true);
      throw new Error('unauthorized — reconnect WHOOP');
    }
    if (!r.ok) throw new Error('WHOOP ' + r.status + ': ' + (await r.text()));
    return r.json();
  }

  function randomState() {
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); // 32 chars (WHOOP needs >= 8)
  }

  window.Whoop = { KEY, load, save, wipe, refresh, getTokens, api, randomState };
})();
