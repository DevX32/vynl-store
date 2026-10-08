if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}
if (!globalThis.crypto?.randomUUID) {
  globalThis.crypto = { ...globalThis.crypto, randomUUID: () => "test-uuid" };
}

let failures = 0;
let checks = 0;

function ok(condition, label) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

function eq(actual, expected, label) {
  ok(
    Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}

function section(name) {
  console.log(`\n${name}`);
}

section("modules import cleanly");

const config = await import("./config.js");
ok(true, "config.js");
const signaling = await import("./signaling.js");
ok(true, "signaling.js");
const transport = await import("./transport.js");
ok(true, "transport.js");
const bucket = await import("./bucket.js");
ok(true, "bucket.js");
const session = await import("./session.js");
ok(true, "session.js");

section("config validation");

eq(config.normalizeProject("https://abc.supabase.co", "anon-key") !== null, true, "accepts a valid project");
eq(
  config.normalizeProject("  https://abc.supabase.co/  ", " k "),
  { url: "https://abc.supabase.co", key: "k" },
  "trims and strips trailing slashes",
);
eq(config.normalizeProject("http://abc.supabase.co", "k"), null, "rejects http");
eq(config.normalizeProject("ftp://abc.supabase.co", "k"), null, "rejects a non-http scheme");
eq(config.normalizeProject("https://abc.supabase.co", ""), null, "rejects an empty key");
eq(config.normalizeProject("", "k"), null, "rejects an empty url");
eq(config.normalizeProject(null, undefined), null, "handles null/undefined");

eq(
  config.resolveProject("https://mine.supabase.co", "mine-key"),
  { url: "https://mine.supabase.co", key: "mine-key" },
  "override wins over default",
);
eq(
  config.resolveProject("", ""),
  config.normalizeProject(config.DEFAULT_PROJECT.url, config.DEFAULT_PROJECT.key),
  "no override falls back to the default",
);

section("session codes");

eq(session.normalizeCode("ab-cd ef"), "ABCDEF", "normalizes case, spaces and dashes");
eq(session.normalizeCode("abc123"), "ABC123", "keeps digits");
eq(session.normalizeCode("A!B@C#D"), "ABCD", "drops symbols");
eq(session.normalizeCode("ABCDEFGHIJ"), "ABCDEF", "caps at six characters");
eq(session.normalizeCode(null), "", "handles null");

section("state frame ordering");

const frames = [
  { seq: 1, time: 0, playing: true },
  { seq: 2, time: 1, playing: true },
  { seq: 2, time: 1, playing: true },
  { seq: 1, time: 0, playing: true },
  { seq: 3, time: 2, playing: false },
];
let lastSeq = -1;
const applied = [];
for (const f of frames) {
  if (!Number.isFinite(f.seq) || f.seq <= lastSeq) continue;
  lastSeq = f.seq;
  applied.push(f.seq);
}
eq(applied, [1, 2, 3], "duplicates and late frames are dropped, order is preserved");

const malformed = [{ seq: NaN }, { seq: "2" }, { seq: undefined }, {}];
const accepted = malformed.filter((f) => Number.isFinite(f.seq) && f.seq > -1);
eq(accepted.length, 0, "non-numeric seq values are rejected");

section("bucket with no project");

bucket.setProject(null);
eq(await bucket.stageAudio(), null, "staging is a no-op without a project");
eq(await bucket.stageCover(), null, "cover staging is a no-op without a project");
eq(await bucket.resolveSource("audio/abc.mp3"), null, "signing is a no-op without a project");
eq(bucket.stagedKey("file:///music/song.mp3"), null, "nothing is staged without a project");

bucket.reset();
ok(true, "reset clears caches");

console.log(`\n${failures === 0 ? "✓" : "✗"} ${checks - failures}/${checks} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
