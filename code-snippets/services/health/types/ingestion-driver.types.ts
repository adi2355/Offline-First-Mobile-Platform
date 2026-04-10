import type { CursorScope } from '../../../repositories/health/HealthCursorRepository';
export enum NativeErrorCode {
  HEALTHKIT_UNAVAILABLE = 'HEALTHKIT_UNAVAILABLE',
  HEALTHKIT_UNAUTHORIZED = 'HEALTHKIT_UNAUTHORIZED',
  HEALTHKIT_QUERY_FAILED = 'HEALTHKIT_QUERY_FAILED',
  SQLITE_OPEN_FAILED = 'SQLITE_OPEN_FAILED',
  SQLITE_WRITE_FAILED = 'SQLITE_WRITE_FAILED',
  SQLITE_BUSY = 'SQLITE_BUSY',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  HOT_CANCELLED = 'HOT_CANCELLED',
  COLD_CANCELLED = 'COLD_CANCELLED',
  NATIVE_BRIDGE_ERROR = 'NATIVE_BRIDGE_ERROR',
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  INVALID_METRIC_CODE = 'INVALID_METRIC_CODE',
  CHANGE_CANCELLED = 'CHANGE_CANCELLED',
  QUERY_TIMEOUT = 'QUERY_TIMEOUT',
}
export const NATIVE_ERROR_RETRYABLE: Readonly<Record<NativeErrorCode, boolean>> = {
  [NativeErrorCode.HEALTHKIT_UNAVAILABLE]: false,
  [NativeErrorCode.HEALTHKIT_UNAUTHORIZED]: false,
  [NativeErrorCode.HEALTHKIT_QUERY_FAILED]: true,
  [NativeErrorCode.SQLITE_OPEN_FAILED]: false,
  [NativeErrorCode.SQLITE_WRITE_FAILED]: true,
  [NativeErrorCode.SQLITE_BUSY]: true,
  [NativeErrorCode.BUDGET_EXCEEDED]: false,
  [NativeErrorCode.HOT_CANCELLED]: false,
  [NativeErrorCode.COLD_CANCELLED]: false,
  [NativeErrorCode.NATIVE_BRIDGE_ERROR]: true,
  [NativeErrorCode.NOT_INITIALIZED]: false,
  [NativeErrorCode.INVALID_METRIC_CODE]: false,
  [NativeErrorCode.CHANGE_CANCELLED]: false,
  [NativeErrorCode.QUERY_TIMEOUT]: true,
} as const;
export interface NativeIngestError {
  code: NativeErrorCode;
  message: string;
  metricCode?: string;
  retryable: boolean;
}
export interface MetricDiagnostic {
  metricCode: string;
  newestSampleTimestampMs: number | null;
  oldestSampleTimestampMs: number | null;
  samplesInserted: number;
  samplesSkipped: number;
}
export interface LaneResult {
  success: boolean;
  samplesInserted: number;
  samplesSkipped: number;
  durationMs: number;
  metricsProcessed: string[];
  errors: NativeIngestError[];
  partial: boolean;
  coldCursorsAdvanced: number;
  metricDiagnostics: MetricDiagnostic[];
}
export interface LaneStatus {
  running: boolean;
  lastCompletedAt: number | null;
  lastFailedAt: number | null;
  lastErrorCode: NativeErrorCode | null;
  consecutiveFailures: number;
  paused: boolean;
}
export interface ColdLaneProgressEvent {
  chunksProcessed: number;
  estimatedTotalChunks: number;
  totalSamplesInserted: number;
  oldestTimestampReached: number;
  isRunning: boolean;
}
export interface NativeMetricConfig {
  readonly metricCode: string;
  readonly hkIdentifier: string;
  readonly queryUnit: string | null;
  readonly valueKind: string;
  readonly isCategory: boolean;
  readonly minBound?: number;
  readonly maxBound?: number;
  readonly canonicalUnit?: string;
}
export interface NativeInitConfig {
  readonly dbPath: string;
  readonly metrics: readonly NativeMetricConfig[];
  readonly laneConstants: {
    readonly hotBudgetMs: number;
    readonly recentDataQueryLimit: number;
    readonly hotLookbackDays: number;
    readonly hotOverlapMs: number;
    readonly hotUiWindowMs: number;
    readonly hotCatchupChunkWindowMs: number;
    readonly hotCatchupMaxChunksPerRun: number;
    readonly hotCatchupQueryLimit: number;
    readonly coldChunkBudgetMs: number;
    readonly coldMaxChunks: number;
    readonly coldBackfillDays: number;
    readonly coldGraceWindowDays: number;
    readonly coldChunkWindowMs: number;
    readonly coldQueryLimitPerChunk: number;
    readonly maxSamplesPerChunk: number;
    readonly busyTimeoutMs: number;
    readonly hotTwoPassEnabled: boolean;
  };
}
export interface IHealthIngestionDriver {
  readonly driverId: 'native' | 'js';
  ingestHot(
    userId: string,
    sourceId: string,
    metricCodes: string[],
    options: {
      budgetMs?: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<LaneResult>;
  ingestCold(
    userId: string,
    sourceId: string,
    options: {
      chunkBudgetMs?: number;
      maxChunks?: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<LaneResult>;
  ingestChanges(
    userId: string,
    sourceId: string,
    options?: {
      abortSignal?: AbortSignal;
    }
  ): Promise<LaneResult>;
  cancelCold(): void;
  isAvailable(): Promise<boolean>;
  getLaneStatuses(): {
    hot: LaneStatus;
    cold: LaneStatus;
    change: LaneStatus;
  };
  dispose(): void;
  getDegradation(): ReadonlyMap<string, LaneDegradation>;
}
export enum LaneDegradationReason {
  COLD_USES_ANCHOR_NOT_TIME_CURSOR = 'COLD_USES_ANCHOR_NOT_TIME_CURSOR',
  HOT_USES_ANCHOR_NOT_DATE_RANGE = 'HOT_USES_ANCHOR_NOT_DATE_RANGE',
}
export interface LaneDegradation {
  readonly reason: LaneDegradationReason;
  readonly description: string;
  readonly functionallyCorrect: boolean;
}
export type { CursorScope };
