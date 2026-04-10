import { type SQLiteDatabase } from 'expo-sqlite';
import {
  type EntityType,
  type MergeContext,
  type MergeResult,
  type ConflictResolutionOutcome,
  mergeEntity,
  createMergeContext,
  isConflictFree,
  hasServerIdColumn,
  adoptServer,
  rebaseAndRetry,
  skipped,
} from '@shared/contracts';
import {
  type FrontendSyncEntityHandler,
} from './FrontendSyncEntityHandler';
import {
  type SyncEntityRepository,
} from '../repositories/SyncEntityRepository';
import {
  executeCascade,
  type CascadeExecutionResult,
  CascadeExecutionError,
} from '../utils/CascadeExecutor';
import {
  ForeignKeyResolver,
  type IdMappingLookup,
} from '../utils/ForeignKeyResolver';
export interface ModelBRepository<T> extends SyncEntityRepository<T> {
  updateServerId(clientId: string, serverId: string): Promise<void>;
}
export function isModelBRepository<T>(repo: SyncEntityRepository<T>): repo is ModelBRepository<T> {
  return 'updateServerId' in repo && typeof (repo as ModelBRepository<T>).updateServerId === 'function';
}
export interface SyncLogger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}
export interface SyncClock {
  nowIso(): string;
}
export const systemClock: SyncClock = {
  nowIso: () => new Date().toISOString(),
};
export function createFixedClock(fixedTime: string | Date): SyncClock {
  const isoTime = typeof fixedTime === 'string' ? fixedTime : fixedTime.toISOString();
  return {
    nowIso: () => isoTime,
  };
}
export interface GenericSyncHandlerDependencies<T> {
  entityType: EntityType;
  repository: SyncEntityRepository<T>;
  database?: SQLiteDatabase;
  logger?: SyncLogger;
  clock?: SyncClock;
  customMerge?: (local: T, server: T, context: MergeContext) => MergeResult<T>;
  tableName?: string;
  idMappingLookup?: IdMappingLookup;
}
export interface MergeOperationResult<T> {
  merged: T;
  resolvedFromLocal: readonly string[];
  resolvedFromServer: readonly string[];
  mergedFields: readonly string[];
  version: number;
}
const noOpLogger: SyncLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
export class GenericSyncHandler<T extends Record<string, unknown>>
  implements FrontendSyncEntityHandler<T>
{
  readonly entityType: EntityType;
  private readonly repository: SyncEntityRepository<T>;
  private readonly database: SQLiteDatabase | null;
  private readonly logger: SyncLogger;
  private readonly clock: SyncClock;
  private readonly customMerge?: (local: T, server: T, context: MergeContext) => MergeResult<T>;
  private readonly tableName: string;
  private readonly fkResolver: ForeignKeyResolver | null;
  constructor(deps: GenericSyncHandlerDependencies<T>) {
    if (!deps.entityType) {
      throw new Error('[GenericSyncHandler] entityType is required');
    }
    if (!deps.repository) {
      throw new Error('[GenericSyncHandler] repository is required');
    }
    this.entityType = deps.entityType;
    this.repository = deps.repository;
    this.database = deps.database ?? null;
    this.clock = deps.clock ?? systemClock;
    this.customMerge = deps.customMerge;
    this.tableName = deps.tableName ?? deps.entityType;
    this.fkResolver = deps.idMappingLookup
      ? new ForeignKeyResolver(deps.idMappingLookup)
      : null;
    if (!deps.logger) {
      const isTestEnv =
        typeof process !== 'undefined' &&
        (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined);
      if (!isTestEnv) {
        console.warn(
          `[GenericSyncHandler:${deps.entityType}] WARNING: No logger provided. ` +
          'This can hide errors in production. ' +
          'Please provide a logger for observability.'
        );
      }
      this.logger = noOpLogger;
    } else {
      this.logger = deps.logger;
    }
    this.logger.debug('[GenericSyncHandler] Initialized', {
      entityType: this.entityType,
      hasDatabase: !!this.database,
      hasCustomMerge: !!this.customMerge,
      hasCustomClock: !!deps.clock,
      hasFkResolver: !!this.fkResolver,
      tableName: this.tableName,
    });
  }
  merge(localData: T, serverData: T): T {
    const now = this.clock.nowIso();
    const context = createMergeContext(
      localData as { version?: number; updatedAt?: string },
      serverData as { version?: number; updatedAt?: string },
      now
    );
    this.logger.debug('[GenericSyncHandler] Starting merge', {
      entityType: this.entityType,
      localId: (localData as { id?: string }).id,
      serverId: (serverData as { id?: string }).id,
      localVersion: context.localVersion,
      serverVersion: context.serverVersion,
      timestamp: context.now,
    });
    if (this.customMerge) {
      const result = this.customMerge(localData, serverData, context);
      this.logger.info('[GenericSyncHandler] Custom merge completed', {
        entityType: this.entityType,
        resultVersion: result.version,
        resolvedFromLocal: result.resolvedFromLocal,
        resolvedFromServer: result.resolvedFromServer,
        mergedFields: result.mergedFields,
      });
      return result.data;
    }
    if (isConflictFree(this.entityType)) {
      this.logger.debug('[GenericSyncHandler] Entity is conflict-free, server wins', {
        entityType: this.entityType,
      });
      return this.ensureVersionIncrement(serverData, localData, serverData, now);
    }
    const result = mergeEntity<T>(this.entityType, localData, serverData, context);
    const hadLocalResolutions = result.resolvedFromLocal.length > 0;
    const hadMergedFields = result.mergedFields.length > 0;
    this.logger.info('[GenericSyncHandler] Merge completed', {
      entityType: this.entityType,
      resultVersion: result.version,
      resolvedFromLocal: result.resolvedFromLocal,
      resolvedFromServer: result.resolvedFromServer,
      mergedFields: result.mergedFields,
      hadLocalResolutions,
      hadMergedFields,
    });
    return result.data;
  }
  async handleIdReplacement(clientId: string, serverId: string): Promise<void> {
    if (clientId === serverId) {
      this.logger.debug('[GenericSyncHandler] IDs identical, skipping', {
        entityType: this.entityType,
        clientId,
      });
      return;
    }
    if (hasServerIdColumn(this.entityType)) {
      this.logger.info('[GenericSyncHandler] Model B: Updating server_id column', {
        entityType: this.entityType,
        clientId,
        serverId,
      });
      if (!isModelBRepository(this.repository)) {
        this.logger.error('[GenericSyncHandler] Model B entity but repository lacks updateServerId', {
          entityType: this.entityType,
          repositoryType: this.repository.constructor.name,
        });
        throw new Error(
          `[GenericSyncHandler] Repository for ${this.entityType} does not implement updateServerId(). ` +
          `Model B entities require updateServerId() method.`
        );
      }
      try {
        await this.repository.updateServerId(clientId, serverId);
        this.logger.info('[GenericSyncHandler] Model B: server_id updated', {
          entityType: this.entityType,
          clientId,
          serverId,
        });
        return;
      } catch (error) {
        this.logger.error('[GenericSyncHandler] Model B: updateServerId failed', {
          entityType: this.entityType,
          clientId,
          serverId,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : { message: String(error) },
        });
        throw error;
      }
    }
    if (!this.database) {
      this.logger.error('[GenericSyncHandler] Missing database for ID replacement', {
        entityType: this.entityType,
        clientId,
        serverId,
      });
      throw new Error(
        `[GenericSyncHandler] Database is required for ID replacement on ${this.entityType}. ` +
        `Model A entities must update primary keys and cascades transactionally.`
      );
    }
    this.logger.info('[GenericSyncHandler] Model A: Starting transactional ID cascade', {
      entityType: this.entityType,
      clientId,
      serverId,
    });
    try {
      const result: CascadeExecutionResult = await executeCascade(
        this.database,
        this.entityType,
        clientId,
        serverId,
        {
          tableName: this.tableName,
          logger: this.logger,
        }
      );
      this.logger.info('[GenericSyncHandler] Model A: ID cascade completed', {
        entityType: this.entityType,
        clientId,
        serverId,
        cascadeCount: result.cascadeCount,
        cascadedTables: result.cascadedTables,
        committed: result.committed,
      });
    } catch (error) {
      if (error instanceof CascadeExecutionError) {
        this.logger.error('[GenericSyncHandler] ID replacement failed', {
          entityType: this.entityType,
          clientId,
          serverId,
          phase: error.phase,
          failedTable: error.failedStatement?.table,
          failedColumn: error.failedStatement?.column,
          error: { name: error.name, message: error.message },
        });
      } else {
        this.logger.error('[GenericSyncHandler] ID replacement failed with unexpected error', {
          entityType: this.entityType,
          clientId,
          serverId,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : { message: String(error) },
        });
      }
      throw error;
    }
  }
  async handleConflict(
    userId: string,
    entityId: string,
    localData: Partial<T>,
    serverData?: T
  ): Promise<T | null> {
    if (!serverData) {
      this.logger.debug('[GenericSyncHandler] No serverData in conflict, skipping', {
        entityType: this.entityType,
        entityId,
      });
      return null;
    }
    const currentLocal = await this.repository.findById(entityId);
    if (!currentLocal) {
      this.logger.warn('[GenericSyncHandler] Local entity not found for conflict', {
        entityType: this.entityType,
        entityId,
      });
      return null;
    }
    const merged = this.merge(currentLocal, serverData);
    await this.repository.update(entityId, merged);
    this.logger.info('[GenericSyncHandler] Conflict resolved', {
      entityType: this.entityType,
      entityId,
      mergedVersion: (merged as { version?: number }).version,
    });
    return merged;
  }
  async handleConflictV2(
    userId: string,
    entityId: string,
    localData: Partial<T>,
    serverData?: T
  ): Promise<ConflictResolutionOutcome<T>> {
    if (!serverData) {
      this.logger.debug('[GenericSyncHandler] No serverData in conflict, skipping', {
        entityType: this.entityType,
        entityId,
      });
      return skipped('No server data provided in conflict response');
    }
    const currentLocal = await this.repository.findById(entityId);
    if (!currentLocal) {
      this.logger.warn('[GenericSyncHandler] Local entity not found for conflict', {
        entityType: this.entityType,
        entityId,
      });
      return skipped(`Local entity not found: ${entityId}`);
    }
    if (isConflictFree(this.entityType)) {
      this.logger.debug('[GenericSyncHandler] Entity is conflict-free, adopting server data', {
        entityType: this.entityType,
        entityId,
      });
      await this.repository.update(entityId, serverData);
      const serverVersion = (serverData as { version?: number }).version ?? 1;
      return adoptServer(
        serverData,
        serverVersion,
        `Conflict-free entity type: ${this.entityType}`
      );
    }
    const now = this.clock.nowIso();
    const context = createMergeContext(
      currentLocal as { version?: number; updatedAt?: string },
      serverData as { version?: number; updatedAt?: string },
      now
    );
    this.logger.debug('[GenericSyncHandler] Merging conflict', {
      entityType: this.entityType,
      entityId,
      localVersion: context.localVersion,
      serverVersion: context.serverVersion,
    });
    let mergeResult: MergeResult<T>;
    let resolvedFromLocal: readonly string[] = [];
    let resolvedFromServer: readonly string[] = [];
    let mergedFields: readonly string[] = [];
    if (this.customMerge) {
      const customResult = this.customMerge(currentLocal, serverData, context);
      await this.repository.update(entityId, customResult.data);
      this.logger.info('[GenericSyncHandler] Conflict resolved with custom merge (REBASE_AND_RETRY)', {
        entityType: this.entityType,
        entityId,
        newVersion: customResult.version,
        resolvedFromLocal: customResult.resolvedFromLocal,
        resolvedFromServer: customResult.resolvedFromServer,
        mergedFields: customResult.mergedFields,
      });
      return rebaseAndRetry(
        customResult.data,
        customResult.version,
        customResult.resolvedFromLocal,
        customResult.resolvedFromServer,
        customResult.mergedFields
      );
    }
    mergeResult = mergeEntity<T>(this.entityType, currentLocal, serverData, context);
    resolvedFromLocal = mergeResult.resolvedFromLocal;
    resolvedFromServer = mergeResult.resolvedFromServer;
    mergedFields = mergeResult.mergedFields;
    await this.repository.update(entityId, mergeResult.data);
    this.logger.info('[GenericSyncHandler] Conflict resolved with config merge (REBASE_AND_RETRY)', {
      entityType: this.entityType,
      entityId,
      newVersion: mergeResult.version,
      resolvedFromLocal,
      resolvedFromServer,
      mergedFields,
    });
    return rebaseAndRetry(
      mergeResult.data,
      mergeResult.version,
      resolvedFromLocal,
      resolvedFromServer,
      mergedFields
    );
  }
  private async resolveInboundForeignKeys(serverData: T): Promise<T> {
    if (!this.fkResolver) {
      return serverData;
    }
    if (!this.fkResolver.hasForeignKeys(this.entityType)) {
      return serverData;
    }
    const report = await this.fkResolver.resolveInboundForeignKeys(
      this.entityType,
      serverData
    );
    if (report.resolvedFields.length > 0) {
      this.logger.debug('[GenericSyncHandler] Resolved inbound FKs', {
        entityType: this.entityType,
        summary: ForeignKeyResolver.getSummary(report),
        resolvedFields: report.resolvedFields,
        unresolvedFields: report.unresolvedFields,
      });
    }
    return report.data;
  }
  async handlePullCreate(userId: string, entityId: string, serverData: T): Promise<T> {
    const existing = await this.repository.findById(entityId);
    if (existing) {
      this.logger.debug('[GenericSyncHandler] Entity exists, updating instead', {
        entityType: this.entityType,
        entityId,
      });
      return this.handlePullUpdate(userId, entityId, serverData);
    }
    const resolvedData = await this.resolveInboundForeignKeys(serverData);
    const dataWithId = {
      ...resolvedData,
      id: entityId,
    } as T;
    const created = await this.repository.create(dataWithId, { syncStatus: 'synced' });
    this.logger.info('[GenericSyncHandler] Created entity from server', {
      entityType: this.entityType,
      entityId,
    });
    return created;
  }
  async handlePullUpdate(userId: string, entityId: string, serverData: T): Promise<T> {
    const localEntity = await this.repository.findById(entityId);
    if (!localEntity) {
      this.logger.debug('[GenericSyncHandler] Entity not found, creating instead', {
        entityType: this.entityType,
        entityId,
      });
      return this.handlePullCreate(userId, entityId, serverData);
    }
    const resolvedData = await this.resolveInboundForeignKeys(serverData);
    const merged = this.mergeForPull(localEntity, resolvedData);
    const updated = await this.repository.update(entityId, merged);
    await this.repository.markSynced(entityId);
    this.logger.info('[GenericSyncHandler] Updated entity from server', {
      entityType: this.entityType,
      entityId,
    });
    return updated;
  }
  async handlePullDelete(userId: string, entityId: string): Promise<T | null> {
    const deleted = await this.repository.delete(entityId);
    if (deleted) {
      this.logger.info('[GenericSyncHandler] Deleted entity from server', {
        entityType: this.entityType,
        entityId,
      });
    } else {
      this.logger.debug('[GenericSyncHandler] Entity not found for deletion', {
        entityType: this.entityType,
        entityId,
      });
    }
    return deleted;
  }
  private mergeForPull(local: T, server: T): T {
    const merged = this.merge(local, server);
    const serverVersion = (server as { version?: number }).version;
    if (typeof serverVersion !== 'number') {
      throw new Error(
        `[GenericSyncHandler] Pull update for ${this.entityType} missing numeric server version`
      );
    }
    (merged as { version?: number }).version = serverVersion;
    const serverUpdatedAt = (server as { updatedAt?: string }).updatedAt;
    if (typeof serverUpdatedAt === 'string') {
      (merged as { updatedAt?: string }).updatedAt = serverUpdatedAt;
    }
    const serverCreatedAt = (server as { createdAt?: string }).createdAt;
    if (typeof serverCreatedAt === 'string') {
      (merged as { createdAt?: string }).createdAt = serverCreatedAt;
    }
    return merged;
  }
  private ensureVersionIncrement(merged: T, local: T, server: T, timestamp: string): T {
    const localVersion = (local as { version?: number }).version ?? 1;
    const serverVersion = (server as { version?: number }).version ?? 1;
    const newVersion = Math.max(localVersion, serverVersion) + 1;
    return {
      ...merged,
      version: newVersion,
      updatedAt: timestamp,
    } as T;
  }
}
export function createGenericSyncHandler<T extends Record<string, unknown>>(
  deps: GenericSyncHandlerDependencies<T>
): GenericSyncHandler<T> {
  return new GenericSyncHandler(deps);
}
