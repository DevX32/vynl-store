# Plugins

Vynl ships with a Nuclear-inspired plugin system: plain JavaScript or
TypeScript modules that load at app startup, contribute settings and Home
sections, and plug into lyrics, artist info, and collection resolution —
plus a built-in store for discovering, installing, and updating them.

- **Runtime** — plugins are bundled in-app with `esbuild-wasm` (ESM output,
  no network access, no `eval`) and evaluated from a Blob URL.
- **Lifecycle** — `onLoad` / `onEnable` / `onDisable` / `onUnload`.
- **Host API** — settings, providers, UI contributions, events, CORS-free
  HTTP, and external links, gated by manifest permissions.
- **Store** — a remote JSON catalog with a bundled fallback, search,
  one-click install, and automatic updates.

Plugins are installed into `plugins/{id}/{version}/` inside Vynl's app data
directory and tracked in a registry file. Everything is managed from the
**Plugins** modal — open it from Settings with the Equalizer-style **Open**
button (Installed / Store tabs).

## Quick start

Create a folder with a `package.json` and an entry file:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My first Vynl plugin",
  "author": "you",
  "main": "index.js",
  "vynl": {
    "displayName": "My Plugin",
    "categories": ["other"],
    "permissions": ["network"]
  }
}
```

```js
/** @type {import('@vynl/plugin-sdk').VynlPlugin} */
export default {
  onLoad(api) {
    api.Logger.info("hello from my-plugin");
  },
  onEnable(api) {
    api.UI.registerHomeSection({
      id: "my-section",
      title: "My Plugin",
      items: [{ id: "1", title: "Hi", subtitle: "from a plugin" }],
    });
  },
};
```

Open the plugins UI from Settings (**Plugins → Open**) and choose
**Installed → Add from folder** to pick the folder. Vynl
copies it into the app data directory and loads it immediately. From the
installed row you can toggle the **switch** (enable/disable), **Reload**
(re-read the folder — handy while developing), or remove the plugin.

You can also install a `.zip` with **Install .zip** (files at the archive
root, or in a single top-level folder — `package.json` must be findable).

## Manifest

| Field            | Where   | Meaning                                                        |
| ---------------- | ------- | -------------------------------------------------------------- |
| `name`           | root    | **Plugin id** — unique, stable, used for registry/config paths |
| `version`        | root    | Semver; compared against the store catalog for updates         |
| `main`           | root    | Entry file (see resolution below)                              |
| `description`    | root    | Shown in the store/installed list                              |
| `author`         | root    | Shown in the store/installed list                              |
| `vynl.displayName` | `vynl` | Name shown in the UI (falls back to `name`)                    |
| `vynl.categories`  | `vynl` | `metadata`, `lyrics`, `artwork`, `download`, `dashboard`, `playlists`, `scrobbling`, `other` |
| `vynl.permissions` | `vynl` | Requested permissions (see [Permissions](#permissions))        |

### Entry resolution

Candidates are probed in order until one reads successfully:

1. `main` (a leading `./` is stripped)
2. `index.ts`
3. `index.js`
4. `index.mjs`
5. `dist/index.js`
6. `dist/index.ts`

TypeScript is fully supported — `.ts`/`.tsx` files and relative imports are
compiled by esbuild-wasm. `package.json` must declare `name` and `version`.

## Lifecycle

Plugins load **sequentially at startup** (registry order, so provider
registration order is deterministic), enabled ones only:

| Action                    | Hooks run                                              |
| ------------------------- | ------------------------------------------------------ |
| App start (enabled)       | `onLoad` → `onEnable`                                  |
| Enable                    | `onLoad` → `onEnable` (fresh load)                     |
| Disable                   | `onDisable`, then everything is torn down              |
| Remove                    | `onUnload` → `onDisable`, then torn down               |
| Store update / reinstall  | `onUnload` → `onDisable`, then fresh `onLoad`/`onEnable` |
| Dev **Reload**            | same as update, plus the compiler cache is cleared     |

"Torn down" means: all event listeners are removed, settings/home
contributions are unregistered, and providers are unregistered.

Hooks may be async. A hook that throws is logged to the console and does not
crash the app; a failure while *loading* (bad manifest, compile error, no
default export) shows as an error on the plugin's row in the Plugins UI.

The entry module must have a **default export** — an object with the optional
hooks.

## API

Every hook receives the same `api` object:

```ts
api.pluginId;    // "my-plugin"
api.permissions; // granted permissions, e.g. ["network"]
api.apiVersion;  // PLUGIN_API_VERSION (currently 1)
```

### Logger

```js
api.Logger.debug/info/warn/error("message");
```

Prefixed with your plugin id in the console.

### Settings

Per-plugin key/value config, persisted on disk by the Rust backend.

```js
await api.Settings.set("greeting", "hi"); // persists + notifies subscribers
const v = await api.Settings.get("greeting"); // undefined until first set
const off = api.Settings.subscribe("greeting", (v) => { /* ... */ });
```

Values are also editable by the user on the **Settings page** (see below);
`subscribe` fires for both plugin-side and UI-side changes.

### UI

```js
const off1 = api.UI.registerSettingsSection({
  id: "hello",
  title: "Hello Vynl",
  fields: [
    { key: "greeting", title: "Greeting", description: "Shown on Home.",
      kind: "text", default: "Hello!" },          // text
    { key: "showOnHome", title: "Show on Home",
      kind: "boolean", default: true },           // switch
    { key: "rate", title: "Rate", kind: "number",
      min: 0, max: 100, step: 1, default: 50 },   // number input
    { key: "mode", title: "Mode", kind: "select",
      options: [{ value: "a", label: "Mode A" }], default: "a" }, // chips
  ],
});

const off2 = api.UI.registerHomeSection({
  id: "hello-greeting",
  title: "Hello Vynl",
  items: [
    { id: "greeting", title: "Hello!", subtitle: "clickable",
      url: "https://example.com" },   // opens the system browser
    { id: "play", title: "Play it", trackId: "lib-track-id" }, // plays a track
  ],
});
```

`api.Settings.register(section)` is an alias for
`api.UI.registerSettingsSection(section)`.

Field `default`s are used until the user (or your plugin) sets a value.
Sections are removed automatically when the plugin is disabled or removed;
the explicit `unregister*` methods are available if you want to swap
sections at runtime.

### Providers

Providers are the main way plugins change Vynl's behavior. Register them in
`onEnable`; they are unregistered automatically on disable/remove.

```js
api.Providers.register({
  id: "echo-lyrics",
  kind: "lyrics",
  name: "Echo lyrics",
  async fetch({ title, artist, album, duration }) {
    return { kind: "txt", text: "..." }; // or null to pass
  },
});
```

| Kind       | Method                       | Runs                                              |
| ---------- | ---------------------------- | ------------------------------------------------- |
| `lyrics`   | `fetch(lookup)`              | after local/embedded lyrics miss, before Vynl's built-in fetch |
| `metadata` | `artistInfo(artist)`         | before Vynl's built-in `fetch_artist_info`        |
| `resolver` | `canHandle(url)`, `resolve(url)` | before `vynl.resolve`; Vynl's resolver is the fallback if yours fails |

Providers are consulted in registration order (i.e. plugin load order). Return
`null` to let the next provider — or Vynl's built-in implementation — answer.

- Lyrics results: `{ kind: "lrc" | "txt", text }`. LRC results are embedded
  into the track's file like built-in lyrics.
- Artist info must match Vynl's `ArtistInfo` shape (name, image, ...).
- Resolver results must match Vynl's `Collection` shape (title, tracks, ...).

### Http

```js
const res = await api.Http.fetch("https://api.example.com/lyrics", {
  method: "GET",
  headers: { Accept: "application/json" },
});
res; // { status, ok, headers, text }
```

Requests are proxied through the Rust host — no CORS, no mixed-content
issues. Requires the `network` permission. The body is exposed as `text`.

### Shell

```js
await api.Shell.openExternal("https://example.com");
```

Requires the `shell` permission; only `http(s):` and `mailto:` URLs are
allowed.

### Events

```js
const off = api.Events.on("track-changed", (track) => { /* ... */ });
```

| Event              | Payload                                              |
| ------------------ | ---------------------------------------------------- |
| `track-changed`    | `{ id, title, artist, album, duration, path }` or `null` |
| `playback-changed` | `{ playing, id }`                                    |
| `download-finished`| (none)                                               |
| `library-updated`  | `{ count }`                                          |

All subscriptions (events + settings) are removed automatically when the
plugin goes away, so unsubscription is optional.

## Permissions

| Permission | Grants                        |
| ---------- | ----------------------------- |
| `network`  | `api.Http.fetch`              |
| `shell`    | `api.Shell.openExternal`      |

Declare them under `vynl.permissions`. Unknown permissions are ignored, and
everything else the plugin touches is host-mediated — the permission layer is
mainly declarative: `Http`/`Shell` hard-require theirs, the rest of the API
has no ambient authority to grant.

## Store

The **Store** tab lists plugins from a JSON catalog. The default source is
this repo's [`plugins.json`](../plugins.json):

```
https://raw.githubusercontent.com/DevX32/vynl-store/main/plugins.json
```

The app ([`DevX32/Vynl`](https://github.com/DevX32/Vynl)) fetches it
anonymously, so that repo can stay private.

If the remote fetch fails or returns nothing, Vynl falls back to the bundled
catalog (`web/src/lib/plugins/fallback-catalog.json` in the app repo) and
shows a banner. To point at your own catalog, edit `DEFAULT_STORE_SOURCES` in
`web/src/state/plugins.svelte.ts`.

### Publishing

This repo **is** the store — `plugins.json` here is the catalog the app
fetches, and `examples/` holds the plugin sources and zips. To publish:

1. Edit `plugins.json` (and `examples/` when the plugin itself changes —
   keep the catalog `version` in sync with the example's `package.json`).
2. Push to `main` — CI validates the catalog, the artifacts, and the
   version parity between them.
3. Copy the new catalog into the app's bundled fallback
   (`web/src/lib/plugins/fallback-catalog.json`, kept byte-identical) for
   the next Vynl release.

Clients see the new catalog after GitHub's raw-CDN TTL (about 5 minutes);
in-app update checks force a refresh.

### Catalog format

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "hello-vynl",
      "name": "Hello Vynl",
      "description": "Example plugin ...",
      "author": "Vynl",
      "repo": "DevX32/vynl-store",
      "categories": ["other"],
      "tags": ["example"],
      "version": "1.0.0",
      "downloadUrl": "https://.../hello-vynl.zip",
      "homepage": "https://github.com/DevX32/vynl-store",
      "addedAt": "2026-09-24T00:00:00Z"
    }
  ]
}
```

- `id` must equal the plugin's `package.json` `name`.
- `downloadUrl` must serve a zip containing the plugin (root `package.json`,
  or in a single top-level folder).
- `repo`/`homepage` are shown as provenance; installs are logged against it.

### Updates

- Only plugins with `installationMethod: "store"` are checked.
- An update exists when the catalog `version` is newer than the installed one
  (lenient semver — unparseable versions never update, preventing loops).
- The **Auto-update Plugins** switch (at the top of the Plugins UI, on by
  default) installs available updates automatically at startup.
- **Check for updates** on the Store tab only *reports* ("N update(s)
  available" / "All plugins are up to date").

### Installation methods

| Method     | How                                      | Notes                       |
| ---------- | ---------------------------------------- | --------------------------- |
| `store`    | Store tab → **Install**                  | Eligible for auto-updates   |
| `dev`      | Installed tab → **Add from folder**      | **Reload** re-reads the folder |
| `sideload` | Installed tab → **Install .zip**         | No update checks            |

## How it works (implementation notes)

- **Compile** — `web/src/lib/plugins/compiler.ts` builds each entry with
  esbuild-wasm. Imports resolve inside the plugin's own directory through a
  virtual `vynl-fs` namespace; `..` escapes are rejected and file reads go
  through the Rust `plugins_read_file` command (confined to the plugin dir).
  Compiled output is cached by content hash and invalidated on **Reload**.
- **SDK** — `@vynl/plugin-sdk` is compile-time only: the compiler rewrites it
  to `globalThis.__VYNL_PLUGIN_SDK__`, so plugins should use `import type`
  for SDK symbols. The default export shape is plain data + functions.
- **Evaluate** — the ESM bundle becomes a Blob URL that is dynamically
  imported and revoked. The CSP allows `blob:` in `script-src` but does not
  enable `unsafe-eval`.
- **Persist** — the Rust backend owns the registry file, per-plugin configs,
  zip extraction (zip-slip safe, size-capped), folder/zip installs, the
  store-catalog fetch/cache (`store-cache.json`), and the HTTP proxy.
- **State** — `web/src/state/plugins.svelte.ts` owns the lifecycle: every
  transition funnels through load/unload so registrations never leak.

## Example

The example plugin lives in the store repo:
[`examples/hello-vynl`](https://github.com/DevX32/vynl-store/tree/main/examples/hello-vynl)
exercises the full surface — a settings section, a home section, a lyrics
provider, and event logging:

```
examples/hello-vynl/
├── package.json   # manifest with the vynl field
└── index.js       # default export with lifecycle hooks
```

A prebuilt copy lives at
[`examples/hello-vynl.zip`](https://raw.githubusercontent.com/DevX32/vynl-store/main/examples/hello-vynl.zip)
and is referenced by the root [`plugins.json`](../plugins.json) catalog.
