import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import type {
  IHealthIngestionDriver,
  LaneResult,
  LaneStatus,
  NativeIngestError,
  ColdLaneProgressEvent,
  NativeInitConfig,
  LaneDegradation,
} from '../types/ingestion-driver.types';
import { NativeErrorCode, NATIVE_ERROR_RETRYABLE } from '../types/ingestion-driver.types';
import { logger } from '../../../utils/logger';
interface NativeLaneResultRaw {
  success: boolean;
  samplesInserted: number;
  samplesSkipped: number;
  durationMs: number;
  metricsProcessed: string[];
  errors: Array<{
    code: string;
    message: string;
    metricCode?: string;
  }>;
  partial: boolean;
  metricDiagnostics?: Array<{
    metricCode: string;
    newestSampleTimestampMs: number | null;
    oldestSampleTimestampMs: number | null;
    samplesInserted: number;
    samplesSkipped: number;
  }>;
  coldCursorsAdvanced?: number;
}
interface NativeHealthIngestModuleType {
  initialize(config: Record<string, unknown>): Promise<boolean>;
  ingestHot(
    userId: string,
    sourceId: string,
    metricCodes: string[],
    budgetMs: number
  ): Promise<NativeLaneResultRaw>;
  ingestCold(
    userId: string,
    sourceId: string,
    chunkBudgetMs: number,
    maxChunks: number
  ): Promise<NativeLaneResultRaw>;
  ingestChanges(
    userId: string,
    sourceId: string
  ): Promise<NativeLaneResultRaw>;
  cancelHot(): void;
  cancelCold(): void;
  cancelChanges(): void;
  isHealthKitAvailable(): Promise<boolean>;
  getLaneStatuses(): Promise<{
    hot: LaneStatus;
    cold: LaneStatus;
    change: LaneStatus;
  }>;
  setBackgroundDeliveryEnabled(enabled: boolean): Promise<boolean>;
  clearCredentialsAndStopDelivery(): Promise<boolean>;
}
const DEFAULT_HOT_BUDGET_MS = 2000;
const DEFAULT_COLD_CHUNK_BUDGET_MS = 500;
const NATIVE_QUERY_TIMEOUT_MS = 30_000;
const BRIDGE_MARGIN_MS = 5_000;
const BRIDGE_TIMEOUT_BASE_MS = 10_000;
const CHANGE_LANE_TIMEOUT_MS = 120_000;
const NATIVE_EVENTS = {
  COLD_PROGRESS: 'NativeHealthIngest_ColdProgress',
  ERROR: 'NativeHealthIngest_Error',
} as const;
const COLD_SAFETY_NET_TIMEOUT_MS = 15 * 60 * 1000;
function mapNativeError(raw: { code: string; message: string; metricCode?: string }): NativeIngestError {
  const code = Object.values(NativeErrorCode).includes(raw.code as NativeErrorCode)
    ? (raw.code as NativeErrorCode)
    : NativeErrorCode.NATIVE_BRIDGE_ERROR;
  return {
    code,
    message: raw.message,
    metricCode: raw.metricCode,
    retryable: NATIVE_ERROR_RETRYABLE[code] ?? false,
  };
}
function mapNativeResult(raw: NativeLaneResultRaw): LaneResult {
  return {
    success: raw.success,
    samplesInserted: raw.samplesInserted,
    samplesSkipped: raw.samplesSkipped,
    durationMs: raw.durationMs,
    metricsProcessed: raw.metricsProcessed,
    errors: raw.errors.map(mapNativeError),
    partial: raw.partial,
    coldCursorsAdvanced: raw.coldCursorsAdvanced ?? 0,
    metricDiagnostics: (raw.metricDiagnostics ?? []).map(d => ({
      metricCode: d.metricCode,
      newestSampleTimestampMs: d.newestSampleTimestampMs,
      oldestSampleTimestampMs: d.oldestSampleTimestampMs,
      samplesInserted: d.samplesInserted,
      samplesSkipped: d.samplesSkipped,
    })),
  };
}
function bridgeErrorResult(message: string, durationMs: number = 0): LaneResult {
  return {
    success: false,
    samplesInserted: 0,
    samplesSkipped: 0,
    durationMs,
    metricsProcessed: [],
    errors: [{
      code: NativeErrorCode.NATIVE_BRIDGE_ERROR,
      message,
      retryable: true,
    }],
    partial: false,
    coldCursorsAdvanced: 0,
    metricDiagnostics: [],
  };
}
function createInitialLaneStatus(): LaneStatus {
  return {
    running: false,
    lastCompletedAt: null,
    lastFailedAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    paused: false,
  };
}
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
const NATIVE_DRIVER_DEGRADATIONS: ReadonlyMap<string, LaneDegradation> = new Map();
export class NativeHealthIngestionDriver implements IHealthIngestionDriver {
  readonly driverId = 'native' as const;
  private readonly nativeModule: NativeHealthIngestModuleType;
  private readonly eventEmitter: NativeEventEmitter;
  private hotStatus: LaneStatus;
  private coldStatus: LaneStatus;
  private changeStatus: LaneStatus;
  private disposed = false;
  private nativeInitialized = false;
  private coldMaxChunks = 10;
  private coldProgressListener: ReturnType<NativeEventEmitter['addListener']> | null = null;
  private errorEventListener: ReturnType<NativeEventEmitter['addListener']> | null = null;
  constructor() {
    const module = NativeModules.NativeHealthIngest as NativeHealthIngestModuleType | undefined;
    if (!module) {
      throw new Error(
        'NativeHealthIngestionDriver: NativeModules.NativeHealthIngest is not available. ' +
        'Ensure the native module is properly linked and you are running on a real device.'
      );
    }
    this.nativeModule = module;
    this.eventEmitter = new NativeEventEmitter(NativeModules.NativeHealthIngest);
    this.hotStatus = createInitialLaneStatus();
    this.coldStatus = createInitialLaneStatus();
    this.changeStatus = createInitialLaneStatus();
    this.errorEventListener = this.eventEmitter.addListener(
      NATIVE_EVENTS.ERROR,
      (event: { code: string; message: string; metricCode?: string }) => {
        logger.error('[NativeHealthIngestionDriver] Native error event', {
          code: event.code,
          message: event.message,
          metricCode: event.metricCode,
        });
      }
    );
  }
  async initializeNativeModule(config: NativeInitConfig): Promise<void> {
    if (this.disposed) {
      throw new Error('NativeHealthIngestionDriver: Cannot initialize after disposal');
    }
    if (this.nativeInitialized) {
      logger.info('[NativeHealthIngestionDriver] Already initialized, skipping re-initialization');
      return;
    }
    try {
      const bridgeConfig: Record<string, unknown> = {
        dbPath: config.dbPath,
        metrics: config.metrics.map(m => ({
          metricCode: m.metricCode,
          hkIdentifier: m.hkIdentifier,
          queryUnit: m.queryUnit,
          valueKind: m.valueKind,
          isCategory: m.isCategory,
          ...(m.minBound !== undefined && { minBound: m.minBound }),
          ...(m.maxBound !== undefined && { maxBound: m.maxBound }),
          ...(m.canonicalUnit !== undefined && { canonicalUnit: m.canonicalUnit }),
        })),
        laneConstants: {
          hotBudgetMs: config.laneConstants.hotBudgetMs,
          recentDataQueryLimit: config.laneConstants.recentDataQueryLimit,
          hotLookbackDays: config.laneConstants.hotLookbackDays,
          hotOverlapMs: config.laneConstants.hotOverlapMs,
          hotUiWindowMs: config.laneConstants.hotUiWindowMs,
          hotCatchupChunkWindowMs: config.laneConstants.hotCatchupChunkWindowMs,
          hotCatchupMaxChunksPerRun: config.laneConstants.hotCatchupMaxChunksPerRun,
          hotCatchupQueryLimit: config.laneConstants.hotCatchupQueryLimit,
          coldChunkBudgetMs: config.laneConstants.coldChunkBudgetMs,
          coldMaxChunks: config.laneConstants.coldMaxChunks,
          coldBackfillDays: config.laneConstants.coldBackfillDays,
          coldGraceWindowDays: config.laneConstants.coldGraceWindowDays,
          coldChunkWindowMs: config.laneConstants.coldChunkWindowMs,
          coldQueryLimitPerChunk: config.laneConstants.coldQueryLimitPerChunk,
          maxSamplesPerChunk: config.laneConstants.maxSamplesPerChunk,
          busyTimeoutMs: config.laneConstants.busyTimeoutMs,
          hotTwoPassEnabled: config.laneConstants.hotTwoPassEnabled,
        },
      };
      const success = await withTimeout(
        this.nativeModule.initialize(bridgeConfig),
        BRIDGE_TIMEOUT_BASE_MS,
        'NativeHealthIngest.initialize'
      );
      if (!success) {
        throw new Error('NativeHealthIngest.initialize returned false');
      }
      this.nativeInitialized = true;
      this.coldMaxChunks = config.laneConstants.coldMaxChunks;
      logger.info('[NativeHealthIngestionDriver] Native module initialized', {
        dbPath: config.dbPath,
        metricCount: config.metrics.length,
        coldMaxChunks: this.coldMaxChunks,
      });
    } catch (error: unknown) {
      logger.error('[NativeHealthIngestionDriver] Failed to initialize native module', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async ingestHot(
    userId: string,
    sourceId: string,
    metricCodes: string[],
    options: { budgetMs?: number; abortSignal?: AbortSignal } = {}
  ): Promise<LaneResult> {
    if (this.disposed) {
      return bridgeErrorResult('Driver disposed');
    }
    const startTime = Date.now();
    const budgetMs = options.budgetMs ?? DEFAULT_HOT_BUDGET_MS;
    this.hotStatus.running = true;
    try {
      this.cancelCold();
      const hotTimeout = Math.max(budgetMs, NATIVE_QUERY_TIMEOUT_MS) + BRIDGE_MARGIN_MS;
      const rawResult = await withTimeout(
        this.nativeModule.ingestHot(userId, sourceId, metricCodes, budgetMs),
        hotTimeout,
        'NativeHealthIngest.ingestHot',
        () => this.cancelHot()
      );
      const laneResult = mapNativeResult(rawResult);
      if (laneResult.success) {
        this.hotStatus.lastCompletedAt = Date.now();
        this.hotStatus.consecutiveFailures = 0;
        this.hotStatus.lastErrorCode = null;
      } else {
        this.hotStatus.lastFailedAt = Date.now();
        this.hotStatus.consecutiveFailures++;
        this.hotStatus.lastErrorCode = laneResult.errors[0]?.code ?? null;
      }
      return laneResult;
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      this.hotStatus.lastFailedAt = Date.now();
      this.hotStatus.consecutiveFailures++;
      this.hotStatus.lastErrorCode = NativeErrorCode.NATIVE_BRIDGE_ERROR;
      logger.error('[NativeHealthIngestionDriver] Hot lane bridge call failed', {
        durationMs,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return bridgeErrorResult(
        error instanceof Error ? error.message : String(error),
        durationMs
      );
    } finally {
      this.hotStatus.running = false;
    }
  }
  async ingestCold(
    userId: string,
    sourceId: string,
    options: { chunkBudgetMs?: number; maxChunks?: number; abortSignal?: AbortSignal } = {}
  ): Promise<LaneResult> {
    if (this.disposed) {
      return bridgeErrorResult('Driver disposed');
    }
    const startTime = Date.now();
    const chunkBudgetMs = options.chunkBudgetMs ?? DEFAULT_COLD_CHUNK_BUDGET_MS;
    const maxChunks = options.maxChunks ?? this.coldMaxChunks;
    this.coldStatus.running = true;
    this.coldStatus.paused = false;
    this.setupColdProgressListener();
    const abortHandler = () => this.cancelCold();
    options.abortSignal?.addEventListener('abort', abortHandler, { once: true });
    try {
      const coldTimeout = maxChunks > 0
        ? BRIDGE_TIMEOUT_BASE_MS + (maxChunks * chunkBudgetMs) + NATIVE_QUERY_TIMEOUT_MS
        : COLD_SAFETY_NET_TIMEOUT_MS;
      if (maxChunks <= 0) {
        logger.warn('[NativeHealthIngestionDriver] Cold lane called with maxChunks=0 (unbounded). ' +
          'This should not happen — HealthSyncService should always pass explicit maxChunks from LaneConstants. ' +
          'Using safety-net timeout.', {
          chunkBudgetMs,
          coldTimeout,
        });
      }
      const rawResult = await withTimeout(
        this.nativeModule.ingestCold(userId, sourceId, chunkBudgetMs, maxChunks),
        coldTimeout,
        'NativeHealthIngest.ingestCold'
      );
      const laneResult = mapNativeResult(rawResult);
      if (laneResult.success) {
        this.coldStatus.lastCompletedAt = Date.now();
        this.coldStatus.consecutiveFailures = 0;
        this.coldStatus.lastErrorCode = null;
      } else {
        this.coldStatus.lastFailedAt = Date.now();
        this.coldStatus.consecutiveFailures++;
        this.coldStatus.lastErrorCode = laneResult.errors[0]?.code ?? null;
      }
      return laneResult;
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      this.coldStatus.lastFailedAt = Date.now();
      this.coldStatus.consecutiveFailures++;
      this.coldStatus.lastErrorCode = NativeErrorCode.NATIVE_BRIDGE_ERROR;
      logger.error('[NativeHealthIngestionDriver] Cold lane bridge call failed', {
        durationMs,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return bridgeErrorResult(
        error instanceof Error ? error.message : String(error),
        durationMs
      );
    } finally {
      this.coldStatus.running = false;
      this.teardownColdProgressListener();
      options.abortSignal?.removeEventListener('abort', abortHandler);
    }
  }
  async ingestChanges(
    userId: string,
    sourceId: string,
    options?: { abortSignal?: AbortSignal }
  ): Promise<LaneResult> {
    if (this.disposed) {
      return bridgeErrorResult('Driver disposed');
    }
    const startTime = Date.now();
    this.changeStatus.running = true;
    try {
      const rawResult = await withTimeout(
        this.nativeModule.ingestChanges(userId, sourceId),
        CHANGE_LANE_TIMEOUT_MS,
        'NativeHealthIngest.ingestChanges',
        () => this.cancelChanges()
      );
      const laneResult = mapNativeResult(rawResult);
      if (laneResult.success) {
        this.changeStatus.lastCompletedAt = Date.now();
        this.changeStatus.consecutiveFailures = 0;
        this.changeStatus.lastErrorCode = null;
      } else {
        this.changeStatus.lastFailedAt = Date.now();
        this.changeStatus.consecutiveFailures++;
        this.changeStatus.lastErrorCode = laneResult.errors[0]?.code ?? null;
      }
      return laneResult;
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      this.changeStatus.lastFailedAt = Date.now();
      this.changeStatus.consecutiveFailures++;
      this.changeStatus.lastErrorCode = NativeErrorCode.NATIVE_BRIDGE_ERROR;
      logger.error('[NativeHealthIngestionDriver] Change lane bridge call failed', {
        durationMs,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return bridgeErrorResult(
        error instanceof Error ? error.message : String(error),
        durationMs
      );
    } finally {
      this.changeStatus.running = false;
    }
  }
  private cancelHot(): void {
    try {
      this.nativeModule.cancelHot();
      logger.info('[NativeHealthIngestionDriver] Hot lane cancel sent to native');
    } catch (error: unknown) {
      logger.warn('[NativeHealthIngestionDriver] Failed to cancel hot lane', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  cancelCold(): void {
    try {
      this.nativeModule.cancelCold();
      logger.info('[NativeHealthIngestionDriver] Cold lane cancel sent to native');
    } catch (error: unknown) {
      logger.warn('[NativeHealthIngestionDriver] Failed to cancel cold lane', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private cancelChanges(): void {
    try {
      this.nativeModule.cancelChanges();
      logger.info('[NativeHealthIngestionDriver] Change lane cancel sent to native');
    } catch (error: unknown) {
      logger.warn('[NativeHealthIngestionDriver] Failed to cancel change lane', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  async isAvailable(): Promise<boolean> {
    if (Platform.OS !== 'ios') {
      return false;
    }
    if (!NativeModules.NativeHealthIngest) {
      return false;
    }
    try {
      return await withTimeout(
        this.nativeModule.isHealthKitAvailable(),
        3000,
        'NativeHealthIngest.isHealthKitAvailable'
      );
    } catch {
      return false;
    }
  }
  getLaneStatuses(): { hot: LaneStatus; cold: LaneStatus; change: LaneStatus } {
    return {
      hot: { ...this.hotStatus },
      cold: { ...this.coldStatus },
      change: { ...this.changeStatus },
    };
  }
  async setBackgroundDeliveryEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) {
      throw new Error('NativeHealthIngestionDriver: Cannot set background delivery after disposal');
    }
    try {
      const result = await withTimeout(
        this.nativeModule.setBackgroundDeliveryEnabled(enabled),
        BRIDGE_TIMEOUT_BASE_MS,
        'NativeHealthIngest.setBackgroundDeliveryEnabled'
      );
      logger.info('[NativeHealthIngestionDriver] Background delivery flag set', {
        enabled,
        result,
      });
    } catch (error: unknown) {
      logger.error('[NativeHealthIngestionDriver] Failed to set background delivery flag', {
        enabled,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async clearCredentialsAndStopDelivery(): Promise<void> {
    try {
      await withTimeout(
        this.nativeModule.clearCredentialsAndStopDelivery(),
        BRIDGE_TIMEOUT_BASE_MS,
        'NativeHealthIngest.clearCredentialsAndStopDelivery'
      );
      logger.info('[NativeHealthIngestionDriver] Credentials cleared and delivery stopped');
    } catch (error: unknown) {
      logger.error('[NativeHealthIngestionDriver] Failed to clear credentials', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  getDegradation(): ReadonlyMap<string, LaneDegradation> {
    return NATIVE_DRIVER_DEGRADATIONS;
  }
  dispose(): void {
    this.disposed = true;
    this.cancelCold();
    this.teardownColdProgressListener();
    if (this.errorEventListener) {
      this.errorEventListener.remove();
      this.errorEventListener = null;
    }
    this.nativeModule.clearCredentialsAndStopDelivery().catch((error: unknown) => {
      logger.warn('[NativeHealthIngestionDriver] Failed to clear credentials during dispose', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    });
    logger.info('[NativeHealthIngestionDriver] Disposed');
  }
  onColdProgress(callback: (event: ColdLaneProgressEvent) => void): () => void {
    const subscription = this.eventEmitter.addListener(
      NATIVE_EVENTS.COLD_PROGRESS,
      callback
    );
    return () => subscription.remove();
  }
  private setupColdProgressListener(): void {
    this.teardownColdProgressListener();
    this.coldProgressListener = this.eventEmitter.addListener(
      NATIVE_EVENTS.COLD_PROGRESS,
      (event: ColdLaneProgressEvent) => {
        logger.debug('[NativeHealthIngestionDriver] Cold progress', {
          chunksProcessed: event.chunksProcessed,
          totalSamples: event.totalSamplesInserted,
          isRunning: event.isRunning,
        });
      }
    );
  }
  private teardownColdProgressListener(): void {
    if (this.coldProgressListener) {
      this.coldProgressListener.remove();
      this.coldProgressListener = null;
    }
  }
}
