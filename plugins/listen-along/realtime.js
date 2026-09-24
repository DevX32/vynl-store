/**
 * Minimal Supabase Realtime client (Phoenix channel protocol) over a raw
 * WebSocket.
 *
 * Only broadcast + join semantics are implemented — peer membership comes
 * from the `peers` table over REST, so presence tracking is not needed.
 * One socket serves every topic this plugin joins (session state + WebRTC
 * signaling).
 *
 * Robustness notes (learned the hard way against the live service):
 *   - Join acks can arrive after the ack timeout; a late ack still counts.
 *   - A closed socket invalidates every join_ref, so topics go back to
 *     "joining" immediately and broadcasts are held back until re-acked.
 *   - Anything that isn't "joined" is retried on a timer, so sync recovers
 *     on its own from dropped connections or rejected joins.
 */

const JOIN_ACK_TIMEOUT_MS = 8000;
const JOIN_RETRY_MS = 3000;
const RETRY_SWEEP_MS = 4000;
const HEARTBEAT_MS = 20000;

export class Realtime {
  constructor() {
    this.url = null;
    this.key = null;
    this.ws = null;
    this.ref = 0;
    this.stopped = false;
    this.retryMs = 0;
    this.hbTimer = null;
    this.sweepTimer = null;
    /** channelName -> { status, ref, lastJoinAt, handlers, onJoin, onError } */
    this.topics = new Map();
    /** ref -> { resolve, reject, timer } */
    this.pending = new Map();
    this.presenceKey =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `p${Math.random().toString(36).slice(2)}`;
  }

  open(url, key) {
    this.url =
      url.replace(/\/+$/, "").replace(/^http/, "ws") +
      "/realtime/v1/websocket?apikey=" +
      encodeURIComponent(key) +
      "&vsn=1.0.0";
    this.key = key;
    this.stopped = false;
    this.retryMs = 0;
    this.connect();
  }

  connect() {
    if (this.stopped || !this.url) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 0;
      this.send({ topic: "phoenix", event: "heartbeat", ref: this.nextRef(), payload: {} });
      this.startHeartbeat();
      this.startSweep();
      for (const [name, state] of this.topics) this.joinTopic(name, state);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      this.stopSweep();
      this.ws = null;
      this.failPending("socket closed");
      // Every join_ref died with the socket: hold broadcasts until re-acked.
      for (const state of this.topics.values()) {
        state.status = "joining";
        state.ref = null;
      }
      this.scheduleRetry();
    };
    ws.onerror = () => {};
  }

  scheduleRetry() {
    if (this.stopped) return;
    this.retryMs = this.retryMs === 0 ? 1000 : Math.min(this.retryMs * 2, 10000);
    setTimeout(() => this.connect(), this.retryMs);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      const ref = this.nextRef();
      this.expect(ref, null, null, 10000);
      this.send({ topic: "phoenix", event: "heartbeat", ref, payload: {} });
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.hbTimer !== null) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  /** Re-join anything that isn't healthy — the self-healing safety net. */
  startSweep() {
    this.stopSweep();
    this.sweepTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      const now = Date.now();
      for (const [name, state] of this.topics) {
        if (state.status === "joined") continue;
        if (now - (state.lastJoinAt ?? 0) < JOIN_RETRY_MS) continue;
        this.joinTopic(name, state);
      }
    }, RETRY_SWEEP_MS);
  }

  stopSweep() {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  nextRef() {
    this.ref += 1;
    return String(this.ref);
  }

  send(frame) {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(frame));
      } catch {
        /* socket died; onclose handles recovery */
      }
    }
  }

  expect(ref, resolve, reject, timeoutMs) {
    const timer = setTimeout(() => {
      this.pending.delete(ref);
      if (reject) reject(new Error("realtime timeout"));
    }, timeoutMs);
    this.pending.set(ref, { resolve, reject, timer });
  }

  failPending(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.reject) p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  markJoined(state) {
    if (state.status === "joined") return;
    state.status = "joined";
    if (state.onJoin) state.onJoin();
  }

  joinTopic(name, state) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const ref = this.nextRef();
    state.ref = ref;
    state.lastJoinAt = Date.now();
    const topic = `realtime:${name}`;
    this.expect(
      ref,
      () => this.markJoined(state),
      (err) => {
        state.status = "error";
        if (state.onError) state.onError(err);
      },
      JOIN_ACK_TIMEOUT_MS,
    );
    this.send({
      topic,
      event: "phx_join",
      ref,
      join_ref: ref,
      payload: {
        access_token: this.key,
        config: {
          broadcast: { self: false },
          presence: { key: this.presenceKey },
        },
      },
    });
  }

  /** Join a channel and resolve once the server acks the join. */
  join(name, handlers = {}) {
    const state = {
      status: "joining",
      ref: null,
      lastJoinAt: 0,
      handlers: new Map(Object.entries(handlers).map(([k, cb]) => [k, new Set([cb])])),
      onJoin: null,
      onError: null,
    };
    this.topics.set(name, state);
    return new Promise((resolve, reject) => {
      state.onJoin = resolve;
      state.onError = reject;
      this.joinTopic(name, state);
    });
  }

  leave(name) {
    const state = this.topics.get(name);
    if (!state) return;
    this.topics.delete(name);
    if (state.ref) {
      this.send({
        topic: `realtime:${name}`,
        event: "phx_leave",
        ref: this.nextRef(),
        join_ref: state.ref,
        payload: {},
      });
    }
  }

  broadcast(name, event, payload) {
    const state = this.topics.get(name);
    if (!state || state.status !== "joined" || !state.ref) return;
    this.send({
      topic: `realtime:${name}`,
      event: "broadcast",
      ref: this.nextRef(),
      join_ref: state.ref,
      payload: { type: "broadcast", event, payload },
    });
  }

  handle(msg) {
    const topic = msg.topic ?? "";
    if (topic === "phoenix") return; // heartbeat replies

    if (msg.event === "phx_reply") {
      const p = this.pending.get(msg.ref);
      if (p) {
        this.pending.delete(msg.ref);
        clearTimeout(p.timer);
        if (msg.payload?.status === "ok") {
          if (p.resolve) p.resolve(msg);
        } else if (p.reject) {
          p.reject(new Error(msg.payload?.response?.reason ?? "realtime join failed"));
        }
        return;
      }
      // Ack for a ref whose timeout already fired (or that raced the
      // timeout): still healthy — the topic is usable.
      for (const state of this.topics.values()) {
        if (state.ref === msg.ref && msg.payload?.status === "ok") {
          this.markJoined(state);
          return;
        }
      }
      return;
    }

    const name = topic.startsWith("realtime:") ? topic.slice(9) : "";
    const state = this.topics.get(name);

    if (msg.event === "phx_error" || msg.event === "phx_close") {
      if (state) {
        state.status = "joining";
        state.lastJoinAt = 0; // re-join on the next sweep tick
      }
      return;
    }

    if (msg.event === "system" && msg.payload?.status === "error" && state) {
      state.status = "joining";
      state.lastJoinAt = 0;
      return;
    }

    if (msg.event === "broadcast" && state && state.status === "joined") {
      const event = msg.payload?.event;
      const cbs = state.handlers.get(event);
      if (cbs) {
        for (const cb of cbs) {
          try {
            cb(msg.payload?.payload);
          } catch (e) {
            console.warn("[listen-along] realtime handler failed:", e);
          }
        }
      }
    }
  }

  close() {
    this.stopped = true;
    this.stopHeartbeat();
    this.stopSweep();
    this.topics.clear();
    this.failPending("closed");
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
  }
}
