import * as session from "./session.js";
import { mountPage } from "./ui.js";
import { hasDefaultProject } from "./config.js";

let api = null;
let config = { url: "", key: "", nickname: "" };
let configUnsubs = [];

function applyConfig() {
  session.configureProject(config.url, config.key);
  session.setNickname(config.nickname);
}

export default {
  onLoad(a) {
    api = a;
  },

  async onEnable(a) {
    api = a;
    session.setApi(a);

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

    const fields = [
      {
        key: "nickname",
        title: "Nickname",
        description: "Name other listeners see in the session.",
        kind: "text",
        default: session.getNickname(),
      },
    ];

    if (!hasDefaultProject()) {
      fields.unshift(
        {
          key: "supabaseUrl",
          title: "Relay project URL",
          description: "Project URL used for signaling and audio staging.",
          kind: "text",
          default: "",
        },
        {
          key: "supabaseKey",
          title: "Relay anon key",
          description: "Anon (public) key for the same project.",
          kind: "text",
          default: "",
        },
      );
    }

    a.UI.registerSettingsSection({
      id: "main",
      title: "Listen Along",
      fields,
    });

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
      a.Settings.subscribe("nickname", (v) => {
        config.nickname = String(v ?? "");
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
