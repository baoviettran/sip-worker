// test/asterisk-matrix/audio.spec.ts — matrix step 4: the outgoing-call
// two-way audio proof for Asterisk.
//
// Procedure: register → createCall('sip:600@127.0.0.1') → established → send
// 1 s of digital silence (page gate), ATTEMPT a per-run silence read of the
// partial MixMonitor WAV node-side and take the floor as
// `max(floorRms, 0.01)`. On Asterisk that read finds a bare 44-byte RIFF
// header, so `floorRms` is null and the floor resolves to the documented 0.01
// baseline rather than a measured per-run value — the calibration is inert
// here, and the assertions below compare against that constant (the full
// measurement is in readRecordingFloor's comment). Then → open the gate → the
// page raises the 440 Hz tone, lets ≥2 s of RTP flow, samples AnalyserNode
// energy on the remote stream, and checks getStats packet growth both ways →
// finish-call hangs up (flushing MixMonitor) → the node reads the one new WAV
// (delta after clearing stale recordings) and computes maxWindowedRms.
//
// THE MILESTONE GATE, stated plainly: two-way audio is programmatically
// verified by THREE independent observations, ALL of which must hold —
//   1. page-side AnalyserNode energy of the REMOTE stream (the tone Echo()
//      returned) is above the silence floor — the 0.01 baseline described
//      above and in readRecordingFloor, for the reason given there;
//   2. `rtpBothWays` is true — both directions' RTP packet counters grew;
//   3. node-side `maxWindowedRms` of the PBX's own MixMonitor recording of
//      the leg is above that same floor.
// A SIP trace alone NEVER satisfies this test. The wire assertions
// (INVITE/200/ACK) at the end are a closing sanity check on the dialog, not
// the audio proof.
//
// The step contract `{ ok, detail, energy, rtpBothWays, recordingRms }` is
// realized across the two steps: `outgoing-audio` carries energy/rtpBothWays
// in its MatrixResult, `finish-call` flushes MixMonitor, and recordingRms is
// computed HERE (node side — the page cannot read the WAV).
//
// Open questions, and the answers this task recorded:
// - `stunPort`: REQUIRED, and passed. Tried without it first, as briefed: the
//   INVITE is answered 200 and the dialog reaches `established` (so pjsip's
//   `ice_support=yes` accepts the offer, unlike sofia's ACL which answered
//   488), but NO audio ever flows — the step then times out waiting for the
//   remote stream to appear, because ICE never finds a working candidate pair
//   for the mDNS-obfuscated `.local` host candidates Chromium puts in the
//   offer and pjsip has no mDNS resolver. The shared STUN responder supplies
//   an srflx 127.0.0.1 candidate pjsip can actually use, so it is needed here
//   for the same underlying reason as on FreeSWITCH — a candidate pjsip can
//   reach — even though the switch's symptom differs (488 there, silent media
//   here).
import { test, expect } from '@playwright/test';
import { readFileSync, unlinkSync } from 'node:fs';
import { bootMatrix, disposeMatrix, runStep } from './helpers';
import { getRecordings, type AstHandle } from './astctl';
import { maxWindowedRms, parseRiffWav, wavRmsLenient } from '../matrix-shared/rms';
import { startStunResponder } from '../matrix-shared/stun';

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
 * Node-side silence floor from the partial recording, when it holds one. The
 * recordingsDir is shared for the whole Playwright invocation (one container
 * per run, every 600 dial writes into it), so audio.spec clears stale WAVs
 * before dialing and asserts its own delta — exactly one new WAV. Recording
 * names are UNIQUEID-based and NOT mtime-ordered — never pick "newest".
 *
 * MEASURED at authoring time: at the gate (≥1 s into an established call) the
 * file is 44 bytes — the RIFF header alone, data length 0 — because
 * MixMonitor's first flush is larger than the 1 s silence window (a call
 * killed ~10 s in leaves 163 840 data bytes behind with the same declared
 * length of 0, i.e. the header is only finalised on close). So this read
 * returns null in practice and `floor` is the 0.01 baseline below, NOT a
 * measured per-run silence: the calibration is inert on Asterisk. The baseline
 * fallback is an inherited shape from the FreeSWITCH spec this one is modelled
 * on — that it is inert there too is NOT measured here and is not claimed —
 * and the recording still has to clear a floor that a silent, truncated, or
 * wrong-offset read cannot (`test/matrix-shared/rms.unit.test.ts` pins that
 * with a fixture).
 */
function readRecordingFloor(handle: AstHandle): { rms: number | null; path: string | null; bytes: number } {
  const recs = getRecordings(handle);
  if (recs.length === 0) return { rms: null, path: null, bytes: 0 };
  const bytes = new Uint8Array(readFileSync(recs[0]));
  return { rms: wavRmsLenient(bytes), path: recs[0], bytes: bytes.byteLength };
}

/**
 * Clear WAVs left in the shared recordings dir by earlier specs' dials. The
 * dir belongs to the ONE container booted in globalSetup and is shared across
 * all spec files and both browser projects, so it is NOT empty when this test
 * starts. Clearing here is safe: only audio.spec consumes WAVs, and the
 * artifacts collector copies them in stopAsterisk — the globalSetup teardown,
 * which Playwright runs once after ALL specs, never between them.
 * Fail-not-skip: unlinkSync throws rather than silently continuing.
 */
function clearStaleRecordings(handle: AstHandle): void {
  for (const wav of getRecordings(handle)) {
    unlinkSync(wav);
  }
}

test.describe('matrix · outgoing call two-way audio', () => {
  test('outgoing-audio: tone reaches Asterisk (WAV RMS) and echo returns (page energy)', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      // Delta accounting: the recordings dir is shared for the whole
      // invocation, so drop stale WAVs from earlier specs before dialing, then
      // assert the delta (exactly one new WAV) after the call (see
      // clearStaleRecordings).
      clearStaleRecordings(ctx.handle);
      // register → dial 600 → established → 1 s of silence → gate open. The
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

      // hang up → MixMonitor flushes the WAV
      const fin = await runStep(page, 'finish-call', CREDENTIALS);
      expect(fin.ok, fin.detail).toBe(true);
      expect(fin.events).toContainEqual(expect.objectContaining({ type: 'wire', detail: 'BYE' }));

      // exactly one new WAV (delta after clearing stale recordings); the
      // strict parse throws when absent or corrupt
      const recs = getRecordings(ctx.handle);
      expect(
        recs.length,
        `recordings: ${recs.join(', ')} — one new WAV (delta after clearing stale recordings)`,
      ).toBe(1);
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
