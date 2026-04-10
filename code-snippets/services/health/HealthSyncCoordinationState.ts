import { type HealthMetricCode } from '@shared/contracts';
import { logger } from '../../utils/logger';
export type HealthSyncSource =
  | 'HEALTHKIT_INGEST'
  | 'HEALTH_CONNECT_INGEST'
  | 'PERIODIC_UPLOAD'
  | 'APP_FOREGROUND'
  | 'NETWORK_RECONNECT'
  | 'MANUAL_REFRESH'
  | 'AUTH_SIGNIN'
  | 'AUTH_REFRESH'
  | 'HEALTH_SYNC_INITIALIZE';
export interface HealthSyncResult {
  readonly success: boolean;
  readonly samplesUploaded: number;
  readonly samplesRejected: number;
  readonly samplesFailed: number;
  readonly deletionsUploaded: number;
  readonly deletionsFailed: number;
  readonly durationMs: number;
  readonly errorMessage?: string;
}
export class HealthSyncCoordinationState {
  private static instance: HealthSyncCoordinationState | null = null;
  public static getInstance(): HealthSyncCoordinationState {
    if (!HealthSyncCoordinationState.instance) {
      HealthSyncCoordinationState.instance = new HealthSyncCoordinationState();
    }
    return HealthSyncCoordinationState.instance;
  }
  public static reset(): void {
    if (HealthSyncCoordinationState.instance) {
      HealthSyncCoordinationState.instance.resetState();
    }
    HealthSyncCoordinationState.instance = null;
  }
  public static hasInstance(): boolean {
    return HealthSyncCoordinationState.instance !== null;
  }
  public readonly SOURCE_COOLDOWN_MS = 60_000;
  public readonly MIN_BACKOFF_MS = 10_000;
  public readonly MAX_BACKOFF_MS = 600_000;
  public readonly BACKOFF_MULTIPLIER = 2;
  public readonly BACKOFF_JITTER_FACTOR = 0.25;
  public readonly HARD_MIN_UPLOAD_INTERVAL_MS = 15_000;
  public readonly HARD_MIN_INGEST_INTERVAL_MS = 300_000;
  public readonly MAX_BATCH_SIZE = 500;
  public readonly MAX_BATCH_BYTES = 4_500_000;
  public readonly MAX_UPLOAD_RETRIES = 3;
  public readonly INTER_BATCH_UPLOAD_DELAY_MS = 500;
  public readonly ACTIVE_UPLOAD_INTERVAL_MS = 300_000;
  public readonly INGEST_INTERVAL_MS = 900_000;
  public readonly COLD_FORCE_THRESHOLD_MS = 86_400_000; 
  public readonly CHANGE_LANE_INTERVAL_MS = 21_600_000; 
  public readonly HOT_STALE_FOREGROUND_MS = 300_000; 
  public readonly COLD_STARVATION_THRESHOLD_MS = 172_800_000; 
  public readonly COLD_PREEMPTION_ALERT_THRESHOLD = 5;
  public readonly COLD_CHUNK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; 
  public readonly COLD_QUERY_LIMIT_PER_CHUNK = 5_000;
  public readonly COLD_GRACE_WINDOW_DAYS = 7;
  public readonly INITIAL_SYNC_MAX_PAGES_PER_METRIC = 3;
  public readonly INCREMENTAL_SYNC_MAX_PAGES_PER_METRIC = 20;
  public readonly MAX_SAMPLES_PER_INGEST_CYCLE = 20_000;
  public readonly INITIAL_SYNC_QUERY_LIMIT = 250;
  public readonly INCREMENTAL_SYNC_QUERY_LIMIT = 500;
  public readonly INTER_METRIC_DELAY_MS = 100;
  public readonly PRIORITIZE_VITAL_SIGNS = true;
  public readonly ENABLE_RECENT_DATA_FIRST = true;
  public readonly HOT_OVERLAP_MS = 5 * 60 * 1000; 
  public readonly HOT_MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; 
  public readonly HOT_UI_WINDOW_MS = 24 * 60 * 60 * 1000; 
  public readonly HOT_CATCHUP_CHUNK_WINDOW_MS = 6 * 60 * 60 * 1000; 
  public readonly HOT_CATCHUP_MAX_CHUNKS_PER_RUN = 4;
  public readonly HOT_CATCHUP_QUERY_LIMIT = 5_000;
  public readonly RECENT_DATA_LOOKBACK_DAYS = 14;
  public readonly RECENT_DATA_QUERY_LIMIT = 60000;
  public readonly RECENT_DATA_PRIORITY_METRICS: readonly HealthMetricCode[] = [
    'heart_rate',
    'heart_rate_variability',
    'resting_heart_rate',
    'respiratory_rate',
    'blood_oxygen',
    'body_temperature',
    'steps',
    'distance_walking_running',
    'active_energy_burned',
    'basal_energy_burned',
    'exercise_minutes',
    'flights_climbed',
    'audio_exposure',
    'sleep_stage',
    'stand_hours',
  ];
  private _ingestInProgress = false;
  private _activeIngestPromise: Promise<void> | null = null;
  private _uploadInProgress = false;
  private _activeUploadPromise: Promise<unknown> | null = null;
  private _lastSourceTime: Map<HealthSyncSource, number> = new Map();
  private _lastIngestAttemptTime = 0;
  private _lastUploadAttemptTime = 0;
  private _uploadBackoffMs = 0;
  private _consecutiveUploadErrors = 0;
  private _lastUploadErrorTime = 0;
  private _ingestBackoffMs = 0;
  private _consecutiveIngestErrors = 0;
  private _lastIngestErrorTime = 0;
  private _lastSyncResult: HealthSyncResult | null = null;
  private _sessionSamplesUploaded = 0;
  private _hotLaneLastCompletedAt = 0;
  private _coldLaneLastCompletedAt = 0;
  private _coldLaneLastProgressAt = 0;
  private _healthSyncStartedAt = 0;
  private _changeLaneLastCompletedAt = 0;
  private _hotLaneLastDurationMs = 0;
  private _hotLaneSloViolations = 0;
  private _activeDriverId: 'native' | 'js' | null = null;
  private _consecutiveColdPreemptions = 0;
  private _coldResumeIndex = 0;
  private constructor() {
  }
  public get activeIngestPromise(): Promise<void> | null {
    return this._activeIngestPromise;
  }
  public get ingestInProgress(): boolean {
    return this._ingestInProgress;
  }
  public acquireIngestLock(promise: Promise<void>): boolean {
    if (this._ingestInProgress) {
      return false;
    }
    this._ingestInProgress = true;
    this._activeIngestPromise = promise;
    promise.finally(() => {
      this._ingestInProgress = false;
      this._activeIngestPromise = null;
    });
    return true;
  }
  public forceReleaseIngestLock(): void {
    this._ingestInProgress = false;
    this._activeIngestPromise = null;
  }
  public get activeUploadPromise(): Promise<unknown> | null {
    return this._activeUploadPromise;
  }
  public get uploadInProgress(): boolean {
    return this._uploadInProgress;
  }
  public acquireUploadLock(promise: Promise<unknown>): boolean {
    if (this._uploadInProgress) {
      return false;
    }
    this._uploadInProgress = true;
    this._activeUploadPromise = promise;
    promise.finally(() => {
      this._uploadInProgress = false;
      this._activeUploadPromise = null;
    });
    return true;
  }
  public forceReleaseUploadLock(): void {
    this._uploadInProgress = false;
    this._activeUploadPromise = null;
  }
  public getLastSourceTime(source: HealthSyncSource): number {
    return this._lastSourceTime.get(source) ?? 0;
  }
  public recordSourceTime(source: HealthSyncSource, timestamp: number = Date.now()): void {
    this._lastSourceTime.set(source, timestamp);
  }
  public isSourceInCooldown(source: HealthSyncSource, now: number = Date.now()): boolean {
    const lastTime = this._lastSourceTime.get(source) ?? 0;
    return now - lastTime < this.SOURCE_COOLDOWN_MS;
  }
  public clearSourceCooldown(source: HealthSyncSource): void {
    this._lastSourceTime.delete(source);
  }
  public get lastIngestAttemptTime(): number {
    return this._lastIngestAttemptTime;
  }
  public recordIngestAttempt(timestamp: number = Date.now()): void {
    this._lastIngestAttemptTime = timestamp;
  }
  public isWithinIngestMinInterval(now: number = Date.now()): boolean {
    return now - this._lastIngestAttemptTime < this.HARD_MIN_INGEST_INTERVAL_MS;
  }
  public get lastUploadAttemptTime(): number {
    return this._lastUploadAttemptTime;
  }
  public recordUploadAttempt(timestamp: number = Date.now()): void {
    this._lastUploadAttemptTime = timestamp;
  }
  public isWithinUploadMinInterval(now: number = Date.now()): boolean {
    return now - this._lastUploadAttemptTime < this.HARD_MIN_UPLOAD_INTERVAL_MS;
  }
  public get uploadBackoffMs(): number {
    return this._uploadBackoffMs;
  }
  public get consecutiveUploadErrors(): number {
    return this._consecutiveUploadErrors;
  }
  public recordUploadError(timestamp: number = Date.now()): number {
    this._consecutiveUploadErrors++;
    this._lastUploadErrorTime = timestamp;
    const baseBackoff = this.MIN_BACKOFF_MS * Math.pow(
      this.BACKOFF_MULTIPLIER,
      this._consecutiveUploadErrors - 1
    );
    const jitter = baseBackoff * this.BACKOFF_JITTER_FACTOR * Math.random();
    const calculatedBackoff = Math.min(baseBackoff + jitter, this.MAX_BACKOFF_MS);
    this._uploadBackoffMs = Math.max(this._uploadBackoffMs, calculatedBackoff);
    return this._uploadBackoffMs;
  }
  public isInUploadBackoff(now: number = Date.now()): boolean {
    if (this._uploadBackoffMs === 0) return false;
    return now - this._lastUploadErrorTime < this._uploadBackoffMs;
  }
  public getRemainingUploadBackoffMs(now: number = Date.now()): number {
    if (this._uploadBackoffMs === 0) return 0;
    const elapsed = now - this._lastUploadErrorTime;
    return Math.max(0, this._uploadBackoffMs - elapsed);
  }
  public clearUploadBackoff(): void {
    this._uploadBackoffMs = 0;
    this._consecutiveUploadErrors = 0;
    this._lastUploadErrorTime = 0;
  }
  public setUploadBackoffMs(
    backoffMs: number,
    reason: string,
    timestamp: number = Date.now()
  ): void {
    const clampedBackoff = Math.min(backoffMs, this.MAX_BACKOFF_MS);
    if (clampedBackoff > this._uploadBackoffMs) {
      this._uploadBackoffMs = clampedBackoff;
      this._lastUploadErrorTime = timestamp;
      logger.info('[HealthSyncCoordinationState] Server-provided backoff set', {
        reason,
        requestedBackoffMs: backoffMs,
        appliedBackoffMs: clampedBackoff,
        maxBackoffMs: this.MAX_BACKOFF_MS,
        previousBackoffMs: this._uploadBackoffMs,
      });
    } else {
      logger.debug('[HealthSyncCoordinationState] Server backoff ignored (current is larger)', {
        reason,
        requestedBackoffMs: backoffMs,
        currentBackoffMs: this._uploadBackoffMs,
      });
    }
    this._consecutiveUploadErrors++;
  }
  public get ingestBackoffMs(): number {
    return this._ingestBackoffMs;
  }
  public get consecutiveIngestErrors(): number {
    return this._consecutiveIngestErrors;
  }
  public recordIngestError(timestamp: number = Date.now()): number {
    this._consecutiveIngestErrors++;
    this._lastIngestErrorTime = timestamp;
    const baseBackoff = this.MIN_BACKOFF_MS * Math.pow(
      this.BACKOFF_MULTIPLIER,
      this._consecutiveIngestErrors - 1
    );
    const jitter = baseBackoff * this.BACKOFF_JITTER_FACTOR * Math.random();
    this._ingestBackoffMs = Math.min(baseBackoff + jitter, this.MAX_BACKOFF_MS);
    return this._ingestBackoffMs;
  }
  public isInIngestBackoff(now: number = Date.now()): boolean {
    if (this._ingestBackoffMs === 0) return false;
    return now - this._lastIngestErrorTime < this._ingestBackoffMs;
  }
  public getRemainingIngestBackoffMs(now: number = Date.now()): number {
    if (this._ingestBackoffMs === 0) return 0;
    const elapsed = now - this._lastIngestErrorTime;
    return Math.max(0, this._ingestBackoffMs - elapsed);
  }
  public clearIngestBackoff(): void {
    this._ingestBackoffMs = 0;
    this._consecutiveIngestErrors = 0;
    this._lastIngestErrorTime = 0;
  }
  public get lastSyncResult(): HealthSyncResult | null {
    return this._lastSyncResult;
  }
  public recordSyncResult(result: HealthSyncResult): void {
    this._lastSyncResult = result;
    if (result.success) {
      this._sessionSamplesUploaded += result.samplesUploaded;
    }
  }
  public get sessionSamplesUploaded(): number {
    return this._sessionSamplesUploaded;
  }
  public resetAllState(): void {
    this.resetState();
    logger.info('[HealthSyncCoordinationState] All state reset for new user');
  }
  private resetState(): void {
    this._ingestInProgress = false;
    this._activeIngestPromise = null;
    this._uploadInProgress = false;
    this._activeUploadPromise = null;
    this._lastSourceTime.clear();
    this._lastIngestAttemptTime = 0;
    this._lastUploadAttemptTime = 0;
    this._uploadBackoffMs = 0;
    this._consecutiveUploadErrors = 0;
    this._lastUploadErrorTime = 0;
    this._ingestBackoffMs = 0;
    this._consecutiveIngestErrors = 0;
    this._lastIngestErrorTime = 0;
    this._lastSyncResult = null;
    this._sessionSamplesUploaded = 0;
    this._hotLaneLastCompletedAt = 0;
    this._coldLaneLastCompletedAt = 0;
    this._coldLaneLastProgressAt = 0;
    this._healthSyncStartedAt = 0;
    this._changeLaneLastCompletedAt = 0;
    this._hotLaneLastDurationMs = 0;
    this._hotLaneSloViolations = 0;
    this._activeDriverId = null;
    this._consecutiveColdPreemptions = 0;
    this._coldResumeIndex = 0;
  }
  public recordHealthSyncStarted(): void {
    if (this._healthSyncStartedAt === 0) {
      this._healthSyncStartedAt = Date.now();
      logger.info('[HealthSyncCoordinationState] Health sync pipeline started', {
        healthSyncStartedAt: this._healthSyncStartedAt,
      });
    }
  }
  public recordHotLaneCompletion(durationMs: number): void {
    this._hotLaneLastCompletedAt = Date.now();
    this._hotLaneLastDurationMs = durationMs;
    if (durationMs > 2000) {
      this._hotLaneSloViolations++;
      logger.warn('[HealthSyncCoordinationState] HOT lane SLO violation', {
        durationMs,
        budget: 2000,
        totalViolations: this._hotLaneSloViolations,
      });
    }
  }
  public recordColdLaneProgress(): void {
    this._coldLaneLastProgressAt = Date.now();
  }
  public recordColdLaneCompletion(): void {
    const now = Date.now();
    this._coldLaneLastCompletedAt = now;
    this._coldLaneLastProgressAt = now;
    this._consecutiveColdPreemptions = 0;
  }
  public recordColdPreemption(): number {
    this._consecutiveColdPreemptions++;
    return this._consecutiveColdPreemptions;
  }
  public get consecutiveColdPreemptions(): number {
    return this._consecutiveColdPreemptions;
  }
  public isColdPreemptionExcessive(): boolean {
    return this._consecutiveColdPreemptions >= this.COLD_PREEMPTION_ALERT_THRESHOLD;
  }
  public get coldResumeIndex(): number {
    return this._coldResumeIndex;
  }
  public setColdResumeIndex(index: number): void {
    this._coldResumeIndex = index;
  }
  public recordChangeLaneCompletion(): void {
    this._changeLaneLastCompletedAt = Date.now();
  }
  public setActiveDriverId(driverId: 'native' | 'js'): void {
    this._activeDriverId = driverId;
  }
  public get activeDriverId(): 'native' | 'js' | null {
    return this._activeDriverId;
  }
  public isHotLaneStale(now: number = Date.now()): boolean {
    if (this._hotLaneLastCompletedAt === 0) return true;
    return now - this._hotLaneLastCompletedAt > 5 * 60_000;
  }
  public isColdOverdue(now: number = Date.now()): boolean {
    if (this._coldLaneLastCompletedAt === 0) return true;
    return now - this._coldLaneLastCompletedAt > this.COLD_FORCE_THRESHOLD_MS;
  }
  public isColdStarved(now: number = Date.now()): boolean {
    if (this._coldLaneLastProgressAt > 0) {
      return now - this._coldLaneLastProgressAt > this.COLD_STARVATION_THRESHOLD_MS;
    }
    if (this._healthSyncStartedAt === 0) return false;
    return now - this._healthSyncStartedAt > this.COLD_STARVATION_THRESHOLD_MS;
  }
  public isChangeLaneDue(now: number = Date.now()): boolean {
    if (this._changeLaneLastCompletedAt === 0) return true;
    return now - this._changeLaneLastCompletedAt > this.CHANGE_LANE_INTERVAL_MS;
  }
  public getLaneConstants(): Readonly<{
    hotBudgetMs: number;
    hotLookbackDays: number;
    hotOverlapMs: number;
    hotUiWindowMs: number;
    hotCatchupChunkWindowMs: number;
    hotCatchupMaxChunksPerRun: number;
    hotCatchupQueryLimit: number;
    coldChunkBudgetMs: number;
    coldMaxChunks: number;
    coldBackfillDays: number;
    coldGraceWindowDays: number;
    coldChunkWindowMs: number;
    coldQueryLimitPerChunk: number;
    maxSamplesPerChunk: number;
    hardMinIngestIntervalMs: number;
    recentDataPriorityMetrics: readonly string[];
    recentDataQueryLimit: number;
    busyTimeoutMs: number;
  }> {
    return {
      hotBudgetMs: 2000,
      hotLookbackDays: this.RECENT_DATA_LOOKBACK_DAYS,
      hotOverlapMs: this.HOT_OVERLAP_MS,
      hotUiWindowMs: this.HOT_UI_WINDOW_MS,
      hotCatchupChunkWindowMs: this.HOT_CATCHUP_CHUNK_WINDOW_MS,
      hotCatchupMaxChunksPerRun: this.HOT_CATCHUP_MAX_CHUNKS_PER_RUN,
      hotCatchupQueryLimit: this.HOT_CATCHUP_QUERY_LIMIT,
      coldChunkBudgetMs: 500,
      coldMaxChunks: 10,
      coldBackfillDays: 90,
      coldGraceWindowDays: this.COLD_GRACE_WINDOW_DAYS,
      coldChunkWindowMs: this.COLD_CHUNK_WINDOW_MS,
      coldQueryLimitPerChunk: this.COLD_QUERY_LIMIT_PER_CHUNK,
      maxSamplesPerChunk: 200,
      hardMinIngestIntervalMs: this.HARD_MIN_INGEST_INTERVAL_MS,
      recentDataPriorityMetrics: this.RECENT_DATA_PRIORITY_METRICS,
      recentDataQueryLimit: this.RECENT_DATA_QUERY_LIMIT,
      busyTimeoutMs: 5000,
    };
  }
  public getDebugSnapshot(): Record<string, unknown> {
    return {
      ingestInProgress: this._ingestInProgress,
      uploadInProgress: this._uploadInProgress,
      lastIngestAttemptTime: this._lastIngestAttemptTime,
      lastUploadAttemptTime: this._lastUploadAttemptTime,
      uploadBackoffMs: this._uploadBackoffMs,
      consecutiveUploadErrors: this._consecutiveUploadErrors,
      lastUploadErrorTime: this._lastUploadErrorTime,
      ingestBackoffMs: this._ingestBackoffMs,
      consecutiveIngestErrors: this._consecutiveIngestErrors,
      lastIngestErrorTime: this._lastIngestErrorTime,
      sessionSamplesUploaded: this._sessionSamplesUploaded,
      lastSyncResult: this._lastSyncResult,
      lastSourceTimes: Object.fromEntries(this._lastSourceTime),
      activeDriverId: this._activeDriverId,
      hotLaneLastCompletedAt: this._hotLaneLastCompletedAt,
      coldLaneLastCompletedAt: this._coldLaneLastCompletedAt,
      coldLaneLastProgressAt: this._coldLaneLastProgressAt,
      healthSyncStartedAt: this._healthSyncStartedAt,
      changeLaneLastCompletedAt: this._changeLaneLastCompletedAt,
      hotLaneLastDurationMs: this._hotLaneLastDurationMs,
      hotLaneSloViolations: this._hotLaneSloViolations,
      isColdOverdue: this.isColdOverdue(),
      isColdStarved: this.isColdStarved(),
      isChangeLaneDue: this.isChangeLaneDue(),
      isHotLaneStale: this.isHotLaneStale(),
      consecutiveColdPreemptions: this._consecutiveColdPreemptions,
      isColdPreemptionExcessive: this.isColdPreemptionExcessive(),
      coldResumeIndex: this._coldResumeIndex,
    };
  }
  public isHealthy(now: number = Date.now()): boolean {
    return !this.isInUploadBackoff(now) && !this.isInIngestBackoff(now);
  }
}
export function getHealthSyncCoordinationState(): HealthSyncCoordinationState {
  return HealthSyncCoordinationState.getInstance();
}
