/**
 * Validates the Vynl plugin store catalogs.
 *
 *   bun scripts/validate-store.ts [catalog.json ...]
 *
 * Checks each catalog (defaults: plugins.json and the bundled fallback):
 *   - JSON parses and matches the PluginCatalogFile shape (version + plugins)
 *   - unique, kebab-case ids; non-empty name/description/author
 *   - categories are known (mirrors PLUGIN_CATEGORIES in web/src/lib/plugins/types.ts)
 *   - semver versions, https URLs, ISO-8601 addedAt dates, no unknown fields
 *   - downloadUrls hosted in this repo resolve to files that actually exist
 *   - example zips: catalog id/version match examples/<dir>/package.json
 *
 * Exits 1 with a list of problems, 0 when everything checks out.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** Catalogs to validate: CLI args win, else both catalogs of the main repo. */
const CATALOGS: readonly string[] =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ["plugins.json", "web/src/lib/plugins/fallback-catalog.json"];

/** Public store repo slug, lowercased (raw URLs compare case-insensitively). */
const REPO_SLUG = "devx32/vynl-store";

/** Private app repo — catalog downloadUrls must never target it (404 for users). */
const MAIN_REPO_SLUG = "devx32/vynl";

/** Mirrors PluginCategory in web/src/lib/plugins/types.ts (keep in sync). */
const CATEGORIES = new Set([
  "metadata",
  "lyrics",
  "artwork",
  "download",
  "dashboard",
  "playlists",
  "scrobbling",
  "other",
]);

/** Exactly the fields of StorePlugin in web/src/lib/plugins/types.ts. */
const ENTRY_KEYS = new Set([
  "id",
  "name",
  "description",
  "author",
  "repo",
  "categories",
  "tags",
  "version",
  "downloadUrl",
  "homepage",
  "addedAt",
]);

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RAW_URL_RE =
  /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const errors: string[] = [];

function fail(message: string): void {
  errors.push(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function requireString(
  entry: Record<string, unknown>,
  key: string,
  at: string,
): string | null {
  const value = entry[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${at}: "${key}" must be a non-empty string`);
    return null;
  }
  return value;
}

function optionalString(
  entry: Record<string, unknown>,
  key: string,
  at: string,
): string | null {
  const value = entry[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    fail(`${at}: "${key}" must be a string or null`);
    return null;
  }
  return value;
}

/**
 * If a downloadUrl targets raw.githubusercontent.com on the store repo,
 * the referenced file must exist in the working tree. Example artifacts
 * additionally get cross-checked against their source package.json.
 */
function checkLocalArtifact(
  url: string,
  id: string | null,
  version: string | null,
  at: string,
): void {
  const m = RAW_URL_RE.exec(url);
  if (m === null) return; // not a raw GitHub URL — nothing to verify locally
  const owner = m[1];
  const repoName = m[2];
  const relPath = decodeURIComponent(m[4]);

  const slug = `${owner}/${repoName}`.toLowerCase();
  if (slug === MAIN_REPO_SLUG) {
    fail(
      `${at}: downloadUrl points at the private main repo (${owner}/${repoName}) — publish to the store repo instead`,
    );
    return;
  }
  if (slug !== REPO_SLUG) return; // external repo — nothing to verify locally

  if (relPath.split("/").includes("..")) {
    fail(`${at}: downloadUrl path "${relPath}" must not contain ".."`);
    return;
  }
  if (!existsSync(join(ROOT, relPath))) {
    fail(
      `${at}: downloadUrl points at "${relPath}" but that file does not exist in the repo`,
    );
    return;
  }

  const example = /^examples\/([^/]+)\.zip$/.exec(relPath);
  if (example === null || id === null) return;
  const dir = example[1];
  const manifestPath = `examples/${dir}/package.json`;
  const abs = join(ROOT, manifestPath);
  if (!existsSync(abs)) return; // zip without checked-in source — zip existence is enough

  try {
    const manifest = JSON.parse(readFileSync(abs, "utf8")) as Record<
      string,
      unknown
    >;
    if (manifest.name !== id) {
      fail(
        `${at}: id "${id}" does not match ${manifestPath} name "${String(manifest.name)}"`,
      );
    }
    if (version !== null && manifest.version !== version) {
      fail(
        `${at}: version "${version}" does not match ${manifestPath} version "${String(manifest.version)}" — bump both together`,
      );
    }
  } catch (e) {
    fail(`${manifestPath}: invalid JSON — ${errorMessage(e)}`);
  }
}

function validateEntry(entry: unknown, at: string, seen: Set<string>): void {
  if (!isRecord(entry)) {
    fail(`${at}: entry must be an object`);
    return;
  }

  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) {
      fail(`${at}: unknown field "${key}"`);
    }
  }

  const id = requireString(entry, "id", at);
  if (id !== null) {
    if (!ID_RE.test(id)) {
      fail(`${at}: id "${id}" must be lowercase kebab-case`);
    }
    if (seen.has(id)) {
      fail(`${at}: duplicate id "${id}"`);
    }
    seen.add(id);
  }

  requireString(entry, "name", at);
  requireString(entry, "description", at);
  requireString(entry, "author", at);

  const repo = optionalString(entry, "repo", at);
  if (repo !== null && !REPO_SLUG_RE.test(repo)) {
    fail(`${at}: repo "${repo}" must look like "owner/name"`);
  }

  const categories = entry.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    fail(`${at}: "categories" must be a non-empty array`);
  } else {
    for (const category of categories) {
      if (typeof category !== "string" || !CATEGORIES.has(category)) {
        fail(`${at}: unknown category ${JSON.stringify(category)}`);
      }
    }
  }

  const tags = entry.tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    fail(`${at}: "tags" must be an array of strings`);
  }

  const version = optionalString(entry, "version", at);
  if (version !== null && !SEMVER_RE.test(version)) {
    fail(`${at}: version "${version}" is not semver (x.y.z)`);
  }

  const downloadUrl = optionalString(entry, "downloadUrl", at);
  if (downloadUrl !== null) {
    if (!downloadUrl.startsWith("https://")) {
      fail(`${at}: downloadUrl must use https://`);
    } else {
      checkLocalArtifact(downloadUrl, id, version, at);
    }
  }

  const homepage = optionalString(entry, "homepage", at);
  if (homepage !== null && !homepage.startsWith("https://")) {
    fail(`${at}: homepage must use https://`);
  }

  const addedAt = optionalString(entry, "addedAt", at);
  if (addedAt !== null && !ISO_RE.test(addedAt)) {
    fail(`${at}: addedAt "${addedAt}" must be an ISO-8601 date-time`);
  }
}

function validateCatalog(relPath: string): unknown {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    fail(`${relPath}: file not found`);
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    fail(`${relPath}: invalid JSON — ${errorMessage(e)}`);
    return null;
  }
  if (!isRecord(data)) {
    fail(`${relPath}: root must be an object`);
    return null;
  }
  for (const key of Object.keys(data)) {
    if (key !== "version" && key !== "plugins") {
      fail(`${relPath}: unknown root field "${key}"`);
    }
  }
  if (data.version !== 1) {
    fail(`${relPath}: "version" must be 1 (got ${JSON.stringify(data.version)})`);
  }
  if (!Array.isArray(data.plugins)) {
    fail(`${relPath}: "plugins" must be an array`);
    return null;
  }
  const seen = new Set<string>();
  data.plugins.forEach((entry: unknown, index: number) => {
    validateEntry(entry, `${relPath} → plugins[${index}]`, seen);
  });
  return data;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const catalogs = CATALOGS.map((path) => ({
  path,
  data: validateCatalog(path),
}));

// Soft check: the bundled fallback usually mirrors the live catalog.
const [live, fallback] = catalogs;
if (live !== undefined && fallback !== undefined) {
  if (live.data !== null && fallback.data !== null) {
    if (JSON.stringify(live.data) !== JSON.stringify(fallback.data)) {
      console.warn(
        "⚠ Note: fallback-catalog.json differs from plugins.json (fine if intentional).",
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`\n✗ Store validation failed with ${errors.length} problem(s):\n`);
  for (const error of errors) {
    console.error(`  • ${error}`);
  }
  console.error("");
  process.exit(1);
}

const total = catalogs.reduce((sum, c) => {
  const plugins = c.data !== null ? (c.data as { plugins?: unknown[] }).plugins : undefined;
  return sum + (Array.isArray(plugins) ? plugins.length : 0);
}, 0);
console.log(
  `✓ Store catalogs valid — ${total} total entries across ${CATALOGS.length} file(s).`,
);
