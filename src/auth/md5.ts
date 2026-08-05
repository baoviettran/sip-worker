import { utf8Bytes, hexWords } from './bytes.js';

const F = (x: number, y: number, z: number): number => (x & y) | (~x & z);
const G = (x: number, y: number, z: number): number => (x & z) | (y & ~z);
const H = (x: number, y: number, z: number): number => x ^ y ^ z;
const I = (x: number, y: number, z: number): number => y ^ (x | ~z);
const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;

// First 64 bits of the fractional parts of the cube roots of the first 64 primes.
// prettier-ignore
const T = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
] as const;

// Round shift amounts: r[r, i] with per-round selections per RFC 1321.
// prettier-ignore
const R = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

const INIT = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);

/**
 * MD5 message digest (RFC 1321) over the raw UTF-8 bytes of `input`.
 * Returns a lowercase, fixed-width 32-character hex string.
 */
export function md5(input: string): string {
  const u8 = utf8Bytes(input);
  const msgLen = u8.length;
  const bitLenLo = (msgLen * 8) >>> 0;
  const bitLenHi = Math.floor(msgLen * 8 / 0x100000000);

  // Pad to a multiple of 64 bytes with room for the 64-bit little-endian bit length.
  const paddedLen = Math.ceil((msgLen + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(u8);
  padded[msgLen] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLenLo, true);
  view.setUint32(paddedLen - 4, bitLenHi, true);
  const words = new Uint32Array(paddedLen / 4);
  for (let i = 0; i < paddedLen / 4; i++) words[i] = view.getUint32(i * 4, true);

  const state = INIT.slice();
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;

  for (let off = 0; off < words.length; off += 16) {
    const a0 = a;
    const b0 = b;
    const c0 = c;
    const d0 = d;
    const m = words.subarray(off, off + 16);

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = F(b, c, d);
        g = i;
      } else if (i < 32) {
        f = G(b, c, d);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = H(b, c, d);
        g = (3 * i + 5) % 16;
      } else {
        f = I(b, c, d);
        g = (7 * i) % 16;
      }
      // RFC 1321: (a, b, c, d) := (d, b + LEFTROTATE(a + F + K[i] + M[g], s[i]), b, c)
      const tmp = (b + rotl((a + f + T[i]! + m[g]!) >>> 0, R[i]!)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = tmp;
    }

    a = (a + a0) >>> 0;
    b = (b + b0) >>> 0;
    c = (c + c0) >>> 0;
    d = (d + d0) >>> 0;
  }

  return hexWords(new Uint32Array([a, b, c, d]), true);
}
