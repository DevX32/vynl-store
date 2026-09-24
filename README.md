# vynl-store

Public plugin-store CDN for [Vynl](https://github.com/DevX32/Vynl). The app
fetches this repository **anonymously** at runtime:

- `plugins.json` — catalog rendered in Settings → Plugins → Store (published
  from the main repo — edit it there, not here)
- `examples/` — example plugins: sources and the `.zip` artifacts referenced
  by catalog `downloadUrl`s (maintained directly in this repo)
- `scripts/validate-store.ts` — validator copy run by CI below

Do not rename, move, or delete existing paths: installed clients depend on
these exact raw URLs.

Catalog + CI files are seeded and updated from the main repo:

```bash
bun scripts/publish-store.ts
```

Run it in [DevX32/Vynl](https://github.com/DevX32/Vynl) (needs `gh` with
`repo` + `workflow` scopes). Example sources/zips are committed straight
here; keep each example's `package.json` version in sync with its catalog
entry — CI below enforces it, including that referenced zips exist.

Every push runs `.github/workflows/validate.yml` to keep the catalog honest.
