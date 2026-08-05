/** Minimal byte-level helpers shared by the hash primitives. */

const encoder = new TextEncoder();

export function utf8Bytes(input: string): Uint8Array {
  return encoder.encode(input);
}

/**
 * Renders 32-bit words as lowercase fixed-width hex. With `littleEndian`
 * true each word is written least-significant byte first (MD5 style);
 * otherwise most-significant byte first (SHA style).
 */
export function hexWords(words: Uint32Array, littleEndian: boolean): string {
  let out = '';
  for (let i = 0; i < words.length; i++) {
    const v = words[i]! >>> 0;
    for (let b = 0; b < 4; b++) {
      const shift = littleEndian ? b * 8 : (3 - b) * 8;
      out += ((v >>> shift) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return out;
}
