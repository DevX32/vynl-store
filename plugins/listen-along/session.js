import * as bucket from "./bucket.js";
import { createSignaling } from "./signaling.js";
import { HostTransport, JoinerTransport } from "./transport.js";
import { resolveProject } from "./config.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

const PUBLISH_INTERVAL_MS = 1000;
const CHANGE_EPSILON_S = 0.35;

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

const NICKNAME_KEY = "vynl.listen_along_nickname";
const INSTANCE_KEY = "vynl.instance_id";

let api = null;
let notifier = () => {};
let project = null;

let mode = null;
let code = "";
let peerCount = 0;
let connected = false;
let status = "idle";
let statusDetail = "";
let lastTrack = null;

let hostTransport = null;
let joinerTransport = null;
let signaling = null;
let publishTimer = null;

let lastPublished = { path: null, playing: false, time: 0 };
let stagedAudioKey = null;
let stagedCoverKey = null;
let stagedFor = null;
let pendingStage = false;
let remoteLyrics = null;
let following = false;

const wantedAudio = new Set();

function notify() {
  notifier();
}

export function setApi(a) {
  api = a;
  bucket.setApi(a);
}

export function setNotifier(fn) {
  notifier = fn;
}

export function configureProject(url, key) {
  project = resolveProject(url, key);
  bucket.setProject(project);
}

export function isConfigured() {
  return project !== null;
}

export function getMode() {
  return mode;
}

export function getCode() {
  return code;
}

export function getPeerCount() {
  return peerCount;
}

export function isConnected() {
  return connected;
}

export function getStatus() {
  return { status, detail: statusDetail };
}

export function getTrackInfo() {
  return lastTrack;
}

export function isFollowing() {
  return following;
}

function setStatus(next, detail = "") {
  status = next;
  statusDetail = detail;
  notify();
}

function getInstanceId() {
  let id = localStorage.getItem(INSTANCE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(INSTANCE_KEY, id);
  }
  return id;
}

export function getNickname() {
  let nick = localStorage.getItem(NICKNAME_KEY);
  if (!nick) {
    nick = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${
      ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
    }`;
    localStorage.setItem(NICKNAME_KEY, nick);
  }
  return nick;
}

export function setNickname(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length > 0) localStorage.setItem(NICKNAME_KEY, trimmed);
}

function generateCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

export function normalizeCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

function topicFor(c) {
  return `la:${c}`;
}

function correctTime(time, playing, sentAt, clockOffsetMs, duration) {
  let target = time;
  if (playing && Number.isFinite(sentAt)) {
    const elapsed = (Date.now() - (sentAt - clockOffsetMs)) / 1000;
    target += Math.max(0, elapsed);
  }
  if (duration > 0) target = Math.min(target, Math.max(0, duration - 0.01));
  return Math.max(0, target);
}

function describe(st) {
  if (!st.track) return null;
  return {
    title: st.track.title,
    artist: st.track.artist,
    album: st.track.album,
    duration: st.track.duration,
  };
}

function sameTrack(a, b) {
  if (!a || !b) return false;
  return (
    String(a.title).trim().toLowerCase() === String(b.title).trim().toLowerCase() &&
    String(a.artist).trim().toLowerCase() === String(b.artist).trim().toLowerCase()
  );
}

function clearState() {
  if (publishTimer !== null) {
    clearInterval(publishTimer);
    publishTimer = null;
  }
  hostTransport?.destroy();
  joinerTransport?.destroy();
  hostTransport = null;
  joinerTransport = null;
  signaling?.close();
  signaling = null;

  mode = null;
  code = "";
  peerCount = 0;
  connected = false;
  status = "idle";
  statusDetail = "";
  lastTrack = null;
  lastPublished = { path: null, playing: false, time: 0 };
  stagedAudioKey = null;
  stagedCoverKey = null;
  stagedFor = null;
  pendingStage = false;
  remoteLyrics = null;
  following = false;
  wantedAudio.clear();
  bucket.clearSessionState();
}

function currentFrame() {
  const st = api.Player.getState();
  const info = describe(st);
  return {
    time: st.position,
    playing: st.playing,
    ...(info ?? {}),
    audioKey: stagedAudioKey,
    coverKey: stagedCoverKey,
    trackKey: st.track?.path ?? null,
    lyrics: st.lyrics?.text ?? null,
    lyricsKind: st.lyrics?.kind ?? null,
  };
}

function publish(force) {
  if (mode !== "host" || !hostTransport) return;
  const st = api.Player.getState();
  const path = st.track?.path ?? null;
  const changed =
    path !== lastPublished.path ||
    st.playing !== lastPublished.playing ||
    Math.abs(st.position - lastPublished.time) > CHANGE_EPSILON_S;

  if (!force && !changed) return;

  if (path !== stagedFor) {
    stagedFor = path;
    stagedAudioKey = null;
    stagedCoverKey = null;
    wantedAudio.clear();
  }

  lastPublished = { path, playing: st.playing, time: st.position };
  lastTrack = describe(st);
  hostTransport.publish({ ...currentFrame(), sentAt: Date.now() });

  if (wantedAudio.size > 0) void stageForRequesters();
}

async function stageForRequesters() {
  if (mode !== "host" || pendingStage) return;
  if (wantedAudio.size === 0) return;

  pendingStage = true;
  try {
    const [audio, cover] = await Promise.all([
      bucket.stageAudio(),
      bucket.stageCover(),
    ]);
    if (mode !== "host") return;
    if (audio) stagedAudioKey = audio;
    if (cover) stagedCoverKey = cover;
    if (audio || cover) {
      wantedAudio.clear();
      publish(true);
    }
  } catch (e) {
    console.warn("[listen-along] staging failed:", e);
  } finally {
    pendingStage = false;
  }
}

export function syncOnTrackChange() {
  if (mode !== "host") return;
  publish(true);
  if (wantedAudio.size > 0) void stageForRequesters();
}

export async function host() {
  if (mode) throw new Error("Already in a session");
  if (!project) throw new Error("No relay configured");

  code = generateCode();
  mode = "host";
  peerCount = 0;
  connected = false;
  setStatus("connecting", "Waiting for listeners");

  signaling = createSignaling(project);
  hostTransport = new HostTransport(signaling);
  hostTransport.setHandlers({
    onPeerChange: (n) => {
      peerCount = n;
      notify();
    },
    onPeerOpen: () => publish(true),
    onNeedAudio: (msg) => {
      if (msg?.trackKey) wantedAudio.add(msg.trackKey);
      void stageForRequesters();
    },
  });

  try {
    await signaling.join(topicFor(code));
  } catch (e) {
    clearState();
    setStatus("error", e instanceof Error ? e.message : String(e));
    throw e;
  }

  hostTransport.start(getInstanceId());

  publishTimer = setInterval(() => publish(false), PUBLISH_INTERVAL_MS);
  setStatus("live", "Sharing");
  publish(true);

  return code;
}

async function applyRemoteState(frame, clockOffsetMs) {
  if (mode !== "joiner") return;

  const st = api.Player.getState();
  const alreadyFollowing = st.shared && sameTrack(lastTrack, frame);
  following = true;
  lastTrack = {
    title: frame.title,
    artist: frame.artist,
    album: frame.album,
    duration: frame.duration,
  };

  let sourceUrl = null;
  if (frame.audioKey) {
    sourceUrl = await bucket.resolveSource(frame.audioKey);
  } else if (frame.trackKey) {
    joinerTransport.requestAudio(frame.trackKey);
  }

  const coverUrl = frame.coverKey ? await bucket.resolveSource(frame.coverKey) : null;

  if (frame.lyrics) {
    remoteLyrics = {
      title: frame.title,
      artist: frame.artist,
      text: frame.lyrics,
      kind: frame.lyricsKind ?? (/^\s*\[\d{1,2}:\d{2}/.test(frame.lyrics) ? "lrc" : "txt"),
    };
  } else {
    remoteLyrics = null;
  }

  const time = correctTime(frame.time, frame.playing, frame.sentAt, clockOffsetMs, frame.duration ?? 0);

  if (!sourceUrl && !alreadyFollowing) {
    notify();
    return;
  }

  try {
    await api.Player.playShared({
      sourceUrl,
      cacheKey: frame.audioKey,
      title: frame.title,
      artist: frame.artist,
      album: frame.album,
      duration: frame.duration,
      coverUrl,
      lyrics: frame.lyrics ?? null,
      time,
      playing: frame.playing,
    });
  } catch (e) {
    console.warn("[listen-along] applying remote state failed:", e);
  }

  notify();
}

export async function join(rawCode) {
  if (mode) throw new Error("Already in a session");
  if (!project) throw new Error("No relay configured");

  const normalized = normalizeCode(rawCode);
  if (normalized.length !== CODE_LENGTH) throw new Error("That code isn't valid");

  code = normalized;
  mode = "joiner";
  setStatus("connecting", "Reaching the host");

  signaling = createSignaling(project);
  joinerTransport = new JoinerTransport(signaling);
  joinerTransport.setHandlers({
    onOpen: () => {
      connected = true;
      setStatus("live", "In sync");
    },
    onClose: () => {
      connected = false;
      setStatus("connecting", "Reconnecting");
    },
    onState: applyRemoteState,
  });

  try {
    await signaling.join(topicFor(code));
  } catch (e) {
    clearState();
    setStatus("error", e instanceof Error ? e.message : String(e));
    throw e;
  }

  joinerTransport.start(getInstanceId(), `host:${code}`);
}

export async function leave() {
  const wasFollowing = following;
  clearState();

  if (wasFollowing && api) {
    try {
      api.Player.stopShared();
    } catch (e) {
      console.warn("[listen-along] releasing the player failed:", e);
    }
  }
  if (api) {
    try {
      await api.Player.clearAudioCache();
    } catch {}
  }
  notify();
}

export function getSharedLyrics(lookup) {
  if (!remoteLyrics || !following) return null;
  if (!sameTrack(remoteLyrics, lookup)) return null;
  return { kind: remoteLyrics.kind, text: remoteLyrics.text };
}
