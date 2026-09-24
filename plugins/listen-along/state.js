/**
 * Listen Along session engine.
 *
 * Ported from Vynl's former in-app implementation. Host broadcasts its
 * playback state over a Supabase Realtime topic + (when connected) a WebRTC
 * data channel; joiners apply that state through `api.Player.playShared`,
 * which owns the actual player diffing. The `peers` table over REST provides
 * membership and a 500ms poll is the fallback when WebRTC is down.
 */

import * as net from "./net.js";
import * as share from "./share.js";
import { Realtime } from "./realtime.js";
import { WebrtcSync } from "./webrtc.js";

const ADJECTIVES = [
  "Cosmic", "Turquoise", "Velvet", "Golden", "Silver", "Midnight", "Crimson",
  "Emerald", "Sapphire", "Amber", "Lunar", "Solar", "Neon", "Electric",
  "Mystic", "Phantom", "Crystal", "Jade", "Coral", "Indigo", "Violet",
  "Scarlet", "Ivory", "Onyx", "Pearl", "Maple", "Cedar", "Willow",
];

const ANIMALS = [
  "Panda", "Fox", "Owl", "Bear", "Wolf", "Hawk", "Lynx", "Orca",
  "Raven", "Tiger", "Otter", "Koala", "Falcon", "Moose", "Crane",
  "Dolphin", "Penguin", "Gecko", "Puma", "Cobra", "Parrot", "Swan",
  "Badger", "Chameleon", "Jaguar", "Pelican", "Quokka", "Axolotl",
];

const POLL_INTERVAL = 500;
const PEER_FALLBACK_EVERY = 20;
const BCAST_INTERVAL_MS = 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const STALE_PEER_MS = 15000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const HEARTBEAT_MIN_MS = 10000;
const WEBRTC_BROADCAST_MS = 40;

function generateNickname() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj} ${animal}`;
}

function getNicknameKey() {
  return "vynl.listen_along_nickname";
}

function getOrCreateNickname() {
  let nick = localStorage.getItem(getNicknameKey());
  if (!nick) {
    nick = generateNickname();
    localStorage.setItem(getNicknameKey(), nick);
  }
  return nick;
}

function getInstanceId() {
  let id = localStorage.getItem("vynl.instance_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("vynl.instance_id", id);
  }
  return id;
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function extrapolateTime(time, playing, updatedAt, duration) {
  let target = time;
  if (playing && updatedAt && Number.isFinite(updatedAt)) {
    target = time + Math.max(0, (Date.now() - updatedAt) / 1000);
  }
  if (duration && duration > 0) {
    target = Math.min(target, Math.max(0, duration - 0.01));
  }
  return Math.max(0, target);
}

let api = null;
let notifier = () => {};
let nickname = null;

let _active = false;
let _peers = [];
let _shareCode = "";
let _mode = null; // "host" | "joiner"
let _sessionId = null;
let _hostInstanceId = null;

let pollTimer = null;
let cleanupTimer = null;
let webrtcBroadcastTimer = null;
let bcastTimer = null;
let pollCount = 0;

let _rt = null;
let _webrtc = null;
let _webrtcLive = false;

let _activeAudioKey = null;
let _activeCoverKey = null;
let _followingRemote = false;
let _followGen = 0;

let _myPeerId = null;
let _lastAppliedAt = 0;
let _syncInFlight = false;
let _syncDirty = false;
let _lastSyncedPath = null;
let _lastSyncedPlaying = false;
let _lastSyncedTime = 0;
let _lastHeartbeatAt = 0;
let _lastAppliedSentAt = 0;

/** Lyrics received from the host; served back through the lyrics provider. */
let _remoteLyrics = null; // { title, artist, text, kind }

const prefetchedAudioKeys = new Set();
const PREFETCH_MAX = 128;

function notify() {
  notifier();
}

export function setApi(a) {
  api = a;
  share.setApi(a);
}

export function setNotifier(fn) {
  notifier = fn;
}

export function setNickname(value) {
  const trimmed = String(value ?? "").trim();
  nickname = trimmed.length > 0 ? trimmed : getOrCreateNickname();
}

export function getNickname() {
  return nickname ?? getOrCreateNickname();
}

export function isRelayActive() {
  return _active;
}

export function isWebrtcLive() {
  return _webrtcLive;
}

export function getPeers() {
  return _peers;
}

export function getShareCode() {
  return _shareCode;
}

export function getMode() {
  return _mode;
}

function hostname() {
  return getNickname();
}

function snapshot() {
  return api.Player.getState();
}

function buildTrackPayload(st) {
  if (!st.track) return null;
  const text = st.lyrics?.text ?? null;
  return {
    title: st.track.title,
    artist: st.track.artist,
    album: st.track.album,
    duration: st.track.duration,
    time: st.position,
    playing: st.playing,
    updatedAt: Date.now(),
    path: st.track.path ?? null,
    audioKey: _activeAudioKey,
    coverKey: _activeCoverKey,
    lyrics: text,
    lyricsKind: st.lyrics?.kind ?? (text && /\[\d{1,2}:\d{2}/.test(text) ? "lrc" : "txt"),
  };
}

function sessionTopic() {
  return _sessionId ? `session:${_sessionId}` : null;
}

function onBeforeUnload() {
  if (_active) void leaveSession();
}

function attachBeforeUnload() {
  window.addEventListener("beforeunload", onBeforeUnload);
}

function detachBeforeUnload() {
  window.removeEventListener("beforeunload", onBeforeUnload);
}

async function upsertPeer(row) {
  const payload = { ...row, updated_at: new Date().toISOString() };

  if (_myPeerId) {
    try {
      await net.updatePeer(_myPeerId, payload);
      return;
    } catch {
      _myPeerId = null;
    }
  }

  const existingId = await net.findPeerIdByInstance(row.instance_id);
  if (existingId) {
    _myPeerId = existingId;
    await net.updatePeer(_myPeerId, payload);
  } else {
    _myPeerId = await net.insertPeer(payload);
  }
}

async function refreshPeers() {
  if (!_active || !_sessionId) return;

  const instanceId = getInstanceId();
  const staleCutoff = Date.now() - STALE_PEER_MS;

  try {
    const rows = await net.selectPeers(_sessionId, instanceId);
    _peers = rows
      .filter((p) => p.updated_at && new Date(p.updated_at).getTime() > staleCutoff)
      .map((p) => {
        const track = p.track ?? null;
        const rowAt = p.updated_at ? new Date(p.updated_at).getTime() : Date.now();
        return {
          instanceId: p.instance_id,
          hostname: p.hostname,
          track: track ? { ...track, updatedAt: track.updatedAt ?? rowAt } : null,
        };
      });
    notify();
    applyListenAlongFollow();
  } catch (e) {
    console.warn("[listen-along] refreshPeers failed:", e);
  }
}

async function heartbeatPeer(track, force = false) {
  if (!_active || !_sessionId) return;
  const now = Date.now();
  if (!force && now - _lastHeartbeatAt < HEARTBEAT_MIN_MS && _myPeerId) return;
  _lastHeartbeatAt = now;
  try {
    if (_myPeerId) {
      const ok = await net.updatePeer(_myPeerId, {
        updated_at: new Date().toISOString(),
        track,
      });
      if (ok) return;
      _myPeerId = null;
    }
    await upsertPeer({
      session_id: _sessionId,
      instance_id: getInstanceId(),
      hostname: hostname(),
      track,
    });
  } catch (e) {
    console.warn("[listen-along] heartbeatPeer failed:", e);
  }
}

function kickShareUploads(sessionId) {
  void share.ensureSharedAudio(sessionId).then((key) => {
    if (!_active || _sessionId !== sessionId) return;
    if (key && key !== _activeAudioKey) {
      _activeAudioKey = key;
      _syncDirty = true;
      syncTrack();
    }
  });
  void share.ensureSharedCover(sessionId).then((key) => {
    if (!_active || _sessionId !== sessionId) return;
    if (key && key !== _activeCoverKey) {
      _activeCoverKey = key;
      _syncDirty = true;
      syncTrack();
    }
  });
}

export function syncTrack() {
  if (!_active || !_sessionId) return;

  const st = snapshot();
  const sessionId = _sessionId;
  const currentTime = st.position;

  if (_followingRemote && _mode === "joiner") {
    void heartbeatPeer(null);
    return;
  }

  const trackPath = st.track?.path ?? null;
  const changed =
    trackPath !== _lastSyncedPath ||
    st.playing !== _lastSyncedPlaying ||
    Math.abs(currentTime - _lastSyncedTime) > 0.3;

  if (!changed && !_syncDirty) {
    void heartbeatPeer(buildTrackPayload(st));
    return;
  }

  if (_syncInFlight) {
    _syncDirty = true;
    return;
  }

  _syncInFlight = true;
  _syncDirty = false;

  void (async () => {
    try {
      const trackChanged = trackPath !== _lastSyncedPath;
      if (st.track?.path && !_followingRemote && trackChanged) {
        _activeAudioKey = null;
        _activeCoverKey = null;
        kickShareUploads(sessionId);
      }

      const track = buildTrackPayload(st);
      await heartbeatPeer(track, true);
      pushWebrtcState(track);
      broadcastTrackState(track);

      _lastSyncedPath = trackPath;
      _lastSyncedPlaying = st.playing;
      _lastSyncedTime = currentTime;
    } finally {
      _syncInFlight = false;
      if (_syncDirty) syncTrack();
    }
  })();
}

async function playRemoteAudio(opts) {
  const sampledAt = opts.updatedAt ?? Date.now();
  if (!opts.audioKey) return; // host audio not available yet

  // The REST poll (10s) can hand us a peer row that predates what the
  // realtime feed already delivered (e.g. right after a track switch) —
  // applying it would roll playback back to the old track. 2s of slack
  // tolerates equal timestamps.
  if (sampledAt + 2000 < _lastAppliedAt) return;
  if (sampledAt > _lastAppliedAt) _lastAppliedAt = sampledAt;

  const source = await share.resolveAudioSource(opts.audioKey);
  if (!source || !_active || _mode !== "joiner") return;

  let coverUrl = null;
  if (opts.coverKey) {
    coverUrl = await share.resolveCoverSource(opts.coverKey);
  }

  const targetTime = extrapolateTime(opts.time, opts.playing, sampledAt, opts.duration);

  if (opts.audioKey !== _activeAudioKey) {
    _activeCoverKey = null;
  }
  _activeAudioKey = opts.audioKey;
  _activeCoverKey = opts.coverKey ?? _activeCoverKey;

  if (opts.lyrics) {
    _remoteLyrics = {
      title: opts.title,
      artist: opts.artist,
      text: opts.lyrics,
      kind: opts.lyricsKind ?? (/\[\d{1,2}:\d{2}/.test(opts.lyrics) ? "lrc" : "txt"),
    };
  } else {
    _remoteLyrics = null;
  }

  const gen = ++_followGen;
  _followingRemote = true;

  try {
    await api.Player.playShared({
      sourceUrl: source.sourceUrl,
      cacheKey: source.cacheKey,
      title: opts.title,
      artist: opts.artist,
      album: opts.album,
      duration: opts.duration,
      coverUrl,
      lyrics: opts.lyrics ?? null,
      time: targetTime,
      playing: opts.playing,
    });
  } catch (e) {
    console.warn("[listen-along] playShared failed:", e);
  }

  if (_mode === "host") {
    setTimeout(() => {
      if (gen === _followGen) _followingRemote = false;
    }, 500);
  }
}

function applyListenAlongFollow() {
  if (_mode !== "joiner") return;
  if (_webrtcLive) return;
  if (_peers.length === 0) return;

  let source = null;
  if (_hostInstanceId) {
    source =
      _peers.find((p) => p.instanceId === _hostInstanceId && p.track) ?? null;
  }
  if (!source) {
    for (const peer of _peers) {
      if (!peer.track) continue;
      if (peer.track.playing) {
        source = peer;
        break;
      }
      if (!source) source = peer;
    }
  }
  if (!source?.track) return;

  const t = source.track;
  void playRemoteAudio({
    audioKey: t.audioKey,
    coverKey: t.coverKey,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    lyrics: t.lyrics,
    lyricsKind: t.lyricsKind,
    time: t.time,
    playing: t.playing,
    updatedAt: t.updatedAt,
  });
}

function upsertPeerTrack(instanceId, peerHostname, track) {
  const idx = _peers.findIndex((p) => p.instanceId === instanceId);
  if (idx >= 0) {
    const next = [..._peers];
    next[idx] = { instanceId, hostname: peerHostname || next[idx].hostname, track };
    _peers = next;
  } else {
    _peers = [..._peers, { instanceId, hostname: peerHostname || "Peer", track }];
  }
}

function prefetchAudio(audioKey) {
  if (!audioKey || audioKey === _activeAudioKey) return;
  if (prefetchedAudioKeys.has(audioKey)) return;
  prefetchedAudioKeys.add(audioKey);
  if (prefetchedAudioKeys.size > PREFETCH_MAX) {
    const toDrop = Math.ceil(PREFETCH_MAX / 2);
    let dropped = 0;
    for (const key of prefetchedAudioKeys) {
      if (dropped >= toDrop) break;
      prefetchedAudioKeys.delete(key);
      dropped += 1;
    }
  }
  // Warm the sign cache so the first playShared doesn't wait on a round trip.
  void share.resolveAudioSource(audioKey).catch(() => {});
}

function broadcastTrackState(track) {
  if (!_active || !_sessionId || !_rt || _mode !== "host") return;
  _rt.broadcast(sessionTopic(), "la-state", {
    instanceId: getInstanceId(),
    hostname: hostname(),
    track,
    sentAt: Date.now(),
  });
}

function onBroadcastState(payload) {
  if (_mode !== "joiner" || !_sessionId) return;
  if (!payload?.instanceId || payload.instanceId === getInstanceId()) return;
  const track = payload.track ?? null;
  const before = _peers.length;
  upsertPeerTrack(payload.instanceId, payload.hostname, track);
  if (track) prefetchAudio(track.audioKey);
  if (_peers.length !== before) notify();
  if (_webrtcLive) return;
  applyListenAlongFollow();
}

function subscribeToSession() {
  if (!_sessionId || !_rt) return;
  void _rt
    .join(sessionTopic(), { "la-state": onBroadcastState })
    .catch((e) => console.warn("[listen-along] session channel failed:", e));
}

function startHostBcast() {
  stopHostBcast();
  bcastTimer = setInterval(() => {
    if (!_active || _mode !== "host" || !_sessionId) return;
    const st = snapshot();
    if (!st.track) return;
    broadcastTrackState(buildTrackPayload(st));
  }, BCAST_INTERVAL_MS);
}

function stopHostBcast() {
  if (bcastTimer) {
    clearInterval(bcastTimer);
    bcastTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollCount = 0;
  const tick = () => {
    pollCount += 1;
    if (pollCount % PEER_FALLBACK_EVERY === 1) void refreshPeers();
    syncTrack();
  };
  tick();
  pollTimer = setInterval(tick, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startCleanupLoop() {
  stopCleanupLoop();
  void share.runListenAlongCleanup(_sessionId);
  cleanupTimer = setInterval(() => {
    void share.runListenAlongCleanup(_sessionId);
  }, CLEANUP_INTERVAL);
}

function stopCleanupLoop() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function pushWebrtcState(track) {
  if (_mode !== "host" || !track) return;
  if (!_webrtc?.hasOpenChannel()) return;
  _webrtc.broadcastState({
    time: track.time,
    playing: track.playing,
    sentAt: Date.now(),
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    audioKey: track.audioKey,
    coverKey: track.coverKey,
    lyrics: track.lyrics,
    lyricsKind: track.lyricsKind,
  });
}

function onWebrtcState(state, clockOffsetMs) {
  if (_mode !== "joiner") return;
  if (state.sentAt <= _lastAppliedSentAt) return;
  _lastAppliedSentAt = state.sentAt;
  if (state.audioKey) prefetchAudio(state.audioKey);
  void playRemoteAudio({
    audioKey: state.audioKey,
    coverKey: state.coverKey,
    title: state.title,
    artist: state.artist,
    album: state.album,
    duration: state.duration,
    lyrics: state.lyrics,
    lyricsKind: state.lyricsKind,
    time: state.time,
    playing: state.playing,
    updatedAt: state.sentAt - clockOffsetMs,
  });
}

async function startWebrtc(role) {
  if (!_sessionId || !_rt) return;
  const handlers = {
    onState: onWebrtcState,
    onConnectionChange: (connected) => {
      _webrtcLive = connected;
      notify();
      if (!connected && role === "joiner") {
        applyListenAlongFollow();
      }
      if (connected && role === "host") {
        const st = snapshot();
        if (st.track) pushWebrtcState(buildTrackPayload(st));
      }
    },
  };

  try {
    _webrtc = new WebrtcSync(_rt);
    if (role === "host") {
      await _webrtc.startHost(_sessionId, getInstanceId(), handlers);
      startWebrtcBroadcast();
    } else {
      const hostId = _hostInstanceId;
      if (!hostId) return;
      await _webrtc.startJoiner(_sessionId, getInstanceId(), hostId, handlers);
    }
  } catch (e) {
    console.warn("[listen-along] webrtc start failed, using broadcast sync:", e);
    _webrtcLive = false;
  }
}

function stopWebrtc() {
  stopWebrtcBroadcast();
  _webrtcLive = false;
  const wrtc = _webrtc;
  _webrtc = null;
  if (wrtc) void wrtc.destroy();
}

function startWebrtcBroadcast() {
  stopWebrtcBroadcast();
  webrtcBroadcastTimer = setInterval(() => {
    if (_mode !== "host" || !_webrtc?.hasOpenChannel()) return;
    const st = snapshot();
    if (!st.track) return;
    pushWebrtcState(buildTrackPayload(st));
  }, WEBRTC_BROADCAST_MS);
}

function stopWebrtcBroadcast() {
  if (webrtcBroadcastTimer) {
    clearInterval(webrtcBroadcastTimer);
    webrtcBroadcastTimer = null;
  }
}

function openRealtime() {
  const cfg = net.getConfig();
  if (!cfg) throw new Error("Supabase is not configured");
  const rt = new Realtime();
  rt.open(cfg.url, cfg.key);
  return rt;
}

export async function startHostSession() {
  if (!net.isConfigured()) throw new Error("Supabase is not configured");

  const code = generateCode();
  const instanceId = getInstanceId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  const sessionId = await net.insertSession(code, instanceId, expiresAt);

  _sessionId = sessionId;
  _hostInstanceId = instanceId;

  await upsertPeer({
    session_id: sessionId,
    instance_id: instanceId,
    hostname: hostname(),
    track: null,
  });

  _rt = openRealtime();

  _active = true;
  _shareCode = code;
  _mode = "host";
  notify();

  subscribeToSession();
  startPolling();
  startCleanupLoop();
  void startWebrtc("host");
  startHostBcast();
  syncTrack();
  attachBeforeUnload();

  return code;
}

export async function joinSession(code) {
  if (!net.isConfigured()) throw new Error("Supabase is not configured");

  const session = await net.findSessionByCode(code);
  if (!session) throw new Error("Session not found");
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error("Session has expired");
  }

  const instanceId = getInstanceId();
  const normalized = code.toUpperCase().trim();

  _sessionId = session.id;
  _hostInstanceId = session.hostId;

  await upsertPeer({
    session_id: session.id,
    instance_id: instanceId,
    hostname: hostname(),
    track: null,
  });
  await refreshPeers();

  _rt = openRealtime();

  _active = true;
  _shareCode = normalized;
  _mode = "joiner";
  notify();

  subscribeToSession();
  startPolling();
  startCleanupLoop();
  void startWebrtc("joiner");
  syncTrack();
  attachBeforeUnload();
}

export async function leaveSession() {
  const instanceId = getInstanceId();
  const sessionId = _sessionId;
  const isHost = _mode === "host";
  const wasFollowing = _followingRemote;

  detachBeforeUnload();
  stopWebrtc();
  stopHostBcast();
  stopWebrtcBroadcast();
  prefetchedAudioKeys.clear();
  stopPolling();
  stopCleanupLoop();

  if (_rt) {
    const rt = _rt;
    _rt = null;
    rt.close();
  }

  _active = false;
  _peers = [];
  _shareCode = "";
  _mode = null;
  _sessionId = null;
  _hostInstanceId = null;
  _activeAudioKey = null;
  _activeCoverKey = null;
  _followingRemote = false;
  _followGen += 1;
  _webrtcLive = false;
  _myPeerId = null;
  _syncInFlight = false;
  _syncDirty = false;
  _lastSyncedPath = null;
  _lastSyncedPlaying = false;
  _lastSyncedTime = 0;
  _lastHeartbeatAt = 0;
  _lastAppliedSentAt = 0;
  _lastAppliedAt = 0;
  _remoteLyrics = null;
  share.clearShareState();
  notify();

  if (wasFollowing && api) {
    try {
      api.Player.stopShared();
    } catch (e) {
      console.warn("[listen-along] stopShared failed:", e);
    }
  }
  if (api) void api.Player.clearAudioCache().catch(() => {});

  if (!sessionId || !net.isConfigured()) return;

  try {
    await net.deletePeerByInstance(instanceId);
  } catch (e) {
    console.warn("[listen-along] peer cleanup failed:", e);
  }

  if (isHost) {
    try {
      await net.deleteSession(sessionId);
      await share.cleanupSessionAudio(sessionId);
    } catch (e) {
      console.warn("[listen-along] session cleanup failed:", e);
    }
  }
}

/** Lyrics provider hook: serves the host's lyrics while following. */
export function getSharedLyrics(lookup) {
  const rl = _remoteLyrics;
  if (!rl || !_followingRemote) return null;
  const sameTrack =
    rl.title.trim().toLowerCase() === String(lookup.title).trim().toLowerCase() &&
    rl.artist.trim().toLowerCase() === String(lookup.artist).trim().toLowerCase();
  if (!sameTrack) return null;
  return { kind: rl.kind, text: rl.text };
}
