import {
  type HealthMetricCode,
  isHealthMetricCodeUnknown,
  getMetricDefinition,
  getValueKind,
  type HealthMetricValueKind,
  tryGetMetricDefinitionUnknown,
  isCategoryCodeAllowed,
  isValueInBounds,
  isUnitAllowedForMetric,
  tryNormalizeToCanonicalUnit,
  resolveMetricUnitAlias,
} from '@shared/contracts';
import { logger } from '../../utils/logger';
import type { HealthSampleRepository, InsertHealthSampleInput } from '../../repositories/health/HealthSampleRepository';
import type { HealthCursorRepository, DomainHealthCursor, CursorUpdateResult } from '../../repositories/health/HealthCursorRepository';
import { getHealthSyncCoordinationState, type HealthSyncCoordinationState } from './HealthSyncCoordinationState';
import { metrics } from '../metrics/Metrics';
import type { CooperativeYieldController } from '../sync/SyncScheduler';
import { resolveHealthSourceId } from './HealthSourceRegistry';
import { type CursorScope, DEFAULT_CURSOR_SCOPE } from '../../repositories/health/HealthCursorRepository';
import { isFeatureEnabled } from '../../config/featureFlags';
import type { LocalRollupDirtyKeyRepository } from '../../repositories/health/LocalRollupDirtyKeyRepository';
import type { LocalSleepDirtyNightRepository } from '../../repositories/health/LocalSleepDirtyNightRepository';
import { computeDirtyKeysFromSamples } from './DirtyKeyComputer';
export { HEALTHKIT_SOURCE_ID, HEALTH_CONNECT_SOURCE_ID } from './HealthSourceRegistry';
export function normalizeSourceRecordId(uuid: string): string {
  return uuid.toLowerCase();
}
export const DEFAULT_QUERY_LIMIT = 1000;
const DERIVED_SLEEP_METRIC_CODES: readonly HealthMetricCode[] = [
  'time_in_bed',
  'sleep_duration',
  'sleep_awake',
  'sleep_light',
  'sleep_deep',
  'sleep_rem',
];
export type IngestionMode = 'hot' | 'cold' | 'change';
export function modeToScope(mode: IngestionMode): CursorScope {
  switch (mode) {
    case 'hot': return 'hot_anchor';
    case 'cold': return 'cold_time';
    case 'change': return 'change_anchor';
  }
}
export interface HotTwoPassGap {
  readonly gapStart: number;
  readonly gapEnd: number;
}
export function computeHotTwoPassGap(
  watermarkMs: number,
  nowMs: number,
  overlapMs: number,
  maxHotWindowMs: number,
  hotUiWindowMs: number,
): HotTwoPassGap | null {
  const gapStart = Math.max(watermarkMs - overlapMs, nowMs - maxHotWindowMs);
  const gapEnd = nowMs - hotUiWindowMs;
  if (gapEnd <= gapStart) return null;
  return { gapStart, gapEnd };
}
export interface CatchupChunk {
  readonly start: number;
  readonly end: number;
}
export function computeCatchupChunks(
  gapStart: number,
  gapEnd: number,
  chunkMs: number,
  maxChunks: number,
): readonly CatchupChunk[] {
  if (gapEnd <= gapStart || chunkMs <= 0 || maxChunks <= 0) return [];
  const chunks: CatchupChunk[] = [];
  let current = gapStart;
  while (current < gapEnd && chunks.length < maxChunks) {
    const end = Math.min(current + chunkMs, gapEnd);
    chunks.push({ start: current, end });
    current = end;
  }
  return chunks;
}
export interface MetricIngestOptions {
  readonly maxPages?: number;
  readonly queryLimit?: number;
  readonly maxSamples?: number;
  readonly isInitialSync?: boolean;
  readonly forceRecentDataFirst?: boolean;
  readonly mode?: IngestionMode;
}
export interface GenericQuantitySample {
  readonly uuid: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly quantity: number;
  readonly unit: string;
  readonly device?: { name?: string };
  readonly deviceId?: string;
  readonly externalUuid?: string;
  readonly metadata?: Record<string, unknown>;
}
export interface GenericCategorySample {
  readonly uuid: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly value: number;
  readonly device?: { name?: string };
  readonly deviceId?: string;
  readonly externalUuid?: string;
  readonly metadata?: Record<string, unknown>;
}
export interface DeletedSampleRef {
  readonly uuid: string;
}
export interface AnchoredQueryResult<TSample> {
  readonly samples: readonly TSample[];
  readonly deletedSamples: readonly DeletedSampleRef[];
  readonly newAnchor: string;
}
export interface HealthDataProviderAdapter {
  queryQuantitySamplesWithAnchor(
    identifier: string,
    options: { anchor?: string | null; unit?: string; limit?: number }
  ): Promise<AnchoredQueryResult<GenericQuantitySample>>;
  queryCategorySamplesWithAnchor(
    identifier: string,
    options: { anchor?: string | null; limit?: number }
  ): Promise<AnchoredQueryResult<GenericCategorySample>>;
  getSourceId(): string;
  isAvailable(): boolean;
  queryRecentQuantitySamples?(
    identifier: string,
    options: {
      fromDate: Date;
      toDate?: Date;
      unit?: string;
      limit?: number;
      ascending?: boolean;
    }
  ): Promise<{ samples: GenericQuantitySample[] }>;
  queryRecentCategorySamples?(
    identifier: string,
    options: {
      fromDate: Date;
      toDate?: Date;
      limit?: number;
      ascending?: boolean;
    }
  ): Promise<{ samples: GenericCategorySample[] }>;
}
export interface MetricIngestionConfig {
  readonly metricCode: HealthMetricCode;
  readonly providerIdentifier: string;
  readonly valueKind: HealthMetricValueKind;
  readonly queryUnit?: string;
  readonly isCategory: boolean;
  readonly categoryCodeMapper?: (value: number) => string | null;
}
export interface MetricIngestionResult {
  readonly metricCode: string;
  readonly samplesIngested: number;
  readonly samplesDeleted: number;
  readonly newAnchor: string | null;
  readonly durationMs: number;
  readonly success: boolean;
  readonly errorMessage?: string;
  readonly cursorUpdated: boolean;
  readonly hitMaxPages?: boolean;
  readonly wasInitialSync?: boolean;
  readonly catchupIncomplete?: boolean;
}
export interface IngestionCycleResult {
  readonly totalDurationMs: number;
  readonly lockAcquired: boolean;
  readonly metricResults: readonly MetricIngestionResult[];
  readonly totalSamplesIngested: number;
  readonly totalSamplesDeleted: number;
  readonly failedMetricsCount: number;
}
export interface ColdChunkResult {
  readonly metricCode: string;
  readonly samplesIngested: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly errorMessage?: string;
  readonly coldComplete: boolean;
  readonly coldBackfillEndTs: number;
  readonly cursorUpdated: boolean;
  readonly queryLimitHit: boolean;
}
export interface HealthIngestionEnginePorts {
  readonly sampleRepository: HealthSampleRepository;
  readonly cursorRepository: HealthCursorRepository;
  readonly coordinationState: HealthSyncCoordinationState;
  readonly healthDataProvider: HealthDataProviderAdapter;
  readonly getUserId: () => string | null;
  readonly rollupDirtyKeyRepository?: LocalRollupDirtyKeyRepository;
  readonly sleepDirtyNightRepository?: LocalSleepDirtyNightRepository;
}
export class HealthIngestionEngine {
  private computeDurationSeconds(startTimestamp: number, endTimestamp: number): number {
    const deltaMs = endTimestamp - startTimestamp;
    return Math.max(0, Math.round(deltaMs / 1000));
  }
  private buildDerivedSourceRecordId(sourceRecordId: string, metricCode: HealthMetricCode): string {
    return `${sourceRecordId}|${metricCode}`;
  }
  private expandSleepStageDeletionIds(baseIds: string[]): string[] {
    if (baseIds.length === 0) return baseIds;
    const seen = new Set<string>();
    const expanded: string[] = [];
    for (const baseId of baseIds) {
      if (!seen.has(baseId)) {
        seen.add(baseId);
        expanded.push(baseId);
      }
      for (const metricCode of DERIVED_SLEEP_METRIC_CODES) {
        const derivedId = this.buildDerivedSourceRecordId(baseId, metricCode);
        if (!seen.has(derivedId)) {
          seen.add(derivedId);
          expanded.push(derivedId);
        }
      }
    }
    return expanded;
  }
  private readonly ports: HealthIngestionEnginePorts;
  private resolvedSourceId: string | null = null;
  constructor(ports: HealthIngestionEnginePorts) {
    this.ports = ports;
  }
  private async resolveSourceId(): Promise<string> {
    if (this.resolvedSourceId) {
      return this.resolvedSourceId;
    }
    const baseSourceId = this.ports.healthDataProvider.getSourceId();
    const resolved = await resolveHealthSourceId({ baseSourceId });
    this.resolvedSourceId = resolved.sourceId;
    return resolved.sourceId;
  }
  async ingestAll(
    metricConfigs: readonly MetricIngestionConfig[],
    abortSignal?: AbortSignal,
    yieldController?: CooperativeYieldController,
    mode: IngestionMode = 'hot'
  ): Promise<IngestionCycleResult> {
    const startTime = Date.now();
    const state = this.ports.coordinationState;
    if (mode === 'hot' && state.isWithinIngestMinInterval()) {
      logger.debug('[HealthIngestionEngine] Within minimum ingest interval, skipping', { mode });
      return {
        totalDurationMs: Date.now() - startTime,
        lockAcquired: false,
        metricResults: [],
        totalSamplesIngested: 0,
        totalSamplesDeleted: 0,
        failedMetricsCount: 0,
      };
    }
    if (state.isInIngestBackoff()) {
      const remainingMs = state.getRemainingIngestBackoffMs();
      logger.info('[HealthIngestionEngine] In ingest backoff period, skipping', {
        remainingMs,
        backoffMs: state.ingestBackoffMs,
        consecutiveErrors: state.consecutiveIngestErrors,
      });
      return {
        totalDurationMs: Date.now() - startTime,
        lockAcquired: false,
        metricResults: [],
        totalSamplesIngested: 0,
        totalSamplesDeleted: 0,
        failedMetricsCount: 0,
      };
    }
    if (state.ingestInProgress) {
      logger.debug('[HealthIngestionEngine] Ingest already in progress, waiting');
      if (state.activeIngestPromise) {
        await state.activeIngestPromise.catch(() => {  });
      }
      return {
        totalDurationMs: Date.now() - startTime,
        lockAcquired: false,
        metricResults: [],
        totalSamplesIngested: 0,
        totalSamplesDeleted: 0,
        failedMetricsCount: 0,
      };
    }
    if (abortSignal?.aborted) {
      logger.info('[HealthIngestionEngine] Ingest aborted before starting');
      return {
        totalDurationMs: Date.now() - startTime,
        lockAcquired: false,
        metricResults: [],
        totalSamplesIngested: 0,
        totalSamplesDeleted: 0,
        failedMetricsCount: 0,
      };
    }
    let resolveIngest: (result: IngestionCycleResult) => void;
    let rejectIngest: (error: Error) => void;
    const ingestPromise = new Promise<IngestionCycleResult>((resolve, reject) => {
      resolveIngest = resolve;
      rejectIngest = reject;
    });
    const lockPromise = ingestPromise.then(() => undefined).catch(() => undefined);
    const acquired = state.acquireIngestLock(lockPromise);
    if (!acquired) {
      logger.debug('[HealthIngestionEngine] Failed to acquire ingest lock');
      return {
        totalDurationMs: Date.now() - startTime,
        lockAcquired: false,
        metricResults: [],
        totalSamplesIngested: 0,
        totalSamplesDeleted: 0,
        failedMetricsCount: 0,
      };
    }
    if (mode === 'hot') {
      state.recordIngestAttempt();
    }
    this.doIngestAllInternal(metricConfigs, startTime, abortSignal, yieldController, mode)
      .then(resolveIngest!)
      .catch(rejectIngest!);
    return ingestPromise;
  }
  async ingestMetric(
    config: MetricIngestionConfig,
    abortSignal?: AbortSignal,
    yieldController?: CooperativeYieldController,
    options?: MetricIngestOptions
  ): Promise<MetricIngestionResult> {
    const startTime = Date.now();
    const userId = this.ports.getUserId();
    const coordState = this.ports.coordinationState;
    if (!userId) {
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        samplesDeleted: 0,
        newAnchor: null,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: 'No userId available',
        cursorUpdated: false,
      };
    }
    if (config.isCategory && config.valueKind === 'CATEGORY' && !config.categoryCodeMapper) {
      const errorMessage = `Missing categoryCodeMapper for CATEGORY metric "${config.metricCode}"`;
      logger.error('[HealthIngestionEngine] Invalid metric config', {
        metricCode: config.metricCode,
        errorMessage,
      });
      coordState.recordIngestError();
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        samplesDeleted: 0,
        newAnchor: null,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage,
        cursorUpdated: false,
      };
    }
    const sourceId = await this.resolveSourceId();
    const deviceTimezoneOffsetMinutes = -new Date().getTimezoneOffset();
    const effectiveMode = options?.mode ?? 'hot';
    const cursorScope = modeToScope(effectiveMode);
    try {
      const cursor = await this.ports.cursorRepository.getCursor(
        userId,
        sourceId,
        config.metricCode,
        cursorScope
      );
      let currentAnchor = cursor?.anchorData ?? null;
      let cursorVersion = cursor?.cursorVersion ?? 0;
      logger.debug('[HealthIngestionEngine] Starting metric ingest', {
        metricCode: config.metricCode,
        hasExistingAnchor: currentAnchor !== null,
        cursorVersion,
        cursorScope,
      });
      const isInitialSync = options?.isInitialSync ?? (cursorVersion === 0);
      const useColdLimits = effectiveMode === 'cold';
      const maxPagesForMetric = options?.maxPages ?? (
        useColdLimits
          ? coordState.INCREMENTAL_SYNC_MAX_PAGES_PER_METRIC 
          : isInitialSync
            ? coordState.INITIAL_SYNC_MAX_PAGES_PER_METRIC   
            : coordState.INCREMENTAL_SYNC_MAX_PAGES_PER_METRIC 
      );
      const queryLimit = options?.queryLimit ?? (
        useColdLimits
          ? coordState.INCREMENTAL_SYNC_QUERY_LIMIT           
          : isInitialSync
            ? coordState.INITIAL_SYNC_QUERY_LIMIT              
            : coordState.INCREMENTAL_SYNC_QUERY_LIMIT          
      );
      const maxSamplesForMetric = options?.maxSamples ?? Number.MAX_SAFE_INTEGER;
      if (isInitialSync) {
        logger.info('[HealthIngestionEngine] Initial sync detected', {
          metricCode: config.metricCode,
          maxPages: maxPagesForMetric,
          queryLimit,
          mode: effectiveMode,
          note: effectiveMode === 'cold'
            ? 'Cold lane: using incremental limits for deeper backfill'
            : 'Remaining data will be fetched in subsequent sessions',
        });
      }
      let totalSamplesIngested = 0;
      let recentDataSamplesIngested = 0;
      const hasRecentQueryMethod = config.isCategory
        ? this.ports.healthDataProvider.queryRecentCategorySamples !== undefined
        : this.ports.healthDataProvider.queryRecentQuantitySamples !== undefined;
      const hotDateRangeOnly = isFeatureEnabled('hotDateRangeOnly');
      const shouldUseHotDateRange =
        effectiveMode === 'hot' &&
        hasRecentQueryMethod &&
        (hotDateRangeOnly || !isInitialSync); 
      if (shouldUseHotDateRange) {
        return this.ingestMetricHotDateRange(config, {
          userId,
          sourceId,
          cursor, 
          cursorVersion,
          cursorScope,
          deviceTimezoneOffsetMinutes,
          startTime,
          abortSignal,
          yieldController,
        });
      }
      if (effectiveMode === 'hot' && hotDateRangeOnly) {
        const adapterMethod = config.isCategory
          ? 'queryRecentCategorySamples'
          : 'queryRecentQuantitySamples';
        const errorMessage =
          `[Phase 6] HOT lane requires ${adapterMethod} adapter method for ` +
          `metric "${config.metricCode}". Per ADR-001, HOT MUST NOT use anchored queries. ` +
          `Either implement the adapter method or disable hotDateRangeOnly flag for rollback.`;
        logger.error('[HealthIngestionEngine] HOT lane blocked from anchored walk', {
          metricCode: config.metricCode,
          isCategory: config.isCategory,
          hasRecentQueryMethod,
          adapterMethod,
        });
        this.ports.coordinationState.recordIngestError();
        return {
          metricCode: config.metricCode,
          samplesIngested: 0,
          samplesDeleted: 0,
          newAnchor: null,
          durationMs: Date.now() - startTime,
          success: false,
          errorMessage,
          cursorUpdated: false,
        };
      }
      const shouldUseRecentFirst =
        effectiveMode === 'hot' && 
        (isInitialSync || options?.forceRecentDataFirst === true) &&
        coordState.ENABLE_RECENT_DATA_FIRST &&
        coordState.RECENT_DATA_PRIORITY_METRICS.includes(config.metricCode) &&
        hasRecentQueryMethod;
      if (shouldUseRecentFirst) {
        logger.info('[HealthIngestionEngine] Using recent-data-first strategy for priority metric', {
          metricCode: config.metricCode,
          lookbackDays: coordState.RECENT_DATA_LOOKBACK_DAYS,
          queryLimit: coordState.RECENT_DATA_QUERY_LIMIT,
        });
        try {
          const toDate = new Date();
          const fromDate = new Date(toDate.getTime() - coordState.RECENT_DATA_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
          let recentSamplesCount = 0;
          if (config.isCategory) {
            const recentResult = await this.ports.healthDataProvider.queryRecentCategorySamples!(
              config.providerIdentifier,
              {
                fromDate,
                toDate,
                limit: coordState.RECENT_DATA_QUERY_LIMIT,
                ascending: false, 
              }
            );
            recentSamplesCount = recentResult.samples.length;
            if (recentSamplesCount > 0) {
              const recentInserts = this.mapCategorySamplesToInsertInput(
                userId,
                sourceId,
                config,
                recentResult.samples
              );
              if (recentInserts.length > 0) {
                const insertResult = await this.ports.sampleRepository.insertSamples(
                  recentInserts
                );
                recentDataSamplesIngested = insertResult.inserted;
              }
            }
          } else {
            const recentResult = await this.ports.healthDataProvider.queryRecentQuantitySamples!(
              config.providerIdentifier,
              {
                fromDate,
                toDate,
                unit: config.queryUnit,
                limit: coordState.RECENT_DATA_QUERY_LIMIT,
                ascending: false, 
              }
            );
            recentSamplesCount = recentResult.samples.length;
            if (recentSamplesCount > 0) {
              const recentInserts = this.mapQuantitySamplesToInsertInput(
                userId,
                sourceId,
                config,
                recentResult.samples
              );
              if (recentInserts.length > 0) {
                const insertResult = await this.ports.sampleRepository.insertSamples(
                  recentInserts
                );
                recentDataSamplesIngested = insertResult.inserted;
              }
            }
          }
          if (recentDataSamplesIngested > 0) {
            logger.info('[HealthIngestionEngine] Recent data ingested successfully', {
              metricCode: config.metricCode,
              isCategory: config.isCategory,
              samplesIngested: recentDataSamplesIngested,
              fromDate: fromDate.toISOString(),
              toDate: toDate.toISOString(),
            });
          } else if (recentSamplesCount === 0) {
            logger.info('[HealthIngestionEngine] No recent samples found for metric', {
              metricCode: config.metricCode,
              fromDate: fromDate.toISOString(),
              toDate: toDate.toISOString(),
            });
          }
          logger.info('[HealthIngestionEngine] Fast-forwarding cursor to skip historical backfill', {
            metricCode: config.metricCode,
            note: 'Historical data older than lookback period will NOT be synced',
          });
          const fastForwardResult = config.isCategory
            ? await this.ports.healthDataProvider.queryCategorySamplesWithAnchor(
                config.providerIdentifier,
                { anchor: null, limit: 1 } 
              )
            : await this.ports.healthDataProvider.queryQuantitySamplesWithAnchor(
                config.providerIdentifier,
                { anchor: null, unit: config.queryUnit, limit: 1 } 
              );
          if (fastForwardResult.newAnchor) {
            const cursorResult = await this.ports.cursorRepository.updateCursor(
              userId,
              sourceId,
              config.metricCode,
              {
                anchorData: fastForwardResult.newAnchor,
                expectedVersion: cursorVersion,
                samplesIngested: recentDataSamplesIngested,
              },
              cursorScope
            );
            if (cursorResult.success) {
              logger.info('[HealthIngestionEngine] Cursor fast-forwarded successfully', {
                metricCode: config.metricCode,
                samplesIngested: recentDataSamplesIngested,
                newCursorVersion: cursorResult.newVersion,
                skippedHistoricalBackfill: true,
              });
              return {
                metricCode: config.metricCode,
                samplesIngested: recentDataSamplesIngested,
                samplesDeleted: 0,
                newAnchor: fastForwardResult.newAnchor,
                durationMs: Date.now() - startTime,
                success: true,
                cursorUpdated: true,
                hitMaxPages: false,
                wasInitialSync: true,
              };
            } else {
              logger.warn('[HealthIngestionEngine] Cursor fast-forward failed, falling back to backfill', {
                metricCode: config.metricCode,
                reason: 'CAS conflict',
              });
            }
          }
        } catch (recentError) {
          logger.warn('[HealthIngestionEngine] Recent data fetch failed, continuing with anchored query', {
            metricCode: config.metricCode,
            error: recentError instanceof Error
              ? { name: recentError.name, message: recentError.message }
              : { name: 'Error', message: String(recentError) },
          });
        }
        totalSamplesIngested += recentDataSamplesIngested;
      }
      let totalSamplesDeleted = 0;
      let pagesProcessed = 0;
      let cursorUpdateFailed = false;
      let hitMaxPagesLimit = false;
      let hitMaxSamplesLimit = false;
      let lastCursorUpdateSuccess = true;
      while (pagesProcessed < maxPagesForMetric) {
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_ingest_page_start');
        }
        if (abortSignal?.aborted) {
          logger.info('[HealthIngestionEngine] Metric ingest aborted', {
            metricCode: config.metricCode,
            pagesProcessed,
            totalSamplesIngested,
          });
          return {
            metricCode: config.metricCode,
            samplesIngested: totalSamplesIngested,
            samplesDeleted: totalSamplesDeleted,
            newAnchor: currentAnchor,
            durationMs: Date.now() - startTime,
            success: false, 
            errorMessage: 'Aborted',
            cursorUpdated: lastCursorUpdateSuccess,
          };
        }
        if (totalSamplesIngested >= maxSamplesForMetric) {
          logger.info('[HealthIngestionEngine] Hit sample limit for metric - will resume next cycle', {
            metricCode: config.metricCode,
            totalSamplesIngested,
            maxSamplesForMetric,
            pagesProcessed,
          });
          hitMaxSamplesLimit = true;
          break;
        }
        pagesProcessed++;
        const queryStartTime = Date.now();
        const queryResult = config.isCategory
          ? await this.ports.healthDataProvider.queryCategorySamplesWithAnchor(
              config.providerIdentifier,
              { anchor: currentAnchor, limit: queryLimit }
            )
          : await this.ports.healthDataProvider.queryQuantitySamplesWithAnchor(
              config.providerIdentifier,
              { anchor: currentAnchor, unit: config.queryUnit, limit: queryLimit }
            );
        const queryDurationMs = Date.now() - queryStartTime;
        let samplesDeleted = 0;
        if (queryResult.deletedSamples.length > 0) {
          const deletedUuids = queryResult.deletedSamples.map(d => normalizeSourceRecordId(d.uuid));
          const deletionIds = config.metricCode === 'sleep_stage'
            ? this.expandSleepStageDeletionIds(deletedUuids)
            : deletedUuids;
          const onAfterDelete =
            this.ports.rollupDirtyKeyRepository && this.ports.sleepDirtyNightRepository
              ? async (deletedDetails: ReadonlyArray<{ sampleType: string; startTimestamp: number }>): Promise<void> => {
                  if (deletedDetails.length === 0) return;
                  const deletionDirtyInputs = deletedDetails.map(detail => ({
                    userId,
                    sampleType: detail.sampleType,
                    startTimestamp: detail.startTimestamp,
                    endTimestamp: detail.startTimestamp, 
                    timezoneOffsetMinutes: deviceTimezoneOffsetMinutes,
                  }));
                  const dirtyKeys = computeDirtyKeysFromSamples(deletionDirtyInputs);
                  if (dirtyKeys.rollupKeys.length > 0) {
                    await this.ports.rollupDirtyKeyRepository!.enqueueBatch(dirtyKeys.rollupKeys);
                  }
                  if (dirtyKeys.sleepNights.length > 0) {
                    await this.ports.sleepDirtyNightRepository!.enqueueBatch(dirtyKeys.sleepNights);
                  }
                  logger.debug('[HealthIngestionEngine] Dirty keys enqueued for deletions (atomic)', {
                    metricCode: config.metricCode,
                    rollupKeys: dirtyKeys.rollupKeys.length,
                    sleepNights: dirtyKeys.sleepNights.length,
                  });
                }
              : undefined;
          const deleteResult = await this.ports.sampleRepository.markSamplesDeletedBySourceRecordIds(
            userId,
            sourceId,
            deletionIds,
            yieldController, 
            onAfterDelete,
          );
          samplesDeleted = deleteResult.deletedCount;
          logger.debug('[HealthIngestionEngine] Page deletions processed', {
            metricCode: config.metricCode,
            sourceId,
            page: pagesProcessed,
            requested: deletionIds.length,
            deleted: deleteResult.deletedCount,
            alreadyDeleted: deleteResult.alreadyDeletedCount,
            notFound: deleteResult.notFoundRecordIds.length,
          });
        }
        let samplesIngested = 0;
        let inserts: InsertHealthSampleInput[] = [];
        if (queryResult.samples.length > 0) {
          inserts = config.isCategory
            ? config.valueKind === 'CATEGORY'
              ? this.mapCategorySamplesToInsertInput(
                  userId,
                  sourceId,
                  config,
                  queryResult.samples as readonly GenericCategorySample[]
                )
              : this.mapCategoryToNumericSamples(
                  userId,
                  sourceId,
                  config,
                  queryResult.samples as readonly GenericCategorySample[]
                )
            : this.mapQuantitySamplesToInsertInput(
                userId,
                sourceId,
                config,
                queryResult.samples as readonly GenericQuantitySample[]
              );
        }
        if (config.metricCode === 'sleep_stage' && config.isCategory && config.valueKind === 'CATEGORY') {
          const derived = this.deriveSleepIntervalsFromSamples(
            userId,
            sourceId,
            queryResult.samples as readonly GenericCategorySample[]
          );
          if (derived.length > 0) {
            inserts = inserts.concat(derived);
            logger.debug('[HealthIngestionEngine] Derived sleep interval samples', {
              derivedCount: derived.length,
              metricCode: config.metricCode,
            });
          }
        }
        const txnStartTime = Date.now();
        const onBeforeCommit =
          this.ports.rollupDirtyKeyRepository && this.ports.sleepDirtyNightRepository
            ? async (insertedSamples: InsertHealthSampleInput[]): Promise<void> => {
                const dirtyKeyInputs = insertedSamples.map(s => ({
                  userId: s.userId,
                  sampleType: s.sampleType,
                  startTimestamp: s.startTimestamp,
                  endTimestamp: s.endTimestamp,
                  timezoneOffsetMinutes: deviceTimezoneOffsetMinutes,
                }));
                const dirtyKeys = computeDirtyKeysFromSamples(dirtyKeyInputs);
                if (dirtyKeys.rollupKeys.length > 0) {
                  await this.ports.rollupDirtyKeyRepository!.enqueueBatch(dirtyKeys.rollupKeys);
                }
                if (dirtyKeys.sleepNights.length > 0) {
                  await this.ports.sleepDirtyNightRepository!.enqueueBatch(dirtyKeys.sleepNights);
                }
              }
            : undefined;
        const atomicResult = await this.ports.sampleRepository.insertSamplesAndUpdateCursorAtomic(
          inserts,
          {
            userId,
            sourceId,
            sampleType: config.metricCode,
            input: {
              anchorData: queryResult.newAnchor,
              expectedVersion: cursorVersion,
              samplesIngested: inserts.length + samplesDeleted,
            },
            scope: cursorScope,
          },
          onBeforeCommit,
        );
        const txnDurationMs = Date.now() - txnStartTime;
        metrics.trackEvent('metricsHealth', 'health_ingest_metric_page', {
          metric_code: config.metricCode,
          page_index: pagesProcessed,
          samples_count: queryResult.samples.length,
          deletions_count: queryResult.deletedSamples.length,
          query_ms: queryDurationMs,
          txn_ms: txnDurationMs,
          cursor_updated: atomicResult.cursorResult.success,
        });
        samplesIngested = atomicResult.insertResult.inserted;
        logger.debug('[HealthIngestionEngine] Atomic page ingest completed', {
          metricCode: config.metricCode,
          page: pagesProcessed,
          totalSamples: queryResult.samples.length,
          inserted: atomicResult.insertResult.inserted,
          duplicatesSkipped: atomicResult.insertResult.duplicatesSkipped,
          errors: atomicResult.insertResult.errors.length,
          cursorUpdated: atomicResult.cursorResult.success,
          newCursorVersion: atomicResult.cursorResult.newVersion,
        });
        if (!atomicResult.cursorResult.success) {
          logger.warn('[HealthIngestionEngine] Atomic ingest rolled back - cursor conflict', {
            metricCode: config.metricCode,
            page: pagesProcessed,
            expectedVersion: cursorVersion,
            actualVersion: atomicResult.cursorResult.currentVersion,
          });
          cursorUpdateFailed = true;
          lastCursorUpdateSuccess = false;
          break;
        }
        totalSamplesIngested += samplesIngested;
        totalSamplesDeleted += samplesDeleted;
        lastCursorUpdateSuccess = true;
        cursorVersion = atomicResult.cursorResult.newVersion!;
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_ingest_page_end');
        }
        const hasMoreData = queryResult.samples.length >= queryLimit;
        const anchorChanged = queryResult.newAnchor !== currentAnchor;
        logger.debug('[HealthIngestionEngine] Page termination check', {
          metricCode: config.metricCode,
          page: pagesProcessed,
          samplesReturned: queryResult.samples.length,
          limit: queryLimit,
          hasMoreData,
          currentAnchor,
          newAnchor: queryResult.newAnchor,
          anchorChanged,
          isInitialSync,
        });
        currentAnchor = queryResult.newAnchor;
        if (!hasMoreData) {
          logger.debug('[HealthIngestionEngine] Pagination complete - fewer than limit', {
            metricCode: config.metricCode,
            pagesProcessed,
            lastPageSamples: queryResult.samples.length,
            limit: queryLimit,
          });
          break;
        }
        if (!anchorChanged && queryResult.samples.length === 0 && queryResult.deletedSamples.length === 0) {
          logger.debug('[HealthIngestionEngine] Pagination complete - anchor unchanged with no data', {
            metricCode: config.metricCode,
            pagesProcessed,
          });
          break;
        }
        logger.debug('[HealthIngestionEngine] Continuing to next page', {
          metricCode: config.metricCode,
          page: pagesProcessed,
          samplesThisPage: queryResult.samples.length,
          deletionsThisPage: queryResult.deletedSamples.length,
        });
      }
      hitMaxPagesLimit = pagesProcessed >= maxPagesForMetric;
      if (hitMaxPagesLimit || hitMaxSamplesLimit) {
        const reason = hitMaxSamplesLimit ? 'sample limit' : 'page limit';
        logger.info('[HealthIngestionEngine] Progressive backfill limit reached', {
          metricCode: config.metricCode,
          reason,
          maxPages: maxPagesForMetric,
          pagesProcessed,
          totalSamplesIngested,
          totalSamplesDeleted,
          isInitialSync,
          note: 'Cursor saved - remaining data will be fetched in subsequent sessions',
        });
      }
      const ingestSuccess = !cursorUpdateFailed;
      logger.info('[HealthIngestionEngine] Metric ingest completed', {
        metricCode: config.metricCode,
        samplesIngested: totalSamplesIngested,
        samplesDeleted: totalSamplesDeleted,
        pagesProcessed,
        durationMs: Date.now() - startTime,
        success: ingestSuccess,
        cursorUpdateFailed,
        hitMaxPagesLimit,
        hitMaxSamplesLimit,
        isInitialSync,
      });
      metrics.trackEvent('metricsHealth', 'health_ingest_metric_summary', {
        metric_code: config.metricCode,
        samples_ingested: totalSamplesIngested,
        samples_deleted: totalSamplesDeleted,
        pages_processed: pagesProcessed,
        duration_ms: Date.now() - startTime,
        success: ingestSuccess,
        cursor_update_failed: cursorUpdateFailed,
        hit_max_pages: hitMaxPagesLimit,
        hit_max_samples: hitMaxSamplesLimit,
        is_initial_sync: isInitialSync,
        ingestion_mode: effectiveMode,
      });
      return {
        metricCode: config.metricCode,
        samplesIngested: totalSamplesIngested,
        samplesDeleted: totalSamplesDeleted,
        newAnchor: currentAnchor,
        durationMs: Date.now() - startTime,
        success: ingestSuccess, 
        cursorUpdated: lastCursorUpdateSuccess, 
        hitMaxPages: hitMaxPagesLimit || hitMaxSamplesLimit, 
        wasInitialSync: isInitialSync, 
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[HealthIngestionEngine] Metric ingest failed', {
        metricCode: config.metricCode,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      this.ports.coordinationState.recordIngestError();
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        samplesDeleted: 0,
        newAnchor: null,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage,
        cursorUpdated: false,
      };
    }
  }
  async resetCursor(metricCode: HealthMetricCode, scope?: CursorScope): Promise<void> {
    const userId = this.ports.getUserId();
    if (!userId) {
      throw new Error('[HealthIngestionEngine] No userId available');
    }
    const sourceId = await this.resolveSourceId();
    if (scope) {
      await this.ports.cursorRepository.deleteCursor(userId, sourceId, metricCode, scope);
      logger.info('[HealthIngestionEngine] Cursor reset (scoped)', {
        metricCode, sourceId, scope,
      });
    } else {
      const allScopes: CursorScope[] = ['hot_anchor', 'cold_time', 'change_anchor'];
      await Promise.all(
        allScopes.map(s =>
          this.ports.cursorRepository.deleteCursor(userId, sourceId, metricCode, s)
        )
      );
      logger.info('[HealthIngestionEngine] Cursor reset (all scopes)', {
        metricCode, sourceId, scopesDeleted: allScopes,
      });
    }
  }
  async getCursorState(
    metricCode: HealthMetricCode,
    scope?: CursorScope
  ): Promise<DomainHealthCursor | null> {
    const userId = this.ports.getUserId();
    if (!userId) {
      return null;
    }
    const sourceId = await this.resolveSourceId();
    return this.ports.cursorRepository.getCursor(userId, sourceId, metricCode, scope);
  }
  async ingestMetricColdChunk(
    config: MetricIngestionConfig,
    options: {
      readonly userId: string;
      readonly sourceId: string;
      readonly coldBackfillDays: number;
      readonly coldGraceWindowDays?: number;
      readonly chunkWindowMs: number;
      readonly queryLimit: number;
      readonly abortSignal?: AbortSignal;
      readonly yieldController?: CooperativeYieldController;
    }
  ): Promise<ColdChunkResult> {
    const startTime = Date.now();
    const {
      userId, sourceId, coldBackfillDays, chunkWindowMs,
      queryLimit, abortSignal, yieldController,
    } = options;
    const coldGraceWindowDays = options.coldGraceWindowDays ?? 0;
    const cursorScope: CursorScope = 'cold_time';
    if (abortSignal?.aborted) {
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: 'Aborted',
        coldComplete: false,
        coldBackfillEndTs: 0,
        queryLimitHit: false,
        cursorUpdated: false,
      };
    }
    let cursor = await this.ports.cursorRepository.getCursor(
      userId, sourceId, config.metricCode, cursorScope
    );
    const now = Date.now();
    const effectiveBackfillDays = coldBackfillDays + coldGraceWindowDays;
    const backfillBoundaryMs = effectiveBackfillDays * 24 * 60 * 60 * 1000;
    if (!cursor) {
      const createResult = await this.ports.cursorRepository.updateCursor(
        userId, sourceId, config.metricCode,
        {
          anchorData: null, 
          expectedVersion: 0, 
          samplesIngested: 0,
          coldBackfillStartTs: now,
          coldBackfillEndTs: now,
        },
        cursorScope
      );
      if (!createResult.success) {
        cursor = await this.ports.cursorRepository.getCursor(
          userId, sourceId, config.metricCode, cursorScope
        );
        if (!cursor) {
          return {
            metricCode: config.metricCode,
            samplesIngested: 0,
            durationMs: Date.now() - startTime,
            success: false,
            errorMessage: 'Failed to initialize cold cursor',
            coldComplete: false,
            coldBackfillEndTs: 0,
            queryLimitHit: false,
            cursorUpdated: false,
          };
        }
      } else {
        cursor = await this.ports.cursorRepository.getCursor(
          userId, sourceId, config.metricCode, cursorScope
        );
        if (!cursor) {
          return {
            metricCode: config.metricCode,
            samplesIngested: 0,
            durationMs: Date.now() - startTime,
            success: false,
            errorMessage: 'Cold cursor created but re-read failed',
            coldComplete: false,
            coldBackfillEndTs: 0,
            queryLimitHit: false,
            cursorUpdated: false,
          };
        }
      }
    }
    const coldBackfillStartTs = cursor.coldBackfillStartTs ?? now;
    const coldBackfillEndTs = cursor.coldBackfillEndTs ?? now;
    if (cursor.coldBackfillStartTs == null || cursor.coldBackfillEndTs == null) {
      await this.ports.cursorRepository.updateCursor(
        userId, sourceId, config.metricCode,
        {
          anchorData: cursor.anchorData,
          expectedVersion: cursor.cursorVersion,
          samplesIngested: 0,
          coldBackfillStartTs,
          coldBackfillEndTs,
        },
        cursorScope
      );
      cursor = await this.ports.cursorRepository.getCursor(
        userId, sourceId, config.metricCode, cursorScope
      );
      if (!cursor) {
        return {
          metricCode: config.metricCode,
          samplesIngested: 0,
          durationMs: Date.now() - startTime,
          success: false,
          errorMessage: 'Failed to initialize cold cursor fields',
          coldComplete: false,
          coldBackfillEndTs: 0,
          queryLimitHit: false,
          cursorUpdated: false,
        };
      }
    }
    const coldBoundaryTs = coldBackfillStartTs - backfillBoundaryMs;
    if (coldBackfillEndTs <= coldBoundaryTs) {
      logger.info('[HealthIngestionEngine] COLD chunk: backfill complete for metric', {
        metricCode: config.metricCode,
        coldBackfillEndTs: new Date(coldBackfillEndTs).toISOString(),
        boundary: new Date(coldBoundaryTs).toISOString(),
      });
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        durationMs: Date.now() - startTime,
        success: true,
        coldComplete: true,
        coldBackfillEndTs,
        queryLimitHit: false,
        cursorUpdated: false,
      };
    }
    const windowEnd = coldBackfillEndTs;
    const windowStart = Math.max(
      windowEnd - chunkWindowMs,
      coldBoundaryTs 
    );
    const fromDate = new Date(windowStart);
    const toDate = new Date(windowEnd);
    logger.info('[HealthIngestionEngine] COLD chunk: processing time window', {
      metricCode: config.metricCode,
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      coldBackfillEndTs: new Date(coldBackfillEndTs).toISOString(),
      coldBackfillStartTs: new Date(coldBackfillStartTs).toISOString(),
      boundary: new Date(coldBoundaryTs).toISOString(),
    });
    if (abortSignal?.aborted) {
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: 'Aborted',
        coldComplete: false,
        coldBackfillEndTs,
        queryLimitHit: false,
        cursorUpdated: false,
      };
    }
    if (yieldController) {
      await yieldController.yieldIfNeeded('health_cold_chunk_start');
    }
    const MAX_COLD_PAGES_PER_CHUNK = 5;
    if (config.isCategory && !this.ports.healthDataProvider.queryRecentCategorySamples) {
      logger.error('[HealthIngestionEngine] COLD chunk: adapter missing queryRecentCategorySamples — cannot ingest', {
        metricCode: config.metricCode,
      });
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: `Adapter does not implement queryRecentCategorySamples — COLD lane cannot process category metric ${config.metricCode}`,
        coldComplete: false,
        coldBackfillEndTs,
        queryLimitHit: false,
        cursorUpdated: false,
      };
    }
    if (!config.isCategory && !this.ports.healthDataProvider.queryRecentQuantitySamples) {
      logger.error('[HealthIngestionEngine] COLD chunk: adapter missing queryRecentQuantitySamples — cannot ingest', {
        metricCode: config.metricCode,
      });
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: `Adapter does not implement queryRecentQuantitySamples — COLD lane cannot process quantity metric ${config.metricCode}`,
        coldComplete: false,
        coldBackfillEndTs,
        queryLimitHit: false,
        cursorUpdated: false,
      };
    }
    let allInserts: InsertHealthSampleInput[] = [];
    let totalRawSampleCount = 0;
    let pagesProcessed = 0;
    let queryLimitHit = false;
    const persistedColdPageFromTs = cursor.coldPageFromTs ?? null;
    let pageFromDate: Date;
    if (
      persistedColdPageFromTs !== null &&
      persistedColdPageFromTs > windowStart &&
      persistedColdPageFromTs < coldBackfillEndTs
    ) {
      pageFromDate = new Date(persistedColdPageFromTs);
      logger.info('[HealthIngestionEngine] COLD chunk: resuming from persisted intra-window cursor', {
        metricCode: config.metricCode,
        coldPageFromTs: new Date(persistedColdPageFromTs).toISOString(),
        windowStart: fromDate.toISOString(),
        windowEnd: toDate.toISOString(),
      });
    } else {
      pageFromDate = fromDate; 
    }
    try {
      while (pagesProcessed < MAX_COLD_PAGES_PER_CHUNK) {
        if (abortSignal?.aborted) {
          break;
        }
        let pageInserts: InsertHealthSampleInput[] = [];
        let pageRawCount = 0;
        if (config.isCategory) {
          const result = await this.ports.healthDataProvider.queryRecentCategorySamples!(
            config.providerIdentifier,
            {
              fromDate: pageFromDate,
              toDate,
              limit: queryLimit,
              ascending: true, 
            }
          );
          const rawSamples = result.samples;
          pageRawCount = rawSamples.length;
          if (pageRawCount > 0) {
            pageInserts = config.valueKind === 'CATEGORY'
              ? this.mapCategorySamplesToInsertInput(userId, sourceId, config, rawSamples)
              : this.mapCategoryToNumericSamples(userId, sourceId, config, rawSamples);
            if (config.metricCode === 'sleep_stage' && config.valueKind === 'CATEGORY') {
              const derived = this.deriveSleepIntervalsFromSamples(userId, sourceId, rawSamples);
              if (derived.length > 0) {
                pageInserts = pageInserts.concat(derived);
                logger.debug('[HealthIngestionEngine] COLD chunk page: derived sleep intervals', {
                  derivedCount: derived.length,
                  metricCode: config.metricCode,
                  page: pagesProcessed + 1,
                });
              }
            }
          }
        } else {
          const result = await this.ports.healthDataProvider.queryRecentQuantitySamples!(
            config.providerIdentifier,
            {
              fromDate: pageFromDate,
              toDate,
              unit: config.queryUnit,
              limit: queryLimit,
              ascending: true, 
            }
          );
          pageRawCount = result.samples.length;
          if (pageRawCount > 0) {
            pageInserts = this.mapQuantitySamplesToInsertInput(userId, sourceId, config, result.samples);
          }
        }
        totalRawSampleCount += pageRawCount;
        allInserts = allInserts.concat(pageInserts);
        pagesProcessed++;
        if (pageRawCount < queryLimit) {
          break;
        }
        queryLimitHit = true;
        if (pageInserts.length > 0) {
          let maxStartTs = pageInserts[0]!.startTimestamp;
          for (let i = 1; i < pageInserts.length; i++) {
            if (pageInserts[i]!.startTimestamp > maxStartTs) {
              maxStartTs = pageInserts[i]!.startTimestamp;
            }
          }
          const newFromMs = maxStartTs; 
          pageFromDate = new Date(newFromMs);
          logger.info('[HealthIngestionEngine] COLD chunk: paginating within window', {
            metricCode: config.metricCode,
            page: pagesProcessed,
            maxPages: MAX_COLD_PAGES_PER_CHUNK,
            pageRawCount,
            newFromDate: pageFromDate.toISOString(),
            toDate: toDate.toISOString(),
          });
        } else {
          logger.warn('[HealthIngestionEngine] COLD chunk: query limit hit but 0 inserts after mapping — breaking pagination', {
            metricCode: config.metricCode,
            pageRawCount,
          });
          break;
        }
      }
    } catch (queryError) {
      const errorMessage = queryError instanceof Error ? queryError.message : String(queryError);
      logger.error('[HealthIngestionEngine] COLD chunk query failed', {
        metricCode: config.metricCode,
        error: queryError instanceof Error
          ? { name: queryError.name, message: queryError.message }
          : { name: 'Error', message: String(queryError) },
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
        pagesProcessed,
      });
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage,
        coldComplete: false,
        coldBackfillEndTs,
        queryLimitHit: false,
        cursorUpdated: false,
      };
    }
    if (queryLimitHit && pagesProcessed >= MAX_COLD_PAGES_PER_CHUNK) {
      logger.warn('[HealthIngestionEngine] COLD chunk: page budget exhausted — window not fully covered', {
        metricCode: config.metricCode,
        pagesProcessed,
        maxPages: MAX_COLD_PAGES_PER_CHUNK,
        totalRawSamples: totalRawSampleCount,
        note: 'Remaining data in this window will be re-queried on next chunk invocation.',
      });
    }
    const deviceTimezoneOffsetMinutes = -new Date().getTimezoneOffset();
    const onBeforeCommit =
      this.ports.rollupDirtyKeyRepository && this.ports.sleepDirtyNightRepository
        ? async (insertedSamples: InsertHealthSampleInput[]): Promise<void> => {
            const dirtyKeyInputs = insertedSamples.map(s => ({
              userId: s.userId,
              sampleType: s.sampleType,
              startTimestamp: s.startTimestamp,
              endTimestamp: s.endTimestamp,
              timezoneOffsetMinutes: deviceTimezoneOffsetMinutes,
            }));
            const dirtyKeys = computeDirtyKeysFromSamples(dirtyKeyInputs);
            if (dirtyKeys.rollupKeys.length > 0) {
              await this.ports.rollupDirtyKeyRepository!.enqueueBatch(dirtyKeys.rollupKeys);
            }
            if (dirtyKeys.sleepNights.length > 0) {
              await this.ports.sleepDirtyNightRepository!.enqueueBatch(dirtyKeys.sleepNights);
            }
          }
        : undefined;
    const pageBudgetExhausted = queryLimitHit && pagesProcessed >= MAX_COLD_PAGES_PER_CHUNK;
    let newColdBackfillEndTs: number;
    let newColdPageFromTs: number | null;
    if (!pageBudgetExhausted) {
      newColdBackfillEndTs = windowStart;
      newColdPageFromTs = null; 
    } else if (allInserts.length > 0) {
      newColdBackfillEndTs = coldBackfillEndTs; 
      newColdPageFromTs = pageFromDate.getTime(); 
      logger.info('[HealthIngestionEngine] COLD chunk: page budget exhausted — saving intra-window resume cursor', {
        metricCode: config.metricCode,
        coldBackfillEndTs: new Date(coldBackfillEndTs).toISOString(),
        coldPageFromTs: pageFromDate.toISOString(),
        pagesProcessed,
        totalInserts: allInserts.length,
      });
    } else {
      newColdBackfillEndTs = windowStart;
      newColdPageFromTs = null; 
      logger.warn('[HealthIngestionEngine] COLD chunk: page budget exhausted with 0 inserts — force advancing to windowStart', {
        metricCode: config.metricCode,
        totalRawSamples: totalRawSampleCount,
      });
    }
    const reachedBoundary = newColdBackfillEndTs <= coldBoundaryTs;
    const positionAdvanced =
      newColdBackfillEndTs < coldBackfillEndTs || 
      newColdPageFromTs !== persistedColdPageFromTs; 
    const atomicResult = await this.ports.sampleRepository.insertSamplesAndUpdateCursorAtomic(
      allInserts,
      {
        userId,
        sourceId,
        sampleType: config.metricCode,
        input: {
          anchorData: cursor.anchorData, 
          expectedVersion: cursor.cursorVersion,
          samplesIngested: allInserts.length,
          coldBackfillEndTs: newColdBackfillEndTs,
          coldBackfillStartTs: coldBackfillStartTs, 
          coldPageFromTs: newColdPageFromTs,
        },
        scope: cursorScope,
      },
      onBeforeCommit,
    );
    const samplesIngested = atomicResult.insertResult.inserted;
    if (!atomicResult.cursorResult.success) {
      logger.warn('[HealthIngestionEngine] COLD chunk cursor update failed (CAS)', {
        metricCode: config.metricCode,
        expectedVersion: cursor.cursorVersion,
        actualVersion: atomicResult.cursorResult.currentVersion,
      });
    }
    const durationMs = Date.now() - startTime;
    const cursorUpdated = atomicResult.cursorResult.success && positionAdvanced;
    logger.info('[HealthIngestionEngine] COLD chunk completed', {
      metricCode: config.metricCode,
      rawSamples: totalRawSampleCount,
      samplesIngested,
      duplicatesSkipped: atomicResult.insertResult.duplicatesSkipped,
      cursorUpdated,
      positionAdvanced,
      coldBackfillEndTs: new Date(newColdBackfillEndTs).toISOString(),
      coldComplete: reachedBoundary,
      queryLimitHit,
      pagesProcessed,
      durationMs,
    });
    metrics.trackEvent('metricsHealth', 'health_cold_chunk_metric', {
      metric_code: config.metricCode,
      raw_samples: totalRawSampleCount,
      samples_ingested: samplesIngested,
      duplicates_skipped: atomicResult.insertResult.duplicatesSkipped,
      cursor_updated: cursorUpdated,
      position_advanced: positionAdvanced,
      cold_complete: reachedBoundary,
      query_limit_hit: queryLimitHit,
      pages_processed: pagesProcessed,
      duration_ms: durationMs,
    });
    return {
      metricCode: config.metricCode,
      samplesIngested,
      durationMs,
      success: atomicResult.cursorResult.success,
      coldComplete: reachedBoundary,
      coldBackfillEndTs: newColdBackfillEndTs,
      cursorUpdated,
      queryLimitHit,
    };
  }
  private async ingestMetricHotDateRange(
    config: MetricIngestionConfig,
    ctx: {
      readonly userId: string;
      readonly sourceId: string;
      readonly cursor: DomainHealthCursor | null;
      readonly cursorVersion: number;
      readonly cursorScope: CursorScope;
      readonly deviceTimezoneOffsetMinutes: number;
      readonly startTime: number;
      readonly abortSignal?: AbortSignal;
      readonly yieldController?: CooperativeYieldController;
    }
  ): Promise<MetricIngestionResult> {
    const {
      userId, sourceId, cursorVersion, cursorScope,
      deviceTimezoneOffsetMinutes, startTime, abortSignal, yieldController,
    } = ctx;
    const coordState = this.ports.coordinationState;
    const now = Date.now();
    const watermark = ctx.cursor?.lastIngestTimestamp ?? null;
    const isInitialHotSync = ctx.cursor == null;
    let fromMs: number;
    if (watermark != null && watermark > 0) {
      fromMs = Math.max(
        watermark - coordState.HOT_OVERLAP_MS,
        now - coordState.HOT_MAX_WINDOW_MS
      );
    } else {
      fromMs = now - coordState.HOT_MAX_WINDOW_MS;
    }
    const fromDate = new Date(fromMs);
    const toDate = new Date(now);
    logger.info('[HealthIngestionEngine] HOT date-range query', {
      metricCode: config.metricCode,
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      watermark: watermark ? new Date(watermark).toISOString() : null,
      overlapMs: coordState.HOT_OVERLAP_MS,
      cursorScope,
      isInitialHotSync,
    });
    if (isFeatureEnabled('hotTwoPassEnabled') && watermark != null && watermark > 0) {
      const gap = computeHotTwoPassGap(
        watermark, now, coordState.HOT_OVERLAP_MS,
        coordState.HOT_MAX_WINDOW_MS, coordState.HOT_UI_WINDOW_MS,
      );
      if (gap != null) {
        return this.executeHotTwoPass(config, ctx, gap, now);
      }
    }
    if (abortSignal?.aborted) {
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        samplesDeleted: 0,
        newAnchor: ctx.cursor?.anchorData ?? null,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: 'Aborted',
        cursorUpdated: false,
      };
    }
    if (yieldController) {
      await yieldController.yieldIfNeeded('health_hot_daterange_start');
    }
    let inserts: InsertHealthSampleInput[] = [];
    let rawSampleCount = 0;
    try {
      if (config.isCategory) {
        const result = await this.ports.healthDataProvider.queryRecentCategorySamples!(
          config.providerIdentifier,
          {
            fromDate,
            toDate,
            limit: coordState.RECENT_DATA_QUERY_LIMIT,
            ascending: false, 
          }
        );
        const rawSamples = result.samples;
        rawSampleCount = rawSamples.length;
        if (rawSampleCount > 0) {
          inserts = config.valueKind === 'CATEGORY'
            ? this.mapCategorySamplesToInsertInput(userId, sourceId, config, rawSamples)
            : this.mapCategoryToNumericSamples(userId, sourceId, config, rawSamples);
          if (config.metricCode === 'sleep_stage' && config.valueKind === 'CATEGORY') {
            const derived = this.deriveSleepIntervalsFromSamples(userId, sourceId, rawSamples);
            if (derived.length > 0) {
              inserts = inserts.concat(derived);
              logger.debug('[HealthIngestionEngine] HOT date-range: derived sleep intervals', {
                derivedCount: derived.length,
                metricCode: config.metricCode,
              });
            }
          }
        }
      } else {
        const result = await this.ports.healthDataProvider.queryRecentQuantitySamples!(
          config.providerIdentifier,
          {
            fromDate,
            toDate,
            unit: config.queryUnit,
            limit: coordState.RECENT_DATA_QUERY_LIMIT,
            ascending: false,
          }
        );
        rawSampleCount = result.samples.length;
        if (rawSampleCount > 0) {
          inserts = this.mapQuantitySamplesToInsertInput(userId, sourceId, config, result.samples);
        }
      }
    } catch (queryError) {
      const errorMessage = queryError instanceof Error ? queryError.message : String(queryError);
      logger.error('[HealthIngestionEngine] HOT date-range query failed', {
        metricCode: config.metricCode,
        error: queryError instanceof Error
          ? { name: queryError.name, message: queryError.message }
          : { name: 'Error', message: String(queryError) },
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
      });
      this.ports.coordinationState.recordIngestError();
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        samplesDeleted: 0,
        newAnchor: ctx.cursor?.anchorData ?? null,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage,
        cursorUpdated: false,
      };
    }
    const onBeforeCommit =
      this.ports.rollupDirtyKeyRepository && this.ports.sleepDirtyNightRepository
        ? async (insertedSamples: InsertHealthSampleInput[]): Promise<void> => {
            const dirtyKeyInputs = insertedSamples.map(s => ({
              userId: s.userId,
              sampleType: s.sampleType,
              startTimestamp: s.startTimestamp,
              endTimestamp: s.endTimestamp,
              timezoneOffsetMinutes: deviceTimezoneOffsetMinutes,
            }));
            const dirtyKeys = computeDirtyKeysFromSamples(dirtyKeyInputs);
            if (dirtyKeys.rollupKeys.length > 0) {
              await this.ports.rollupDirtyKeyRepository!.enqueueBatch(dirtyKeys.rollupKeys);
            }
            if (dirtyKeys.sleepNights.length > 0) {
              await this.ports.sleepDirtyNightRepository!.enqueueBatch(dirtyKeys.sleepNights);
            }
          }
        : undefined;
    const queryLimit = coordState.RECENT_DATA_QUERY_LIMIT;
    const queryLimitHit = rawSampleCount >= queryLimit;
    if (queryLimitHit) {
      logger.warn('[HealthIngestionEngine] HOT date-range: query limit hit, NOT advancing watermark', {
        metricCode: config.metricCode,
        rawSampleCount,
        queryLimit,
        note: 'Same window will be re-queried next cycle. Idempotent insert handles duplicates.',
      });
    }
    const preservedAnchor = ctx.cursor?.anchorData ?? null;
    const atomicResult = await this.ports.sampleRepository.insertSamplesAndUpdateCursorAtomic(
      inserts,
      {
        userId,
        sourceId,
        sampleType: config.metricCode,
        input: {
          anchorData: preservedAnchor,
          expectedVersion: cursorVersion,
          samplesIngested: inserts.length,
          lastIngestTimestamp: queryLimitHit
            ? (watermark ?? fromMs) 
            : undefined, 
        },
        scope: cursorScope,
      },
      onBeforeCommit,
    );
    const samplesIngested = atomicResult.insertResult.inserted;
    if (!atomicResult.cursorResult.success) {
      logger.warn('[HealthIngestionEngine] HOT date-range cursor update failed (CAS)', {
        metricCode: config.metricCode,
        expectedVersion: cursorVersion,
        actualVersion: atomicResult.cursorResult.currentVersion,
      });
    }
    const durationMs = Date.now() - startTime;
    logger.info('[HealthIngestionEngine] HOT date-range ingest completed', {
      metricCode: config.metricCode,
      rawSamples: rawSampleCount,
      samplesIngested,
      duplicatesSkipped: atomicResult.insertResult.duplicatesSkipped,
      cursorUpdated: atomicResult.cursorResult.success,
      queryLimitHit,
      durationMs,
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      isInitialHotSync,
    });
    metrics.trackEvent('metricsHealth', 'health_hot_daterange_metric', {
      metric_code: config.metricCode,
      raw_samples: rawSampleCount,
      samples_ingested: samplesIngested,
      duplicates_skipped: atomicResult.insertResult.duplicatesSkipped,
      cursor_updated: atomicResult.cursorResult.success,
      query_limit_hit: queryLimitHit,
      duration_ms: durationMs,
      watermark_age_ms: watermark ? now - watermark : null,
    });
    return {
      metricCode: config.metricCode,
      samplesIngested,
      samplesDeleted: 0, 
      newAnchor: preservedAnchor,
      durationMs,
      success: atomicResult.cursorResult.success,
      cursorUpdated: atomicResult.cursorResult.success,
    };
  }
  private async executeHotTwoPass(
    config: MetricIngestionConfig,
    ctx: {
      readonly userId: string;
      readonly sourceId: string;
      readonly cursor: DomainHealthCursor | null;
      readonly cursorVersion: number;
      readonly cursorScope: CursorScope;
      readonly deviceTimezoneOffsetMinutes: number;
      readonly startTime: number;
      readonly abortSignal?: AbortSignal;
      readonly yieldController?: CooperativeYieldController;
    },
    gap: HotTwoPassGap,
    nowMs: number,
  ): Promise<MetricIngestionResult> {
    const {
      userId, sourceId, cursorScope,
      deviceTimezoneOffsetMinutes, startTime, abortSignal,
    } = ctx;
    const coordState = this.ports.coordinationState;
    const preservedAnchor = ctx.cursor?.anchorData ?? null;
    let passAInserted = 0;
    let passAFailed = false;
    let passBInserted = 0;
    let chunksProcessed = 0;
    let totalChunks = 0;
    logger.info('[HealthIngestionEngine] HOT two-pass: entering', {
      metricCode: config.metricCode,
      gapStartMs: gap.gapStart,
      gapEndMs: gap.gapEnd,
      gapDurationMs: gap.gapEnd - gap.gapStart,
    });
    if (abortSignal?.aborted) {
      return {
        metricCode: config.metricCode,
        samplesIngested: 0,
        samplesDeleted: 0,
        newAnchor: preservedAnchor,
        durationMs: Date.now() - startTime,
        success: false,
        errorMessage: 'Aborted before Pass A',
        cursorUpdated: false,
      };
    }
    try {
      const passAResult = await this.queryHealthSamplesForDateRange(
        config, userId, sourceId,
        new Date(gap.gapEnd), new Date(nowMs),
        false, 
        coordState.RECENT_DATA_QUERY_LIMIT,
      );
      if (passAResult.inserts.length > 0) {
        const onBeforeCommit = this.buildDirtyKeyCallback(deviceTimezoneOffsetMinutes);
        const insertResult = await this.ports.sampleRepository.insertSamples(
          passAResult.inserts,
          onBeforeCommit,
        );
        passAInserted = insertResult.inserted;
      }
      logger.info('[HealthIngestionEngine] HOT two-pass Pass A completed', {
        metricCode: config.metricCode,
        rawSamples: passAResult.rawCount,
        samplesInserted: passAInserted,
      });
    } catch (passAError) {
      passAFailed = true;
      logger.error('[HealthIngestionEngine] HOT two-pass Pass A failed', {
        metricCode: config.metricCode,
        error: passAError instanceof Error
          ? { name: passAError.name, message: passAError.message }
          : { name: 'Error', message: String(passAError) },
      });
    }
    if (!abortSignal?.aborted) {
      const chunks = computeCatchupChunks(
        gap.gapStart,
        gap.gapEnd,
        coordState.HOT_CATCHUP_CHUNK_WINDOW_MS,
        coordState.HOT_CATCHUP_MAX_CHUNKS_PER_RUN,
      );
      totalChunks = chunks.length;
      let currentCursorVersion = ctx.cursorVersion;
      for (const chunk of chunks) {
        if (abortSignal?.aborted) {
          logger.info('[HealthIngestionEngine] HOT two-pass Pass B: aborted between chunks', {
            metricCode: config.metricCode,
            chunksProcessed,
            totalChunks,
          });
          break;
        }
        try {
          const chunkResult = await this.queryHealthSamplesForDateRange(
            config, userId, sourceId,
            new Date(chunk.start), new Date(chunk.end),
            true, 
            coordState.HOT_CATCHUP_QUERY_LIMIT,
          );
          const queryLimitHit =
            chunkResult.rawCount >= coordState.HOT_CATCHUP_QUERY_LIMIT;
          let watermarkAdvanceTo: number;
          if (queryLimitHit && chunkResult.inserts.length > 0) {
            watermarkAdvanceTo = chunkResult.inserts.reduce(
              (max, s) => Math.max(max, s.startTimestamp),
              chunk.start,
            );
            logger.warn(
              '[HealthIngestionEngine] HOT two-pass Pass B: query limit hit, ' +
              'advancing watermark to last sample timestamp (not chunk.end)',
              {
                metricCode: config.metricCode,
                rawCount: chunkResult.rawCount,
                queryLimit: coordState.HOT_CATCHUP_QUERY_LIMIT,
                watermarkAdvanceTo: new Date(watermarkAdvanceTo).toISOString(),
                chunkEnd: new Date(chunk.end).toISOString(),
                chunkIndex: chunksProcessed + 1,
                totalChunks,
              },
            );
          } else {
            watermarkAdvanceTo = chunk.end;
          }
          const onBeforeCommit = this.buildDirtyKeyCallback(deviceTimezoneOffsetMinutes);
          const atomicResult = await this.ports.sampleRepository.insertSamplesAndUpdateCursorAtomic(
            chunkResult.inserts,
            {
              userId,
              sourceId,
              sampleType: config.metricCode,
              input: {
                anchorData: preservedAnchor,
                expectedVersion: currentCursorVersion,
                samplesIngested: chunkResult.inserts.length,
                lastIngestTimestamp: watermarkAdvanceTo,
              },
              scope: cursorScope,
            },
            onBeforeCommit,
          );
          passBInserted += atomicResult.insertResult.inserted;
          chunksProcessed++;
          if (!atomicResult.cursorResult.success) {
            logger.warn('[HealthIngestionEngine] HOT two-pass Pass B: cursor CAS failed', {
              metricCode: config.metricCode,
              chunk: chunksProcessed,
              expectedVersion: currentCursorVersion,
              actualVersion: atomicResult.cursorResult.currentVersion,
            });
          }
          const refreshedCursor = await this.ports.cursorRepository.getCursor(
            userId, sourceId, config.metricCode, cursorScope,
          );
          currentCursorVersion = refreshedCursor?.cursorVersion ?? currentCursorVersion + 1;
          if (queryLimitHit) {
            logger.info(
              '[HealthIngestionEngine] HOT two-pass Pass B: breaking chunk loop after limit hit',
              {
                metricCode: config.metricCode,
                chunksProcessed,
                totalChunks,
                watermarkAdvanceTo: new Date(watermarkAdvanceTo).toISOString(),
              },
            );
            break;
          }
        } catch (chunkError) {
          logger.error('[HealthIngestionEngine] HOT two-pass Pass B chunk failed', {
            metricCode: config.metricCode,
            chunk: chunksProcessed + 1,
            totalChunks,
            error: chunkError instanceof Error
              ? { name: chunkError.name, message: chunkError.message }
              : { name: 'Error', message: String(chunkError) },
          });
          break;
        }
      }
      const gapFullyCovered = chunksProcessed === totalChunks && totalChunks > 0;
      if (gapFullyCovered) {
        try {
          const latestCursor = await this.ports.cursorRepository.getCursor(
            userId, sourceId, config.metricCode, cursorScope,
          );
          const finalVersion = latestCursor?.cursorVersion ?? currentCursorVersion;
          await this.ports.sampleRepository.insertSamplesAndUpdateCursorAtomic(
            [], 
            {
              userId,
              sourceId,
              sampleType: config.metricCode,
              input: {
                anchorData: preservedAnchor,
                expectedVersion: finalVersion,
                samplesIngested: 0,
                lastIngestTimestamp: nowMs, 
              },
              scope: cursorScope,
            },
          );
          logger.info('[HealthIngestionEngine] HOT two-pass: gap fully covered, watermark → now', {
            metricCode: config.metricCode,
          });
        } catch (finalError) {
          logger.warn('[HealthIngestionEngine] HOT two-pass: final watermark advance failed', {
            metricCode: config.metricCode,
            error: finalError instanceof Error
              ? { name: finalError.name, message: finalError.message }
              : { name: 'Error', message: String(finalError) },
          });
        }
      }
      logger.info('[HealthIngestionEngine] HOT two-pass Pass B completed', {
        metricCode: config.metricCode,
        chunksProcessed,
        totalChunks,
        passBInserted,
        gapFullyCovered,
      });
    }
    const durationMs = Date.now() - startTime;
    const totalInserted = passAInserted + passBInserted;
    metrics.trackEvent('metricsHealth', 'health_hot_two_pass', {
      metric_code: config.metricCode,
      pass_a_samples: passAInserted,
      pass_b_samples: passBInserted,
      pass_b_chunks: chunksProcessed,
      pass_b_total_chunks: totalChunks,
      gap_ms_before: gap.gapEnd - gap.gapStart,
      gap_fully_covered: chunksProcessed === totalChunks && totalChunks > 0,
      duration_ms: durationMs,
    });
    const cursorUpdated = chunksProcessed > 0;
    const success = totalInserted > 0 || cursorUpdated;
    const gapFullyCovered = chunksProcessed === totalChunks && totalChunks > 0;
    const errorMessage = !success && passAFailed
      ? 'Both Pass A and Pass B failed — no samples ingested, no cursor advancement'
      : undefined;
    const catchupIncomplete = totalChunks > 0 && !gapFullyCovered;
    return {
      metricCode: config.metricCode,
      samplesIngested: totalInserted,
      samplesDeleted: 0,
      newAnchor: preservedAnchor,
      durationMs,
      success,
      cursorUpdated,
      ...(errorMessage != null ? { errorMessage } : {}),
      ...(catchupIncomplete ? { catchupIncomplete } : {}),
    };
  }
  private async queryHealthSamplesForDateRange(
    config: MetricIngestionConfig,
    userId: string,
    sourceId: string,
    fromDate: Date,
    toDate: Date,
    ascending: boolean,
    queryLimit: number,
  ): Promise<{ inserts: InsertHealthSampleInput[]; rawCount: number }> {
    let inserts: InsertHealthSampleInput[] = [];
    let rawCount = 0;
    if (config.isCategory) {
      const result = await this.ports.healthDataProvider.queryRecentCategorySamples!(
        config.providerIdentifier,
        { fromDate, toDate, limit: queryLimit, ascending },
      );
      const rawSamples = result.samples;
      rawCount = rawSamples.length;
      if (rawCount > 0) {
        inserts = config.valueKind === 'CATEGORY'
          ? this.mapCategorySamplesToInsertInput(userId, sourceId, config, rawSamples)
          : this.mapCategoryToNumericSamples(userId, sourceId, config, rawSamples);
        if (config.metricCode === 'sleep_stage' && config.valueKind === 'CATEGORY') {
          const derived = this.deriveSleepIntervalsFromSamples(userId, sourceId, rawSamples);
          if (derived.length > 0) {
            inserts = inserts.concat(derived);
          }
        }
      }
    } else {
      const result = await this.ports.healthDataProvider.queryRecentQuantitySamples!(
        config.providerIdentifier,
        { fromDate, toDate, unit: config.queryUnit, limit: queryLimit, ascending },
      );
      rawCount = result.samples.length;
      if (rawCount > 0) {
        inserts = this.mapQuantitySamplesToInsertInput(userId, sourceId, config, result.samples);
      }
    }
    return { inserts, rawCount };
  }
  private buildDirtyKeyCallback(
    deviceTimezoneOffsetMinutes: number,
  ): ((insertedSamples: InsertHealthSampleInput[]) => Promise<void>) | undefined {
    if (!this.ports.rollupDirtyKeyRepository || !this.ports.sleepDirtyNightRepository) {
      return undefined;
    }
    return async (insertedSamples: InsertHealthSampleInput[]): Promise<void> => {
      const dirtyKeyInputs = insertedSamples.map(s => ({
        userId: s.userId,
        sampleType: s.sampleType,
        startTimestamp: s.startTimestamp,
        endTimestamp: s.endTimestamp,
        timezoneOffsetMinutes: deviceTimezoneOffsetMinutes,
      }));
      const dirtyKeys = computeDirtyKeysFromSamples(dirtyKeyInputs);
      if (dirtyKeys.rollupKeys.length > 0) {
        await this.ports.rollupDirtyKeyRepository!.enqueueBatch(dirtyKeys.rollupKeys);
      }
      if (dirtyKeys.sleepNights.length > 0) {
        await this.ports.sleepDirtyNightRepository!.enqueueBatch(dirtyKeys.sleepNights);
      }
    };
  }
  private async enqueueDirtyKeysNonAtomic(
    inserts: InsertHealthSampleInput[],
    deviceTimezoneOffsetMinutes: number,
    metricCode: string,
  ): Promise<void> {
    if (!this.ports.rollupDirtyKeyRepository || !this.ports.sleepDirtyNightRepository) {
      return;
    }
    if (inserts.length === 0) {
      return;
    }
    try {
      const dirtyKeyInputs = inserts.map(s => ({
        userId: s.userId,
        sampleType: s.sampleType,
        startTimestamp: s.startTimestamp,
        endTimestamp: s.endTimestamp,
        timezoneOffsetMinutes: deviceTimezoneOffsetMinutes,
      }));
      const dirtyKeys = computeDirtyKeysFromSamples(dirtyKeyInputs);
      if (dirtyKeys.rollupKeys.length > 0) {
        await this.ports.rollupDirtyKeyRepository.enqueueBatch(dirtyKeys.rollupKeys);
      }
      if (dirtyKeys.sleepNights.length > 0) {
        await this.ports.sleepDirtyNightRepository.enqueueBatch(dirtyKeys.sleepNights);
      }
    } catch (dirtyKeyError) {
      logger.warn('[HealthIngestionEngine] Dirty key enqueue failed (non-atomic)', {
        metricCode,
        error: dirtyKeyError instanceof Error
          ? { name: dirtyKeyError.name, message: dirtyKeyError.message }
          : { name: 'Error', message: String(dirtyKeyError) },
      });
    }
  }
  private async doIngestAllInternal(
    metricConfigs: readonly MetricIngestionConfig[],
    startTime: number,
    abortSignal?: AbortSignal,
    yieldController?: CooperativeYieldController,
    mode: IngestionMode = 'hot'
  ): Promise<IngestionCycleResult> {
    const metricResults: MetricIngestionResult[] = [];
    const coordState = this.ports.coordinationState;
    let cycleSamplesIngested = 0;
    const maxCycleSamples = coordState.MAX_SAMPLES_PER_INGEST_CYCLE;
    let hitCycleSampleLimit = false;
    const interMetricDelay = async () => {
      const delayMs = coordState.INTER_METRIC_DELAY_MS;
      if (delayMs > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      }
    };
    for (let i = 0; i < metricConfigs.length; i++) {
      const config = metricConfigs[i];
      if (!config) {
        logger.warn('[HealthIngestionEngine] Unexpected undefined config at index', { index: i });
        continue;
      }
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_ingest_metric_start');
      }
      if (abortSignal?.aborted) {
        logger.info('[HealthIngestionEngine] Ingest aborted - stopping metric loop', {
          processedMetrics: metricResults.length,
          remainingMetrics: metricConfigs.length - metricResults.length,
        });
        break;
      }
      if (cycleSamplesIngested >= maxCycleSamples) {
        logger.info('[HealthIngestionEngine] Cycle sample limit reached - deferring remaining metrics', {
          cycleSamplesIngested,
          maxCycleSamples,
          processedMetrics: metricResults.length,
          remainingMetrics: metricConfigs.length - metricResults.length,
          note: 'Remaining metrics will be processed in next ingestion cycle',
        });
        hitCycleSampleLimit = true;
        break;
      }
      const remainingSampleBudget = maxCycleSamples - cycleSamplesIngested;
      try {
        const result = await this.ingestMetric(config, abortSignal, yieldController, {
          maxSamples: remainingSampleBudget,
          mode,
        });
        metricResults.push(result);
        cycleSamplesIngested += result.samplesIngested;
        if (i < metricConfigs.length - 1 && !abortSignal?.aborted) {
          await interMetricDelay();
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('[HealthIngestionEngine] Unexpected error during metric ingest', {
          metricCode: config.metricCode,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
        });
        metricResults.push({
          metricCode: config.metricCode,
          samplesIngested: 0,
          samplesDeleted: 0,
          newAnchor: null,
          durationMs: 0,
          success: false,
          errorMessage,
          cursorUpdated: false,
        });
        if (i < metricConfigs.length - 1 && !abortSignal?.aborted) {
          await interMetricDelay();
        }
      }
    }
    const totalSamplesIngested = metricResults.reduce((sum, r) => sum + r.samplesIngested, 0);
    const totalSamplesDeleted = metricResults.reduce((sum, r) => sum + r.samplesDeleted, 0);
    const failedMetricsCount = metricResults.filter(r => !r.success).length;
    const initialSyncMetricsCount = metricResults.filter(r => r.wasInitialSync).length;
    logger.info('[HealthIngestionEngine] Ingestion cycle completed', {
      totalMetrics: metricConfigs.length,
      processedMetrics: metricResults.length,
      totalSamplesIngested,
      totalSamplesDeleted,
      failedMetricsCount,
      initialSyncMetricsCount,
      hitCycleSampleLimit,
      durationMs: Date.now() - startTime,
    });
    return {
      totalDurationMs: Date.now() - startTime,
      lockAcquired: true,
      metricResults,
      totalSamplesIngested,
      totalSamplesDeleted,
      failedMetricsCount,
    };
  }
  private mapQuantitySamplesToInsertInput(
    userId: string,
    sourceId: string,
    config: MetricIngestionConfig,
    samples: readonly GenericQuantitySample[]
  ): InsertHealthSampleInput[] {
    const inserts: InsertHealthSampleInput[] = [];
    for (const sample of samples) {
      if (!sample.uuid) {
        logger.warn('[HealthIngestionEngine] Skipping sample without UUID', {
          metricCode: config.metricCode,
        });
        continue;
      }
      const metricDef = tryGetMetricDefinitionUnknown(config.metricCode);
      if (!metricDef) {
        logger.warn('[HealthIngestionEngine] Invalid metric code, skipping sample', {
          metricCode: config.metricCode,
        });
        continue;
      }
      let normalizedValue = sample.quantity;
      let normalizedUnit = sample.unit;
      if (sample.unit) {
        const normalizationResult = tryNormalizeToCanonicalUnit(
          config.metricCode as HealthMetricCode,
          sample.quantity,
          sample.unit
        );
        if (!normalizationResult) {
          const resolvedAlias = resolveMetricUnitAlias(config.metricCode, sample.unit);
          logger.warn('[HealthIngestionEngine] Unit normalization failed, skipping sample', {
            metricCode: config.metricCode,
            rawUnit: sample.unit,
            resolvedAlias: resolvedAlias !== sample.unit ? resolvedAlias : undefined,
          });
          continue;
        }
        normalizedValue = normalizationResult.value;
        normalizedUnit = normalizationResult.unit;
        if (normalizationResult.wasConverted) {
          logger.debug('[HealthIngestionEngine] Unit normalized', {
            metricCode: config.metricCode,
            originalUnit: sample.unit,
            normalizedUnit,
          });
        }
      }
      if (normalizedValue != null && !isValueInBounds(config.metricCode as HealthMetricCode, normalizedValue)) {
        logger.warn('[HealthIngestionEngine] Value out of bounds, skipping sample', {
          metricCode: config.metricCode,
          unit: normalizedUnit,
          wasConverted: normalizedValue !== sample.quantity,
        });
        continue;
      }
      const startTimestamp = sample.startDate.getTime();
      const endTimestamp = sample.endDate.getTime();
      if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
        logger.warn('[HealthIngestionEngine] Invalid timestamp (non-finite), skipping sample', {
          metricCode: config.metricCode,
          startTimestamp,
          endTimestamp,
        });
        continue;
      }
      if (startTimestamp > endTimestamp) {
        logger.warn('[HealthIngestionEngine] Invalid timestamp interval (start > end), skipping sample', {
          metricCode: config.metricCode,
          startTimestamp,
          endTimestamp,
        });
        continue;
      }
      const durationSeconds = this.computeDurationSeconds(startTimestamp, endTimestamp);
      inserts.push({
        userId,
        sourceId,
        sourceRecordId: normalizeSourceRecordId(sample.uuid),
        sampleType: config.metricCode,
        valueKind: config.valueKind,
        startTimestamp,   
        endTimestamp,     
        durationSeconds,
        value: normalizedValue,   
        unit: normalizedUnit,     
        categoryCode: null,
        metadata: sample.metadata ?? null,
        deviceId: sample.deviceId ?? null,
        externalUuid: sample.externalUuid ?? null,
      });
    }
    return inserts;
  }
  private mapCategoryToNumericSamples(
    userId: string,
    sourceId: string,
    config: MetricIngestionConfig,
    samples: readonly GenericCategorySample[]
  ): InsertHealthSampleInput[] {
    const inserts: InsertHealthSampleInput[] = [];
    const metricDef = tryGetMetricDefinitionUnknown(config.metricCode);
    if (!metricDef) {
      logger.warn('[HealthIngestionEngine] Invalid metric code for category→numeric conversion', {
        metricCode: config.metricCode,
      });
      return [];
    }
    const canonicalUnit = metricDef.canonicalUnit;
    for (const sample of samples) {
      if (!sample.uuid) {
        logger.warn('[HealthIngestionEngine] Skipping category→numeric sample without UUID', {
          metricCode: config.metricCode,
        });
        continue;
      }
      const numericValue = sample.value;
      if (typeof numericValue !== 'number' || !Number.isFinite(numericValue)) {
        logger.warn('[HealthIngestionEngine] Invalid category value for numeric conversion', {
          metricCode: config.metricCode,
          valueType: typeof numericValue,
        });
        continue;
      }
      if (!isValueInBounds(config.metricCode as HealthMetricCode, numericValue)) {
        logger.warn('[HealthIngestionEngine] Category→numeric value out of bounds, skipping', {
          metricCode: config.metricCode,
        });
        continue;
      }
      const startTimestamp = sample.startDate.getTime();
      const endTimestamp = sample.endDate.getTime();
      if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
        logger.warn('[HealthIngestionEngine] Invalid timestamp (non-finite), skipping category→numeric sample', {
          metricCode: config.metricCode,
        });
        continue;
      }
      if (startTimestamp > endTimestamp) {
        logger.warn('[HealthIngestionEngine] Invalid timestamp interval (start > end), skipping category→numeric sample', {
          metricCode: config.metricCode,
        });
        continue;
      }
      const durationSeconds = this.computeDurationSeconds(startTimestamp, endTimestamp);
      inserts.push({
        userId,
        sourceId,
        sourceRecordId: normalizeSourceRecordId(sample.uuid),
        sampleType: config.metricCode,
        valueKind: config.valueKind, 
        startTimestamp,
        endTimestamp,
        durationSeconds,
        value: numericValue,
        unit: canonicalUnit,
        categoryCode: null, 
        metadata: sample.metadata ?? null,
        deviceId: sample.deviceId ?? null,
        externalUuid: sample.externalUuid ?? null,
      });
    }
    logger.debug('[HealthIngestionEngine] Category→numeric conversion completed', {
      metricCode: config.metricCode,
      inputCount: samples.length,
      outputCount: inserts.length,
    });
    return inserts;
  }
  private mapCategorySamplesToInsertInput(
    userId: string,
    sourceId: string,
    config: MetricIngestionConfig,
    samples: readonly GenericCategorySample[]
  ): InsertHealthSampleInput[] {
    const inserts: InsertHealthSampleInput[] = [];
    for (const sample of samples) {
      if (!sample.uuid) {
        logger.warn('[HealthIngestionEngine] Skipping category sample without UUID', {
          metricCode: config.metricCode,
        });
        continue;
      }
      const metricDef = tryGetMetricDefinitionUnknown(config.metricCode);
      if (!metricDef) {
        logger.warn('[HealthIngestionEngine] Invalid metric code for category sample, skipping', {
          metricCode: config.metricCode,
        });
        continue;
      }
      const categoryCode = config.categoryCodeMapper
        ? config.categoryCodeMapper(sample.value)
        : null;
      if (categoryCode === null) {
        logger.warn('[HealthIngestionEngine] Unknown category value, skipping', {
          metricCode: config.metricCode,
        });
        continue;
      }
      if (!isCategoryCodeAllowed(config.metricCode as HealthMetricCode, categoryCode)) {
        logger.warn('[HealthIngestionEngine] Category code not allowed for metric, skipping', {
          metricCode: config.metricCode,
          categoryCode,
        });
        continue;
      }
      const startTimestamp = sample.startDate.getTime();
      const endTimestamp = sample.endDate.getTime();
      if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
        logger.warn('[HealthIngestionEngine] Invalid timestamp (non-finite), skipping category sample', {
          metricCode: config.metricCode,
          startTimestamp,
          endTimestamp,
        });
        continue;
      }
      if (startTimestamp > endTimestamp) {
        logger.warn('[HealthIngestionEngine] Invalid timestamp interval (start > end), skipping category sample', {
          metricCode: config.metricCode,
          startTimestamp,
          endTimestamp,
        });
        continue;
      }
      const durationSeconds = this.computeDurationSeconds(startTimestamp, endTimestamp);
      inserts.push({
        userId,
        sourceId,
        sourceRecordId: normalizeSourceRecordId(sample.uuid),
        sampleType: config.metricCode,
        valueKind: 'CATEGORY',
        startTimestamp,   
        endTimestamp,     
        durationSeconds,
        value: null,
        unit: null,
        categoryCode,
        metadata: sample.metadata ?? null,
        deviceId: sample.deviceId ?? null,
        externalUuid: sample.externalUuid ?? null,
      });
    }
    return inserts;
  }
  private deriveSleepIntervalsFromSamples(
    userId: string,
    sourceId: string,
    samples: readonly GenericCategorySample[]
  ): InsertHealthSampleInput[] {
    const inserts: InsertHealthSampleInput[] = [];
    const HK_SLEEP = {
      inBed: 0,
      asleepUnspecified: 1,
      awake: 2,
      asleepCore: 3,
      asleepDeep: 4,
      asleepREM: 5,
    } as const;
    const buildIntervalSample = (
      baseSample: GenericCategorySample,
      metricCode: HealthMetricCode
    ): InsertHealthSampleInput | null => {
      const metricDef = tryGetMetricDefinitionUnknown(metricCode);
      if (!metricDef || metricDef.valueKind !== 'INTERVAL_NUM') {
        logger.warn('[HealthIngestionEngine] Invalid interval metric for sleep derivation', {
          metricCode,
        });
        return null;
      }
      const startTimestamp = baseSample.startDate.getTime();
      const endTimestamp = baseSample.endDate.getTime();
      const durationSeconds = this.computeDurationSeconds(startTimestamp, endTimestamp);
      if (durationSeconds <= 0) {
        return null;
      }
      const normalized = tryNormalizeToCanonicalUnit(metricCode, durationSeconds, 's');
      if (!normalized) {
        logger.warn('[HealthIngestionEngine] Failed to normalize sleep interval duration', {
          metricCode,
          durationSeconds,
        });
        return null;
      }
      return {
        userId,
        sourceId,
        sourceRecordId: this.buildDerivedSourceRecordId(normalizeSourceRecordId(baseSample.uuid), metricCode),
        sampleType: metricCode,
        valueKind: 'INTERVAL_NUM',
        startTimestamp,
        endTimestamp,
        durationSeconds,
        value: normalized.value,
        unit: normalized.unit,
        categoryCode: null,
        metadata: baseSample.metadata ?? null,
        deviceId: baseSample.deviceId ?? null,
        externalUuid: baseSample.externalUuid ?? null,
      };
    };
    for (const sample of samples) {
      switch (sample.value) {
        case HK_SLEEP.inBed: {
          const interval = buildIntervalSample(sample, 'time_in_bed');
          if (interval) inserts.push(interval);
          break;
        }
        case HK_SLEEP.asleepUnspecified: {
          const interval = buildIntervalSample(sample, 'sleep_duration');
          if (interval) inserts.push(interval);
          break;
        }
        case HK_SLEEP.awake: {
          const interval = buildIntervalSample(sample, 'sleep_awake');
          if (interval) inserts.push(interval);
          break;
        }
        case HK_SLEEP.asleepCore: {
          const duration = buildIntervalSample(sample, 'sleep_duration');
          const stage = buildIntervalSample(sample, 'sleep_light');
          if (duration) inserts.push(duration);
          if (stage) inserts.push(stage);
          break;
        }
        case HK_SLEEP.asleepDeep: {
          const duration = buildIntervalSample(sample, 'sleep_duration');
          const stage = buildIntervalSample(sample, 'sleep_deep');
          if (duration) inserts.push(duration);
          if (stage) inserts.push(stage);
          break;
        }
        case HK_SLEEP.asleepREM: {
          const duration = buildIntervalSample(sample, 'sleep_duration');
          const stage = buildIntervalSample(sample, 'sleep_rem');
          if (duration) inserts.push(duration);
          if (stage) inserts.push(stage);
          break;
        }
        default:
          break;
      }
    }
    return inserts;
  }
}
export function createHealthIngestionEngine(
  ports: Omit<HealthIngestionEnginePorts, 'coordinationState'>
): HealthIngestionEngine {
  return new HealthIngestionEngine({
    ...ports,
    coordinationState: getHealthSyncCoordinationState(),
  });
}
