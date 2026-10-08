import { BUCKET, SIGN_TTL_S, SIGN_CACHE_TTL_MS } from "./config.js";

let api = null;
let project = null;

const staged = new Map();
const signedCache = new Map();
const inflight = new Map();

export function setApi(a) {
  api = a;
}

export function setProject(p) {
  project = p;
  if (!p) reset();
}

export function stagedKey(sourceUrl) {
  return staged.get(sourceUrl) ?? null;
}

function isConfigured() {
  return project !== null;
}

function currentProject() {
  if (!project) throw new Error("No relay project configured");
  return project;
}

function headers(extra) {
  const { key } = currentProject();
  const out = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  for (const [k, v] of Object.entries(extra ?? {})) {
    const canonical = k.toLowerCase() === "content-type" ? "Content-Type" : k;
    out[canonical] = v;
  }
  return out;
}

async function request(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const raw =
      body && typeof body === "object"
        ? body.message ?? body.error_description ?? body.error ?? body.msg
        : body;
    throw new Error(
      typeof raw === "string" && raw.length > 0 ? raw : `HTTP ${res.status}`,
    );
  }
  return body;
}

function storageUrl(path) {
  return `${currentProject().url}/storage/v1/${path}`;
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function extFromUrl(url, fallback) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const i = pathname.lastIndexOf(".");
    if (i >= 0) {
      const ext = pathname.slice(i + 1).toLowerCase();
      if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
    }
  } catch {}
  return fallback;
}

function mimeForAudio(ext) {
  switch (ext) {
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    case "wav":
      return "audio/wav";
    case "opus":
    case "ogg":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    default:
      return "audio/mpeg";
  }
}

function mimeForImage(ext) {
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return "image/jpeg";
  }
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export function stageAudio() {
  return stage("audio");
}

export function stageCover() {
  return stage("cover");
}

async function stage(kind) {
  if (!api || !isConfigured()) return null;

  const url = await api.Player.getLocalFileUrl(kind);
  if (!url) return null;

  const known = staged.get(url);
  if (known) return known;

  const existing = inflight.get(url);
  if (existing) return existing;

  const work = (async () => {
    try {
      const fallbackExt = kind === "cover" ? "jpg" : "mp3";
      const ext = extFromUrl(url, fallbackExt);
      const key = `${kind}/${await sha256Hex(url)}.${ext}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`read ${kind} failed: ${res.status}`);
      const blob = await res.blob();

      await request(storageUrl(`object/${BUCKET}/${encodeKey(key)}`), {
        method: "POST",
        headers: headers({
          "x-upsert": "true",
          "content-type": blob.type || (kind === "cover" ? mimeForImage(ext) : mimeForAudio(ext)),
        }),
        body: blob,
      });

      staged.set(url, key);
      return key;
    } catch (e) {
      console.warn(`[listen-along] staging ${kind} failed:`, e);
      return null;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, work);
  return work;
}

export async function resolveSource(key) {
  if (!isConfigured() || !key) return null;
  const hit = signedCache.get(key);
  if (hit && Date.now() - hit.at < SIGN_CACHE_TTL_MS) return hit.url;
  try {
    const body = await request(storageUrl(`object/sign/${BUCKET}/${encodeKey(key)}`), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ expiresIn: SIGN_TTL_S }),
    });
    const signed = body?.signedURL ?? body?.signedUrl;
    if (!signed) throw new Error("Failed to sign object");
    const url = currentProject().url + "/storage/v1" + signed;
    signedCache.set(key, { url, at: Date.now() });
    return url;
  } catch (e) {
    console.warn("[listen-along] signing failed:", e);
    return null;
  }
}

export function clearSessionState() {
  signedCache.clear();
}

export function reset() {
  staged.clear();
  signedCache.clear();
  inflight.clear();
}
