/**
 * Hello Vynl — an example plugin exercising the full plugin API surface:
 * lifecycle hooks, settings, home sections, providers, and events.
 *
 * @type {import('@vynl/plugin-sdk').VynlPlugin}
 */
export default {
  /** Runs once when the plugin is loaded (at app startup if enabled). */
  onLoad(api) {
    api.Logger.info(`loaded (api v${api.apiVersion}, perms: ${api.permissions.join(", ") || "none"})`);
  },

  /** Runs when the plugin is enabled — register providers & UI here. */
  async onEnable(api) {
    // --- Settings -----------------------------------------------------------
    api.UI.registerSettingsSection({
      id: "hello",
      title: "Hello Vynl",
      fields: [
        {
          key: "greeting",
          title: "Greeting",
          description: "Shown on the Home page.",
          kind: "text",
          default: "Hello from a Vynl plugin!",
        },
        {
          key: "showOnHome",
          title: "Show greeting on Home",
          kind: "boolean",
          default: true,
        },
      ],
    });

    // --- Home section --------------------------------------------------------
    const greeting = (await api.Settings.get("greeting")) ?? "Hello from a Vynl plugin!";
    api.UI.registerHomeSection({
      id: "hello-greeting",
      title: "Hello Vynl",
      items: [
        {
          id: "greeting",
          title: String(greeting),
          subtitle: "This section is provided by the hello-vynl plugin",
        },
      ],
    });

    // --- Lyrics provider -----------------------------------------------------
    api.Providers.register({
      id: "echo-lyrics",
      kind: "lyrics",
      name: "Echo lyrics",
      async fetch(lookup) {
        // A real plugin would call an API here via api.Http.fetch.
        return {
          kind: "txt",
          text: `[${lookup.artist} — ${lookup.title}]\nLyrics provided by the hello-vynl example plugin.`,
        };
      },
    });

    // --- Events --------------------------------------------------------------
    api.Events.on("track-changed", (track) => {
      api.Logger.debug(`now playing: ${JSON.stringify(track)}`);
    });

    api.Logger.info("enabled");
  },

  /** Runs when the plugin is disabled — clean up registrations here. */
  onDisable(api) {
    api.Logger.info("disabled");
  },

  /** Runs right before the plugin is unloaded/removed. */
  onUnload(api) {
    api.Logger.info("unloaded");
  },
};
