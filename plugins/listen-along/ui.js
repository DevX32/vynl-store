import * as session from "./session.js";
import { hasDefaultProject } from "./config.js";

const T = {
  title: "Listen Along",
  subtitle: "Play something together, in sync",

  hostTitle: "Start a session",
  hostDesc: "You'll get a code to share with friends.",
  hostCta: "Start hosting",
  starting: "Starting…",

  joinTitle: "Join a session",
  joinDesc: "Enter the code someone shared with you.",
  joinCta: "Join",
  codePlaceholder: "ABC123",

  liveHost: "You're hosting",
  liveJoiner: "You're listening",
  waiting: "Waiting for someone to join",
  inSync: "In sync",
  reconnecting: "Reconnecting…",
  listenersOne: "1 listener",
  listenersMany: "{n} listeners",

  shareCode: "Share this code",
  copyCode: "Copy code",
  copied: "Copied",

  nowPlaying: "Now playing",
  nothingPlaying: "Nothing playing",

  relayTitle: "Using your own relay",
  relayDesc:
    "This build uses Vynl's shared relay. Point it at your own Supabase project if you'd rather not.",
  relayUrl: "Project URL",
  relayKey: "Anon key",
  relaySave: "Save",
  relayRevert: "Use the shared relay",
  relayNone:
    "This build has no shared relay configured. Enter your own Supabase project URL and anon key to use Listen Along.",

  setup: "Setup",
  hideSetup: "Hide relay settings",
  leave: "Leave session",
  copyFailed: "Couldn't copy — select the code instead",
};

const ICON = {
  copy:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  leave:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>',
  alert:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.5"/></svg>',
};

const STYLE_ID = "listen-along-styles";

const CSS = `
.la {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding-top: 28px;
  scrollbar-width: none;
}
.la::-webkit-scrollbar { display: none; }

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
.la-btn--wide { width: 100%; height: 42px; font-size: 13px; }
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
.la-btn--ghost {
  background: transparent;
  color: var(--dim);
  border-color: var(--line-strong);
  font-size: 11px;
  height: 32px;
  padding: 0 14px;
}
.la-btn--ghost:hover { color: var(--text); border-color: var(--faint); }
.la-btn--danger {
  background: rgba(255, 107, 97, 0.08);
  color: var(--red);
  font-weight: 500;
  border-color: rgba(255, 107, 97, 0.35);
}
.la-btn--danger:not(:disabled):hover { background: rgba(255, 107, 97, 0.15); border-color: var(--red); }

.la-spin {
  width: 13px; height: 13px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: la-spin 1s linear infinite;
  display: inline-block;
}
@keyframes la-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.la-panel { padding: 24px 0; border-bottom: 1px solid var(--line); }
.la-panel:last-of-type { border-bottom: 0; }
.la-panel-title { font-size: 17px; font-weight: 600; line-height: 1.2; }
.la-panel-desc { font-size: 12.5px; color: var(--faint); line-height: 1.5; max-width: 46ch; margin: 5px 0 0; }
.la-panel-cta { margin-top: 16px; }

.la-join-row { display: flex; gap: 8px; margin-top: 16px; }
.la-input {
  height: 36px;
  padding: 0 12px;
  background: var(--bg-raise);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12.5px;
  min-width: 0;
  transition: border-color 0.15s;
}
.la-input:focus { outline: none; border-color: var(--faint); }
.la-input::placeholder { color: var(--faint); }
.la-code-input {
  flex: 1;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.la-code-input::placeholder {
  letter-spacing: 0.03em;
  text-transform: none;
  font-weight: 400;
  font-size: 12px;
}

.la-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 12px 14px;
  margin-top: 18px;
  border: 1px solid rgba(255, 107, 97, 0.3);
  background: rgba(255, 107, 97, 0.06);
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
  color: var(--red);
}
.la-note svg { flex-shrink: 0; margin-top: 2px; }

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
.la-dot.live { background: var(--green); box-shadow: 0 0 6px color-mix(in srgb, var(--green) 55%, transparent); }
.la-status-role { color: var(--text); }
.la-status-count { margin-left: auto; color: var(--faint); }

.la-code-block { padding: 26px 0; border-bottom: 1px solid var(--line); }
.la-code-label {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--faint);
  margin-bottom: 12px;
}
.la-code-row { display: flex; align-items: center; gap: 16px; }
.la-code { font-size: 52px; font-weight: 600; letter-spacing: 0.16em; line-height: 1; user-select: all; }
.la-copy {
  display: flex; align-items: center; justify-content: center;
  width: 34px; height: 34px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--dim);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, border-color 0.15s;
}
.la-copy:hover { color: var(--text); border-color: var(--faint); }

.la-track { display: flex; align-items: center; gap: 14px; padding: 18px 0; }
.la-track-art {
  width: 46px; height: 46px; border-radius: var(--radius-sm);
  background: var(--bg-raise);
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; color: var(--faint); flex-shrink: 0;
  overflow: hidden;
}
.la-track-text { min-width: 0; }
.la-track-name { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.la-track-meta { font-size: 11.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 3px; }

.la-foot { padding-top: 22px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.la-relay-toggle {
  background: none; border: 0; padding: 0;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px; color: var(--faint); cursor: pointer;
  text-decoration: underline; text-underline-offset: 3px;
}
.la-relay-toggle:hover { color: var(--dim); }

.la-relay { padding: 20px 0; border-top: 1px solid var(--line); }
.la-relay-row { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.la-relay-row .la-input { flex: 1; min-width: 200px; }
.la-relay-actions { display: flex; gap: 8px; margin-top: 10px; }
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

export function mountPage(container, ctx) {
  ensureStyles();

  let joinCode = "";
  let busy = false;
  let error = null;
  let copied = false;
  let showRelay = false;
  let copiedTimer = null;

  const listeners = [];
  const on = (target, event, fn) => {
    target.addEventListener(event, fn);
    listeners.push([target, event, fn]);
  };

  container.replaceChildren(
    el(`
      <div class="la">
        <header class="la-hdr">
          <div>
            <h1 class="la-title display"></h1>
            <p class="la-subtitle mono"></p>
          </div>
          <button class="la-btn la-btn--danger la-btn--sm la-leave" hidden></button>
        </header>

        <div class="la-idle">
          <section class="la-panel">
            <div class="la-panel-title display"></div>
            <p class="la-panel-desc mono"></p>
            <div class="la-panel-cta">
              <button class="la-btn la-btn--primary la-btn--wide la-host"></button>
            </div>
          </section>

          <section class="la-panel">
            <div class="la-panel-title display"></div>
            <p class="la-panel-desc mono"></p>
            <div class="la-join-row">
              <input class="la-input la-code-input mono la-join-input"
                     maxlength="6" spellcheck="false" autocomplete="off" />
              <button class="la-btn la-btn--primary la-btn--sm la-join"></button>
            </div>
          </section>

          <div class="la-note" role="alert" hidden>
            <span class="la-note-icon"></span>
            <span class="la-note-text"></span>
          </div>
        </div>

        <div class="la-active" hidden>
          <div class="la-status mono">
            <span class="la-dot"></span>
            <span class="la-status-role"></span>
            <span class="la-status-text"></span>
            <span class="la-status-count"></span>
          </div>

          <div class="la-code-block">
            <div class="la-code-label mono"></div>
            <div class="la-code-row">
              <span class="la-code display"></span>
              <button class="la-copy"></button>
            </div>
          </div>

          <div class="la-track">
            <div class="la-track-art"></div>
            <div class="la-track-text">
              <div class="la-track-label mono"></div>
              <div class="la-track-name display"></div>
              <div class="la-track-meta mono"></div>
            </div>
          </div>
        </div>

        <div class="la-foot">
          <button class="la-relay-toggle"></button>
        </div>

        <div class="la-relay" hidden>
          <div class="la-panel-title display"></div>
          <p class="la-panel-desc mono"></p>
          <div class="la-relay-row">
            <input class="la-input mono la-cfg-url" spellcheck="false" autocomplete="off" />
            <input class="la-input mono la-cfg-key" spellcheck="false" autocomplete="off" />
          </div>
          <div class="la-relay-actions">
            <button class="la-btn la-btn--primary la-btn--sm la-cfg-save"></button>
            <button class="la-btn la-btn--ghost la-cfg-revert"></button>
          </div>
        </div>
      </div>
    `),
  );

  const q = (sel) => container.querySelector(sel);

  q(".la-title").textContent = T.title;
  q(".la-subtitle").textContent = T.subtitle;
  q(".la-leave").append(el(`<span>${ICON.leave}</span>`), document.createTextNode(T.leave));

  const idlePanels = container.querySelectorAll(".la-idle .la-panel");
  idlePanels[0].querySelector(".la-panel-title").textContent = T.hostTitle;
  idlePanels[0].querySelector(".la-panel-desc").textContent = T.hostDesc;
  idlePanels[1].querySelector(".la-panel-title").textContent = T.joinTitle;
  idlePanels[1].querySelector(".la-panel-desc").textContent = T.joinDesc;

  q(".la-join-input").placeholder = T.codePlaceholder;
  q(".la-join").textContent = T.joinCta;
  q(".la-code-label").textContent = T.shareCode;
  q(".la-track-label").textContent = T.nowPlaying;
  q(".la-relay .la-panel-title").textContent = T.relayTitle;
  q(".la-relay .la-panel-desc").textContent = T.relayDesc;
  q(".la-cfg-url").placeholder = T.relayUrl;
  q(".la-cfg-key").placeholder = T.relayKey;
  q(".la-cfg-save").textContent = T.relaySave;
  q(".la-cfg-revert").textContent = T.relayRevert;
  q(".la-note-icon").innerHTML = ICON.alert;

  const refs = {
    idle: q(".la-idle"),
    active: q(".la-active"),
    leave: q(".la-leave"),
    host: q(".la-host"),
    join: q(".la-join"),
    joinInput: q(".la-join-input"),
    note: q(".la-note"),
    noteText: q(".la-note-text"),
    dot: q(".la-dot"),
    role: q(".la-status-role"),
    statusText: q(".la-status-text"),
    count: q(".la-status-count"),
    codeBlock: q(".la-code-block"),
    code: q(".la-code"),
    copy: q(".la-copy"),
    art: q(".la-track-art"),
    trackName: q(".la-track-name"),
    trackMeta: q(".la-track-meta"),
    relayToggle: q(".la-relay-toggle"),
    relay: q(".la-relay"),
    cfgUrl: q(".la-cfg-url"),
    cfgKey: q(".la-cfg-key"),
    cfgSave: q(".la-cfg-save"),
    cfgRevert: q(".la-cfg-revert"),
  };

  const initial = ctx.getConfig();
  refs.cfgUrl.value = initial.url ?? "";
  refs.cfgKey.value = initial.key ?? "";

  function setBusyLabel(button, isBusy, label) {
    const spin = button.querySelector(".la-spin");
    if (isBusy && !spin) button.prepend(el('<span class="la-spin"></span>'));
    if (!isBusy && spin) spin.remove();
    const span = button.querySelector(".la-btn-label");
    if (span) {
      span.textContent = label;
    } else {
      const next = document.createElement("span");
      next.className = "la-btn-label";
      next.textContent = label;
      button.appendChild(next);
    }
  }

  function listenerCount(n) {
    return n === 1 ? T.listenersOne : T.listenersMany.replace("{n}", String(n));
  }

  function renderTrack(info) {
    if (!info) {
      refs.trackName.textContent = T.nothingPlaying;
      refs.trackMeta.textContent = "";
      refs.art.replaceChildren(document.createTextNode("—"));
      return;
    }
    refs.trackName.textContent = info.title ?? "";
    refs.trackMeta.textContent = [info.artist, info.album].filter(Boolean).join(" · ");
    refs.art.replaceChildren(
      document.createTextNode((info.title ?? "?").slice(0, 1).toUpperCase()),
    );
  }

  function render() {
    const currentMode = session.getMode();
    const active = currentMode !== null;
    const configured = session.isConfigured();

    refs.idle.hidden = active;
    refs.active.hidden = !active;
    refs.leave.hidden = !active;

    refs.host.disabled = busy || !configured;
    setBusyLabel(refs.host, busy, busy ? T.starting : T.hostCta);

    if (refs.joinInput.value !== joinCode) refs.joinInput.value = joinCode;
    refs.join.disabled = busy || joinCode.length !== 6 || !configured;
    setBusyLabel(refs.join, busy, T.joinCta);

    refs.note.hidden = configured;
    refs.noteText.textContent = hasDefaultProject() ? T.relayNone : `${T.relayNone} ${T.relayDesc}`;

    if (active) {
      const { status, detail } = session.getStatus();
      const hosting = currentMode === "host";
      const live = status === "live";

      refs.dot.classList.toggle("live", live);
      refs.role.textContent = hosting ? T.liveHost : T.liveJoiner;

      let statusText = detail;
      if (status === "live") {
        statusText = hosting
          ? session.getPeerCount() > 0
            ? T.inSync
            : T.waiting
          : T.inSync;
      }
      refs.statusText.textContent = statusText;
      refs.count.textContent = hosting ? listenerCount(session.getPeerCount()) : "";

      refs.codeBlock.hidden = !hosting;
      refs.code.textContent = session.getCode();
      refs.copy.replaceChildren(el(`<span>${copied ? ICON.check : ICON.copy}</span>`));
      const copyLabel = copied ? T.copied : T.copyCode;
      refs.copy.title = copyLabel;
      refs.copy.setAttribute("aria-label", copyLabel);

      renderTrack(session.getTrackInfo());
    }

    refs.relay.hidden = !showRelay;
    refs.relayToggle.textContent = showRelay ? T.hideSetup : T.setup;
  }

  session.setNotifier(render);

  async function run(action) {
    busy = true;
    error = null;
    render();
    try {
      await action();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      render();
    }
  }

  async function handleHost() {
    await run(() => session.host());
  }

  async function handleJoin() {
    if (joinCode.length !== 6) return;
    await run(() => session.join(joinCode));
  }

  async function handleLeave() {
    joinCode = "";
    error = null;
    await session.leave();
    render();
  }

  async function copyCode() {
    const value = session.getCode();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch {
      error = T.copyFailed;
    }
    render();
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = false;
      render();
    }, 2000);
  }

  async function saveConfig() {
    await run(async () => {
      await ctx.saveConfig(refs.cfgUrl.value.trim(), refs.cfgKey.value.trim());
    });
  }

  async function revertConfig() {
    await run(async () => {
      await ctx.saveConfig("", "");
      refs.cfgUrl.value = "";
      refs.cfgKey.value = "";
    });
  }

  on(refs.host, "click", handleHost);
  on(refs.join, "click", handleJoin);
  on(refs.leave, "click", handleLeave);
  on(refs.copy, "click", copyCode);
  on(refs.cfgSave, "click", saveConfig);
  on(refs.cfgRevert, "click", revertConfig);
  on(refs.relayToggle, "click", () => {
    showRelay = !showRelay;
    render();
  });
  on(refs.joinInput, "input", (e) => {
    joinCode = session.normalizeCode(e.target.value);
    render();
  });
  on(refs.joinInput, "keydown", (e) => {
    if (e.key === "Enter" && joinCode.length === 6) void handleJoin();
  });

  render();

  return function cleanup() {
    session.setNotifier(() => {});
    if (copiedTimer) clearTimeout(copiedTimer);
    for (const [target, event, fn] of listeners) {
      target.removeEventListener(event, fn);
    }
    container.replaceChildren();
    document.getElementById(STYLE_ID)?.remove();
  };
}
