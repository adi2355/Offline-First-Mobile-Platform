import type { EntityType } from '@shared/contracts';
import {
  buildCompositeCursor,
  encodeCompositeCursor,
  InvalidCursorError,
  computeSyncChangesEtag,
  DEFAULT_PRODUCT_SYNC_FIELDS,
} from '@shared/contracts';
import type { BackendAPIClient } from '../../api/BackendAPIClient';
import type { IApplyEngine, IPullEngine, PullEngineStats, IPullEngineRepositories } from './interfaces';
import type { SyncRunContext, PullReport, PullChangeItem, EntityCursorMap } from './types';
import { createEmptyPullReport, SyncEngineError, SYNC_ERROR_CODES } from './types';
import { getSyncableEntityTypes } from '../config/entity-mappings';
import { logger } from '../../../utils/logger';
import { DeviceIdManager } from '../../../utils/DeviceIdManager';
import { metrics } from '../../metrics/Metrics';
import { isFeatureEnabled } from '../../../config/featureFlags';
export interface PullEngineDependencies {
  readonly repositories: IPullEngineRepositories;
  readonly apiClient: BackendAPIClient;
  readonly applyEngine: IApplyEngine;
}
interface PullChangesResponse {
  readonly changes: readonly ServerChange[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly entityCursors: Record<string, string>;
  readonly recordsReturned: number;
}
interface ServerChange {
  readonly entityType: EntityType;
  readonly operation: 'CREATE' | 'UPDATE' | 'DELETE';
  readonly serverId: string;
  readonly data?: Record<string, unknown>;
  readonly timestamp: string;
}
const MAX_PULL_ITERATIONS = 15;
const DEFAULT_PULL_LIMIT = 700;
export class PullEngine implements IPullEngine {
  private readonly repos: IPullEngineRepositories;
  private readonly apiClient: BackendAPIClient;
  private readonly applyEngine: IApplyEngine;
  private stats: PullEngineStats = {
    totalChangesPulled: 0,
    totalIterations: 0,
    lastPullTime: null,
    lastCursor: null,
  };
  constructor(deps: PullEngineDependencies) {
    this.repos = deps.repositories;
    this.apiClient = deps.apiClient;
    this.applyEngine = deps.applyEngine;
  }
  async pull(ctx: SyncRunContext): Promise<PullReport> {
    const entityTypes = getSyncableEntityTypes();
    return this.pullForEntityTypes(entityTypes, ctx);
  }
  async pullForEntityTypes(
    entityTypes: readonly EntityType[],
    ctx: SyncRunContext,
  ): Promise<PullReport> {
    const startTime = Date.now();
    try {
      logger.debug('[PullEngine] Starting pull operation', {
        correlationId: ctx.correlationId,
        entityCount: entityTypes.length,
      });
      const compositeCursor = await this.buildCursor(entityTypes);
      const deviceId = await DeviceIdManager.getDeviceId();
      const result = await this.pullWithPagination(
        entityTypes,
        compositeCursor,
        deviceId,
        ctx
      );
      this.stats = {
        totalChangesPulled: this.stats.totalChangesPulled + result.totalChanges,
        totalIterations: this.stats.totalIterations + result.iterations,
        lastPullTime: Date.now(),
        lastCursor: result.lastCursor,
      };
      const report: PullReport = {
        changes: result.changes,
        cursor: result.lastCursor,
        hasMore: result.hasMore,
        entityCursors: result.entityCursors as EntityCursorMap,
        recordsReturned: result.totalChanges,
        durationMs: Date.now() - startTime,
        success: true,
      };
      logger.info('[PullEngine] Pull completed', {
        correlationId: ctx.correlationId,
        totalChanges: result.totalChanges,
        iterations: result.iterations,
        durationMs: report.durationMs,
      });
      return report;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        changes: [],
        cursor: null,
        hasMore: false,
        entityCursors: {} as EntityCursorMap,
        recordsReturned: 0,
        durationMs: Date.now() - startTime,
        success: false,
        error: errorMessage,
      };
    }
  }
  getStats(): PullEngineStats {
    return { ...this.stats };
  }
  private async buildCursor(entityTypes: readonly EntityType[]): Promise<string | undefined> {
    const storedEntityCursors: Record<string, string | null> = {};
    for (const entityType of entityTypes) {
      const cursor = await this.repos.cursor.getCursor(entityType);
      storedEntityCursors[entityType] = cursor;
    }
    try {
      const composite = buildCompositeCursor(storedEntityCursors);
      if (composite) {
        const encoded = encodeCompositeCursor(composite);
        logger.debug('[PullEngine] Built composite cursor', {
          lastCreatedAt: composite.lastCreatedAt,
          entityCount: Object.keys(composite.entityCursors).length,
        });
        return encoded;
      }
      logger.debug('[PullEngine] No valid cursor, performing initial sync');
      return undefined;
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        logger.error('[PullEngine] Corrupted cursor state, performing full sync', {
          error: { name: 'InvalidCursorError', message: error.reason },
        });
        return undefined;
      }
      throw error;
    }
  }
  private async pullWithPagination(
    entityTypes: readonly EntityType[],
    initialCursor: string | undefined,
    deviceId: string,
    ctx: SyncRunContext,
  ): Promise<{
    changes: PullChangeItem[];
    totalChanges: number;
    iterations: number;
    hasMore: boolean;
    lastCursor: string | null;
    entityCursors: Record<string, string>;
  }> {
    const allChanges: PullChangeItem[] = [];
    let nextCursor: string | undefined = initialCursor;
    let hasMore = true;
    let iterations = 0;
    let lastEntityCursors: Record<string, string> = {};
    while (hasMore && iterations < MAX_PULL_ITERATIONS) {
      iterations++;
      const pageStartTime = Date.now();
      logger.debug(`[PullEngine] Pulling page ${iterations}`, {
        cursor: nextCursor ? nextCursor.substring(0, 8) + '...' : 'none',
      });
      const fetchStartTime = Date.now();
      const catalogShapingEnabled = isFeatureEnabled('catalogSnapshotV2');
      const productFields = catalogShapingEnabled ? DEFAULT_PRODUCT_SYNC_FIELDS : undefined;
      const productFieldsParam = productFields ? productFields.join(',') : undefined;
      const etag = catalogShapingEnabled && nextCursor
        ? computeSyncChangesEtag({
            cursor: nextCursor,
            entityTypes,
            limit: DEFAULT_PULL_LIMIT,
            productFields,
          })
        : undefined;
      const response = await this.apiClient.getWithMetadata<PullChangesResponse>('/sync/changes', {
        params: {
          deviceId,
          cursor: nextCursor,
          entityTypes: (entityTypes as EntityType[]).join(','),
          limit: String(DEFAULT_PULL_LIMIT),
          ...(ctx.leaseId ? { leaseId: ctx.leaseId } : {}),
          ...(productFieldsParam ? { productFields: productFieldsParam } : {}),
        },
        headers: etag ? { 'If-None-Match': etag } : undefined,
      });
      const fetchDurationMs = Date.now() - fetchStartTime;
      if (!response.success) {
        const apiError = response.error;
        if (apiError) {
          const error = new Error(apiError.message);
          Object.assign(error, apiError);
          throw error;
        }
        throw new Error('PullEngine: Request failed');
      }
      if (response.metadata?.statusCode === 304) {
        metrics.trackEvent('metricsSync', 'sync_pull_not_modified', {
          iteration: iterations,
          entity_count: entityTypes.length,
          batch_id: ctx.correlationId,
          page_id: `${ctx.correlationId}:${iterations}`,
          api_correlation_id: response.metadata?.correlationId ?? '',
          page_total_ms: Date.now() - pageStartTime,
        });
        logger.debug('[PullEngine] 304 Not Modified - no changes to apply', {
          iteration: iterations,
        });
        hasMore = false;
        break;
      }
      if (!response.data) {
        throw new Error('PullEngine: Missing response data');
      }
      const { changes, cursor: responseCursor, hasMore: moreAvailable, entityCursors } = response.data;
      if (changes.length === 0) {
        logger.debug('[PullEngine] Received empty changes, ending pull');
        break;
      }
      logger.info(`[PullEngine] Received batch ${iterations}`, {
        changes: changes.length,
        hasMore: moreAvailable,
      });
      const decodeStartTime = Date.now();
      const pullChanges: PullChangeItem[] = [];
      const yieldController = ctx.yieldController;
      if (yieldController) {
        for (const change of changes) {
          pullChanges.push({
            entityType: change.entityType,
            operation: change.operation,
            serverId: change.serverId,
            data: change.data,
            timestamp: change.timestamp,
          });
          await yieldController.yieldIfNeeded('pull_decode');
        }
      } else {
        for (const change of changes) {
          pullChanges.push({
            entityType: change.entityType,
            operation: change.operation,
            serverId: change.serverId,
            data: change.data,
            timestamp: change.timestamp,
          });
        }
      }
      const decodeDurationMs = Date.now() - decodeStartTime;
      const applyStartTime = Date.now();
      if (yieldController) {
        await yieldController.yieldIfNeeded('pull_apply_start');
      }
      const applyReport = await this.applyEngine.applyBatch(pullChanges, ctx);
      const applyDurationMs = Date.now() - applyStartTime;
      const parseDurationMs = response.metadata?.parseDurationMs ?? 0;
      metrics.trackEvent('metricsSync', 'sync_pull_page_timing', {
        iteration: iterations,
        entity_count: entityTypes.length,
        change_count: pullChanges.length,
        batch_id: ctx.correlationId,
        page_id: `${ctx.correlationId}:${iterations}`,
        api_correlation_id: response.metadata?.correlationId ?? '',
        fetch_ms: fetchDurationMs,
        parse_ms: parseDurationMs,
        decode_ms: decodeDurationMs,
        apply_ms: applyDurationMs,
        has_more: moreAvailable,
        page_total_ms: Date.now() - pageStartTime,
      });
      this.deferCursorUpdates(entityTypes, entityCursors, applyReport, moreAvailable, ctx);
      allChanges.push(...pullChanges);
      lastEntityCursors = entityCursors;
      hasMore = moreAvailable;
      nextCursor = responseCursor ?? undefined;
    }
    return {
      changes: allChanges,
      totalChanges: allChanges.length,
      iterations,
      hasMore,
      lastCursor: nextCursor ?? null,
      entityCursors: lastEntityCursors,
    };
  }
  private deferCursorUpdates(
    entityTypes: readonly EntityType[],
    entityCursors: Record<string, string>,
    applyReport: {
      readonly applied: readonly { entityType: EntityType }[];
      readonly failed: readonly { entityType: EntityType }[];
      readonly failedByType: Readonly<Partial<Record<EntityType, readonly string[]>>>;
    },
    hasMore: boolean,
    ctx: SyncRunContext,
  ): void {
    const appliedByType = new Map<EntityType, number>();
    for (const item of applyReport.applied) {
      const count = appliedByType.get(item.entityType) ?? 0;
      appliedByType.set(item.entityType, count + 1);
    }
    for (const entityType of entityTypes) {
      const appliedCount = appliedByType.get(entityType) ?? 0;
      if (appliedCount === 0) continue;
      const failedForType = applyReport.failedByType[entityType];
      if (failedForType && failedForType.length > 0) {
        logger.warn('[PullEngine] NOT deferring cursor due to failures', {
          entityType,
          failedCount: failedForType.length,
          appliedCount,
        });
        continue; 
      }
      if (Object.prototype.hasOwnProperty.call(entityCursors, entityType)) {
        const newCursor = entityCursors[entityType] ?? null;
        ctx.batchContext.deferCursorUpdate(entityType, newCursor, appliedCount, hasMore);
        logger.debug('[PullEngine] Deferred cursor update', {
          entityType,
          appliedCount,
          hasMore,
        });
      }
    }
  }
}
