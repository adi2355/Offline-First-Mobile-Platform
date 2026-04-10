import {
  isHealthMetricCode,
  getMetricCategory,
  type HealthMetricCode,
  getSleepNightAnchorDate,
} from '@shared/contracts';
export type DirtyKeyReason =
  | 'new_samples'
  | 'late_arrival'
  | 'correction'
  | 'formula_update';
export interface DirtyKeySampleInput {
  readonly userId: string;
  readonly sampleType: string;
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly timezoneOffsetMinutes?: number | null;
}
export interface DirtyKeyComputeResult {
  readonly rollupKeys: ReadonlyArray<{
    readonly userId: string;
    readonly metricCode: string;
    readonly dayUtc: string;
    readonly reason: DirtyKeyReason;
  }>;
  readonly sleepNights: ReadonlyArray<{
    readonly userId: string;
    readonly nightLocalDate: string;
    readonly reason: DirtyKeyReason;
  }>;
}
export function timestampToUtcDate(timestampMs: number): string {
  const d = new Date(timestampMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
export function timestampToLocalDate(
  timestampMs: number,
  timezoneOffsetMinutes: number,
): string {
  const localMs = timestampMs + timezoneOffsetMinutes * 60 * 1000;
  const d = new Date(localMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
export function computeDirtyKeysFromSamples(
  samples: ReadonlyArray<DirtyKeySampleInput>,
  reason: DirtyKeyReason = 'new_samples',
): DirtyKeyComputeResult {
  if (samples.length === 0) {
    return { rollupKeys: [], sleepNights: [] };
  }
  const rollupKeySet = new Set<string>();
  const sleepNightSet = new Set<string>();
  const rollupKeys: Array<{ userId: string; metricCode: string; dayUtc: string; reason: DirtyKeyReason }> = [];
  const sleepNights: Array<{ userId: string; nightLocalDate: string; reason: DirtyKeyReason }> = [];
  for (const sample of samples) {
    if (!isHealthMetricCode(sample.sampleType)) {
      continue;
    }
    const metricCode: HealthMetricCode = sample.sampleType;
    const tzOffset = sample.timezoneOffsetMinutes;
    const dayLocal = tzOffset != null
      ? timestampToLocalDate(sample.startTimestamp, tzOffset)
      : timestampToUtcDate(sample.startTimestamp);
    const rollupKey = `${sample.userId}|${metricCode}|${dayLocal}`;
    if (!rollupKeySet.has(rollupKey)) {
      rollupKeySet.add(rollupKey);
      rollupKeys.push({
        userId: sample.userId,
        metricCode,
        dayUtc: dayLocal,
        reason,
      });
    }
    const category = getMetricCategory(metricCode);
    if (category === 'sleep') {
      if (tzOffset != null) {
        const sleepStartDate = new Date(sample.startTimestamp);
        const nightLocalDate = getSleepNightAnchorDate(sleepStartDate, tzOffset);
        const sleepKey = `${sample.userId}|${nightLocalDate}`;
        if (!sleepNightSet.has(sleepKey)) {
          sleepNightSet.add(sleepKey);
          sleepNights.push({
            userId: sample.userId,
            nightLocalDate,
            reason,
          });
        }
      }
    }
  }
  return { rollupKeys, sleepNights };
}
