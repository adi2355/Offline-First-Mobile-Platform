import type { QueryClient } from '@tanstack/react-query';
import type { EntityType, ConflictResolutionOutcome } from '@shared/contracts';
import {
  tryCanonicalizeEntityType,
  canonicalizeEntityType,
  getForeignKeyFields,
  getOptionalForeignKeyFields,
  getTargetEntityForFkField,
  isEntityType,
} from '@shared/contracts';
import type { OutboxCommand } from '../../../repositories/offline';
import type { FrontendSyncHandlerRegistry } from '../handlers';
import type { BackendAPIClient } from '../../api/BackendAPIClient';
import { isSyncableEntity } from '../config/entity-mappings';
import type { SyncBatchContext } from '../SyncBatchContext';
import type {
  IPushEngine,
  PushEngineStats,
  IPushEngineRepositories,
} from './interfaces';
import type {
  SyncRunContext,
  ResolvedCommand,
  PushReport,
  PushSuccessItem,
} from './types';
import {
  createEmptyPushReport,
  SyncEngineError,
  SYNC_ERROR_CODES,
} from './types';
import {
  orderCommands,
  collectCreateIds,
  resolveForeignKeysInPayload,
  buildPushRequest,
  processPushResponse,
  shouldSkipCommand,
  groupSuccessfulByEntityType,
  categorizeFailed,
  computeDeterministicSyncOperationId,
  type PushChangeInput,
  type PushResponseBody,
} from './PushEngineCore';
import { logger } from '../../../utils/logger';
export interface PushEngineDependencies {
  readonly repositories: IPushEngineRepositories;
  readonly apiClient: BackendAPIClient;
  readonly handlerRegistry: FrontendSyncHandlerRegistry;
  readonly queryClient?: QueryClient;
}
interface PushCommandsResponse {
  readonly successful: readonly PushSuccessItem[];
  readonly failed: readonly {
    clientId: string;
    error: string;
    retryable?: boolean;
    requestId?: string;
    errorCode?: string;
    details?: Record<string, unknown>;
  }[];
  readonly conflicts: readonly {
    id: string;
    entityType: string;
    entityId: string;
    userId: string;
    requestId?: string;
    remoteVersion?: Record<string, unknown>;
  }[];
}
interface PushCommandsRequest {
  readonly deviceId: string;
  readonly changes: readonly {
    entityType: EntityType;
    entityId: string;
    changeType: 'CREATE' | 'UPDATE' | 'DELETE';
    clientId: string;
    requestId: string;
    data: Record<string, unknown>;
    version: number;
    timestamp: string;
  }[];
  readonly syncOperationId: string;
  readonly lastSyncCursor?: string;
}
export class PushEngine implements IPushEngine {
  private readonly repos: IPushEngineRepositories;
  private readonly apiClient: BackendAPIClient;
  private readonly handlerRegistry: FrontendSyncHandlerRegistry;
  private readonly queryClient?: QueryClient;
  private stats: PushEngineStats = {
    totalCommandsPushed: 0,
    totalTombstonesPushed: 0,
    totalConflicts: 0,
    totalFailures: 0,
    lastPushTime: null,
  };
  constructor(deps: PushEngineDependencies) {
    this.repos = deps.repositories;
    this.apiClient = deps.apiClient;
    this.handlerRegistry = deps.handlerRegistry;
    this.queryClient = deps.queryClient;
  }
  async push(ctx: SyncRunContext): Promise<PushReport> {
    const startTime = Date.now();
    try {
      logger.debug('[PushEngine] Starting push operation', {
        correlationId: ctx.correlationId,
        userId: ctx.userId,
      });
      const commandsReport = await this.pushOutboxCommands(ctx);
      const tombstonesCount = await this.pushTombstones(ctx);
      const durationMs = Date.now() - startTime;
      const report: PushReport = {
        ...commandsReport,
        tombstonesProcessed: tombstonesCount,
        durationMs,
      };
      this.stats = {
        totalCommandsPushed: this.stats.totalCommandsPushed + commandsReport.commandsProcessed,
        totalTombstonesPushed: this.stats.totalTombstonesPushed + tombstonesCount,
        totalConflicts: this.stats.totalConflicts + commandsReport.conflicts.length,
        totalFailures: this.stats.totalFailures + commandsReport.failed.length,
        lastPushTime: Date.now(),
      };
      logger.info('[PushEngine] Push completed', {
        correlationId: ctx.correlationId,
        commandsProcessed: report.commandsProcessed,
        tombstonesProcessed: report.tombstonesProcessed,
        successful: report.successful.length,
        failed: report.failed.length,
        conflicts: report.conflicts.length,
        durationMs: report.durationMs,
      });
      return report;
    } catch (error) {
      throw SyncEngineError.fromUnknown('PUSH', error, {
        correlationId: ctx.correlationId,
        userId: ctx.userId,
      });
    }
  }
  async resolveForeignKeys(command: OutboxCommand): Promise<ResolvedCommand> {
    const entityType = tryCanonicalizeEntityType(command.aggregateType);
    if (!entityType) {
      return {
        original: command,
        resolvedPayload: command.payload || {},
        unresolvedFkFields: [],
        unresolvedClientIds: [],
        canPush: true,
      };
    }
    const fkFields = getForeignKeyFields(entityType);
    const idMappings = new Map<string, string>();
    for (const field of fkFields) {
      const clientId = command.payload?.[field];
      if (typeof clientId === 'string' && clientId) {
        const serverId = await this.repos.idMap.getServerId(clientId);
        if (serverId) {
          idMappings.set(clientId, serverId);
        }
      }
    }
    const result = resolveForeignKeysInPayload({
      entityType,
      payload: command.payload || {},
      idMappings,
      pendingCreateIds: new Map(), 
    });
    return {
      original: command,
      resolvedPayload: result.resolvedPayload,
      unresolvedFkFields: result.unresolvedMandatoryFields,
      unresolvedClientIds: result.fieldResults
        .filter((r) => r.action === 'kept' && !r.serverId)
        .map((r) => r.clientId),
      canPush: result.canPush,
    };
  }
  getStats(): PushEngineStats {
    return { ...this.stats };
  }
  private async pushOutboxCommands(ctx: SyncRunContext): Promise<PushReport> {
    const startTime = Date.now();
    const deadLetteredCount = await this.repos.outbox.markRetryExhaustedAsDeadLetter(ctx.userId);
    if (deadLetteredCount > 0) {
      logger.warn('[PushEngine] Pre-sweep: moved retry-exhausted commands to dead letter', {
        correlationId: ctx.correlationId,
        deadLetteredCount,
      });
    }
    const dedupResult = await this.repos.outbox.dequeueDeduplicatedByEntity(100, ctx.userId);
    const idsToClose = [...dedupResult.supersededIds, ...dedupResult.cancelledIds];
    if (idsToClose.length > 0) {
      await this.repos.outbox.markCompletedByIds(idsToClose);
      logger.info('[PushEngine] Closed superseded/cancelled commands', {
        correlationId: ctx.correlationId,
        supersededCount: dedupResult.supersededIds.length,
        cancelledCount: dedupResult.cancelledIds.length,
      });
    }
    const commands = dedupResult.representatives;
    if (commands.length === 0) {
      logger.debug('[PushEngine] No pending outbox commands to push');
      return createEmptyPushReport(Date.now() - startTime);
    }
    const orderedCommands = orderCommands(commands);
    const createIdsByEntity = collectCreateIds(orderedCommands);
    const pushChanges: PushChangeInput[] = [];
    let deferredCount = 0;
    for (const cmd of orderedCommands) {
      const resolved = await this.resolveCommandForeignKeys(cmd, createIdsByEntity);
      const hasServerIdMapping = await this.repos.idMap.getServerId(cmd.aggregateId) !== null;
      const entityType_ = tryCanonicalizeEntityType(cmd.aggregateType);
      const hasPendingCreateInBatch = entityType_
        ? createIdsByEntity.get(entityType_)?.has(cmd.aggregateId) ?? false
        : false;
      const skipResult = shouldSkipCommand(cmd, hasServerIdMapping, hasPendingCreateInBatch);
      if (skipResult.skip) {
        const skipReason = skipResult.reason ?? 'Command skipped: prerequisite not met';
        logger.warn('[PushEngine] Command deferred — marking FAILED for retry lifecycle', {
          aggregateId: cmd.aggregateId.substring(0, 8) + '...',
          eventType: cmd.eventType,
          reason: skipReason,
        });
        if (cmd.id) {
          await this.repos.outbox.markFailed(cmd.id, `Deferred: ${skipReason}`);
        }
        deferredCount++;
        continue;
      }
      const entityType = tryCanonicalizeEntityType(cmd.aggregateType);
      if (!entityType || !isSyncableEntity(entityType)) {
        logger.debug('[PushEngine] Skipping non-syncable entity', {
          aggregateType: cmd.aggregateType,
          aggregateId: cmd.aggregateId.substring(0, 8) + '...',
        });
        if (cmd.id) {
          await this.repos.outbox.markSynced(cmd.id);
        }
        continue;
      }
      ctx.batchContext.touch(entityType, resolved.resolvedAggregateId);
      pushChanges.push({
        command: cmd,
        resolvedPayload: resolved.resolvedPayload,
        resolvedAggregateId: resolved.resolvedAggregateId,
        timestamp: this.normalizeTimestamp(cmd.createdAt ?? new Date().toISOString()),
        version: this.extractVersion(resolved.resolvedPayload),
      });
    }
    if (pushChanges.length === 0) {
      logger.info('[PushEngine] All commands were skipped or deferred');
      return createEmptyPushReport(Date.now() - startTime);
    }
    const outboxIdByClientId = new Map<string, string>();
    for (const pc of pushChanges) {
      const outboxEventId = pc.command.id;
      if (outboxEventId) {
        outboxIdByClientId.set(pc.command.aggregateId, outboxEventId);
        if (pc.resolvedAggregateId !== pc.command.aggregateId) {
          outboxIdByClientId.set(pc.resolvedAggregateId, outboxEventId);
        }
      }
    }
    const deviceId = this.apiClient.getDeviceId();
    if (!deviceId) {
      throw new SyncEngineError(
        'PUSH',
        SYNC_ERROR_CODES.INITIALIZATION_FAILED,
        'Device ID not initialized',
        false,
        { correlationId: ctx.correlationId }
      );
    }
    const batchEventIds = pushChanges
      .map((pc) => pc.command.id)
      .filter((id): id is string => id != null);
    const syncOperationId = computeDeterministicSyncOperationId(batchEventIds, 'sync');
    const requestBody = buildPushRequest(pushChanges, {
      deviceId,
      syncOperationId,
    });
    logger.info('[PushEngine] Pushing commands to server', {
      correlationId: ctx.correlationId,
      count: pushChanges.length,
      syncOperationId,
    });
    const response = await this.apiClient.post<PushCommandsResponse>(
      '/sync/push',
      requestBody as unknown as Record<string, unknown>
    );
    const report = processPushResponse(response.data as unknown as PushResponseBody, {
      startTime,
      commandsSent: pushChanges.length,
      commandsDeferred: deferredCount,
      tombstonesSent: 0,
    });
    await this.handleSuccessfulPushes(response.data.successful, outboxIdByClientId, ctx);
    await this.handleFailedPushes(response.data.failed, outboxIdByClientId);
    if (response.data.conflicts && response.data.conflicts.length > 0) {
      const payloadByRequestId = new Map<string, Record<string, unknown>>();
      for (const pc of pushChanges) {
        if (pc.command.id) {
          payloadByRequestId.set(pc.command.id, pc.resolvedPayload);
        }
      }
      await this.handleConflicts(response.data.conflicts, payloadByRequestId, outboxIdByClientId, ctx);
    }
    await this.invalidateCacheForSuccessful(response.data.successful);
    return report;
  }
  private async pushTombstones(ctx: SyncRunContext): Promise<number> {
    const tombstones = await this.repos.tombstone.getActionableTombstones(100, ctx.userId);
    if (tombstones.length === 0) {
      logger.debug('[PushEngine] No actionable tombstones to push');
      return 0;
    }
    const syncableTombstones = tombstones.filter((t) => {
      const entityType = tryCanonicalizeEntityType(t.entityType);
      if (!entityType || !isSyncableEntity(entityType)) {
        void this.repos.tombstone.markSynced(t.entityId);
        return false;
      }
      return true;
    });
    if (syncableTombstones.length === 0) {
      logger.debug('[PushEngine] No syncable tombstones after filtering');
      return 0;
    }
    const deviceId = this.apiClient.getDeviceId();
    if (!deviceId) {
      throw new SyncEngineError(
        'PUSH',
        SYNC_ERROR_CODES.INITIALIZATION_FAILED,
        'Device ID not initialized for tombstones',
        false,
        { correlationId: ctx.correlationId }
      );
    }
    const tombstoneEntityIds = syncableTombstones.map((t) => t.entityId);
    const syncOperationId = computeDeterministicSyncOperationId(tombstoneEntityIds, 'sync-tombstones');
    const pushRequest: PushCommandsRequest = {
      deviceId,
      changes: syncableTombstones.map((tombstone) => {
        const entityType = canonicalizeEntityType(tombstone.entityType);
        return {
          entityType,
          entityId: tombstone.entityId,
          changeType: 'DELETE' as const,
          clientId: tombstone.entityId,
          requestId: tombstone.id,
          data: {},
          version: 1,
          timestamp: new Date().toISOString(),
        };
      }),
      syncOperationId,
    };
    logger.info('[PushEngine] Pushing tombstones to server', {
      correlationId: ctx.correlationId,
      count: syncableTombstones.length,
      syncOperationId,
    });
    const response = await this.apiClient.post<PushCommandsResponse>(
      '/sync/push',
      pushRequest as unknown as Record<string, unknown>
    );
    for (const success of response.data.successful) {
      await this.repos.tombstone.markSynced(success.clientId);
      ctx.batchContext.recordDelete(success.entityType, success.clientId);
    }
    for (const failed of response.data.failed) {
      if (failed.retryable) {
        await this.repos.tombstone.markFailed(failed.clientId, failed.error);
      } else {
        await this.repos.tombstone.markSynced(failed.clientId);
      }
    }
    const deletedTypes = groupSuccessfulByEntityType(response.data.successful);
    if (this.queryClient && deletedTypes.size > 0) {
      for (const entityType of deletedTypes) {
        await this.queryClient.invalidateQueries({
          queryKey: [entityType, 'list'],
          refetchType: 'none',
        });
      }
    }
    return syncableTombstones.length;
  }
  private async resolveCommandForeignKeys(
    command: OutboxCommand,
    createIdsByEntity: Map<EntityType, Set<string>>,
  ): Promise<{
    resolvedPayload: Record<string, unknown>;
    resolvedAggregateId: string;
  }> {
    const resolvedPayload = { ...command.payload };
    const entityType = tryCanonicalizeEntityType(command.aggregateType);
    if (!entityType) {
      const mainServerId = await this.repos.idMap.getServerId(command.aggregateId);
      return {
        resolvedPayload,
        resolvedAggregateId: mainServerId || command.aggregateId,
      };
    }
    const fkFields = getForeignKeyFields(entityType);
    const optionalFkFields = getOptionalForeignKeyFields(entityType);
    for (const field of fkFields) {
      const clientId = resolvedPayload[field];
      if (typeof clientId !== 'string' || !clientId) continue;
      const serverId = await this.repos.idMap.getServerId(clientId);
      if (serverId) {
        resolvedPayload[field] = serverId;
        logger.debug('[PushEngine] Resolved FK field', {
          entityType,
          field,
          clientId: clientId.substring(0, 8) + '...',
          serverId: serverId.substring(0, 8) + '...',
        });
      } else if (optionalFkFields.has(field)) {
        const referencedType = getTargetEntityForFkField(entityType, field);
        const isPending = referencedType && createIdsByEntity.get(referencedType)?.has(clientId);
        if (isPending) {
          logger.debug('[PushEngine] Keeping pending FK', { entityType, field, clientId: clientId.substring(0, 8) + '...' });
        } else {
          const isStableId = field === 'deviceId' || field === 'sessionId';
          const looksLikeValidId = clientId.length >= 17;
          if (isStableId && looksLikeValidId) {
            logger.debug('[PushEngine] Keeping stable FK', { entityType, field });
          } else {
            resolvedPayload[field] = null;
            logger.warn('[PushEngine] Nullified unresolved optional FK', {
              entityType,
              field,
              clientId: clientId.substring(0, 8) + '...',
            });
          }
        }
      }
    }
    const mainServerId = await this.repos.idMap.getServerId(command.aggregateId);
    return {
      resolvedPayload,
      resolvedAggregateId: mainServerId || command.aggregateId,
    };
  }
  private async handleSuccessfulPushes(
    successful: readonly PushSuccessItem[],
    outboxIdByClientId: ReadonlyMap<string, string>,
    ctx: SyncRunContext,
  ): Promise<void> {
    for (const success of successful) {
      const outboxEventId = success.requestId
        ?? outboxIdByClientId.get(success.clientId)
        ?? outboxIdByClientId.get(success.serverId);
      if (!outboxEventId) {
        logger.error('[PushEngine] Cannot resolve outboxEventId for successful push — command will remain unmarked', {
          clientId: success.clientId.substring(0, 8) + '...',
          serverId: success.serverId.substring(0, 8) + '...',
          entityType: success.entityType,
        });
      }
      await this.repos.idMap.saveMapping(
        success.entityType,
        success.clientId,
        success.serverId
      );
      const entityType = success.entityType as EntityType;
      const handler = this.handlerRegistry.get(entityType);
      if (handler?.handleIdReplacement) {
        try {
          await handler.handleIdReplacement(success.clientId, success.serverId);
          logger.debug('[PushEngine] ID replacement cascade completed', {
            entityType,
            clientId: success.clientId.substring(0, 8) + '...',
            serverId: success.serverId.substring(0, 8) + '...',
          });
          ctx.batchContext.recordIdReplacement(entityType, success.clientId, success.serverId);
          if (outboxEventId) {
            await this.repos.outbox.markSynced(outboxEventId);
          }
        } catch (cascadeError) {
          const errorMessage = cascadeError instanceof Error
            ? cascadeError.message
            : String(cascadeError);
          logger.error('[PushEngine] ID cascade failed - marking for retry', {
            entityType,
            clientId: success.clientId.substring(0, 8) + '...',
            error: { name: 'CascadeError', message: errorMessage },
          });
          if (outboxEventId) {
            await this.repos.outbox.markFailed(outboxEventId, `Cascade failure: ${errorMessage}`);
          }
          ctx.batchContext.recordIdReplacement(entityType, success.clientId, success.serverId);
        }
      } else {
        ctx.batchContext.touch(entityType, success.serverId);
        if (outboxEventId) {
          await this.repos.outbox.markSynced(outboxEventId);
        }
      }
    }
  }
  private async handleFailedPushes(
    failed: readonly {
      clientId: string;
      error: string;
      retryable?: boolean;
      requestId?: string;
    }[],
    outboxIdByClientId: ReadonlyMap<string, string>,
  ): Promise<void> {
    const { retryable, nonRetryable } = categorizeFailed(
      failed.map((f) => ({
        clientId: f.clientId,
        error: f.error,
        retryable: f.retryable ?? false,
        requestId: f.requestId,
      }))
    );
    for (const item of retryable) {
      const outboxEventId = item.requestId ?? outboxIdByClientId.get(item.clientId);
      if (outboxEventId) {
        await this.repos.outbox.markFailed(outboxEventId, item.error);
      } else {
        logger.error('[PushEngine] Cannot resolve outboxEventId for retryable failure — command will remain unmarked', {
          clientId: item.clientId.substring(0, 8) + '...',
          error: { name: 'RetryableError', message: item.error },
        });
      }
      logger.warn('[PushEngine] Retryable failure', {
        clientId: item.clientId.substring(0, 8) + '...',
        error: { name: 'RetryableError', message: item.error },
      });
    }
    for (const item of nonRetryable) {
      const outboxEventId = item.requestId ?? outboxIdByClientId.get(item.clientId);
      if (outboxEventId) {
        await this.repos.outbox.markDeadLetter(outboxEventId, item.error);
      } else {
        logger.error('[PushEngine] Cannot resolve outboxEventId for non-retryable failure — command will remain unmarked', {
          clientId: item.clientId.substring(0, 8) + '...',
          error: { name: 'NonRetryableError', message: item.error },
        });
      }
      logger.error('[PushEngine] Non-retryable failure moved to dead letter', {
        clientId: item.clientId.substring(0, 8) + '...',
        error: { name: 'NonRetryableError', message: item.error },
      });
    }
  }
  private async handleConflicts(
    conflicts: readonly {
      id: string;
      entityType: string;
      entityId: string;
      userId: string;
      requestId?: string;
      remoteVersion?: Record<string, unknown>;
    }[],
    payloadByRequestId: Map<string, Record<string, unknown>>,
    outboxIdByClientId: ReadonlyMap<string, string>,
    ctx: SyncRunContext,
  ): Promise<void> {
    for (const conflict of conflicts) {
      const entityType = conflict.entityType as EntityType;
      const handler = this.handlerRegistry.get(entityType);
      let requestId: string | undefined = conflict.requestId
        ?? outboxIdByClientId.get(conflict.entityId);
      if (!requestId) {
        try {
          const dbResult = await this.repos.outbox.findEventIdByAggregateId(
            conflict.entityId, ctx.userId
          );
          if (dbResult) {
            requestId = dbResult;
            logger.info('[PushEngine] Resolved outboxEventId via DB query fallback', {
              correlationId: ctx.correlationId,
              entityType,
              entityId: conflict.entityId.substring(0, 8) + '...',
              outboxEventId: requestId.substring(0, 8) + '...',
            });
          }
        } catch (dbError) {
          logger.error('[PushEngine] DB fallback resolution for conflict failed', {
            correlationId: ctx.correlationId,
            entityId: conflict.entityId.substring(0, 8) + '...',
            error: dbError instanceof Error
              ? { name: dbError.name, message: dbError.message }
              : { name: 'Error', message: String(dbError) },
          });
        }
      }
      const localPayload = requestId ? payloadByRequestId.get(requestId) : undefined;
      logger.warn('[PushEngine] Push conflict detected', {
        correlationId: ctx.correlationId,
        entityType,
        entityId: conflict.entityId.substring(0, 8) + '...',
        hasLocalPayload: !!localPayload,
        hasRemoteVersion: !!conflict.remoteVersion,
      });
      let outcome: ConflictResolutionOutcome<Record<string, unknown>>;
      if (handler?.handleConflictV2) {
        outcome = await handler.handleConflictV2(
          ctx.userId,
          conflict.entityId,
          localPayload ?? {},
          conflict.remoteVersion
        ) as ConflictResolutionOutcome<Record<string, unknown>>;
      } else if (handler?.handleConflict) {
        const merged = await handler.handleConflict(
          ctx.userId,
          conflict.entityId,
          localPayload ?? {},
          conflict.remoteVersion
        );
        if (merged) {
          const mergedRecord = merged as Record<string, unknown>;
          const mergedVersion = (mergedRecord as { version?: number }).version;
          if (typeof mergedVersion !== 'number') {
            outcome = {
              outcome: 'MANUAL_REQUIRED',
              reason: `Conflict merge for ${entityType} did not produce a numeric version`,
              localData: localPayload ?? {},
              serverData: conflict.remoteVersion ?? {},
              conflictingFields: ['version'],
            };
          } else {
            outcome = {
              outcome: 'REBASE_AND_RETRY',
              mergedData: mergedRecord,
              newVersion: mergedVersion,
              resolvedFromLocal: [],
              resolvedFromServer: [],
              mergedFields: [],
            };
          }
        } else {
          outcome = {
            outcome: 'SKIPPED',
            reason: 'Legacy handler returned null for conflict',
          };
        }
      } else {
        if (conflict.remoteVersion) {
          outcome = {
            outcome: 'ADOPT_SERVER',
            adoptedData: conflict.remoteVersion,
            serverVersion: (conflict.remoteVersion as { version?: number }).version ?? 1,
            reason: `No conflict handler for ${entityType}, adopting server version`,
          };
        } else {
          outcome = {
            outcome: 'SKIPPED',
            reason: `No conflict handler registered for ${entityType}`,
          };
        }
      }
      await this.executeConflictOutcome(outcome, conflict, requestId, ctx);
    }
  }
  private async executeConflictOutcome(
    outcome: ConflictResolutionOutcome<Record<string, unknown>>,
    conflict: {
      entityType: string;
      entityId: string;
    },
    requestId: string | undefined,
    ctx: SyncRunContext,
  ): Promise<void> {
    switch (outcome.outcome) {
      case 'ADOPT_SERVER': {
        if (requestId) {
          await this.repos.outbox.markSynced(requestId);
        } else {
          logger.error('[PushEngine] ADOPT_SERVER cannot mark synced — outboxEventId unresolvable', {
            correlationId: ctx.correlationId,
            entityType: conflict.entityType,
            entityId: conflict.entityId.substring(0, 8) + '...',
          });
        }
        logger.info('[PushEngine] Conflict resolved by adopting server data', {
          correlationId: ctx.correlationId,
          entityType: conflict.entityType,
          entityId: conflict.entityId.substring(0, 8) + '...',
          outcome: 'ADOPT_SERVER',
        });
        break;
      }
      case 'REBASE_AND_RETRY': {
        if (!requestId) {
          logger.error('[PushEngine] CRITICAL: Conflict rebase cannot proceed — outboxEventId unresolvable after all resolution attempts', {
            correlationId: ctx.correlationId,
            entityType: conflict.entityType,
            entityId: conflict.entityId.substring(0, 8) + '...',
            hint: 'Ensure backend echoes requestId in conflict response items',
          });
          break;
        }
        await this.repos.outbox.updatePayloadAndVersion(
          requestId,
          outcome.mergedData,
          outcome.newVersion
        );
        logger.info('[PushEngine] Conflict rebased for retry', {
          correlationId: ctx.correlationId,
          entityType: conflict.entityType,
          entityId: conflict.entityId.substring(0, 8) + '...',
          newVersion: outcome.newVersion,
        });
        break;
      }
      case 'MANUAL_REQUIRED': {
        const reason = outcome.reason;
        if (requestId) {
          await this.repos.outbox.markDeadLetter(requestId, reason);
        } else {
          logger.error('[PushEngine] MANUAL_REQUIRED cannot dead-letter — outboxEventId unresolvable', {
            correlationId: ctx.correlationId,
            entityType: conflict.entityType,
            entityId: conflict.entityId.substring(0, 8) + '...',
            reason,
          });
        }
        logger.warn('[PushEngine] Conflict requires manual resolution', {
          correlationId: ctx.correlationId,
          entityType: conflict.entityType,
          entityId: conflict.entityId.substring(0, 8) + '...',
          reason,
        });
        break;
      }
      case 'SKIPPED': {
        if (requestId) {
          await this.repos.outbox.markFailed(requestId, outcome.reason ?? 'Conflict skipped');
        } else {
          logger.error('[PushEngine] SKIPPED cannot mark failed — outboxEventId unresolvable', {
            correlationId: ctx.correlationId,
            entityType: conflict.entityType,
            entityId: conflict.entityId.substring(0, 8) + '...',
            reason: outcome.reason,
          });
        }
        logger.debug('[PushEngine] Conflict skipped - marking as FAILED for retry', {
          correlationId: ctx.correlationId,
          entityType: conflict.entityType,
          entityId: conflict.entityId.substring(0, 8) + '...',
          reason: outcome.reason,
        });
        break;
      }
    }
  }
  private async invalidateCacheForSuccessful(
    successful: readonly PushSuccessItem[],
  ): Promise<void> {
    if (!this.queryClient) return;
    const entityTypes = groupSuccessfulByEntityType(successful);
    if (entityTypes.size === 0) return;
    for (const entityType of entityTypes) {
      await this.queryClient.invalidateQueries({
        queryKey: [entityType, 'list'],
        refetchType: 'none',
      });
    }
    for (const success of successful) {
      try {
        const oldData = this.queryClient.getQueryData([success.entityType, 'detail', success.clientId]);
        if (oldData) {
          await this.queryClient.invalidateQueries({
            queryKey: [success.entityType, 'detail', success.clientId],
            refetchType: 'none',
          });
          const updatedData = typeof oldData === 'object' && oldData !== null
            ? { ...(oldData as Record<string, unknown>), id: success.serverId }
            : oldData;
          this.queryClient.setQueryData(
            [success.entityType, 'detail', success.serverId],
            updatedData
          );
        }
      } catch {
      }
    }
  }
  private normalizeTimestamp(timestamp: string): string {
    if (timestamp.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(timestamp)) {
      return timestamp;
    }
    return timestamp.replace(' ', 'T') + 'Z';
  }
  private extractVersion(payload: Record<string, unknown>): number {
    return typeof payload.version === 'number' ? payload.version : 1;
  }
}
