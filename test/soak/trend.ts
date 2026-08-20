export interface TrendSample {
  readonly tMs: number;
  readonly value: number;
}

export interface TrendResult {
  readonly count: number;
  readonly p95: number;
  readonly slopePerHour: number;
  readonly firstHalfMean: number;
  readonly lastHalfMean: number;
}

function mean(samples: readonly TrendSample[]): number {
  return samples.reduce((acc, s) => acc + s.value, 0) / samples.length;
}

/** Least-squares slope of value vs elapsed hours (0 for fewer than 2 samples). */
export function computeTrend(samples: readonly TrendSample[]): TrendResult {
  if (samples.length === 0) throw new Error('computeTrend: empty samples');
  const count = samples.length;
  if (count === 1) {
    return { count, p95: samples[0]!.value, slopePerHour: 0, firstHalfMean: samples[0]!.value, lastHalfMean: samples[0]!.value };
  }

  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const p95 = sorted[Math.floor(0.95 * (count - 1))]!.value;

  const t0 = samples[0]!.tMs;
  const hours = samples.map((s) => (s.tMs - t0) / 3_600_000);
  const meanH = hours.reduce((a, b) => a + b, 0) / count;
  const meanV = mean(samples);
  let num = 0;
  let den = 0;
  for (let i = 0; i < count; i += 1) {
    num += (hours[i]! - meanH) * (samples[i]!.value - meanV);
    den += (hours[i]! - meanH) ** 2;
  }
  const slopePerHour = den === 0 ? 0 : num / den;

  const half = Math.floor(count / 2);
  const firstHalfMean = half === 0 ? meanV : mean(samples.slice(0, half));
  const lastHalfMean = half === 0 ? meanV : mean(samples.slice(count - half));

  return { count, p95, slopePerHour, firstHalfMean, lastHalfMean };
}

export interface NoUpwardTrendOptions {
  /** Jitter-tolerant ceiling: the 95th percentile of samples must be <= this. */
  readonly max?: number;
  /** Maximum tolerated least-squares slope in value-units per hour. */
  readonly maxSlopePerHour?: number;
  /** Maximum tolerated growth of the tail-half mean over the head-half mean, in value units. */
  readonly maxTailGrowth?: number;
}

export function assertNoUpwardTrend(samples: readonly TrendSample[], options: NoUpwardTrendOptions = {}): void {
  const max = options.max ?? 8;
  const maxSlopePerHour = options.maxSlopePerHour ?? 1;
  const maxTailGrowth = options.maxTailGrowth ?? 1;
  const t = computeTrend(samples);
  if (t.p95 > max) {
    throw new Error(`assertNoUpwardTrend: p95 ${t.p95} exceeds ceiling ${max}`);
  }
  if (t.slopePerHour > maxSlopePerHour) {
    throw new Error(`assertNoUpwardTrend: slope ${t.slopePerHour.toFixed(3)}/h exceeds ${maxSlopePerHour}/h`);
  }
  if (t.lastHalfMean > t.firstHalfMean + maxTailGrowth) {
    throw new Error(
      `assertNoUpwardTrend: tail mean ${t.lastHalfMean.toFixed(2)} exceeds head mean ${t.firstHalfMean.toFixed(2)} + ${maxTailGrowth}`,
    );
  }
}
