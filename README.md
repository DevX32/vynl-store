# vynl-store

Public plugin-store CDN for [Vynl](https://github.com/DevX32/Vynl). The app
fetches this repository **anonymously** at runtime:

- `plugins.json` — catalog rendered in Settings → Plugins → Store
- `examples/*.zip` — plugin artifacts referenced by catalog `downloadUrl`s
- `scripts/validate-store.ts` — validator copy run by CI below

Do not rename, move, or delete existing paths: installed clients depend on
these exact raw URLs.

This repo is seeded and updated only from the main repo:

```bash
bun scripts/publish-store.ts
```

Every push runs `.github/workflows/validate.yml` to keep the catalog honest.
