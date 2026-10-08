import * as session from "./session.js";
import { mountPage } from "./ui.js";

let api = null;
let config = { url: "", key: "" };
let configUnsubs = [];

/** Vynl owns the user's name; fall back if this host predates api.App. */
function resolveDisplayName(a) {
  try {
    const name = a.App?.getDisplayName?.();
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {}
  return session.getNickname();
}

function applyConfig() {
  session.configureProject(config.url, config.key);
}

export default {
  onLoad(a) {
    api = a;
  },

  async onEnable(a) {
    api = a;
    session.setApi(a);

    const [url, key] = await Promise.all([
      a.Settings.get("supabaseUrl"),
      a.Settings.get("supabaseKey"),
    ]);
    config = {
      url: String(url ?? ""),
      key: String(key ?? ""),
    };
    applyConfig();
    session.setDisplayName(resolveDisplayName(a));

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

    a.Providers.register({
      id: "synced-lyrics",
      kind: "lyrics",
      name: "Synced lyrics (Listen Along)",
      fetch: async (lookup) => session.getSharedLyrics(lookup),
    });

    a.Events.on("track-changed", () => session.syncOnTrackChange());
    a.Events.on("playback-changed", () => session.syncOnTrackChange());

    configUnsubs = [
      a.Settings.subscribe("supabaseUrl", (v) => {
        config.url = String(v ?? "");
        applyConfig();
      }),
      a.Settings.subscribe("supabaseKey", (v) => {
        config.key = String(v ?? "");
        applyConfig();
      }),
    ];

    a.Logger.info(
      session.isConfigured()
        ? "enabled"
        : "enabled (no relay configured — set one in the page or Settings)",
    );
  },

  async onDisable() {
    for (const fn of configUnsubs) {
      try {
        fn();
      } catch {}
    }
    configUnsubs = [];
    await session.leave().catch(() => {});
  },
};
