import type {
  IHealthIngestionDriver,
  LaneResult,
  LaneStatus,
  NativeIngestError,
  LaneDegradation,
} from '../types/ingestion-driver.types';
import { NativeErrorCode, LaneDegradationReason } from '../types/ingestion-driver.types';
import type {
  HealthIngestionEngine,
  MetricIngestionConfig,
  IngestionCycleResult,
  IngestionMode,
  ColdChunkResult,
} from '../HealthIngestionEngine';
import type { HealthSyncCoordinationState } from '../HealthSyncCoordinationState';
import { isFeatureEnabled } from '../../../config/featureFlags';
import { logger } from '../../../utils/logger';
export interface JsHealthIngestionDriverDeps {
  readonly engine: HealthIngestionEngine;
  readonly getMetricConfigs: (metricCodes: string[]) => readonly MetricIngestionConfig[];
  readonly getAllMetricConfigs: () => readonly MetricIngestionConfig[];
  readonly coordinationState: HealthSyncCoordinationState;
}
const ABORT_ERROR_MESSAGE = 'Aborted' as const;
const JS_DRIVER_DEGRADATIONS: ReadonlyMap<string, LaneDegradation> = new Map();
function mapCycleResultToLaneResult(
  cycleResult: IngestionCycleResult,
  durationMs: number
): LaneResult {
  const errors: NativeIngestError[] = [];
  for (const metricResult of cycleResult.metricResults) {
    if (!metricResult.success && metricResult.errorMessage) {
      if (metricResult.errorMessage === ABORT_ERROR_MESSAGE) {
        continue;
      }
      errors.push({
        code: NativeErrorCode.HEALTHKIT_QUERY_FAILED,
        message: metricResult.errorMessage,
        metricCode: metricResult.metricCode,
        retryable: true,
      });
    }
  }
  const nonAbortFailureCount = cycleResult.metricResults.filter(
    r => !r.success && r.errorMessage !== ABORT_ERROR_MESSAGE
  ).length;
  const hasCatchupIncomplete = cycleResult.metricResults.some(
    r => r.catchupIncomplete === true
  );
  return {
    success: nonAbortFailureCount === 0,
    samplesInserted: cycleResult.totalSamplesIngested,
    samplesSkipped: 0, 
    durationMs,
    metricsProcessed: cycleResult.metricResults.map(r => r.metricCode),
    errors,
    partial: hasCatchupIncomplete,
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
export class JsHealthIngestionDriver implements IHealthIngestionDriver {
  readonly driverId = 'js' as const;
  private readonly deps: JsHealthIngestionDriverDeps;
  private hotStatus: LaneStatus;
  private coldStatus: LaneStatus;
  private changeStatus: LaneStatus;
  private coldAbortController: AbortController | null = null;
  private disposed = false;
  constructor(deps: JsHealthIngestionDriverDeps) {
    this.deps = deps;
    this.hotStatus = createInitialLaneStatus();
    this.coldStatus = createInitialLaneStatus();
    this.changeStatus = createInitialLaneStatus();
  }
  async ingestHot(
    userId: string,
    sourceId: string,
    metricCodes: string[],
    options: { budgetMs?: number; abortSignal?: AbortSignal } = {}
  ): Promise<LaneResult> {
    if (this.disposed) {
      return this.errorResult('Driver disposed', NativeErrorCode.NATIVE_BRIDGE_ERROR);
    }
    const startTime = Date.now();
    this.hotStatus.running = true;
    const budgetMs = options.budgetMs;
    let budgetTimerId: ReturnType<typeof setTimeout> | null = null;
    let budgetController: AbortController | null = null;
    let budgetExceeded = false;
    let effectiveSignal = options.abortSignal;
    if (budgetMs != null && budgetMs > 0) {
      budgetController = new AbortController();
      budgetTimerId = setTimeout(() => {
        budgetExceeded = true;
        budgetController!.abort();
      }, budgetMs);
      effectiveSignal = options.abortSignal
        ? this.combineAbortSignals(options.abortSignal, budgetController.signal)
        : budgetController.signal;
    }
    try {
      this.cancelCold();
      const metricConfigs = this.deps.getMetricConfigs(metricCodes);
      if (metricConfigs.length === 0) {
        logger.warn('[JsHealthIngestionDriver] No metric configs found for hot lane', {
          metricCodes,
        });
        return this.emptyResult(Date.now() - startTime, metricCodes);
      }
      const cycleResult = await this.deps.engine.ingestAll(
        metricConfigs,
        effectiveSignal,
        undefined, 
        'hot'
      );
      if (!cycleResult.lockAcquired) {
        logger.debug('[JsHealthIngestionDriver] HOT lane skipped (engine guard)', {
          durationMs: Date.now() - startTime,
        });
        return {
          success: true,
          samplesInserted: 0,
          samplesSkipped: 0,
          durationMs: Date.now() - startTime,
          metricsProcessed: [],
          errors: [],
          partial: true, 
          coldCursorsAdvanced: 0,
          metricDiagnostics: [],
        };
      }
      const durationMs = Date.now() - startTime;
      const laneResult = mapCycleResultToLaneResult(cycleResult, durationMs);
      if (budgetExceeded) {
        logger.info('[JsHealthIngestionDriver] HOT lane budget exceeded', {
          budgetMs,
          durationMs,
          samplesInserted: laneResult.samplesInserted,
          metricsProcessed: laneResult.metricsProcessed.length,
        });
        this.hotStatus.lastCompletedAt = Date.now();
        this.hotStatus.consecutiveFailures = 0;
        this.hotStatus.lastErrorCode = null;
        return {
          ...laneResult,
          partial: true,
        };
      }
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
      if (budgetExceeded) {
        logger.info('[JsHealthIngestionDriver] HOT lane budget exceeded (caught)', {
          budgetMs,
          durationMs,
        });
        this.hotStatus.lastCompletedAt = Date.now();
        this.hotStatus.consecutiveFailures = 0;
        return {
          success: true,
          samplesInserted: 0, 
          samplesSkipped: 0,
          durationMs,
          metricsProcessed: [],
          errors: [], 
          partial: true,
          coldCursorsAdvanced: 0, 
          metricDiagnostics: [],
        };
      }
      this.hotStatus.lastFailedAt = Date.now();
      this.hotStatus.consecutiveFailures++;
      this.hotStatus.lastErrorCode = NativeErrorCode.HEALTHKIT_QUERY_FAILED;
      logger.error('[JsHealthIngestionDriver] Hot lane failed', {
        durationMs,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return this.errorResult(
        error instanceof Error ? error.message : String(error),
        NativeErrorCode.HEALTHKIT_QUERY_FAILED,
        durationMs
      );
    } finally {
      this.hotStatus.running = false;
      if (budgetTimerId != null) {
        clearTimeout(budgetTimerId);
      }
    }
  }
  async ingestCold(
    userId: string,
    sourceId: string,
    options: { chunkBudgetMs?: number; maxChunks?: number; abortSignal?: AbortSignal } = {}
  ): Promise<LaneResult> {
    if (this.disposed) {
      return this.errorResult('Driver disposed', NativeErrorCode.NATIVE_BRIDGE_ERROR);
    }
    const startTime = Date.now();
    this.coldStatus.running = true;
    this.coldStatus.paused = false;
    this.coldAbortController = new AbortController();
    const combinedSignal = options.abortSignal
      ? this.combineAbortSignals(options.abortSignal, this.coldAbortController.signal)
      : this.coldAbortController.signal;
    try {
      const laneConstants = this.deps.coordinationState.getLaneConstants();
      const maxChunks = options.maxChunks ?? laneConstants.coldMaxChunks;
      const coldBackfillDays = laneConstants.coldBackfillDays;
      const coldGraceWindowDays = laneConstants.coldGraceWindowDays;
      const chunkWindowMs = laneConstants.coldChunkWindowMs;
      const queryLimit = laneConstants.coldQueryLimitPerChunk;
      const chunkBudgetMs = options.chunkBudgetMs ?? laneConstants.coldChunkBudgetMs;
      const totalBudgetMs = chunkBudgetMs * maxChunks;
      const allConfigs = this.deps.getAllMetricConfigs();
      if (allConfigs.length === 0) {
        logger.warn('[JsHealthIngestionDriver] No metric configs for cold lane');
        return this.emptyResult(Date.now() - startTime, []);
      }
      const fairnessEnabled = isFeatureEnabled('coldFairnessEnabled');
      const resumeIndex = this.deps.coordinationState.coldResumeIndex;
      const effectiveStartIndex = allConfigs.length > 0
        ? resumeIndex % allConfigs.length
        : 0;
      const rotatedConfigs: readonly MetricIngestionConfig[] = effectiveStartIndex > 0
        ? [...allConfigs.slice(effectiveStartIndex), ...allConfigs.slice(0, effectiveStartIndex)]
        : allConfigs;
      logger.info('[JsHealthIngestionDriver] Cold lane starting (time-cursor)', {
        maxChunks,
        coldBackfillDays,
        coldGraceWindowDays,
        chunkWindowMs,
        queryLimit,
        chunkBudgetMs,
        totalBudgetMs,
        metricCount: allConfigs.length,
        fairnessEnabled,
        coldResumeIndex: resumeIndex,
        effectiveStartIndex,
      });
      let totalChunksProcessed = 0;
      let totalSamplesInserted = 0;
      let totalCursorsAdvanced = 0;
      const metricsProcessed = new Set<string>();
      const metricComplete = new Set<string>(); 
      const errors: NativeIngestError[] = [];
      let lastChunkedMetricRotatedIndex = -1;
      if (fairnessEnabled) {
        let anyProgressThisRound = true;
        while (
          totalChunksProcessed < maxChunks &&
          anyProgressThisRound &&
          metricComplete.size < rotatedConfigs.length &&
          !combinedSignal.aborted
        ) {
          anyProgressThisRound = false;
          for (let ri = 0; ri < rotatedConfigs.length; ri++) {
            const config = rotatedConfigs[ri];
            if (!config) continue; 
            if (totalChunksProcessed >= maxChunks || combinedSignal.aborted) {
              break;
            }
            const elapsedBeforeChunk = Date.now() - startTime;
            if (elapsedBeforeChunk >= totalBudgetMs) {
              logger.info('[JsHealthIngestionDriver] Cold lane: total budget exceeded before chunk', {
                elapsedMs: elapsedBeforeChunk,
                totalBudgetMs,
                chunksProcessed: totalChunksProcessed,
                maxChunks,
              });
              break;
            }
            if (metricComplete.has(config.metricCode)) {
              continue;
            }
            const processed = await this.processOneColdChunk(
              config, userId, sourceId, coldBackfillDays, coldGraceWindowDays,
              chunkWindowMs, queryLimit, combinedSignal,
              metricsProcessed, metricComplete, errors,
            );
            totalChunksProcessed++;
            totalSamplesInserted += processed.samplesInserted;
            if (processed.cursorUpdated) {
              totalCursorsAdvanced++;
            }
            lastChunkedMetricRotatedIndex = ri;
            if (processed.samplesInserted > 0 || processed.cursorUpdated) {
              anyProgressThisRound = true;
            }
            const elapsedAfterChunk = Date.now() - startTime;
            if (elapsedAfterChunk >= totalBudgetMs) {
              logger.info('[JsHealthIngestionDriver] Cold lane: total budget exceeded after chunk', {
                elapsedMs: elapsedAfterChunk,
                totalBudgetMs,
                chunksProcessed: totalChunksProcessed,
                maxChunks,
                lastMetric: config.metricCode,
              });
              break;
            }
          }
        }
      } else {
        for (let ri = 0; ri < rotatedConfigs.length; ri++) {
          const config = rotatedConfigs[ri];
          if (!config) continue; 
          if (totalChunksProcessed >= maxChunks || combinedSignal.aborted) {
            break;
          }
          const seqElapsedBefore = Date.now() - startTime;
          if (seqElapsedBefore >= totalBudgetMs) {
            logger.info('[JsHealthIngestionDriver] Cold lane (seq): budget exceeded before metric', {
              elapsedMs: seqElapsedBefore,
              totalBudgetMs,
              chunksProcessed: totalChunksProcessed,
              maxChunks,
            });
            break;
          }
          while (
            totalChunksProcessed < maxChunks &&
            !metricComplete.has(config.metricCode) &&
            !combinedSignal.aborted
          ) {
            const processed = await this.processOneColdChunk(
              config, userId, sourceId, coldBackfillDays, coldGraceWindowDays,
              chunkWindowMs, queryLimit, combinedSignal,
              metricsProcessed, metricComplete, errors,
            );
            totalChunksProcessed++;
            totalSamplesInserted += processed.samplesInserted;
            if (processed.cursorUpdated) {
              totalCursorsAdvanced++;
            }
            lastChunkedMetricRotatedIndex = ri;
            if (processed.samplesInserted === 0 && !processed.coldComplete) {
            }
            const seqElapsedAfter = Date.now() - startTime;
            if (seqElapsedAfter >= totalBudgetMs) {
              logger.info('[JsHealthIngestionDriver] Cold lane (seq): budget exceeded after chunk', {
                elapsedMs: seqElapsedAfter,
                totalBudgetMs,
                chunksProcessed: totalChunksProcessed,
                maxChunks,
                lastMetric: config.metricCode,
              });
              break;
            }
          }
        }
      }
      if (lastChunkedMetricRotatedIndex >= 0 && allConfigs.length > 0) {
        const originalIndex = (effectiveStartIndex + lastChunkedMetricRotatedIndex + 1) % allConfigs.length;
        this.deps.coordinationState.setColdResumeIndex(originalIndex);
        logger.debug('[JsHealthIngestionDriver] Cold resume index updated', {
          lastChunkedMetricRotatedIndex,
          effectiveStartIndex,
          newResumeIndex: originalIndex,
        });
      }
      if (combinedSignal.aborted) {
        this.coldStatus.paused = true;
        return {
          success: true,
          samplesInserted: totalSamplesInserted,
          samplesSkipped: 0,
          durationMs: Date.now() - startTime,
          metricsProcessed: [...metricsProcessed],
          errors: [{ code: NativeErrorCode.COLD_CANCELLED, message: 'Cold lane cancelled by hot preemption', retryable: false }],
          partial: true,
          coldCursorsAdvanced: totalCursorsAdvanced,
          metricDiagnostics: [],
        };
      }
      const durationMs = Date.now() - startTime;
      const allMetricsComplete = metricComplete.size >= allConfigs.length;
      const budgetExhausted = durationMs >= totalBudgetMs;
      logger.info('[JsHealthIngestionDriver] Cold lane completed (time-cursor)', {
        totalChunksProcessed,
        totalSamplesInserted,
        metricsProcessed: metricsProcessed.size,
        metricsComplete: metricComplete.size,
        allMetricsComplete,
        budgetExhausted,
        errors: errors.length,
        durationMs,
        totalBudgetMs,
      });
      const nonAbortErrors = errors.filter(e => e.message !== 'Aborted');
      const success = nonAbortErrors.length === 0;
      if (success) {
        this.coldStatus.lastCompletedAt = Date.now();
        this.coldStatus.consecutiveFailures = 0;
        this.coldStatus.lastErrorCode = null;
      } else {
        this.coldStatus.lastFailedAt = Date.now();
        this.coldStatus.consecutiveFailures++;
        this.coldStatus.lastErrorCode = nonAbortErrors[0]?.code ?? null;
      }
      const partial = !allMetricsComplete &&
        (totalChunksProcessed >= maxChunks || budgetExhausted);
      return {
        success,
        samplesInserted: totalSamplesInserted,
        samplesSkipped: 0, 
        durationMs,
        metricsProcessed: [...metricsProcessed],
        errors: nonAbortErrors,
        partial,
        coldCursorsAdvanced: totalCursorsAdvanced,
        metricDiagnostics: [], 
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      if (this.coldAbortController?.signal.aborted) {
        this.coldStatus.paused = true;
        return {
          success: true,
          samplesInserted: 0,
          samplesSkipped: 0,
          durationMs,
          metricsProcessed: [],
          errors: [{ code: NativeErrorCode.COLD_CANCELLED, message: 'Cold lane cancelled by hot preemption', retryable: false }],
          partial: true,
          coldCursorsAdvanced: 0,
          metricDiagnostics: [],
        };
      }
      this.coldStatus.lastFailedAt = Date.now();
      this.coldStatus.consecutiveFailures++;
      this.coldStatus.lastErrorCode = NativeErrorCode.HEALTHKIT_QUERY_FAILED;
      logger.error('[JsHealthIngestionDriver] Cold lane failed', {
        durationMs,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return this.errorResult(
        error instanceof Error ? error.message : String(error),
        NativeErrorCode.HEALTHKIT_QUERY_FAILED,
        durationMs
      );
    } finally {
      this.coldStatus.running = false;
      this.coldAbortController = null;
    }
  }
  async ingestChanges(
    userId: string,
    sourceId: string,
    options?: { abortSignal?: AbortSignal }
  ): Promise<LaneResult> {
    if (this.disposed) {
      return this.errorResult('Driver disposed', NativeErrorCode.NATIVE_BRIDGE_ERROR);
    }
    const startTime = Date.now();
    this.changeStatus.running = true;
    try {
      const allConfigs = this.deps.getAllMetricConfigs();
      const cycleResult = await this.deps.engine.ingestAll(
        allConfigs,
        options?.abortSignal,
        undefined, 
        'change'
      );
      if (!cycleResult.lockAcquired) {
        logger.debug('[JsHealthIngestionDriver] CHANGE lane skipped (engine guard)', {
          durationMs: Date.now() - startTime,
        });
        return {
          success: true,
          samplesInserted: 0,
          samplesSkipped: 0,
          durationMs: Date.now() - startTime,
          metricsProcessed: [],
          errors: [],
          partial: true, 
          coldCursorsAdvanced: 0,
          metricDiagnostics: [],
        };
      }
      const durationMs = Date.now() - startTime;
      const laneResult = mapCycleResultToLaneResult(cycleResult, durationMs);
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
      this.changeStatus.lastErrorCode = NativeErrorCode.HEALTHKIT_QUERY_FAILED;
      logger.error('[JsHealthIngestionDriver] Change lane failed', {
        durationMs,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return this.errorResult(
        error instanceof Error ? error.message : String(error),
        NativeErrorCode.HEALTHKIT_QUERY_FAILED,
        durationMs
      );
    } finally {
      this.changeStatus.running = false;
    }
  }
  cancelCold(): void {
    if (this.coldAbortController && !this.coldAbortController.signal.aborted) {
      this.coldAbortController.abort();
      logger.info('[JsHealthIngestionDriver] Cold lane cancelled by preemption');
    }
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  getLaneStatuses(): { hot: LaneStatus; cold: LaneStatus; change: LaneStatus } {
    return {
      hot: { ...this.hotStatus },
      cold: { ...this.coldStatus },
      change: { ...this.changeStatus },
    };
  }
  dispose(): void {
    this.disposed = true;
    this.cancelCold();
    logger.info('[JsHealthIngestionDriver] Disposed');
  }
  getDegradation(): ReadonlyMap<string, LaneDegradation> {
    return JS_DRIVER_DEGRADATIONS;
  }
  private async processOneColdChunk(
    config: MetricIngestionConfig,
    userId: string,
    sourceId: string,
    coldBackfillDays: number,
    coldGraceWindowDays: number,
    chunkWindowMs: number,
    queryLimit: number,
    abortSignal: AbortSignal,
    metricsProcessed: Set<string>,
    metricComplete: Set<string>,
    errors: NativeIngestError[],
  ): Promise<{ samplesInserted: number; coldComplete: boolean; cursorUpdated: boolean }> {
    try {
      const chunkResult: ColdChunkResult =
        await this.deps.engine.ingestMetricColdChunk(config, {
          userId,
          sourceId,
          coldBackfillDays,
          coldGraceWindowDays,
          chunkWindowMs,
          queryLimit,
          abortSignal,
        });
      metricsProcessed.add(config.metricCode);
      if (chunkResult.coldComplete) {
        metricComplete.add(config.metricCode);
        logger.debug('[JsHealthIngestionDriver] Cold metric complete', {
          metricCode: config.metricCode,
          coldBackfillEndTs: chunkResult.coldBackfillEndTs,
        });
      }
      if (!chunkResult.success && chunkResult.errorMessage !== 'Aborted') {
        errors.push({
          code: NativeErrorCode.HEALTHKIT_QUERY_FAILED,
          message: chunkResult.errorMessage ?? 'Unknown cold chunk error',
          metricCode: config.metricCode,
          retryable: true,
        });
      }
      return {
        samplesInserted: chunkResult.samplesIngested,
        coldComplete: chunkResult.coldComplete,
        cursorUpdated: chunkResult.cursorUpdated,
      };
    } catch (chunkError: unknown) {
      const errorMessage = chunkError instanceof Error
        ? chunkError.message
        : String(chunkError);
      logger.error('[JsHealthIngestionDriver] Cold chunk error for metric', {
        metricCode: config.metricCode,
        error: chunkError instanceof Error
          ? { name: chunkError.name, message: chunkError.message }
          : { name: 'Error', message: errorMessage },
      });
      errors.push({
        code: NativeErrorCode.HEALTHKIT_QUERY_FAILED,
        message: errorMessage,
        metricCode: config.metricCode,
        retryable: true,
      });
      return { samplesInserted: 0, coldComplete: false, cursorUpdated: false };
    }
  }
  private errorResult(
    message: string,
    code: NativeErrorCode,
    durationMs: number = 0
  ): LaneResult {
    return {
      success: false,
      samplesInserted: 0,
      samplesSkipped: 0,
      durationMs,
      metricsProcessed: [],
      errors: [{ code, message, retryable: code !== NativeErrorCode.NATIVE_BRIDGE_ERROR }],
      partial: false,
      coldCursorsAdvanced: 0,
      metricDiagnostics: [],
    };
  }
  private emptyResult(durationMs: number, metricsProcessed: string[]): LaneResult {
    return {
      success: true,
      samplesInserted: 0,
      samplesSkipped: 0,
      durationMs,
      metricsProcessed,
      errors: [],
      partial: false,
      coldCursorsAdvanced: 0,
      metricDiagnostics: [],
    };
  }
  private combineAbortSignals(
    signalA: AbortSignal,
    signalB: AbortSignal
  ): AbortSignal {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    if (signalA.aborted || signalB.aborted) {
      controller.abort();
      return controller.signal;
    }
    signalA.addEventListener('abort', abort, { once: true });
    signalB.addEventListener('abort', abort, { once: true });
    return controller.signal;
  }
}
