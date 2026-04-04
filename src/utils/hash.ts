import { createHash } from 'node:crypto';

export function hashUrl(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl).digest('hex');
}

/**
 * Simple simhash implementation for content dedup.
 * Returns a 64-bit hash as a hex string.
 */
export function computeSimhash(text: string): string {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const vector = new Array<number>(64).fill(0);

  for (const word of words) {
    const hash = createHash('md5').update(word).digest();
    for (let i = 0; i < 64; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      if ((hash[byteIndex] >> bitIndex) & 1) {
        vector[i]++;
      } else {
        vector[i]--;
      }
    }
  }

  // Convert to 64-bit hash
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 64; i++) {
    if (vector[i] > 0) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      bytes[byteIndex] |= 1 << bitIndex;
    }
  }

  return Buffer.from(bytes).toString('hex');
}

/**
 * Compute hamming distance between two simhashes.
 * Returns similarity as 0.0-1.0 (1.0 = identical).
 */
export function simhashSimilarity(hashA: string, hashB: string): number {
  const a = Buffer.from(hashA, 'hex');
  const b = Buffer.from(hashB, 'hex');
  let diffBits = 0;

  for (let i = 0; i < a.length; i++) {
    let xor = a[i] ^ b[i];
    while (xor) {
      diffBits += xor & 1;
      xor >>= 1;
    }
  }

  return 1 - diffBits / 64;
}
