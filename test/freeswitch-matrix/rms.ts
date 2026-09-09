// test/freeswitch-matrix/rms.ts — pure PCM16 WAV energy pass. No audio device,
// no docker: a pure function over WAV bytes, unit-tested with synthetic fixtures.
export function parseRiffWav(bytes: Uint8Array): { sampleRate: number; channels: number; pcm: Float32Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12;
  let sampleRate = 0;
  let channels = 1;
  let pcmOff = -1;
  let dataLen = 0;
  while (off + 8 <= bytes.byteLength) {
    const id = ascii(off, 4);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      channels = dv.getUint16(off + 10, true);
      sampleRate = dv.getUint32(off + 12, true);
      if (dv.getUint16(off + 22, true) !== 16) throw new Error('only PCM16 supported');
    } else if (id === 'data') {
      pcmOff = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
  }
  if (pcmOff < 0 || dataLen < 2) throw new Error('no data chunk');
  return { sampleRate, channels, pcm: readWavPcm16(bytes.subarray(pcmOff, pcmOff + dataLen)) };
}

export function readWavPcm16(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = bytes[i * 2];
    const hi = bytes[i * 2 + 1];
    out[i] = (hi < 128 ? hi * 256 + lo : (hi - 256) * 256 + lo) / 32768;
  }
  return out;
}

export function maxWindowedRms(samples: Float32Array, windowMs: number, sampleRate: number): number {
  const win = Math.max(1, Math.round((windowMs * sampleRate) / 1000));
  const windows = Math.floor(samples.length / win);
  let best = 0;
  for (let w = 0; w < windows; w++) {
    let acc = 0;
    for (let i = 0; i < win; i++) {
      const v = samples[w * win + i];
      acc += v * v;
    }
    const rms = Math.sqrt(acc / win);
    if (rms > best) best = rms;
  }
  return best;
}
