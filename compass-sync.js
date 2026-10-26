// Life OS sync engine, shared by the Claude version and the phone app (copied into daily-compass-app/).
// Each device keeps its own copy and trades changes with Supabase: it pushes what it edited, then pulls
// what other devices stored since its last pull. Per day (and for the habit setup) the newest edit wins.
// The page supplies the transport (how to reach Supabase) and how to read and apply its own data.
(() => {
  const STORE = "dc:sync";
  const CHUNK = 200;      // items per push
  const PAGE = 1000;      // rows per pull; matches the limit in compass_pull
  const EVERY = 30000;    // background check while the page is visible

  // Sync codes: 24 characters in groups of four, no look-alike letters (no I, L, O, 0, 1).
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const normalizeCode = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");
  const validCode = s => /^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/.test(normalizeCode(s));

  function create({ transport, getLocal, allLocal, applyRemote, onStatus }) {
    let saved; try { saved = JSON.parse(localStorage.getItem(STORE)); } catch {}
    // primed: this device has offered everything it already had at least once.
    const st = { cursor: 0, dirty: {}, primed: false, lastOk: 0, ...(saved || {}) };
    const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch {} };
    let running = false, again = false, timer = null, interval = null;

    async function run() {
      if (running) { again = true; return; }
      if (!navigator.onLine) return onStatus({ state: "offline", lastOk: st.lastOk, pending: Object.keys(st.dirty).length });
      running = true; onStatus({ state: "syncing", lastOk: st.lastOk });
      try {
        if (!st.primed) { allLocal().forEach(({ kind, id }) => { st.dirty[`${kind}:${id}`] = 1; }); st.primed = true; persist(); }

        const keys = Object.keys(st.dirty);
        const items = keys.map(k => { const i = k.indexOf(":"), kind = k.slice(0, i), id = k.slice(i + 1), l = getLocal(kind, id); return l && { kind, id, data: l.data, updated: l.updated || 0 }; }).filter(Boolean);
        for (let i = 0; i < items.length; i += CHUNK) await transport.push(items.slice(i, i + CHUNK));
        // Something edited mid-push stays dirty and goes out next round.
        keys.forEach(k => { const i = k.indexOf(":"), l = getLocal(k.slice(0, i), k.slice(i + 1)); if (!l || items.some(x => `${x.kind}:${x.id}` === k && x.updated === (l.updated || 0))) delete st.dirty[k]; });
        persist();

        const changed = [];
        for (;;) {
          const rows = await transport.pull(st.cursor);
          for (const r of rows) {
            const l = getLocal(r.kind, r.id);
            if (!l || (l.updated || 0) < r.updated) changed.push(r);
            st.cursor = Math.max(st.cursor, r.synced_at);
          }
          if (rows.length < PAGE) break;
        }
        if (changed.length) applyRemote(changed);
        st.lastOk = Date.now(); persist();
        onStatus({ state: "ok", lastOk: st.lastOk, received: changed.length });
      } catch (e) {
        onStatus({ state: "error", lastOk: st.lastOk, message: e?.message || "Couldn't reach the sync server." });
      } finally {
        running = false;
        if (again) { again = false; run(); }
      }
    }

    const api = {
      markDirty(kind, id) { st.dirty[`${kind}:${id}`] = 1; persist(); },
      soon(ms = 1500) { clearTimeout(timer); timer = setTimeout(run, ms); },
      now: run,
      start() {
        run();
        clearInterval(interval);
        interval = setInterval(() => { if (document.visibilityState === "visible") run(); }, EVERY);
        addEventListener("online", () => run());
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") run(); });
      },
      // A new or removed sync code starts over: offer everything again and pull from the beginning.
      reset() { Object.assign(st, { cursor: 0, dirty: {}, primed: false, lastOk: 0 }); persist(); }
    };
    return api;
  }

  // "just now", "4 min ago", "2 h ago" for status lines.
  const ago = t => { if (!t) return "never"; const s = Math.round((Date.now() - t) / 1000); return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };

  // Supabase over HTTPS, for pages allowed to reach it directly (the phone app).
  function supabaseTransport({ url, key, code }) {
    const headers = { apikey: key, "Content-Type": "application/json" };
    if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`; // legacy anon keys are JWTs; publishable keys go in apikey only
    const rpc = async (fn, body) => {
      const r = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "The sync server refused this app's key." : `Sync server error (${r.status}).`);
      return r.json();
    };
    return {
      pull: since => rpc("compass_pull", { p_key: code, p_since: since }),
      push: items => rpc("compass_push", { p_key: code, p_items: items })
    };
  }

  window.CompassSync = { create, supabaseTransport, normalizeCode, validCode, ago, ALPHABET };
})();
