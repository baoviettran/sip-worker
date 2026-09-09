// test/freeswitch-matrix/audio.spec.ts — matrix step 4: the outgoing-call
// two-way audio proof.
//
// Procedure: register → createCall('sip:9196@127.0.0.1') → established → send
// 1 s of digital silence (page gate), read the partial record_session WAV
// node-side and record its RMS as the per-run silence floor
// (`floor = max(floorRms, 0.01)`) → open the gate → the page raises the 440 Hz
// tone, lets ≥2 s of RTP flow, samples AnalyserNode energy on the remote
// stream, and checks getStats packet growth both ways → finish-call hangs up
// (flushing the recorder) → the node reads the single /recordings WAV and
// computes maxWindowedRms. Assert: page energy above the floor AND
// recordingRms above the floor AND rtpBothWays true.
//
// The step contract `{ ok, detail, energy, rtpBothWays, recordingRms }` is
// realized across the two steps: `outgoing-audio` carries energy/rtpBothWays
// in its MatrixResult, `finish-call` flushes the recorder, and recordingRms is
// computed HERE (node side — the page cannot read the WAV).
import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { bootMatrix, disposeMatrix, runStep } from './helpers';
import { getRecordings, type FsHandle } from './fsctl';
import { maxWindowedRms, parseRiffWav, readWavPcm16 } from './rms';

const CREDENTIALS = { user: '1000', password: 'matrix-pass-2026' };

/** The page's floor-calibration gate (set by the outgoing-audio step). */
interface FloorGateWindow {
  __matrixAwaitFloor?: boolean;
  __matrixGoTone?: boolean;
}

interface RtpCounters {
  packets: number;
  bytes: number;
}

interface AudioStepResult {
  energy: number;
  rtpBothWays: boolean;
  rtp: { ok: boolean; baseline: { inbound: RtpCounters; outbound: RtpCounters }; inbound: RtpCounters; outbound: RtpCounters };
  callState: string;
  remoteTracks: number;
}

/**
 * RMS of a possibly still-open recording. libsndfile may leave the data-chunk
 * header length stale while record_session is mid-call, so the strict parse
 * runs first and a data-through-EOF fallback rescues a zero/short declared
 * length. Null = no usable floor from the WAV yet (the caller then relies on
 * the 0.01 baseline, which a silent final recording still fails).
 */
function wavRmsLenient(bytes: Uint8Array): number | null {
  try {
    const { pcm, sampleRate } = parseRiffWav(bytes);
    if (pcm.length < sampleRate / 10) return null; // <100 ms: no usable floor yet
    return maxWindowedRms(pcm, 20, sampleRate);
  } catch {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n));
    if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return null;
    let off = 12;
    let sampleRate = 0;
    while (off + 8 <= bytes.byteLength) {
      const id = ascii(off, 4);
      const size = dv.getUint32(off + 4, true);
      if (id === 'fmt ') sampleRate = dv.getUint32(off + 12, true);
      if (id === 'data') {
        const pcm = readWavPcm16(bytes.subarray(off + 8));
        if (pcm.length < sampleRate / 10) return null;
        return maxWindowedRms(pcm, 20, sampleRate || 8000);
      }
      off += 8 + size + (size % 2);
    }
    return null;
  }
}

/**
 * Node-side silence floor from the partial recording. Recording names are
 * uuid-based and NOT mtime-ordered, and there is at most one WAV (one
 * container per test, one call per test) — never pick "newest".
 */
function readRecordingFloor(handle: FsHandle): { rms: number | null; path: string | null; bytes: number } {
  const recs = getRecordings(handle);
  if (recs.length === 0) return { rms: null, path: null, bytes: 0 };
  const bytes = new Uint8Array(readFileSync(recs[0]));
  return { rms: wavRmsLenient(bytes), path: recs[0], bytes: bytes.byteLength };
}

/**
 * Seed the DTLS-SRTP certificate FreeSWITCH needs to answer WebRTC offers.
 * FreeSWITCH looks for `<certs_dir>/dtls-srtp.pem` (this image: /etc/freeswitch
 * /tls, alongside the harness-minted wss.pem) and generates one on first use —
 * but /etc/freeswitch is mounted READ-ONLY, so generation always fails with
 * "FP FILE ERR" and the INVITE is answered 488. The runtimeDir is writable from
 * the host (the ro flag only binds the container view), and FreeSWITCH re-reads
 * the pem per call, so seeding a copy of wss.pem here fixes the answer without
 * touching the committed harness.
 */
function ensureDtlsPem(handle: FsHandle): string {
  const tlsDir = join(handle.runtimeDir, 'tls');
  const dtlsPem = join(tlsDir, 'dtls-srtp.pem');
  if (!existsSync(dtlsPem)) {
    copyFileSync(join(tlsDir, 'wss.pem'), dtlsPem);
  }
  return dtlsPem;
}

/**
 * Minimal RFC 5389 STUN server on loopback: replies to Binding Requests with
 * XOR-MAPPED-ADDRESS = 127.0.0.1:<source port>. Fed to the page as an
 * iceServer, this makes Chromium gather an srflx 127.0.0.1 candidate — srflx
 * candidates are not mDNS-obfuscated and loopback passes the FreeSWITCH
 * wan.auto candidate ACL, unlike the *.local host candidates Chromium offers
 * by default (which caused the 488 "no suitable candidates found").
 */
function startStunResponder(): Promise<{ port: number; close: () => Promise<void> }> {
  const socket: Socket = createSocket('udp4');
  socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    // Binding Request: type 0x0001, then length, magic cookie, 12-byte txn id.
    if (msg.length < 20 || msg[0] !== 0x00 || msg[1] !== 0x01) return;
    const res = Buffer.alloc(32);
    res[0] = 0x01;
    res[1] = 0x01; // Binding Response
    res[2] = 0x00;
    res[3] = 0x0c; // message length: one 12-byte attribute
    msg.copy(res, 4, 4, 20); // magic cookie + transaction id, verbatim
    // XOR-MAPPED-ADDRESS (0x0020), value: reserved, family IPv4, x-port, x-addr.
    res[20] = 0x00;
    res[21] = 0x20;
    res[22] = 0x00;
    res[23] = 0x08;
    res[24] = 0x00; // reserved
    res[25] = 0x01; // IPv4
    const xport = rinfo.port ^ 0x2112;
    res[26] = (xport >> 8) & 0xff;
    res[27] = xport & 0xff;
    res.writeUInt32BE((0x7f000001 ^ 0x2112a442) >>> 0, 28);
    socket.send(res, rinfo.port, rinfo.address);
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.removeListener('error', reject);
      resolve({
        port: (socket.address() as { port: number }).port,
        close: () =>
          new Promise<void>((res) => {
            socket.once('close', () => res());
            socket.close();
          }),
      });
    });
  });
}

test.describe('matrix · outgoing call two-way audio', () => {
  test('outgoing-audio: tone reaches FreeSWITCH (WAV RMS) and echo returns (page energy)', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      // The DTLS pem must exist before the INVITE (FreeSWITCH re-reads it per
      // call, but seeding up front removes the order dependence entirely).
      ensureDtlsPem(ctx.handle);
      // register → dial 9196 → established → 1 s of silence → gate open. The
      // step promise is awaited only AFTER the node-side floor is calibrated,
      // so the page parks in its gate while we read the partial WAV.
      const args = { ...CREDENTIALS, stunPort: stun.port };
      const stepPromise = runStep(page, 'outgoing-audio', args);
      await page.waitForFunction(
        () => (window as unknown as FloorGateWindow).__matrixAwaitFloor === true,
        undefined,
        { timeout: 120_000 },
      );
      const floorRead = readRecordingFloor(ctx.handle);
      const floor = Math.max(floorRead.rms ?? 0, 0.01);
      await page.evaluate(() => {
        (window as unknown as FloorGateWindow).__matrixGoTone = true;
      });

      const r = await stepPromise;
      expect(r.ok, r.detail).toBe(true);
      const audio = r.result as AudioStepResult;
      expect(audio.callState).toBe('established');
      expect(audio.remoteTracks).toBeGreaterThan(0);
      expect(audio.rtpBothWays, `rtp counters ${JSON.stringify(audio.rtp)}`).toBe(true);
      expect(
        audio.energy,
        `page energy ${audio.energy.toFixed(4)} vs floor ${floor.toFixed(4)} (silence rms ${floorRead.rms})`,
      ).toBeGreaterThan(floor);

      // hang up → record_session flushes the WAV
      const fin = await runStep(page, 'finish-call', CREDENTIALS);
      expect(fin.ok, fin.detail).toBe(true);
      expect(fin.events).toContainEqual(expect.objectContaining({ type: 'wire', detail: 'BYE' }));

      // exactly one WAV; the strict parse throws when absent or corrupt
      const recs = getRecordings(ctx.handle);
      expect(recs.length, `recordings: ${recs.join(', ')}`).toBe(1);
      const bytes = new Uint8Array(readFileSync(recs[0]));
      const { pcm, sampleRate } = parseRiffWav(bytes);
      const durationS = pcm.length / sampleRate;
      expect(durationS, `recording only ${durationS.toFixed(2)}s at ${sampleRate}Hz`).toBeGreaterThanOrEqual(2);
      const recordingRms = maxWindowedRms(pcm, 20, sampleRate);
      expect(
        recordingRms,
        `recordingRms ${recordingRms.toFixed(4)} vs floor ${floor.toFixed(4)} (silence rms ${floorRead.rms}, ${floorRead.bytes} bytes mid-call)`,
      ).toBeGreaterThan(floor);

      // wire evidence of the full outgoing dialog
      const wire = r.events.filter((e) => e.type === 'wire').map((e) => e.detail);
      expect(wire).toContain('INVITE');
      expect(wire).toContain('200');
      expect(wire).toContain('ACK');
    } finally {
      await stun.close();
      await disposeMatrix(ctx);
    }
  });
});
