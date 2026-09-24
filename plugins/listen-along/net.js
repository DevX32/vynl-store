/**
 * Hand-rolled Supabase client.
 *
 * Plugins can't use npm packages (the compiler only resolves files inside
 * the plugin folder), so the few endpoints the sync layer needs — PostgREST
 * tables, RPC functions, and the Storage API — are wrapped here on top of
 * `fetch`.
 */

let cfg = null; // { url, key }

/** Validate + store the project config. Returns true when usable. */
export function configure(url, key) {
  const cleanUrl = String(url ?? "").trim().replace(/\/+$/, "");
  const cleanKey = String(key ?? "").trim();
  const valid =
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cleanUrl) && cleanKey.length > 0;
  cfg = valid ? { url: cleanUrl, key: cleanKey } : null;
  return valid;
}

export function isConfigured() {
  return cfg !== null;
}

export function getConfig() {
  return cfg;
}

function requireCfg() {
  if (!cfg) throw new Error("Supabase is not configured");
  return cfg;
}

function headers(extra) {
  const { key } = requireCfg();
  const out = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  for (const [k, v] of Object.entries(extra ?? {})) {
    // fetch merges case-variant header keys, so normalize Content-Type here
    // (a duplicate would serialize as "application/json, image/png").
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
    const msg =
      typeof raw === "string" && raw.length > 0 ? raw : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

function restUrl(path) {
  return `${requireCfg().url}/rest/v1/${path}`;
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.append(k, v);
  return sp.toString();
}

// ---------------------------------------------------------------------------
// PostgREST
// ---------------------------------------------------------------------------

const RETURNING = { Prefer: "return=representation" };

async function getRows(table, query) {
  return (await request(`${restUrl(table)}?${qs(query)}`, {
    method: "GET",
    headers: headers(),
  })) ?? [];
}

export async function insertSession(code, hostId, expiresAt) {
  const rows = await request(`${restUrl("sessions")}?${qs({ select: "id" })}`, {
    method: "POST",
    headers: headers(RETURNING),
    body: JSON.stringify({ code, host_id: hostId, expires_at: expiresAt }),
  });
  const row = rows?.[0];
  if (!row?.id) throw new Error("Failed to create session");
  return row.id;
}

export async function findSessionByCode(code) {
  const rows = await getRows("sessions", {
    code: `eq.${code.toUpperCase()}`,
    select: "id,expires_at,host_id",
  });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    expires_at: row.expires_at ?? null,
    hostId: row.host_id ?? null,
  };
}

export async function deleteSession(id) {
  await request(`${restUrl("sessions")}?${qs({ id: `eq.${id}` })}`, {
    method: "DELETE",
    headers: headers(),
  });
}

export async function listSessionIds() {
  const rows = await getRows("sessions", { select: "id" });
  return rows.map((r) => r.id).filter(Boolean);
}

export async function selectPeers(sessionId, excludeInstanceId) {
  return getRows("peers", {
    session_id: `eq.${sessionId}`,
    instance_id: `neq.${excludeInstanceId}`,
    select: "instance_id,hostname,track,updated_at",
  });
}

export async function findPeerIdByInstance(instanceId) {
  const rows = await getRows("peers", {
    instance_id: `eq.${instanceId}`,
    select: "id",
  });
  return rows[0]?.id ?? null;
}

export async function updatePeer(id, patch) {
  const rows = await request(`${restUrl("peers")}?${qs({ id: `eq.${id}` })}`, {
    method: "PATCH",
    headers: headers(RETURNING),
    body: JSON.stringify(patch),
  });
  return Array.isArray(rows) && rows.length > 0;
}

export async function insertPeer(payload) {
  const rows = await request(`${restUrl("peers")}?${qs({ select: "id" })}`, {
    method: "POST",
    headers: headers(RETURNING),
    body: JSON.stringify(payload),
  });
  const id = rows?.[0]?.id;
  if (!id) throw new Error("Failed to register peer");
  return id;
}

export async function deletePeerByInstance(instanceId) {
  await request(`${restUrl("peers")}?${qs({ instance_id: `eq.${instanceId}` })}`, {
    method: "DELETE",
    headers: headers(),
  });
}

export async function rpc(name) {
  await request(restUrl(`rpc/${name}`), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({}),
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function storageUrl(path) {
  return `${requireCfg().url}/storage/v1/${path}`;
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export async function storageUpload(bucket, key, blob, contentType) {
  await request(storageUrl(`object/${bucket}/${encodeKey(key)}`), {
    method: "POST",
    headers: headers({
      "x-upsert": "true",
      "content-type": contentType || "application/octet-stream",
    }),
    body: blob,
  });
}

export async function storageSign(bucket, key, expiresIn) {
  const body = await request(
    storageUrl(`object/sign/${bucket}/${encodeKey(key)}`),
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ expiresIn }),
    },
  );
  const signed = body?.signedURL ?? body?.signedUrl;
  if (!signed) throw new Error("Failed to sign storage object");
  // The API returns a `/object/sign/...` path; the absolute URL needs the
  // storage API prefix (what supabase-js's client does internally).
  return requireCfg().url + "/storage/v1" + signed;
}

export async function storageList(bucket, prefix, limit, offset) {
  const rows = await request(storageUrl(`object/list/${bucket}`), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ prefix, limit, offset }),
  });
  return Array.isArray(rows) ? rows : [];
}

export async function storageRemove(bucket, paths) {
  await request(storageUrl(`object/${bucket}`), {
    method: "DELETE",
    headers: headers(),
    body: JSON.stringify({ prefixes: paths }),
  });
}
