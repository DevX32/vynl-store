export const BUCKET = "listen-along";

export const DEFAULT_PROJECT = {
  url: "",
  key: "",
};

const URL_RE = /^https:\/\/[^\s/]+$/;

const SIGN_TTL_S = 60 * 60;
const SIGN_CACHE_TTL_MS = 50 * 60 * 1000;

export function normalizeProject(url, key) {
  const cleanUrl = String(url ?? "").trim().replace(/\/+$/, "");
  const cleanKey = String(key ?? "").trim();
  if (!URL_RE.test(cleanUrl)) return null;
  if (cleanKey.length === 0) return null;
  return { url: cleanUrl, key: cleanKey };
}

const validDefault = normalizeProject(DEFAULT_PROJECT.url, DEFAULT_PROJECT.key);

export function hasDefaultProject() {
  return validDefault !== null;
}

export function resolveProject(overrideUrl, overrideKey) {
  return normalizeProject(overrideUrl, overrideKey) ?? validDefault;
}

export function isUsingDefault(overrideUrl, overrideKey) {
  if (validDefault === null) return false;
  const override = normalizeProject(overrideUrl, overrideKey);
  return override === null;
}

export { SIGN_TTL_S, SIGN_CACHE_TTL_MS };
