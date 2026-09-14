import { describe, it, expect } from 'vitest';
import { maxWindowedRms, parseRiffWav, readWavPcm16 } from './rms';

const RATE = 8000;
function tonePcm(amp: number, hz: number, ms: number): Float32Array {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}
function wrapWav(pcm: Float32Array): Uint8Array {
  const p16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) p16[i] = Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767);
  const bytes = new Uint8Array(p16.buffer);
  const wav = new Uint8Array(44 + bytes.byteLength);
  const dv = new DataView(wav.buffer);
  wav.set([0x52, 0x49, 0x46, 0x46], 0);        // RIFF
  dv.setUint32(4, 36 + bytes.byteLength, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8);        // WAVE
  wav.set([0x66, 0x6d, 0x74, 0x20], 12);       // "fmt "
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wav.set([0x64, 0x61, 0x74, 0x61], 36);       // data
  dv.setUint32(40, bytes.byteLength, true);
  wav.set(bytes, 44);
  return wav;
}

describe('parseRiffWav', () => {
  it('parses a mono 8k PCM16 fixture', () => {
    const w = parseRiffWav(wrapWav(tonePcm(0.9, 440, 100)));
    expect(w.sampleRate).toBe(RATE);
    expect(w.channels).toBe(1);
    expect(w.pcm.length).toBe(Math.round((RATE * 100) / 1000));
  });
});
describe('readWavPcm16', () => {
  it('normalizes PCM16 to [-1, 1]', () => {
    const v = readWavPcm16(new Uint8Array(new Int16Array([0, 16384, -32768, 32767]).buffer));
    expect(v[0]).toBe(0);
    expect(v[1]).toBeCloseTo(0.5, 2);
    expect(v[2]).toBeCloseTo(-1, 2);
    expect(v[3]).toBeCloseTo(1, 2);
  });
});
describe('maxWindowedRms', () => {
  it('is near zero on silence', () => {
    expect(maxWindowedRms(new Float32Array(RATE), 20, RATE)).toBeLessThan(0.005);
  });
  it('is above 0.5 on a full-scale tone', () => {
    expect(maxWindowedRms(tonePcm(1, 440, 200), 20, RATE)).toBeGreaterThan(0.5);
  });
  it('finds a 200ms tone inside 1s of silence (windowed, not global)', () => {
    const s = new Float32Array(RATE);
    s.set(tonePcm(1, 440, 200), Math.round(RATE * 0.4));
    expect(maxWindowedRms(s, 20, RATE)).toBeGreaterThan(0.5);
  });
});
