declare module "@vynl/plugin-sdk" {
  export const PLUGIN_API_VERSION: number;
  export type {
    VynlPlugin,
    VynlPluginAPI,
    PluginManifest,
    PluginSettingsSection,
    PluginSettingField,
    PluginHomeSection,
    PluginHomeItem,
    PluginLyricsLookup,
    PluginLyricsResult,
    PluginLyricsProvider,
    PluginMetadataProvider,
    PluginResolverProvider,
    PluginProvider,
    PluginProviderKind,
    PluginHttpInit,
    PluginHttpResponse,
    PluginPermission,
    PluginCategory,
  } from "../../web/src/lib/plugins/types";
}
