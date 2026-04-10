import type { SQLiteDatabase } from 'expo-sqlite';
import type { EntityType } from '@shared/contracts';
import { isEntityType } from '@shared/contracts';
import type { FrontendSyncHandlerRegistry } from '../handlers';
import type { SyncBatchContext } from '../SyncBatchContext';
import type { IApplyEngine, IdMapPort } from './interfaces';
import type {
  SyncRunContext,
  PullChangeItem,
  ApplyReport,
  ApplyChangeResult,
} from './types';
import { createEmptyApplyReport } from './types';
import {
  buildEntityInsert,
  buildEntityUpdate,
  ENTITY_COLUMN_MAPPINGS,
} from '../config/entity-mappings';
import { logger, toLogError } from '../../../utils/logger';
export interface ApplyEngineDependencies {
  readonly db: SQLiteDatabase;
  readonly handlerRegistry: FrontendSyncHandlerRegistry;
  readonly idMap?: Pick<IdMapPort, 'saveMapping'>;
}
interface ApplyHandler {
  handlePullCreate?(userId: string, entityId: string, data: Record<string, unknown>): Promise<unknown>;
  handlePullUpdate?(userId: string, entityId: string, data: Record<string, unknown>): Promise<unknown>;
  handlePullDelete?(userId: string, entityId: string): Promise<unknown>;
}
export class ApplyEngine implements IApplyEngine {
  private readonly db: SQLiteDatabase;
  private readonly handlerRegistry: FrontendSyncHandlerRegistry;
  private readonly idMap: Pick<IdMapPort, 'saveMapping'> | null;
  constructor(deps: ApplyEngineDependencies) {
    this.db = deps.db;
    this.handlerRegistry = deps.handlerRegistry;
    this.idMap = deps.idMap ?? null;
  }
  async applyBatch(
    changes: readonly PullChangeItem[],
    ctx: SyncRunContext,
  ): Promise<ApplyReport> {
    const startTime = Date.now();
    const results: ApplyChangeResult[] = [];
    if (changes.length === 0) {
      logger.debug('[ApplyEngine] No changes to apply');
      return createEmptyApplyReport(Date.now() - startTime);
    }
    logger.debug('[ApplyEngine] Applying batch', {
      correlationId: ctx.correlationId,
      changeCount: changes.length,
    });
    const yieldController = ctx.yieldController;
    for (const change of changes) {
      if (yieldController) {
        await yieldController.yieldIfNeeded('apply_change');
      }
      try {
        const result = await this.applySingleChange(change, ctx);
        results.push(result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({
          status: 'failed',
          entityType: change.entityType,
          serverId: change.serverId,
          error: errorMessage,
        });
        logger.error('[ApplyEngine] Failed to apply change', {
          entityType: change.entityType,
          serverId: change.serverId.substring(0, 8) + '...',
          error: { name: 'ApplyError', message: errorMessage },
        });
      }
    }
    return this.buildReport(results, startTime);
  }
  async applySingle(
    change: PullChangeItem,
    ctx: SyncRunContext,
  ): Promise<ApplyReport> {
    const startTime = Date.now();
    try {
      const result = await this.applySingleChange(change, ctx);
      return this.buildReport([result], startTime);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.buildReport([{
        status: 'failed',
        entityType: change.entityType,
        serverId: change.serverId,
        error: errorMessage,
      }], startTime);
    }
  }
  private async applySingleChange(
    change: PullChangeItem,
    ctx: SyncRunContext,
  ): Promise<ApplyChangeResult> {
    const { entityType, operation, serverId, data } = change;
    if (!isEntityType(entityType)) {
      return {
        status: 'skipped',
        entityType,
        serverId,
        reason: `Unknown entity type: ${entityType}`,
      };
    }
    const publicCatalogSkipReason = await this.shouldSkipAsPublicCatalog(change);
    if (publicCatalogSkipReason) {
      return {
        status: 'skipped',
        entityType,
        serverId,
        reason: publicCatalogSkipReason,
      };
    }
    const handler = this.handlerRegistry.get(entityType) as ApplyHandler | undefined;
    switch (operation) {
      case 'CREATE':
        return this.applyCreate(entityType, serverId, data ?? {}, ctx, handler);
      case 'UPDATE':
        return this.applyUpdate(entityType, serverId, data ?? {}, ctx, handler);
      case 'DELETE':
        return this.applyDelete(entityType, serverId, ctx, handler);
      default:
        return {
          status: 'skipped',
          entityType,
          serverId,
          reason: `Unknown operation: ${operation}`,
        };
    }
  }
  private async applyCreate(
    entityType: EntityType,
    serverId: string,
    data: Record<string, unknown>,
    ctx: SyncRunContext,
    handler?: ApplyHandler,
  ): Promise<ApplyChangeResult> {
    const existing = await this.findExistingEntity(entityType, serverId);
    if (existing) {
      logger.debug('[ApplyEngine] CREATE found existing entity, treating as UPDATE', {
        entityType,
        serverId: serverId.substring(0, 8) + '...',
      });
      return this.applyUpdate(entityType, serverId, data, ctx, handler);
    }
    if (handler?.handlePullCreate) {
      await handler.handlePullCreate(ctx.userId, serverId, data);
    } else {
      const { sql, params } = buildEntityInsert(
        entityType,
        serverId,
        data,
        new Date().toISOString()
      );
      await this.db.runAsync(sql, params);
    }
    await this.saveIdentityMapping(entityType, serverId);
    ctx.batchContext.touch(entityType, serverId);
    return {
      status: 'applied',
      entityType,
      serverId,
    };
  }
  private async applyUpdate(
    entityType: EntityType,
    serverId: string,
    data: Record<string, unknown>,
    ctx: SyncRunContext,
    handler?: ApplyHandler,
  ): Promise<ApplyChangeResult> {
    const existing = await this.findExistingEntity(entityType, serverId);
    if (!existing) {
      logger.debug('[ApplyEngine] UPDATE found no existing entity, treating as CREATE', {
        entityType,
        serverId: serverId.substring(0, 8) + '...',
      });
      return this.applyCreate(entityType, serverId, data, ctx, handler);
    }
    if (handler?.handlePullUpdate) {
      await handler.handlePullUpdate(ctx.userId, serverId, data);
    } else {
      const { sql, params } = buildEntityUpdate(
        entityType,
        serverId,
        data,
        new Date().toISOString()
      );
      await this.db.runAsync(sql, params);
    }
    await this.saveIdentityMapping(entityType, serverId);
    ctx.batchContext.touch(entityType, serverId);
    return {
      status: 'applied',
      entityType,
      serverId,
    };
  }
  private async applyDelete(
    entityType: EntityType,
    serverId: string,
    ctx: SyncRunContext,
    handler?: ApplyHandler,
  ): Promise<ApplyChangeResult> {
    if (handler?.handlePullDelete) {
      await handler.handlePullDelete(ctx.userId, serverId);
    } else {
      const config = ENTITY_COLUMN_MAPPINGS[entityType];
      const idCol = config?.baseColumns.hasServerId ? 'server_id' : 'id';
      await this.db.runAsync(
        `DELETE FROM ${entityType} WHERE ${idCol} = ?`,
        [serverId]
      );
    }
    ctx.batchContext.recordDelete(entityType, serverId);
    return {
      status: 'applied',
      entityType,
      serverId,
    };
  }
  private async saveIdentityMapping(
    entityType: EntityType,
    serverId: string,
  ): Promise<void> {
    if (!this.idMap) return;
    try {
      await this.idMap.saveMapping(entityType, serverId, serverId);
    } catch (error) {
      logger.warn('[ApplyEngine] Failed to save identity mapping', {
        entityType,
        serverId: serverId.substring(0, 8) + '...',
        error: toLogError(error),
      });
    }
  }
  private async shouldSkipAsPublicCatalog(
    change: PullChangeItem,
  ): Promise<string | null> {
    if (change.entityType !== 'products') {
      return null;
    }
    const { operation, data, serverId } = change;
    if (operation === 'CREATE' || operation === 'UPDATE') {
      const isPublic = data?.isPublic;
      if (isPublic === true || isPublic === 1) {
        return `Public catalog product skipped (${operation}): managed by local snapshot, not sync`;
      }
      return null;
    }
    if (operation === 'DELETE') {
      const existing = await this.findExistingEntity('products', serverId);
      if (!existing) {
        return null;
      }
      const isPublic = existing.isPublic;
      if (isPublic === true || isPublic === 1) {
        return 'Public catalog product DELETE skipped: managed by local snapshot, not sync';
      }
      return null;
    }
    return null;
  }
  private async findExistingEntity(
    entityType: EntityType,
    serverId: string,
  ): Promise<Record<string, unknown> | null> {
    const config = ENTITY_COLUMN_MAPPINGS[entityType];
    if (!config) {
      logger.warn('[ApplyEngine] No column mapping for entity type', { entityType });
      return null;
    }
    const hasServerIdCol = config.baseColumns.hasServerId;
    const idLookupCol = hasServerIdCol ? 'server_id' : 'id';
    const result = await this.db.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM ${entityType} WHERE ${idLookupCol} = ?`,
      [serverId]
    );
    if (result) {
      return result;
    }
    if (hasServerIdCol) {
      const fallbackResult = await this.db.getFirstAsync<Record<string, unknown>>(
        `SELECT * FROM ${entityType} WHERE id = ?`,
        [serverId]
      );
      return fallbackResult;
    }
    return null;
  }
  private buildReport(
    results: ApplyChangeResult[],
    startTime: number,
  ): ApplyReport {
    const applied: { entityType: EntityType; serverId: string }[] = [];
    const skipped: { entityType: EntityType; serverId: string; reason: string }[] = [];
    const conflictsResolved: { entityType: EntityType; serverId: string; outcome: string }[] = [];
    const failed: { entityType: EntityType; serverId: string; error: string }[] = [];
    for (const result of results) {
      switch (result.status) {
        case 'applied':
          applied.push({ entityType: result.entityType, serverId: result.serverId });
          break;
        case 'skipped':
          skipped.push({ entityType: result.entityType, serverId: result.serverId, reason: result.reason });
          break;
        case 'conflict_resolved':
          conflictsResolved.push({ entityType: result.entityType, serverId: result.serverId, outcome: result.outcome });
          break;
        case 'failed':
          failed.push({ entityType: result.entityType, serverId: result.serverId, error: result.error });
          break;
      }
    }
    const failedByType = this.computeFailedByType(failed);
    return {
      applied,
      skipped,
      conflictsResolved,
      failed,
      failedByType,
      totalProcessed: results.length,
      durationMs: Date.now() - startTime,
      success: failed.length === 0,
    };
  }
  private computeFailedByType(
    failed: readonly { entityType: EntityType; serverId: string; error: string }[],
  ): Readonly<Partial<Record<EntityType, readonly string[]>>> {
    if (failed.length === 0) {
      return {};
    }
    const failedByType: Partial<Record<EntityType, string[]>> = {};
    for (const item of failed) {
      const existingList = failedByType[item.entityType];
      if (existingList) {
        existingList.push(item.serverId);
      } else {
        failedByType[item.entityType] = [item.serverId];
      }
    }
    const entityTypesWithFailures = Object.keys(failedByType);
    if (entityTypesWithFailures.length > 0) {
      logger.warn('[ApplyEngine] Apply failures by entity type', {
        failedEntityTypes: entityTypesWithFailures,
        totalFailed: failed.length,
      });
    }
    return failedByType as Readonly<Partial<Record<EntityType, readonly string[]>>>;
  }
}
