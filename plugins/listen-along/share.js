/**
 * Audio/cover sharing over Supabase Storage.
 *
 * The host controls what a plugin can read: `api.Player.getLocalFileUrl`
 * hands back an asset URL for the *current* track's local audio/cover after
 * the app validated the path on the Rust side. Everything past that point
 * (fetch bytes, upload, sign, delete) is plain fetch from the plugin.
 */

import * as net from "./net.js";

const BUCKET = "session-audio";
const SIGN_TTL_S = 3600;
/** Re-sign well before the hour-long signed URL actually expires. */
const SIGN_CACHE_TTL_MS = 50 * 60 * 1000;

let api = null;
const uploadedKeys = new Map();
const inflightUploads = new Map();
const signedUrls = new Map();
const resolvedCoverCache = new Map();

export function setApi(a) {
  api = a;
}

function extFromUrl(url, fallback) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const i = pathname.lastIndexOf(".");
    if (i >= 0) {
      const ext = pathname.slice(i + 1).toLowerCase();
      if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
    }
  } catch {
    /* fall through */
  }
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

async function hashKey(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

async function uploadCurrentFile(sessionId, kind) {
  if (!api || !net.isConfigured()) return null;
  const url = await api.Player.getLocalFileUrl(kind);
  if (!url) return null;

  const cacheKey = `${kind}:${url}`;
  const cached = uploadedKeys.get(cacheKey);
  if (cached) return cached;
  const existing = inflightUploads.get(cacheKey);
  if (existing) return existing;

  const work = (async () => {
    try {
      const fallbackExt = kind === "cover" ? "jpg" : "mp3";
      const ext = extFromUrl(url, fallbackExt);
      const hash = await hashKey(url);
      const key = `${sessionId}/${kind}-${hash}.${ext}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`read ${kind} failed: ${res.status}`);
      const blob = await res.blob();

      await net.storageUpload(
        BUCKET,
        key,
        blob,
        blob.type || (kind === "cover" ? mimeForImage(ext) : mimeForAudio(ext)),
      );
      uploadedKeys.set(cacheKey, key);
      return key;
    } catch (e) {
      console.warn(`[listen-along] upload ${kind} failed:`, e);
      return null;
    } finally {
      inflightUploads.delete(cacheKey);
    }
  })();

  inflightUploads.set(cacheKey, work);
  return work;
}

export function ensureSharedAudio(sessionId) {
  return uploadCurrentFile(sessionId, "audio");
}

export function ensureSharedCover(sessionId) {
  return uploadCurrentFile(sessionId, "cover");
}

async function signedUrlFor(key) {
  const hit = signedUrls.get(key);
  if (hit && Date.now() - hit.at < SIGN_CACHE_TTL_MS) return hit.url;
  const url = await net.storageSign(BUCKET, key, SIGN_TTL_S);
  signedUrls.set(key, { url, at: Date.now() });
  return url;
}

/** Signed https URL of a shared audio object (the host caches + plays it). */
export async function resolveAudioSource(audioKey) {
  try {
    return { sourceUrl: await signedUrlFor(audioKey), cacheKey: audioKey };
  } catch (e) {
    console.warn("[listen-along] audio sign failed:", e);
    return null;
  }
}

/** Signed https URL of a shared cover object (shown directly in the UI). */
export async function resolveCoverSource(coverKey) {
  const cached = resolvedCoverCache.get(coverKey);
  if (cached && Date.now() - cached.at < SIGN_CACHE_TTL_MS) return cached.url;
  try {
    const url = await signedUrlFor(coverKey);
    resolvedCoverCache.set(coverKey, { url, at: Date.now() });
    return url;
  } catch (e) {
    console.warn("[listen-along] cover sign failed:", e);
    return null;
  }
}

export async function cleanupSessionAudio(sessionId) {
  try {
    const paths = [];
    const page = 100;
    for (let offset = 0; ; offset += page) {
      const rows = await net.storageList(BUCKET, sessionId, page, offset);
      if (!rows || rows.length === 0) break;
      for (const f of rows) {
        if (f?.name) paths.push(`${sessionId}/${f.name}`);
      }
      if (rows.length < page) break;
    }
    for (let i = 0; i < paths.length; i += 100) {
      await net.storageRemove(BUCKET, paths.slice(i, i + 100));
    }
  } catch (e) {
    console.warn("[listen-along] session audio cleanup failed:", e);
  }

  for (const [path, key] of [...uploadedKeys.entries()]) {
    if (key.startsWith(`${sessionId}/`)) uploadedKeys.delete(path);
  }
  for (const key of [...resolvedCoverCache.keys()]) {
    if (key.startsWith(`${sessionId}/`)) resolvedCoverCache.delete(key);
  }

  try {
    await api?.Player.clearAudioCache();
  } catch {
    /* cache clear is best-effort */
  }
}

async function cleanupOrphanedSessionAudio(keepSessionId) {
  try {
    const [sessions, folders] = await Promise.all([
      net.listSessionIds(),
      net.storageList(BUCKET, "", 1000, 0),
    ]);

    const alive = new Set(sessions);
    if (keepSessionId) alive.add(keepSessionId);

    const orphans = (folders ?? [])
      .map((f) => f?.name)
      .filter((name) => !!name && !alive.has(name));

    for (const sessionId of orphans) {
      await cleanupSessionAudio(sessionId);
    }
  } catch (e) {
    console.warn("[listen-along] orphan cleanup failed:", e);
  }
}

export async function runListenAlongCleanup(keepSessionId) {
  try {
    await net.rpc("cleanup_listen_along");
  } catch (e) {
    console.warn("[listen-along] cleanup rpc failed, trying fallbacks:", e);
    await Promise.allSettled([
      net.rpc("cleanup_stale_peers"),
      net.rpc("cleanup_expired_sessions"),
    ]);
  }
  await cleanupOrphanedSessionAudio(keepSessionId);
}

export function clearShareState() {
  uploadedKeys.clear();
  inflightUploads.clear();
  signedUrls.clear();
  resolvedCoverCache.clear();
}
