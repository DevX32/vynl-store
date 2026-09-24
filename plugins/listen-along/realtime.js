/**
 * Minimal Supabase Realtime client (Phoenix channel protocol) over a raw
 * WebSocket.
 *
 * Only broadcast + join semantics are implemented — peer membership comes
 * from the `peers` table over REST, so presence tracking is not needed.
 * One socket serves every topic this plugin joins (session state + WebRTC
 * signaling).
 */

export class Realtime {
  constructor() {
    this.url = null;
    this.key = null;
    this.ws = null;
    this.ref = 0;
    this.stopped = false;
    this.retryMs = 0;
    this.hbTimer = null;
    /** channelName -> { status, ref, handlers: Map<event, Set<cb>>, onJoin, onError } */
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
      this.ws = null;
      this.failPending("socket closed");
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
    }, 20000);
  }

  stopHeartbeat() {
    if (this.hbTimer !== null) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
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

  joinTopic(name, state) {
    const ref = this.nextRef();
    state.ref = ref;
    const topic = `realtime:${name}`;
    this.expect(
      ref,
      () => {
        if (state.status === "joined") return;
        state.status = "joined";
        if (state.onJoin) state.onJoin();
      },
      (err) => {
        state.status = "error";
        if (state.onError) state.onError(err);
      },
      8000,
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
      if (!p) return;
      this.pending.delete(msg.ref);
      clearTimeout(p.timer);
      if (msg.payload?.status === "ok") {
        if (p.resolve) p.resolve(msg);
      } else if (p.reject) {
        p.reject(
          new Error(msg.payload?.response?.reason ?? "realtime join failed"),
        );
      }
      return;
    }

    const name = topic.startsWith("realtime:") ? topic.slice(9) : "";
    const state = this.topics.get(name);

    if (msg.event === "phx_error" || msg.event === "phx_close") {
      if (state) {
        // Topic-level failure: re-join shortly (socket itself is fine).
        state.status = "joining";
        setTimeout(() => {
          if (this.topics.get(name) === state) this.joinTopic(name, state);
        }, 1000);
      }
      return;
    }

    if (msg.event === "system" && msg.payload?.status === "error") {
      if (state) {
        state.status = "joining";
        setTimeout(() => {
          if (this.topics.get(name) === state) this.joinTopic(name, state);
        }, 1000);
      }
      return;
    }

    if (msg.event === "broadcast" && state) {
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
