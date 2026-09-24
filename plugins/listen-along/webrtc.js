/**
 * WebRTC data-channel sync (low-latency playback state + clock offset).
 *
 * Signaling rides the plugin's Realtime connection on a
 * `webrtc:<sessionId>` broadcast topic; state frames flow over an
 * unreliable/unordered data channel, with the Supabase broadcast/poll path
 * as the fallback when WebRTC can't connect.
 */

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const DATA_CHANNEL = "vynl-sync";
const PING_INTERVAL_MS = 500;
const HELLO_RETRY_MS = 2500;

export class WebrtcSync {
  constructor(realtime) {
    this.realtime = realtime;
    this.sessionId = null;
    this.myId = null;
    this.hostId = null;
    this.role = null;
    this.handlers = null;
    this.peers = new Map();
    this.pingTimer = null;
    this.helloTimer = null;
    this.clockOffsetMs = 0;
    this.offsetSamples = 0;
    this.destroyed = false;
  }

  get topic() {
    return this.sessionId ? `webrtc:${this.sessionId}` : null;
  }

  async startHost(sessionId, myId, handlers) {
    await this.reset();
    this.destroyed = false;
    this.sessionId = sessionId;
    this.myId = myId;
    this.hostId = myId;
    this.role = "host";
    this.handlers = handlers;
    await this.subscribeSignal();
  }

  async startJoiner(sessionId, myId, hostId, handlers) {
    await this.reset();
    this.destroyed = false;
    this.sessionId = sessionId;
    this.myId = myId;
    this.hostId = hostId;
    this.role = "joiner";
    this.handlers = handlers;
    await this.subscribeSignal();
    this.sendHello();
    this.helloTimer = setInterval(() => {
      if (!this.hasOpenChannel()) this.sendHello();
    }, HELLO_RETRY_MS);
    this.pingTimer = setInterval(() => this.sendPings(), PING_INTERVAL_MS);
  }

  broadcastState(state) {
    if (this.role !== "host") return;
    const raw = JSON.stringify({ type: "state", ...state });
    for (const slot of this.peers.values()) {
      if (slot.dc?.readyState === "open") {
        try {
          slot.dc.send(raw);
        } catch {
          /* channel closed under us */
        }
      }
    }
  }

  hasOpenChannel() {
    for (const slot of this.peers.values()) {
      if (slot.dc?.readyState === "open") return true;
    }
    return false;
  }

  getClockOffsetMs() {
    return this.clockOffsetMs;
  }

  async destroy() {
    this.destroyed = true;
    if (this.myId) {
      this.sendSignal({ kind: "bye", from: this.myId });
    }
    await this.reset();
  }

  async reset() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.helloTimer) {
      clearInterval(this.helloTimer);
      this.helloTimer = null;
    }
    for (const [id, slot] of [...this.peers]) {
      try {
        slot.dc?.close();
        slot.pc.close();
      } catch {
        /* already closed */
      }
      this.peers.delete(id);
    }
    if (this.sessionId) this.realtime.leave(this.topic);
    this.sessionId = null;
    this.myId = null;
    this.hostId = null;
    this.role = null;
    this.handlers = null;
    this.clockOffsetMs = 0;
    this.offsetSamples = 0;
  }

  async subscribeSignal() {
    if (!this.sessionId || !this.myId) return;
    const topic = this.topic;
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("webrtc signal timeout")), 8000),
    );
    // onSignal is async: a synchronous try/catch would not catch its
    // rejections, so own the promise here.
    const onMessage = (payload) => {
      void this.onSignal(payload).catch((e) => {
        console.warn("[listen-along] signal handling failed:", e);
      });
    };
    await Promise.race([this.realtime.join(topic, { signal: onMessage }), timer]);
  }

  sendSignal(payload) {
    if (!this.sessionId) return;
    this.realtime.broadcast(this.topic, "signal", payload);
  }

  sendHello() {
    if (!this.myId) return;
    this.sendSignal({ kind: "hello", from: this.myId });
  }

  async onSignal(msg) {
    if (this.destroyed || !this.myId || !msg) return;

    const isToUs = !("to" in msg) || msg.to === this.myId;
    const isFromUs = msg.from === this.myId;
    if (!isToUs || isFromUs) return;

    if (msg.kind === "bye") {
      this.closePeer(msg.from);
      return;
    }

    if (msg.kind === "hello") {
      if (this.role !== "host") return;
      await this.hostConnectTo(msg.from);
      return;
    }

    if (msg.kind === "offer" && this.role === "joiner") {
      if (this.hostId && msg.from !== this.hostId) {
        console.warn("[listen-along] ignoring offer from unknown peer:", msg.from);
        return;
      }
      await this.joinerHandleOffer(msg.from, msg.sdp);
    } else if (msg.kind === "answer" && this.role === "host") {
      const slot = this.peers.get(msg.from);
      if (!slot) return;
      try {
        await slot.pc.setRemoteDescription(msg.sdp);
      } catch (e) {
        console.warn("[listen-along] setRemoteDescription(answer) failed:", e);
      }
    } else if (msg.kind === "ice") {
      const slot = this.peers.get(msg.from);
      if (!slot || !msg.candidate) return;
      try {
        await slot.pc.addIceCandidate(msg.candidate);
      } catch (e) {
        console.warn("[listen-along] addIceCandidate failed:", e);
      }
    }
  }

  createPc(remoteId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const slot = { pc, dc: null };
    this.peers.set(remoteId, slot);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !this.myId) return;
      this.sendSignal({
        kind: "ice",
        from: this.myId,
        to: remoteId,
        candidate: ev.candidate.toJSON(),
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "closed") {
        this.closePeer(remoteId);
      } else if (state === "disconnected") {
        this.emitConnection();
      } else if (state === "connected") {
        this.emitConnection();
      }
    };

    return slot;
  }

  attachDc(remoteId, dc) {
    const slot = this.peers.get(remoteId);
    if (!slot) return;
    slot.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      this.emitConnection();
      if (this.role === "joiner") this.sendPings();
    };
    dc.onclose = () => this.emitConnection();
    dc.onmessage = (ev) => this.onDataMessage(remoteId, String(ev.data));
  }

  async hostConnectTo(joinerId) {
    if (!this.myId) return;
    let slot = this.peers.get(joinerId);
    if (slot?.dc?.readyState === "open") return;
    if (slot) this.closePeer(joinerId);

    slot = this.createPc(joinerId);
    const dc = slot.pc.createDataChannel(DATA_CHANNEL, {
      ordered: false,
      maxRetransmits: 0,
    });
    this.attachDc(joinerId, dc);

    try {
      const offer = await slot.pc.createOffer();
      await slot.pc.setLocalDescription(offer);
      this.sendSignal({
        kind: "offer",
        from: this.myId,
        to: joinerId,
        sdp: {
          type: slot.pc.localDescription.type,
          sdp: slot.pc.localDescription.sdp,
        },
      });
    } catch (e) {
      console.warn("[listen-along] host offer failed:", e);
      this.closePeer(joinerId);
    }
  }

  async joinerHandleOffer(hostId, sdp) {
    if (!this.myId) return;
    if (this.peers.has(hostId)) this.closePeer(hostId);

    const slot = this.createPc(hostId);
    slot.pc.ondatachannel = (ev) => {
      if (ev.channel.label === DATA_CHANNEL) {
        this.attachDc(hostId, ev.channel);
      }
    };

    try {
      await slot.pc.setRemoteDescription(sdp);
      const answer = await slot.pc.createAnswer();
      await slot.pc.setLocalDescription(answer);
      this.sendSignal({
        kind: "answer",
        from: this.myId,
        to: hostId,
        sdp: {
          type: slot.pc.localDescription.type,
          sdp: slot.pc.localDescription.sdp,
        },
      });
    } catch (e) {
      console.warn("[listen-along] joiner answer failed:", e);
      this.closePeer(hostId);
    }
  }

  closePeer(remoteId) {
    const slot = this.peers.get(remoteId);
    if (!slot) return;
    try {
      slot.dc?.close();
      slot.pc.close();
    } catch {
      /* already closed */
    }
    this.peers.delete(remoteId);
    this.emitConnection();
  }

  emitConnection() {
    if (this.handlers?.onConnectionChange) {
      this.handlers.onConnectionChange(this.hasOpenChannel());
    }
  }

  sendPings() {
    if (this.role !== "joiner") return;
    const raw = JSON.stringify({ type: "ping", t: Date.now() });
    for (const slot of this.peers.values()) {
      if (slot.dc?.readyState === "open") {
        try {
          slot.dc.send(raw);
        } catch {
          /* channel closed under us */
        }
      }
    }
  }

  onDataMessage(remoteId, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "ping" && this.role === "host") {
      const slot = this.peers.get(remoteId);
      if (slot?.dc?.readyState !== "open") return;
      try {
        slot.dc.send(JSON.stringify({ type: "pong", t: msg.t, serverNow: Date.now() }));
      } catch {
        /* channel closed under us */
      }
      return;
    }

    if (msg.type === "pong" && this.role === "joiner") {
      const t1 = msg.t;
      const t4 = Date.now();
      const t2 = msg.serverNow;
      const sample = (t2 - t1 - (t4 - t2)) / 2;
      this.offsetSamples += 1;
      const w = Math.min(this.offsetSamples, 8);
      this.clockOffsetMs = (this.clockOffsetMs * (w - 1) + sample) / w;
      return;
    }

    if (msg.type === "state" && this.role === "joiner") {
      this.handlers?.onState(msg, this.clockOffsetMs);
    }
  }
}
