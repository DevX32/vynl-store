const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const DATA_CHANNEL = "vynl-listen-along";
const SIGNAL_CONFIG = { ordered: true };
const STATE_CONFIG = { ordered: false, maxRetransmits: 0 };

const PING_INTERVAL_MS = 1000;
const CLOCK_SAMPLES_MAX = 8;

export class HostTransport {
  constructor(signaling) {
    this.signaling = signaling;
    this.peers = new Map();
    this.seq = 0;
    this.handlers = { onPeerChange: () => {}, onPeerOpen: () => {}, onNeedAudio: () => {} };
    this.destroyed = false;
    this.myId = null;
  }

  get peerCount() {
    return this.peers.size;
  }

  setHandlers(handlers) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  start(myId) {
    this.myId = myId;
    this.signaling.onMessage((msg) => this.onSignal(msg));
    this.signaling.send({ kind: "host-ready", from: myId });
  }

  onSignal(msg) {
    if (this.destroyed || !this.myId || !msg) return;
    if (msg.from === this.myId) return;
    if (msg.to && msg.to !== this.myId) return;
    if (msg.kind === "hello") {
      void this.offerTo(msg.from);
    }
  }

  async offerTo(joinerId) {
    if (this.destroyed || !this.myId) return;

    const existing = this.peers.get(joinerId);
    if (existing?.dc?.readyState === "open") return;
    if (existing?.pc && existing.pc.connectionState !== "failed" && existing.pc.connectionState !== "closed") {
      if (existing.pc.signalingState === "have-local-offer") return;
    }
    if (existing) this.dropPeer(joinerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const slot = { pc, dc: null };
    this.peers.set(joinerId, slot);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !this.myId) return;
      this.signaling.send({
        kind: "ice",
        from: this.myId,
        to: joinerId,
        candidate: ev.candidate.toJSON(),
      });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "closed") this.dropPeer(joinerId);
      else if (s === "disconnected" || s === "connected") this.emitPeerChange();
    };

    const signalDc = pc.createDataChannel(`${DATA_CHANNEL}-signal`, SIGNAL_CONFIG);
    const stateDc = pc.createDataChannel(DATA_CHANNEL, STATE_CONFIG);
    this.wireChannel(slot, stateDc, joinerId);
    void signalDc;

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.send({
        kind: "offer",
        from: this.myId,
        to: joinerId,
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      });
    } catch (e) {
      console.warn("[listen-along] offer failed:", e);
      this.dropPeer(joinerId);
    }
  }

  wireChannel(slot, dc, peerId) {
    slot.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      this.emitPeerChange();
      this.handlers.onPeerOpen(peerId);
    };
    dc.onclose = () => this.emitPeerChange();
    dc.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg?.type === "need-audio") {
        this.handlers.onNeedAudio(msg);
        return;
      }
      if (msg?.type === "ping" && msg.responder && dc.readyState === "open") {
        try {
          dc.send(JSON.stringify({ type: "pong", t: msg.t, serverNow: Date.now() }));
        } catch {}
      }
    };
  }

  publish(state) {
    if (this.destroyed || this.peers.size === 0) return;
    this.seq += 1;
    const frame = JSON.stringify({ type: "state", seq: this.seq, ...state });
    for (const slot of this.peers.values()) {
      if (slot.dc?.readyState !== "open") continue;
      try {
        slot.dc.send(frame);
      } catch {}
    }
  }

  emitPeerChange() {
    this.handlers.onPeerChange(this.peers.size);
  }

  dropPeer(id) {
    const slot = this.peers.get(id);
    if (!slot) return;
    try {
      slot.dc?.close();
      slot.pc.close();
    } catch {}
    this.peers.delete(id);
    this.emitPeerChange();
  }

  destroy() {
    this.destroyed = true;
    if (this.myId) this.signaling.send({ kind: "bye", from: this.myId });
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
  }
}

export class JoinerTransport {
  constructor(signaling) {
    this.signaling = signaling;
    this.myId = null;
    this.hostId = null;
    this.pc = null;
    this.dc = null;
    this.open = false;
    this.destroyed = false;
    this.lastSeq = -1;
    this.clockOffsetMs = 0;
    this.clockSamples = 0;
    this.helloTimer = null;
    this.pingTimer = null;
    this.pendingIce = [];
    this.handlers = { onState: () => {}, onOpen: () => {}, onClose: () => {} };
  }

  setHandlers(handlers) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  start(myId) {
    this.myId = myId;
    this.signaling.onMessage((msg) => this.onSignal(msg));
    this.sayHello();
    this.helloTimer = setInterval(() => {
      if (!this.open && !this.destroyed) this.sayHello();
    }, 2000);
  }

  sayHello() {
    if (!this.myId) return;
    this.signaling.send({ kind: "hello", from: this.myId });
  }

  onSignal(msg) {
    if (this.destroyed || !this.myId || !msg) return;
    if (msg.from === this.myId) return;
    if (msg.to && msg.to !== this.myId) return;

    if (msg.kind === "host-ready") {
      if (!this.open) this.sayHello();
      return;
    }

    if (msg.kind === "bye") {
      if (msg.from === this.hostId) this.markClosed();
      return;
    }

    if (msg.kind === "offer") {
      if (this.open) return;
      if (this.hostId && msg.from !== this.hostId) return;
      this.hostId = msg.from;
      void this.answer(msg.sdp);
      return;
    }

    if (msg.kind === "ice") {
      if (!msg.candidate) return;
      if (this.hostId && msg.from !== this.hostId) return;
      if (!this.pc) {
        this.pendingIce.push(msg.candidate);
        return;
      }
      this.pc.addIceCandidate(msg.candidate).catch(() => {});
    }
  }

  async answer(sdp) {
    if (this.destroyed || !sdp) return;
    this.teardownPc();

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !this.myId) return;
      this.signaling.send({
        kind: "ice",
        from: this.myId,
        to: this.hostId,
        candidate: ev.candidate.toJSON(),
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.markClosed();
      }
    };
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === DATA_CHANNEL) this.attach(ev.channel);
      else if (ev.channel.label === `${DATA_CHANNEL}-signal`) ev.channel.close();
    };

    try {
      await pc.setRemoteDescription(sdp);
      for (const candidate of this.pendingIce.splice(0)) {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.send({
        kind: "answer",
        from: this.myId,
        to: this.hostId,
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      });
    } catch (e) {
      console.warn("[listen-along] answer failed:", e);
    }
  }

  attach(dc) {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      this.open = true;
      this.stopTimers();
      this.handlers.onOpen();
      this.startPings();
    };
    dc.onclose = () => this.markClosed();
    dc.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.onFrame(msg);
    };
  }

  onFrame(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "pong") {
      this.absorbPong(msg);
      return;
    }
    if (msg.type !== "state") return;
    if (!Number.isFinite(msg.seq) || msg.seq <= this.lastSeq) return;
    this.lastSeq = msg.seq;
    this.handlers.onState(msg, this.clockOffsetMs);
  }

  startPings() {
    this.stopTimers();
    this.pingTimer = setInterval(() => this.sendPings(), PING_INTERVAL_MS);
  }

  sendPings() {
    if (this.dc?.readyState !== "open") return;
    try {
      this.dc.send(JSON.stringify({ type: "ping", t: Date.now(), responder: true }));
    } catch {}
  }

  absorbPong(msg) {
    if (!Number.isFinite(msg.t) || !Number.isFinite(msg.serverNow)) return;
    const t4 = Date.now();
    const sample = (msg.serverNow - msg.t - (t4 - msg.serverNow)) / 2;
    this.clockSamples += 1;
    const w = Math.min(this.clockSamples, CLOCK_SAMPLES_MAX);
    this.clockOffsetMs = (this.clockOffsetMs * (w - 1) + sample) / w;
  }

  requestAudio(trackKey) {
    if (this.dc?.readyState !== "open") return;
    try {
      this.dc.send(JSON.stringify({ type: "need-audio", trackKey }));
    } catch {}
  }

  markClosed() {
    const wasOpen = this.open;
    this.open = false;
    this.stopTimers();
    if (wasOpen) this.handlers.onClose();
  }

  stopTimers() {
    if (this.helloTimer !== null) {
      clearInterval(this.helloTimer);
      this.helloTimer = null;
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  teardownPc() {
    this.stopTimers();
    if (this.dc) {
      try {
        this.dc.close();
      } catch {}
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }
    this.open = false;
    this.pendingIce.length = 0;
  }

  destroy() {
    this.destroyed = true;
    if (this.myId && this.hostId) {
      this.signaling.send({ kind: "bye", from: this.myId, to: this.hostId });
    }
    this.teardownPc();
    this.hostId = null;
    this.lastSeq = -1;
    this.clockOffsetMs = 0;
    this.clockSamples = 0;
  }
}
