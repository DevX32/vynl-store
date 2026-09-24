/**
 * Listen Along — synchronized listening sessions for Vynl.
 *
 * Host a session, share a code, and friends' Vynl follows your playback
 * (audio included) in real time over Supabase Realtime + WebRTC, with a
 * REST poll fallback.
 *
 * @type {import('@vynl/plugin-sdk').VynlPlugin}
 */
import * as la from "./state.js";
import * as net from "./net.js";
import { mountPage } from "./ui.js";

let api = null;
let config = { url: "", key: "", nickname: "" };
let configUnsubs = [];

function applyConfig() {
  net.configure(config.url, config.key);
  la.setNickname(config.nickname || null);
}

export default {
  onLoad(a) {
    api = a;
  },

  async onEnable(a) {
    api = a;
    la.setApi(a);

    const [url, key, nickname] = await Promise.all([
      a.Settings.get("supabaseUrl"),
      a.Settings.get("supabaseKey"),
      a.Settings.get("nickname"),
    ]);
    config = {
      url: String(url ?? ""),
      key: String(key ?? ""),
      nickname: String(nickname ?? ""),
    };
    applyConfig();

    // --- Settings ---------------------------------------------------------
    a.UI.registerSettingsSection({
      id: "main",
      title: "Listen Along",
      fields: [
        {
          key: "supabaseUrl",
          title: "Supabase URL",
          description: "Project URL used for session sync (https://<project>.supabase.co).",
          kind: "text",
          default: "",
        },
        {
          key: "supabaseKey",
          title: "Supabase anon key",
          description: "Anon (public) key for the same project.",
          kind: "text",
          default: "",
        },
        {
          key: "nickname",
          title: "Nickname",
          description: "Name other listeners see in the session.",
          kind: "text",
          default: la.getNickname(),
        },
      ],
    });

    // --- Page -------------------------------------------------------------
    a.UI.registerPage({ title: "Listen Along" }, (container) =>
      mountPage(container, {
        api: a,
        getConfig: () => ({ url: config.url, key: config.key }),
        saveConfig: async (url, key) => {
          await a.Settings.set("supabaseUrl", url);
          await a.Settings.set("supabaseKey", key);
          config.url = url;
          config.key = key;
          applyConfig();
        },
      }),
    );

    // --- Lyrics provider (host's lyrics while following) -------------------
    a.Providers.register({
      id: "synced-lyrics",
      kind: "lyrics",
      name: "Synced lyrics (Listen Along)",
      fetch: async (lookup) => la.getSharedLyrics(lookup),
    });

    // --- Events (sync immediately on playback changes) ----------------------
    a.Events.on("track-changed", () => la.syncTrack());
    a.Events.on("playback-changed", () => la.syncTrack());

    // --- Keep config in sync with the Settings page ------------------------
    configUnsubs = [
      a.Settings.subscribe("supabaseUrl", (v) => {
        config.url = String(v ?? "");
        applyConfig();
      }),
      a.Settings.subscribe("supabaseKey", (v) => {
        config.key = String(v ?? "");
        applyConfig();
      }),
      a.Settings.subscribe("nickname", (v) => {
        config.nickname = String(v ?? "");
        applyConfig();
      }),
    ];

    a.Logger.info(`enabled (supabase configured: ${net.isConfigured()})`);
  },

  async onDisable() {
    for (const fn of configUnsubs) {
      try {
        fn();
      } catch {
        /* already gone */
      }
    }
    configUnsubs = [];
    await la.leaveSession().catch(() => {});
  },
};
