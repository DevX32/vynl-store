# vynl-store

Plugin store for [Vynl](https://github.com/DevX32/Vynl) — the public home of
everything plugins: catalog, plugin sources, docs, and the CI that keeps it
honest. The app fetches this repository **anonymously** at runtime:

- `plugins.json` — catalog rendered in Settings → Plugins → Store
- `plugins/` — plugin sources and the `.zip` artifacts referenced by catalog
  `downloadUrl`s
- `docs/plugins.md` — plugin API, store, and publishing docs
- `scripts/validate-store.ts` — validator run by CI below

Do not rename, move, or delete existing paths: installed clients depend on
these exact raw URLs.

To publish: edit `plugins.json` (keep each entry's `version` in sync with its
`plugins/<dir>/package.json`), rebuild the plugin zip, and commit to `main`.
CI validates the catalog and the artifacts.

Every push runs `.github/workflows/validate.yml`.
