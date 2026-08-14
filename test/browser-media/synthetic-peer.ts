/**
 * The controllable synthetic peer-connection endpoint for the v0.5 real-browser
 * WebRTC audio gate. Runs INSIDE the page, alongside the library's real
 * `WebRtcMediaManager` session, and owns exactly ONE real `RTCPeerConnection`
 * plus an `AudioContext -> OscillatorNode -> MediaStreamAudioDestinationNode`
 * synthetic audio source that emits real audio (a distinct frequency per
 * direction) with no human microphone.
 *
 * This module is written in plain-JS syntax (types live in JSDoc) so the page
 * can `import { ... } from "/synthetic-peer.js"` and execute it directly — the
 * alternative (TypeScript) would need a browser-side build step that would
 * violate the *built/packed only* server contract. Everything here is real
 * WebRTC: there are no fakes in this file.
 */

/**
 * Create an always-emitting synthetic audio source at a given fundamental
 * frequency. Returns the MediaStream (fed from an oscillator) and a `stop`
 * that fully releases the AudioContext.
 *
 * @param {number} freqHz
 * @returns {{ stream: MediaStream, stop: () => void }}
 */
export function makeSyntheticSource(freqHz) {
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const osc = ac.createOscillator();
  osc.frequency.value = freqHz;
  osc.connect(dest);
  osc.start();
  return { stream: dest.stream, stop: () => { try { ac.close(); } catch {} } };
}

/**
 * Non-zero synthetic energy over a MediaStream, measured via an AnalyserNode.
 * A stream that actually carries decoded RTP audio (not silence) reports a
 * positive peak. `ok` is true only when a positive peak was observed by a
 * supporting engine; engines without a stable AudioContext analysis admit it
 * via `reason`.
 *
 * @param {MediaStream} stream
 * @param {number} sampleMs
 * @returns {Promise<{ ok: boolean, peak: number, reason?: string }>}
 */
export function measureEnergy(stream, sampleMs = 600) {
  return new Promise((resolve) => {
    let ac;
    try { ac = new AudioContext(); } catch {
      resolve({ ok: false, peak: 0, reason: 'no-audio-context' });
      return;
    }
    // Headless engines start the context suspended; without a running context
    // the analyser reports pure silence even while RTP flows. User-gesture
    // suppression is not relied on here — we resume explicitly.
    const resume = () => {
      if (!ac || ac.state === 'running') return;
      try { return ac.resume(); } catch {}
    };
    resume();
    const src = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let peak = 0, samples = 0;
    let suspendedCount = 0;
    const step = () => {
      if (ac && ac.state !== 'running') {
        resume();
        suspendedCount += 1;
        if (suspendedCount < 3) { setTimeout(step, 50); return; }
      }
      analyser.getByteFrequencyData(data);
      let max = 0;
      for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
      if (max > peak) peak = max;
      samples += 1;
      if (samples * 50 >= sampleMs) {
        try { src.disconnect(); } catch {}
        try { ac.close(); } catch {}
        let reason;
        if (peak <= 0) {
          // Silence with a running context: on Chromium headless-shell the
          // WebRTC audio pipeline decodes into a null/discarded sink, so the
          // analyser reads 0 even though RTP bytes are demonstrably flowing
          // (the gate's RTP assertions prove that independently). Name the real
          // cause rather than a generic suspended-context.
          const isChromium = navigator?.userAgent?.includes('Chrome') && !navigator.userAgent.includes('Edg') && !navigator.userAgent.includes('Firefox');
          reason = isChromium ? 'null-audio-decode-sink' : (ac && ac.state !== 'running' ? 'suspended-context' : 'silent-decode');
        } else if (ac && ac.state !== 'running') {
          reason = 'suspended-context';
        }
        resolve({
          ok: peak > 0,
          peak,
          ...(reason ? { reason } : {}),
        });
      } else setTimeout(step, 50);
    };
    step();
  });
}

/**
 * The controllable remote endpoint: owns ONE RTCPeerConnection and its
 * oscillator audio source. Supports both roles (it can answer the library's
 * offer, or create its own offer the library answers), always using complete
 * non-trickle SDP, and exposes getStats-derived media assertions.
 */
export class SyntheticPeer {
  /**
   * @param {{ iceServers?: RTCIceServer[], iceTransportPolicy?: RTCIceTransportPolicy, freqHz?: number, register?(pc: RTCPeerConnection): void }} opts
   */
  constructor(opts = {}) {
    const cfg = {};
    if (opts.iceServers && opts.iceServers.length) cfg.iceServers = opts.iceServers;
    else cfg.iceServers = [];
    // Forced-relay peers (the TURN gate) must apply the same transport policy as
    // the library so BOTH endpoints only consider relay candidates.
    if (opts.iceTransportPolicy) cfg.iceTransportPolicy = opts.iceTransportPolicy;
    this.pc = new RTCPeerConnection(cfg);
    if (opts.register) opts.register(this.pc);
    this.source = makeSyntheticSource(opts.freqHz ?? 880);
    for (const track of this.source.stream.getTracks()) {
      this.pc.addTrack(track, this.source.stream);
    }
  }

  /** Apply the library's offer and produce a complete answer (non-trickle). */
  async answerOffer(offerSdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.gather();
    return this.pc.localDescription.sdp;
  }

  /** Create a complete offer (non-trickle) for the library to answer. */
  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.gather();
    return this.pc.localDescription.sdp;
  }

  /** Resolve once this peer's ICE gathering has completed (complete SDP). */
  async gather(timeoutMs = 15000) {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pc.onicegatheringstatechange = null;
        reject(new Error(`synthetic peer gathering timed out (${this.pc.iceGatheringState})`));
      }, timeoutMs);
      this.pc.onicegatheringstatechange = () => {
        if (this.pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  /** Apply the library's answer. */
  async applyAnswer(answerSdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /** Number of remote audio tracks this peer received. */
  remoteAudioTracks() {
    return this.pc.getReceivers().filter((r) => r.track && r.track.kind === 'audio').length;
  }

  /** A new MediaStream from this peer's remote audio receivers. */
  remoteAudioStream() {
    return new MediaStream(
      this.pc.getReceivers().map((r) => r.track).filter((t) => t && t.kind === 'audio'),
    );
  }

  /** ICE / connection state snapshot. */
  state() {
    return {
      connectionState: this.pc.connectionState,
      iceConnectionState: this.pc.iceConnectionState,
      iceGatheringState: this.pc.iceGatheringState,
    };
  }

  close() {
    try { this.pc.close(); } catch {}
    this.source.stop();
  }
}
