/**
 * Listen Along page (DOM port of Vynl's former in-app page).
 *
 * The host hands the plugin a container element; this module renders the
 * session UI into it, re-rendering on state changes, and returns a cleanup
 * function the host calls when the user navigates away.
 */

import * as la from "./state.js";
import * as net from "./net.js";

const T = {
  title: "Listen Along",
  subtitle: "Listen together with others over the network",
  hostSession: "Host a Session",
  hostDesc: "Share your code so friends can listen with you",
  joinSession: "Join a Session",
  joinDesc: "Enter a code to sync with someone's session",
  startHosting: "Start Hosting",
  starting: "Starting...",
  joinCta: "Join",
  codePlaceholder: "Enter code",
  connected: "Connected",
  lowLatency: "Low latency",
  hosting: "Hosting",
  joined: "Joined",
  leave: "Leave",
  shareCode: "Share Code",
  copyCode: "Copy code",
  copied: "Copied",
  sessionPeers: "Peers",
  waitingForPeers: "Waiting for others to join...",
  idle: "Not listening",
  configTitle: "Supabase setup",
  configDesc:
    "This plugin syncs through your own Supabase project. Official Vynl builds ship with Vynl's project preconfigured; self-hosters should enter their own project URL and anon key.",
  urlPlaceholder: "https://<project>.supabase.co",
  keyPlaceholder: "anon key",
  save: "Save",
};

const ICON = {
  copy:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  leave:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>',
};

const STYLE_ID = "listen-along-plugin-styles";

const CSS = `
.la-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding-top: 28px;
  overflow-y: auto;
  scrollbar-width: none;
}
.la-page::-webkit-scrollbar { display: none; }

.la-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.04em;
  border: 1px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.1s;
}
.la-btn:active:not(:disabled) { transform: scale(0.97); }
.la-btn:disabled { opacity: 0.3; cursor: default; }
.la-btn--sm { height: 36px; min-width: 92px; padding: 0 16px; font-size: 12px; }
.la-btn--primary {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 500;
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}
.la-btn--primary:not(:disabled):hover {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
}
.la-btn--danger {
  background: rgba(255, 107, 97, 0.08);
  color: var(--red);
  font-weight: 500;
  border-color: rgba(255, 107, 97, 0.35);
}
.la-btn--danger:not(:disabled):hover { background: rgba(255, 107, 97, 0.15); border-color: var(--red); }

.la-spin {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: la-spin 1s linear infinite;
  display: inline-block;
}
@keyframes la-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.la-hdr {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.la-title { font-size: 26px; font-weight: 600; line-height: 1.15; margin: 0; }
.la-subtitle { font-size: 11.5px; color: var(--faint); margin: 4px 0 0; }

.la-config { padding: 22px 0; border-bottom: 1px solid var(--line); }
.la-config-row { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.la-config-row .la-input { flex: 1; min-width: 220px; }
.la-input {
  height: 36px;
  padding: 0 12px;
  background: var(--bg-raise);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12.5px;
  transition: border-color 0.15s;
}
.la-input:focus { outline: none; border-color: var(--faint); }
.la-input::placeholder { color: var(--faint); }

.la-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 22px 0;
  border-bottom: 1px solid var(--line);
}
.la-sec-text { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.la-sec-title { font-size: 17px; font-weight: 600; line-height: 1.2; }
.la-sec-desc { font-size: 12.5px; color: var(--faint); line-height: 1.5; max-width: 46ch; margin: 0; }
.la-section .la-btn--sm { min-width: 138px; }

.la-join-field { display: flex; gap: 8px; flex-shrink: 0; }
.la-join-input {
  width: 130px;
  height: 36px;
  padding: 0 12px;
  background: var(--bg-raise);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  transition: border-color 0.15s;
}
.la-join-input:focus { outline: none; border-color: var(--faint); }
.la-join-input::placeholder {
  color: var(--faint);
  letter-spacing: 0.03em;
  text-transform: none;
  font-weight: 400;
  font-size: 12px;
}
.la-join-field .la-btn--sm { min-width: 78px; }

.la-error {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 16px;
  font-size: 12px;
  color: var(--red);
}

.la-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dim);
}
.la-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); flex-shrink: 0; }
.la-dot.live { background: var(--green); }
.la-status-mode { margin-left: auto; color: var(--faint); }

.la-code-block { padding: 26px 0; border-bottom: 1px solid var(--line); }
.la-code-label {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--faint);
  margin-bottom: 12px;
}
.la-code-row { display: flex; align-items: center; gap: 16px; }
.la-code { font-size: 52px; font-weight: 600; letter-spacing: 0.16em; line-height: 1; }
.la-copy {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  transition: all 0.15s;
}
.la-copy:hover { color: var(--text); border-color: var(--faint); }

.la-peers-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 0 10px;
  font-size: 10.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}
.la-peers-count { color: var(--dim); }
.la-peers { display: flex; flex-direction: column; }
.la-peer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 11px 0;
  border-top: 1px solid var(--line);
}
.la-peer-name {
  width: 160px;
  flex-shrink: 0;
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.la-peer-track {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.la-peer-dot { width: 6px; height: 6px; border-radius: 50%; background: transparent; flex-shrink: 0; }
.la-peer-dot.on { background: var(--green); }
.la-empty { padding: 28px 0; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--faint); }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function normalizeCode(v) {
  return v.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6);
}

/**
 * Render the page into `container`.
 * `ctx` = { api, getConfig(): {url, key}, saveConfig(url, key): Promise<void> }
 * Returns a cleanup function.
 */
export function mountPage(container, ctx) {
  ensureStyles();

  let joinCode = "";
  let hosting = false;
  let joining = false;
  let copied = false;
  let error = null;
  let copiedTimer = null;
  const listeners = [];

  const on = (target, event, fn) => {
    target.addEventListener(event, fn);
    listeners.push([target, event, fn]);
  };

  container.replaceChildren();
  container.appendChild(
    el(`
      <div class="la-page">
        <header class="la-hdr">
          <div>
            <h1 class="la-title display"></h1>
            <p class="la-subtitle mono"></p>
          </div>
          <button class="la-btn la-btn--danger la-btn--sm la-leave" hidden></button>
        </header>

        <div class="la-config" hidden>
          <div class="la-sec-title display"></div>
          <p class="la-sec-desc mono"></p>
          <div class="la-config-row">
            <input class="la-input mono la-cfg-url" spellcheck="false" autocomplete="off" />
            <input class="la-input mono la-cfg-key" spellcheck="false" autocomplete="off" />
            <button class="la-btn la-btn--primary la-btn--sm la-cfg-save"></button>
          </div>
        </div>

        <div class="la-setup">
          <section class="la-section">
            <div class="la-sec-text">
              <div class="la-sec-title display"></div>
              <div class="la-sec-desc mono"></div>
            </div>
            <button class="la-btn la-btn--primary la-btn--sm la-host"><span class="la-host-label"></span></button>
          </section>
          <section class="la-section">
            <div class="la-sec-text">
              <div class="la-sec-title display"></div>
              <div class="la-sec-desc mono"></div>
            </div>
            <div class="la-join-field">
              <input class="la-join-input mono" maxlength="6" spellcheck="false" autocomplete="off" />
              <button class="la-btn la-btn--primary la-btn--sm la-join"></button>
            </div>
          </section>
          <div class="la-error mono" role="alert" hidden></div>
        </div>

        <div class="la-session" hidden>
          <div class="la-status mono">
            <span class="la-dot"></span>
            <span class="la-status-text"></span>
            <span class="la-status-mode"></span>
          </div>
          <div class="la-code-block">
            <div class="la-code-label mono"></div>
            <div class="la-code-row">
              <span class="la-code display"></span>
              <button class="la-copy"></button>
            </div>
          </div>
          <div class="la-peers-head mono">
            <span class="la-peer-head-label"></span>
            <span class="la-peers-count">0</span>
          </div>
          <div class="la-empty mono"></div>
          <div class="la-peers"></div>
        </div>
      </div>
    `),
  );

  const q = (sel) => container.querySelector(sel);
  const qa = (sel) => [...container.querySelectorAll(sel)];

  // Static labels (textContent only — no user data ever hits innerHTML).
  q(".la-title").textContent = T.title;
  q(".la-subtitle").textContent = T.subtitle;
  q(".la-leave").append(el(`<span>${ICON.leave}</span>`), document.createTextNode(T.leave));
  q(".la-config .la-sec-title").textContent = T.configTitle;
  q(".la-config .la-sec-desc").textContent = T.configDesc;
  q(".la-cfg-url").placeholder = T.urlPlaceholder;
  q(".la-cfg-key").placeholder = T.keyPlaceholder;
  q(".la-cfg-save").textContent = T.save;
  qa(".la-section .la-sec-title")[0].textContent = T.hostSession;
  qa(".la-sec-desc")[0].textContent = T.hostDesc;
  qa(".la-section .la-sec-title")[1].textContent = T.joinSession;
  qa(".la-sec-desc")[1].textContent = T.joinDesc;
  q(".la-join-input").placeholder = T.codePlaceholder;
  q(".la-join").textContent = T.joinCta;
  q(".la-code-label").textContent = T.shareCode;
  q(".la-peer-head-label").textContent = T.sessionPeers;
  q(".la-empty").textContent = T.waitingForPeers;

  const refs = {
    leave: q(".la-leave"),
    config: q(".la-config"),
    cfgUrl: q(".la-cfg-url"),
    cfgKey: q(".la-cfg-key"),
    cfgSave: q(".la-cfg-save"),
    setup: q(".la-setup"),
    host: q(".la-host"),
    hostLabel: q(".la-host-label"),
    join: q(".la-join"),
    joinInput: q(".la-join-input"),
    error: q(".la-error"),
    session: q(".la-session"),
    dot: q(".la-dot"),
    statusText: q(".la-status-text"),
    statusMode: q(".la-status-mode"),
    codeBlock: q(".la-code-block"),
    code: q(".la-code"),
    copy: q(".la-copy"),
    peersCount: q(".la-peers-count"),
    empty: q(".la-empty"),
    peers: q(".la-peers"),
  };

  const initial = ctx.getConfig();
  refs.cfgUrl.value = initial.url ?? "";
  refs.cfgKey.value = initial.key ?? "";

  function renderPeers(peers) {
    refs.peersCount.textContent = String(peers.length);
    refs.empty.hidden = peers.length > 0;
    const frag = document.createDocumentFragment();
    for (const peer of peers) {
      const row = document.createElement("div");
      row.className = "la-peer";

      const name = document.createElement("span");
      name.className = "la-peer-name display";
      name.textContent = peer.hostname;

      const track = document.createElement("span");
      track.className = "la-peer-track mono";
      track.textContent = peer.track
        ? `${peer.track.title} — ${peer.track.artist}`
        : T.idle;

      const dot = document.createElement("span");
      dot.className = `la-peer-dot${peer.track?.playing ? " on" : ""}`;

      row.append(name, track, dot);
      frag.appendChild(row);
    }
    refs.peers.replaceChildren(frag);
  }

  function render() {
    const active = la.isRelayActive();
    const mode = la.getMode();
    const configured = net.isConfigured();

    refs.leave.hidden = !active;
    refs.config.hidden = configured;
    refs.setup.hidden = active || !configured;
    refs.session.hidden = !active;

    // host button
    refs.hostLabel.textContent = hosting ? T.starting : T.startHosting;
    const wantSpin = hosting;
    const hasSpin = !!refs.host.querySelector(".la-spin");
    if (wantSpin && !hasSpin) refs.host.prepend(el('<span class="la-spin"></span>'));
    if (!wantSpin && hasSpin) refs.host.querySelector(".la-spin")?.remove();
    refs.host.disabled = hosting || !configured;

    // join
    if (refs.joinInput.value !== joinCode) refs.joinInput.value = joinCode;
    refs.join.disabled = joining || joinCode.length < 6 || !configured;
    refs.join.textContent = joining ? "" : T.joinCta;
    if (joining && !refs.join.querySelector(".la-spin")) {
      refs.join.appendChild(el('<span class="la-spin"></span>'));
    } else if (!joining) {
      refs.join.querySelector(".la-spin")?.remove();
    }

    // error
    refs.error.hidden = error === null;
    if (error !== null) refs.error.textContent = error;

    if (active) {
      const live = la.isWebrtcLive();
      refs.dot.classList.toggle("live", live);
      refs.statusText.textContent = live ? T.lowLatency : T.connected;
      refs.statusMode.textContent = mode === "host" ? T.hosting : T.joined;
      refs.codeBlock.hidden = mode !== "host";
      refs.code.textContent = la.getShareCode();
      refs.copy.innerHTML = copied ? ICON.check : ICON.copy;
      const copyLabel = copied ? T.copied : T.copyCode;
      refs.copy.title = copyLabel;
      refs.copy.setAttribute("aria-label", copyLabel);
      renderPeers(la.getPeers());
    }
  }

  la.setNotifier(render);

  // --- actions -------------------------------------------------------------

  async function handleHost() {
    hosting = true;
    error = null;
    render();
    try {
      await la.startHostSession();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      hosting = false;
      render();
    }
  }

  async function handleJoin() {
    if (joinCode.length < 6) return;
    joining = true;
    error = null;
    render();
    try {
      await la.joinSession(joinCode);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      joining = false;
      render();
    }
  }

  async function handleLeave() {
    error = null;
    joinCode = "";
    await la.leaveSession();
    render();
  }

  function copyCode() {
    const code = la.getShareCode();
    if (!code) return;
    void navigator.clipboard?.writeText(code);
    copied = true;
    render();
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = false;
      render();
    }, 2000);
  }

  async function saveConfig() {
    try {
      await ctx.saveConfig(refs.cfgUrl.value.trim(), refs.cfgKey.value.trim());
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    render();
  }

  on(refs.host, "click", handleHost);
  on(refs.join, "click", handleJoin);
  on(refs.leave, "click", handleLeave);
  on(refs.copy, "click", copyCode);
  on(refs.cfgSave, "click", saveConfig);
  on(refs.joinInput, "input", (e) => {
    joinCode = normalizeCode(e.target.value);
    render();
  });
  on(refs.joinInput, "keydown", (e) => {
    if (e.key === "Enter") void handleJoin();
  });

  render();

  return function cleanup() {
    la.setNotifier(() => {});
    if (copiedTimer) clearTimeout(copiedTimer);
    for (const [target, event, fn] of listeners) {
      target.removeEventListener(event, fn);
    }
    container.replaceChildren();
    document.getElementById(STYLE_ID)?.remove();
  };
}
