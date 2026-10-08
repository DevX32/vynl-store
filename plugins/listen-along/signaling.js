const JOIN_TIMEOUT_MS = 8000;
const JOIN_RETRY_MS = 3000;
const RETRY_SWEEP_MS = 4000;
const HEARTBEAT_MS = 20000;
const MAX_RECONNECT_MS = 10000;

export class RealtimeSignaling {
  constructor(project) {
    this.project = project;
    this.ws = null;
    this.topic = null;
    this.ref = 0;
    this.joinRef = null;
    this.joined = false;
    this.closed = false;
    this.retryMs = 0;
    this.retryTimer = null;
    this.hbTimer = null;
    this.sweepTimer = null;
    this.lastJoinAt = 0;
    this.handler = () => {};
    this.pending = new Map();
  }

  connect() {
    if (this.closed) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;

    const { url, key } = this.project;
    const wsUrl =
      url.replace(/\/+$/, "").replace(/^http/, "ws") +
      "/realtime/v1/websocket?apikey=" +
      encodeURIComponent(key) +
      "&vsn=1.0.0";

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = 0;
      this.sendFrame({ topic: "phoenix", event: "heartbeat", ref: this.nextRef(), payload: {} });
      this.startHeartbeat();
      this.startSweep();
      if (this.topic) this.joinTopic(this.topic);
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
      this.joined = false;
      this.joinRef = null;
      this.failPending("signaling socket closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  scheduleReconnect() {
    if (this.closed || this.retryTimer !== null) return;
    this.retryMs = this.retryMs === 0 ? 1000 : Math.min(this.retryMs * 2, MAX_RECONNECT_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryMs);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      this.sendFrame({ topic: "phoenix", event: "heartbeat", ref: this.nextRef(), payload: {} });
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.hbTimer !== null) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  startSweep() {
    this.stopSweep();
    this.sweepTimer = setInterval(() => {
      if (this.closed || !this.topic) return;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (!this.joined && Date.now() - this.lastJoinAt > JOIN_RETRY_MS) {
          this.joinTopic(this.topic);
        }
      } else if (!this.ws) {
        this.connect();
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

  sendFrame(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {}
  }

  expect(ref, resolve, reject, timeoutMs = JOIN_TIMEOUT_MS) {
    const timer = setTimeout(() => {
      this.pending.delete(ref);
      reject(new Error("signaling timed out"));
    }, timeoutMs);
    this.pending.set(ref, { resolve, reject, timer });
  }

  failPending(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  joinTopic(topic) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const ref = this.nextRef();
    this.joinRef = ref;
    this.lastJoinAt = Date.now();
    this.expect(
      ref,
      () => {
        this.joined = true;
      },
      () => {
        this.joined = false;
      },
    );
    this.sendFrame({
      topic: `realtime:${topic}`,
      event: "phx_join",
      ref,
      join_ref: ref,
      payload: {
        access_token: this.project.key,
        config: { broadcast: { self: false }, presence: { key: "la-signal" } },
      },
    });
  }

  onMessage(fn) {
    this.handler = fn;
  }

  async join(topic) {
    this.topic = topic;
    this.connect();
    if (!this.ws) throw new Error("Could not open a signaling socket");
    this.joinTopic(topic);
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (this.joined) {
          clearInterval(poll);
          resolve();
        } else if (this.closed || Date.now() - started > JOIN_TIMEOUT_MS) {
          clearInterval(poll);
          reject(new Error("Could not reach the signaling server"));
        }
      }, 150);
    });
  }

  send(msg) {
    if (!this.joined || !this.joinRef) return;
    this.sendFrame({
      topic: `realtime:${this.topic}`,
      event: "broadcast",
      ref: this.nextRef(),
      join_ref: this.joinRef,
      payload: { type: "broadcast", event: "la-signal", payload: msg },
    });
  }

  handle(msg) {
    if ((msg.topic ?? "") === "phoenix") return;

    if (msg.event === "phx_reply") {
      const p = this.pending.get(msg.ref);
      if (p) {
        this.pending.delete(msg.ref);
        clearTimeout(p.timer);
        if (msg.payload?.status === "ok") p.resolve();
        else p.reject(new Error(msg.payload?.response?.reason ?? "Signaling was rejected"));
        return;
      }
      if (msg.payload?.status === "ok" && msg.ref === this.joinRef) this.joined = true;
      return;
    }

    const wanted = `realtime:${this.topic}`;
    if ((msg.topic ?? "") !== wanted) return;

    if (msg.event === "phx_close" || msg.event === "phx_error") {
      this.joined = false;
      this.joinTopic(this.topic);
      return;
    }

    if (msg.event === "broadcast" && this.joined) {
      try {
        this.handler(msg.payload?.payload);
      } catch (e) {
        console.warn("[listen-along] signaling handler failed:", e);
      }
    }
  }

  close() {
    this.closed = true;
    this.stopHeartbeat();
    this.stopSweep();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.failPending("closed");
    if (this.topic && this.joinRef) {
      this.sendFrame({
        topic: `realtime:${this.topic}`,
        event: "phx_leave",
        ref: this.nextRef(),
        join_ref: this.joinRef,
        payload: {},
      });
    }
    this.topic = null;
    this.joinRef = null;
    this.joined = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

export class ManualSignaling {
  onMessage(fn) {
    this.handler = fn;
  }

  async join() {}

  send() {}

  receive(msg) {
    try {
      this.handler(msg);
    } catch (e) {
      console.warn("[listen-along] signaling handler failed:", e);
    }
  }

  close() {}
}

export function createSignaling(project) {
  return project ? new RealtimeSignaling(project) : new ManualSignaling();
}
