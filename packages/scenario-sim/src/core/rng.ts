/**
 * Seeded PRNG (sfc32). Every scenario run owns one, seeded from the run's
 * seed, so ids, latencies, jitter and fixture data replay identically for the
 * same seed — never use Math.random or wall-clock ids inside a scenario.
 */

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  /** Draws so far; useful when asserting determinism across runs. */
  draws = 0;

  constructor(public readonly seed: string | number) {
    const h = hashSeed(String(seed));
    this.a = h[0]!;
    this.b = h[1]!;
    this.c = h[2]!;
    this.d = h[3]!;
    for (let i = 0; i < 12; i++) this.next();
    this.draws = 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.draws++;
    this.a |= 0;
    this.b |= 0;
    this.c |= 0;
    this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min = 0, max = 1): number {
    return min + this.next() * (max - min);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick() from an empty list");
    return items[this.int(0, items.length - 1)]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** Deterministic opaque id: `<prefix>_<8 base36 chars>`. */
  id(prefix = "id"): string {
    let s = "";
    while (s.length < 8) s += Math.floor(this.next() * 36 ** 4).toString(36).padStart(4, "0");
    return `${prefix}_${s.slice(0, 8)}`;
  }

  /** RFC-4122-shaped id (version 4 bits set) from the seeded stream. */
  uuid(): string {
    const hex = () => Math.floor(this.next() * 0x10000).toString(16).padStart(4, "0");
    const v = hex();
    return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${((parseInt(v[0]!, 16) & 0x3) | 0x8).toString(16)}${v.slice(1)}-${hex()}${hex()}${hex()}`;
  }

  /** Fork a child generator with a derived seed (stable across runs). */
  fork(label: string): Rng {
    return new Rng(`${this.seed}/${label}`);
  }
}

/** MurmurHash3-style mixing of a string into four 32-bit words. */
function hashSeed(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}
