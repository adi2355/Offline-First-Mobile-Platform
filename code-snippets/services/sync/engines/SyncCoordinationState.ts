export type SyncSource =
  | 'DATA_CHANGE_EVENT'
  | 'NETWORK_RECONNECT'
  | 'WEBSOCKET_RECONNECT'
  | 'APP_FOREGROUND'
  | 'PERIODIC_INTERVAL'
  | 'MANUAL_REFRESH'
  | 'PENDING_SESSIONS'
  | 'AUTH_REFRESH'
  | 'AUTH_SIGNIN'
  | 'AUTH_GOOGLE'
  | 'AUTH_PHONE'
  | 'AUTH_CACHED_SESSION'
  | 'AUTH_CONTEXT'
  | 'DATASYNC_INITIALIZE'
  | 'DATASYNC_START'
  | 'REPAIR_INTEGRITY'
  | 'EXTERNAL';
export class SyncCoordinationState {
  private static instance: SyncCoordinationState | null = null;
  public static getInstance(): SyncCoordinationState {
    if (!SyncCoordinationState.instance) {
      SyncCoordinationState.instance = new SyncCoordinationState();
    }
    return SyncCoordinationState.instance;
  }
  public static reset(): void {
    if (SyncCoordinationState.instance) {
      SyncCoordinationState.instance.resetState();
    }
    SyncCoordinationState.instance = null;
  }
  public static hasInstance(): boolean {
    return SyncCoordinationState.instance !== null;
  }
  public readonly SOURCE_COOLDOWN_MS = 30_000;
  public readonly MIN_BACKOFF_MS = 5_000;
  public readonly MAX_BACKOFF_MS = 300_000;
  public readonly BACKOFF_MULTIPLIER = 2;
  public readonly BACKOFF_JITTER_FACTOR = 0.2;
  public readonly MANUAL_OVERRIDE_COOLDOWN_MS = 30_000;
  public readonly MIN_SYNC_DEBOUNCE_MS = 30_000;
  public readonly SMART_SYNC_THRESHOLD_MS = 60_000;
  public readonly HARD_MIN_SYNC_INTERVAL_MS = 5_000;
  public readonly CACHE_BUST_COOLDOWN_MS = 3_000;
  public readonly MAX_ALLOWED_CLOCK_SKEW_MS = 5 * 60 * 1000;
  public readonly ACTIVE_SYNC_INTERVAL_MS = 600_000;
  public readonly BACKGROUND_SYNC_INTERVAL_MS = 1_200_000;
  private _initializationPromise: Promise<void> | null = null;
  private _initializationInProgress = false;
  private _activeSyncPromise: Promise<void> | null = null;
  private _syncInProgress = false;
  private _lastSyncSourceTime: Map<SyncSource, number> = new Map();
  private _lastSyncAttemptTime = 0;
  private _backoffMs = 0;
  private _consecutiveRateLimitErrors = 0;
  private _lastRateLimitErrorTime = 0;
  private _lastManualOverrideTime = 0;
  private _lastCacheBustTime = 0;
  private constructor() {
  }
  public get initializationPromise(): Promise<void> | null {
    return this._initializationPromise;
  }
  public get initializationInProgress(): boolean {
    return this._initializationInProgress;
  }
  public startInitialization(promise: Promise<void>): void {
    if (this._initializationInProgress) {
      throw new Error('SyncCoordinationState: Initialization already in progress');
    }
    this._initializationInProgress = true;
    this._initializationPromise = promise;
    promise.finally(() => {
      this._initializationInProgress = false;
      this._initializationPromise = null;
    });
  }
  public get activeSyncPromise(): Promise<void> | null {
    return this._activeSyncPromise;
  }
  public get syncInProgress(): boolean {
    return this._syncInProgress;
  }
  public acquireSyncLock(promise: Promise<void>): boolean {
    if (this._syncInProgress) {
      return false;
    }
    this._syncInProgress = true;
    this._activeSyncPromise = promise;
    promise
      .catch(() => {
      })
      .finally(() => {
        this._syncInProgress = false;
        this._activeSyncPromise = null;
      });
    return true;
  }
  public forceReleaseSyncLock(): void {
    this._syncInProgress = false;
    this._activeSyncPromise = null;
  }
  public getLastSyncSourceTime(source: SyncSource): number {
    return this._lastSyncSourceTime.get(source) ?? 0;
  }
  public recordSyncSourceTime(source: SyncSource, timestamp: number = Date.now()): void {
    this._lastSyncSourceTime.set(source, timestamp);
  }
  public isSourceInCooldown(source: SyncSource, now: number = Date.now()): boolean {
    const lastTime = this._lastSyncSourceTime.get(source) ?? 0;
    return now - lastTime < this.SOURCE_COOLDOWN_MS;
  }
  public clearSourceCooldown(source: SyncSource): void {
    this._lastSyncSourceTime.delete(source);
  }
  public get lastSyncAttemptTime(): number {
    return this._lastSyncAttemptTime;
  }
  public recordSyncAttempt(timestamp: number = Date.now()): void {
    this._lastSyncAttemptTime = timestamp;
  }
  public isWithinHardMinInterval(now: number = Date.now()): boolean {
    return now - this._lastSyncAttemptTime < this.HARD_MIN_SYNC_INTERVAL_MS;
  }
  public isWithinSoftDebounce(now: number = Date.now()): boolean {
    return now - this._lastSyncAttemptTime < this.MIN_SYNC_DEBOUNCE_MS;
  }
  public get backoffMs(): number {
    return this._backoffMs;
  }
  public get consecutiveRateLimitErrors(): number {
    return this._consecutiveRateLimitErrors;
  }
  public get lastRateLimitErrorTime(): number {
    return this._lastRateLimitErrorTime;
  }
  public recordRateLimitError(timestamp: number = Date.now()): number {
    this._consecutiveRateLimitErrors++;
    this._lastRateLimitErrorTime = timestamp;
    const baseBackoff = this.MIN_BACKOFF_MS * Math.pow(
      this.BACKOFF_MULTIPLIER,
      this._consecutiveRateLimitErrors - 1
    );
    const jitter = baseBackoff * this.BACKOFF_JITTER_FACTOR * Math.random();
    this._backoffMs = Math.min(baseBackoff + jitter, this.MAX_BACKOFF_MS);
    return this._backoffMs;
  }
  public isInBackoff(now: number = Date.now()): boolean {
    if (this._backoffMs === 0) return false;
    return now - this._lastRateLimitErrorTime < this._backoffMs;
  }
  public getRemainingBackoffMs(now: number = Date.now()): number {
    if (this._backoffMs === 0) return 0;
    const elapsed = now - this._lastRateLimitErrorTime;
    return Math.max(0, this._backoffMs - elapsed);
  }
  public clearBackoff(): void {
    this._backoffMs = 0;
    this._consecutiveRateLimitErrors = 0;
    this._lastRateLimitErrorTime = 0;
  }
  public get lastManualOverrideTime(): number {
    return this._lastManualOverrideTime;
  }
  public recordManualOverride(timestamp: number = Date.now()): void {
    this._lastManualOverrideTime = timestamp;
  }
  public canManualOverride(now: number = Date.now()): boolean {
    return now - this._lastManualOverrideTime >= this.MANUAL_OVERRIDE_COOLDOWN_MS;
  }
  public get lastCacheBustTime(): number {
    return this._lastCacheBustTime;
  }
  public recordCacheBust(timestamp: number = Date.now()): void {
    this._lastCacheBustTime = timestamp;
  }
  public isCacheBustInCooldown(now: number = Date.now()): boolean {
    return now - this._lastCacheBustTime < this.CACHE_BUST_COOLDOWN_MS;
  }
  private resetState(): void {
    this._initializationPromise = null;
    this._initializationInProgress = false;
    this._activeSyncPromise = null;
    this._syncInProgress = false;
    this._lastSyncSourceTime.clear();
    this._lastSyncAttemptTime = 0;
    this._backoffMs = 0;
    this._consecutiveRateLimitErrors = 0;
    this._lastRateLimitErrorTime = 0;
    this._lastManualOverrideTime = 0;
    this._lastCacheBustTime = 0;
  }
  public getDebugSnapshot(): Record<string, unknown> {
    return {
      initializationInProgress: this._initializationInProgress,
      syncInProgress: this._syncInProgress,
      lastSyncAttemptTime: this._lastSyncAttemptTime,
      backoffMs: this._backoffMs,
      consecutiveRateLimitErrors: this._consecutiveRateLimitErrors,
      lastRateLimitErrorTime: this._lastRateLimitErrorTime,
      lastManualOverrideTime: this._lastManualOverrideTime,
      lastCacheBustTime: this._lastCacheBustTime,
      lastSyncSourceTimes: Object.fromEntries(this._lastSyncSourceTime),
    };
  }
}
export function getSyncCoordinationState(): SyncCoordinationState {
  return SyncCoordinationState.getInstance();
}
