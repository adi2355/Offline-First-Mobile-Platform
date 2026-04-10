import { eq, and, or, lt, sql, desc, asc, SQL, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import { outboxEvents, type DbOutboxEvent, type DbOutboxEventInsert } from '../../db/schema';
import { BaseRepository } from '../BaseRepository';
import { logger } from '../../utils/logger';
import {
  canonicalizeEntityType,
  tryCanonicalizeEntityType,
  isEntityType,
  compareBySyncOrder,
  type EntityType,
} from '@shared/contracts';
import { validateOutboxPayload, type OutboxEventType } from '../../validation/outboxPayloadValidation';
import { generateUUID } from '../../db/schema-helpers';
export type OutboxOperationType = 'CREATE' | 'UPDATE' | 'DELETE';
export interface DeduplicationResult {
  readonly representatives: OutboxCommand[];
  readonly supersededIds: readonly string[];
  readonly cancelledIds: readonly string[];
}
export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'DEAD_LETTER';
export interface OutboxCommand {
  id?: string;
  userId: string;
  aggregateId: string;
  aggregateType: string;
  eventType: OutboxOperationType;
  payload: Record<string, unknown>;
  status?: OutboxStatus;
  retryCount?: number;
  lastRetryAt?: string;
  maxRetries?: number;
  processedAt?: string;
  error?: string;
  errorDetails?: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface OutboxStats {
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  oldestPendingAt: string | null;
}
export class OutboxRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  private static readonly DrizzleTransactionType: Parameters<
    Parameters<DrizzleDB['transaction']>[0]
  >[0] = null as never; 
  async enqueue(
    command: OutboxCommand,
    tx?: typeof OutboxRepository.DrizzleTransactionType
  ): Promise<string> {
    try {
      if (!command.userId) {
        throw new Error('[OutboxRepository] userId is required to enqueue outbox commands.');
      }
      const canonicalEntityType = canonicalizeEntityType(command.aggregateType);
      const validatedPayload = validateOutboxPayload(
        canonicalEntityType,
        command.eventType as OutboxEventType,
        command.payload
      );
      const eventId = generateUUID();
      const now = new Date().toISOString();
      const insertValues: DbOutboxEventInsert = {
        id: eventId,
        userId: command.userId,
        aggregateType: canonicalEntityType, 
        aggregateId: command.aggregateId,
        eventType: command.eventType,
        payload: JSON.stringify(validatedPayload), 
        status: 'PENDING',
        retryCount: 0,
        maxRetries: command.maxRetries ?? 5,
        createdAt: now,
        updatedAt: now,
      };
      const drizzle = tx ?? this.getDrizzle();
      await drizzle.insert(outboxEvents).values(insertValues);
      logger.debug('[OutboxRepository] Command enqueued', {
        eventId,
        aggregateType: canonicalEntityType,
        originalAggregateType: command.aggregateType !== canonicalEntityType ? command.aggregateType : undefined,
        aggregateId: command.aggregateId,
        eventType: command.eventType,
        payloadValidated: true, 
      });
      return eventId;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error enqueueing command', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
        aggregateType: command.aggregateType,
        aggregateId: command.aggregateId,
      });
      throw new Error(`Failed to enqueue command: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async dequeue(limit: number = 50, userId: string): Promise<OutboxCommand[]> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to dequeue outbox commands.');
      }
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.userId, userId),
            or(
              eq(outboxEvents.status, 'PENDING'),
              and(
                eq(outboxEvents.status, 'FAILED'),
                sql`${outboxEvents.retryCount} < ${outboxEvents.maxRetries}`
              )
            )
          )
        )
        .orderBy(asc(outboxEvents.createdAt))
        .limit(limit);
      return await this.mapRowsSafe(rows);
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error dequeuing commands', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
        limit,
      });
      throw new Error(`Failed to dequeue commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async dequeueDeduplicatedByEntity(limit: number = 50, userId: string): Promise<DeduplicationResult> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to dequeue outbox commands.');
      }
      const allCommands = await this.dequeue(limit * 3, userId);
      if (allCommands.length === 0) {
        return { representatives: [], supersededIds: [], cancelledIds: [] };
      }
      const entityGroups = new Map<string, OutboxCommand[]>();
      for (const cmd of allCommands) {
        const key = `${cmd.aggregateType}:${cmd.aggregateId}`;
        const group = entityGroups.get(key) || [];
        group.push(cmd);
        entityGroups.set(key, group);
      }
      const deduplicatedCommands: OutboxCommand[] = [];
      const allSupersededIds: string[] = [];
      const allCancelledIds: string[] = [];
      for (const [entityKey, commands] of entityGroups) {
        const result = this.selectRepresentativeCommand(commands, entityKey);
        if (result.representative) {
          deduplicatedCommands.push(result.representative);
        }
        allSupersededIds.push(...result.supersededIds);
        allCancelledIds.push(...result.cancelledIds);
      }
      const sortedCommands = this.sortByDependencyOrder(deduplicatedCommands);
      const finalCommands = sortedCommands.slice(0, limit);
      const totalClosed = allSupersededIds.length + allCancelledIds.length;
      if (allCommands.length !== finalCommands.length || totalClosed > 0) {
        logger.info('[OutboxRepository] Commands deduplicated by entity', {
          context: {
            originalCount: allCommands.length,
            deduplicatedCount: finalCommands.length,
            supersededCount: allSupersededIds.length,
            cancelledCount: allCancelledIds.length,
          },
        });
      }
      return {
        representatives: finalCommands,
        supersededIds: allSupersededIds,
        cancelledIds: allCancelledIds,
      };
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error dequeuing deduplicated commands', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
        limit,
      });
      throw new Error(`Failed to dequeue deduplicated commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private selectRepresentativeCommand(
    commands: OutboxCommand[],
    entityKey: string,
  ): { representative: OutboxCommand | null; supersededIds: string[]; cancelledIds: string[] } {
    const empty = { representative: null, supersededIds: [] as string[], cancelledIds: [] as string[] };
    if (commands.length === 0) return empty;
    const firstCommand = commands[0];
    if (!firstCommand) return empty; 
    if (commands.length === 1) {
      return { representative: firstCommand, supersededIds: [], cancelledIds: [] };
    }
    const getIds = (cmds: OutboxCommand[]): string[] =>
      cmds.map((c) => c.id).filter((id): id is string => id != null);
    const deletes = commands.filter((c) => c.eventType === 'DELETE');
    const creates = commands.filter((c) => c.eventType === 'CREATE');
    const updates = commands.filter((c) => c.eventType === 'UPDATE');
    if (deletes.length > 0 && creates.length > 0) {
      const allIds = getIds(commands);
      logger.debug('[OutboxRepository] CREATE+DELETE cancel — entity never synced', {
        context: { entityKey, cancelledCount: allIds.length },
      });
      return { representative: null, supersededIds: [], cancelledIds: allIds };
    }
    if (deletes.length > 0) {
      const latestDelete = deletes.reduce((latest, cmd) =>
        (cmd.createdAt || '') > (latest.createdAt || '') ? cmd : latest,
      );
      const supersededIds = getIds(commands).filter((id) => id !== latestDelete.id);
      logger.debug('[OutboxRepository] Entity has DELETE - superseding prior commands', {
        context: { entityKey, supersededCount: supersededIds.length },
      });
      return { representative: latestDelete, supersededIds, cancelledIds: [] };
    }
    if (creates.length > 0) {
      const createCmd = creates[0];
      if (!createCmd) return { representative: firstCommand, supersededIds: [], cancelledIds: [] };
      const mergedPayload: Record<string, unknown> = { ...createCmd.payload };
      const sortedUpdates = updates.sort((a, b) =>
        (a.createdAt || '').localeCompare(b.createdAt || ''),
      );
      for (const update of sortedUpdates) {
        Object.assign(mergedPayload, update.payload);
      }
      const supersededIds = getIds(updates);
      if (updates.length > 0) {
        logger.debug('[OutboxRepository] Merged UPDATE payloads into CREATE', {
          context: { entityKey, updateCount: updates.length, supersededCount: supersededIds.length },
        });
      }
      const mergedCommand: OutboxCommand = {
        id: createCmd.id,
        userId: createCmd.userId,
        aggregateId: createCmd.aggregateId,
        aggregateType: createCmd.aggregateType,
        eventType: createCmd.eventType,
        payload: mergedPayload,
        status: createCmd.status,
        retryCount: createCmd.retryCount,
        lastRetryAt: createCmd.lastRetryAt,
        maxRetries: createCmd.maxRetries,
        processedAt: createCmd.processedAt,
        error: createCmd.error,
        errorDetails: createCmd.errorDetails,
        createdAt: createCmd.createdAt,
        updatedAt: createCmd.updatedAt,
      };
      return { representative: mergedCommand, supersededIds, cancelledIds: [] };
    }
    if (updates.length > 0) {
      const latestUpdate = updates.reduce((latest, cmd) =>
        (cmd.createdAt || '') > (latest.createdAt || '') ? cmd : latest,
      );
      const supersededIds = getIds(updates).filter((id) => id !== latestUpdate.id);
      if (updates.length > 1) {
        logger.debug('[OutboxRepository] Multiple UPDATEs for entity - keeping latest', {
          context: { entityKey, supersededCount: supersededIds.length },
        });
      }
      return { representative: latestUpdate, supersededIds, cancelledIds: [] };
    }
    return { representative: firstCommand, supersededIds: [], cancelledIds: [] };
  }
  private sortByDependencyOrder(commands: OutboxCommand[]): OutboxCommand[] {
    const unknownTypesEncountered = new Set<string>();
    const sorted = commands.sort((a, b) => {
      const aIsKnown = isEntityType(a.aggregateType);
      const bIsKnown = isEntityType(b.aggregateType);
      if (aIsKnown && bIsKnown) {
        const orderDiff = compareBySyncOrder(
          a.aggregateType as EntityType,
          b.aggregateType as EntityType
        );
        if (orderDiff !== 0) {
          return orderDiff;
        }
        return (a.createdAt || '').localeCompare(b.createdAt || '');
      }
      if (aIsKnown && !bIsKnown) {
        unknownTypesEncountered.add(b.aggregateType);
        return -1; 
      }
      if (!aIsKnown && bIsKnown) {
        unknownTypesEncountered.add(a.aggregateType);
        return 1; 
      }
      unknownTypesEncountered.add(a.aggregateType);
      unknownTypesEncountered.add(b.aggregateType);
      const typeCmp = a.aggregateType.localeCompare(b.aggregateType);
      if (typeCmp !== 0) return typeCmp;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    });
    if (unknownTypesEncountered.size > 0) {
      logger.warn('[OutboxRepository] Unknown entity types found in outbox - may indicate legacy data', {
        unknownTypes: Array.from(unknownTypesEncountered),
        hint: 'These types are sorted last. Consider migrating legacy rows to canonical types.',
      });
    }
    return sorted;
  }
  async hasPendingCreateForAggregate(aggregateId: string, userId: string): Promise<boolean> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to check pending CREATE commands.');
      }
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.userId, userId),
            eq(outboxEvents.aggregateId, aggregateId),
            eq(outboxEvents.eventType, 'CREATE'),
            or(
              eq(outboxEvents.status, 'PENDING'),
              and(
                eq(outboxEvents.status, 'FAILED'),
                sql`${outboxEvents.retryCount} < ${outboxEvents.maxRetries}`
              )
            )
          )
        )
        .limit(1);
      return rows.length > 0;
    } catch (error) {
      logger.error('[OutboxRepository] Error checking pending CREATE command — propagating to caller', {
        aggregateId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to check pending CREATE for ${aggregateId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async isPending(aggregateId: string, userId: string): Promise<boolean> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to check pending commands.');
      }
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.userId, userId),
            eq(outboxEvents.aggregateId, aggregateId),
            or(
              eq(outboxEvents.status, 'PENDING'),
              and(
                eq(outboxEvents.status, 'FAILED'),
                sql`${outboxEvents.retryCount} < ${outboxEvents.maxRetries}`
              )
            )
          )
        )
        .limit(1);
      return rows.length > 0;
    } catch (error) {
      logger.error('[OutboxRepository] Error checking pending status — propagating to caller', {
        aggregateId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to check pending status for ${aggregateId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getUncompletedCommandsByAggregateType(
    aggregateType: string,
    userId: string
  ): Promise<OutboxCommand[]> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to fetch uncompleted commands.');
      }
      const drizzle = this.getDrizzle();
      const activeStatuses: OutboxStatus[] = ['PENDING', 'PROCESSING', 'FAILED', 'DEAD_LETTER'];
      const rows = await drizzle
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.userId, userId),
            eq(outboxEvents.aggregateType, aggregateType),
            inArray(outboxEvents.status, activeStatuses)
          )
        )
        .orderBy(asc(outboxEvents.createdAt));
      return await this.mapRowsSafe(rows);
    } catch (error) {
      logger.error('[OutboxRepository] Error fetching uncompleted commands — propagating to caller', {
        aggregateType,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to fetch uncompleted commands for ${aggregateType}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async updateAggregateId(oldAggregateId: string, newAggregateId: string, userId: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .update(outboxEvents)
        .set({
          aggregateId: newAggregateId,
          updatedAt: now,
        })
        .where(
          and(
            eq(outboxEvents.userId, userId),
            eq(outboxEvents.aggregateId, oldAggregateId),
            or(
              eq(outboxEvents.status, 'PENDING'),
              eq(outboxEvents.status, 'FAILED')
            )
          )
        );
      const updatedCount = (result as unknown as { changes?: number })?.changes ?? 0;
      if (updatedCount > 0) {
        logger.info('[OutboxRepository] Updated aggregateId for pending commands', {
          oldAggregateId,
          newAggregateId,
          updatedCount,
        });
      }
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error updating aggregateId', {
        oldAggregateId,
        newAggregateId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async updateAggregateIdForEntity(
    aggregateType: string,
    oldAggregateId: string,
    newAggregateId: string,
    userId: string
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const canonicalType = tryCanonicalizeEntityType(aggregateType) ?? aggregateType;
      const result = await drizzle
        .update(outboxEvents)
        .set({
          aggregateId: newAggregateId,
          updatedAt: now,
        })
        .where(
          and(
            eq(outboxEvents.userId, userId),
            eq(outboxEvents.aggregateType, canonicalType),
            eq(outboxEvents.aggregateId, oldAggregateId),
            or(
              eq(outboxEvents.status, 'PENDING'),
              eq(outboxEvents.status, 'FAILED')
            )
          )
        );
      const updatedCount = (result as unknown as { changes?: number })?.changes ?? 0;
      if (updatedCount > 0) {
        logger.info('[OutboxRepository] Updated aggregateId for entity type', {
          aggregateType: canonicalType,
          oldAggregateId,
          newAggregateId,
          updatedCount,
        });
      }
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error updating aggregateId for entity type', {
        aggregateType,
        oldAggregateId,
        newAggregateId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async markSynced(outboxEventId: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .update(outboxEvents)
        .set({
          status: 'COMPLETED',
          processedAt: now,
          updatedAt: now,
        })
        .where(eq(outboxEvents.id, outboxEventId));
      const rowsAffected = (result as unknown as { changes?: number })?.changes ?? 0;
      if (rowsAffected === 0) {
        logger.warn('[OutboxRepository] markSynced affected 0 rows — command may have been already completed, deleted, or ID is invalid', {
          outboxEventId,
        });
      } else {
        logger.debug('[OutboxRepository] Command marked as synced', { outboxEventId });
      }
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error marking command as synced', {
        outboxEventId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to mark command as synced: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async markCompletedByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return; 
    try {
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const BATCH_SIZE = 500;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        await drizzle
          .update(outboxEvents)
          .set({
            status: 'COMPLETED',
            processedAt: now,
            updatedAt: now,
          })
          .where(inArray(outboxEvents.id, batch));
      }
      logger.info('[OutboxRepository] Batch marked commands as COMPLETED', {
        count: ids.length,
      });
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error batch marking commands as COMPLETED', {
        count: ids.length,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to batch mark commands as COMPLETED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async markSyncedByAggregateId(aggregateId: string, userId: string): Promise<void> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required for aggregate-wide markSynced.');
      }
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      await drizzle
        .update(outboxEvents)
        .set({
          status: 'COMPLETED',
          processedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(outboxEvents.userId, userId),
            eq(outboxEvents.aggregateId, aggregateId)
          )
        );
      logger.debug('[OutboxRepository] Commands marked as synced by aggregate (user-scoped)', {
        aggregateId,
        userId,
      });
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error marking commands as synced by aggregate', {
        aggregateId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to mark commands as synced: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async markFailed(outboxEventId: string, errorMessage: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .update(outboxEvents)
        .set({
          status: 'FAILED',
          retryCount: sql`${outboxEvents.retryCount} + 1`,
          lastRetryAt: now,
          error: errorMessage,
          errorDetails: errorMessage,
          updatedAt: now,
        })
        .where(eq(outboxEvents.id, outboxEventId));
      const rowsAffected = (result as unknown as { changes?: number })?.changes ?? 0;
      if (rowsAffected === 0) {
        logger.warn('[OutboxRepository] markFailed affected 0 rows — command may have been already completed/dead-lettered, deleted, or ID is invalid', {
          outboxEventId,
          originalError: errorMessage,
        });
      } else {
        logger.warn('[OutboxRepository] Command marked as failed', {
          outboxEventId,
          error: { name: 'SyncError', message: errorMessage },
        });
      }
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error marking command as failed', {
        outboxEventId,
        originalError: errorMessage,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to mark command as failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async resetToPendingById(outboxEventId: string): Promise<void> {
    try {
      if (!outboxEventId) {
        throw new Error('[OutboxRepository] outboxEventId is required to reset command.');
      }
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .update(outboxEvents)
        .set({
          status: 'PENDING',
          retryCount: 0,
          lastRetryAt: null,
          error: null,
          errorDetails: null,
          updatedAt: now,
        })
        .where(and(eq(outboxEvents.id, outboxEventId), eq(outboxEvents.status, 'FAILED')));
      const updatedCount = (result as unknown as { changes?: number })?.changes ?? 0;
      if (updatedCount === 0) {
        logger.warn('[OutboxRepository] resetToPendingById affected 0 rows — command may not be in FAILED status or does not exist', {
          outboxEventId,
        });
      } else {
        logger.info('[OutboxRepository] Command reset to PENDING for retry', { outboxEventId });
      }
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error resetting command to PENDING', {
        outboxEventId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to reset command to PENDING: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async updatePayloadAndVersion(outboxEventId: string, payload: Record<string, unknown>, version: number): Promise<void> {
    try {
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const payloadWithVersion: Record<string, unknown> = {
        ...payload,
        version, 
      };
      await drizzle
        .update(outboxEvents)
        .set({
          payload: JSON.stringify(payloadWithVersion),
          updatedAt: now,
          status: 'PENDING', 
          retryCount: 0, 
        })
        .where(eq(outboxEvents.id, outboxEventId));
      logger.debug('[OutboxRepository] Command payload updated with version', {
        outboxEventId,
        version,
        payloadHasVersion: 'version' in payloadWithVersion,
      });
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error updating command payload', {
        outboxEventId,
        version,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async markDeadLetter(outboxEventId: string, errorMessage?: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const updateFields: Partial<DbOutboxEventInsert> = {
        status: 'DEAD_LETTER',
        updatedAt: now,
      };
      if (errorMessage) {
        updateFields.error = errorMessage;
        updateFields.errorDetails = errorMessage;
      }
      const result = await drizzle
        .update(outboxEvents)
        .set(updateFields)
        .where(eq(outboxEvents.id, outboxEventId));
      const rowsAffected = (result as unknown as { changes?: number })?.changes ?? 0;
      if (rowsAffected === 0) {
        logger.warn('[OutboxRepository] markDeadLetter affected 0 rows — command may have been already completed, deleted, or ID is invalid', {
          outboxEventId,
        });
      } else {
        logger.warn('[OutboxRepository] Command moved to dead letter queue', { outboxEventId });
      }
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error marking command as dead letter', {
        outboxEventId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async retryDeadLetter(outboxEventId: string): Promise<void> {
    try {
      if (!outboxEventId) {
        throw new Error('[OutboxRepository] outboxEventId is required to retry dead letter command.');
      }
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .update(outboxEvents)
        .set({
          status: 'PENDING',
          retryCount: 0,
          lastRetryAt: null,
          processedAt: null,
          error: null,
          errorDetails: null,
          updatedAt: now,
        })
        .where(and(eq(outboxEvents.id, outboxEventId), eq(outboxEvents.status, 'DEAD_LETTER')));
      const updatedCount = (result as unknown as { changes?: number })?.changes ?? 0;
      if (updatedCount === 0) {
        throw new Error('[OutboxRepository] Dead letter command not found or already reset.');
      }
      logger.info('[OutboxRepository] Dead letter command reset for retry', { outboxEventId });
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error retrying dead letter command', {
        outboxEventId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to retry dead letter command: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async deleteDeadLetter(outboxEventId: string): Promise<void> {
    try {
      if (!outboxEventId) {
        throw new Error('[OutboxRepository] outboxEventId is required to delete dead letter command.');
      }
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .delete(outboxEvents)
        .where(and(eq(outboxEvents.id, outboxEventId), eq(outboxEvents.status, 'DEAD_LETTER')));
      const deletedCount = (result as unknown as { changes?: number })?.changes ?? 0;
      if (deletedCount === 0) {
        throw new Error('[OutboxRepository] Dead letter command not found or already removed.');
      }
      logger.info('[OutboxRepository] Dead letter command deleted', { outboxEventId });
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error deleting dead letter command', {
        outboxEventId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to delete dead letter command: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async markRetryExhaustedAsDeadLetter(userId: string): Promise<number> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to quarantine retry-exhausted commands.');
      }
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const defaultError = 'Max retry attempts exceeded';
      const result = await drizzle
        .update(outboxEvents)
        .set({
          status: 'DEAD_LETTER',
          updatedAt: now,
          error: sql`COALESCE(${outboxEvents.error}, ${defaultError})`,
          errorDetails: sql`COALESCE(${outboxEvents.errorDetails}, ${defaultError})`,
        })
        .where(
          and(
            eq(outboxEvents.userId, userId),
            eq(outboxEvents.status, 'FAILED'),
            sql`${outboxEvents.retryCount} >= ${outboxEvents.maxRetries}`
          )
        );
      const movedCount = (result as unknown as { changes?: number })?.changes ?? 0;
      if (movedCount > 0) {
        logger.warn('[OutboxRepository] Retry-exhausted commands moved to dead letter queue', {
          movedCount,
        });
      }
      return movedCount;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error moving retry-exhausted commands to dead letter queue', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to move retry-exhausted commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async getStats(userId: string): Promise<OutboxStats> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to fetch outbox stats.');
      }
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({
          pendingCount: sql<number>`SUM(CASE WHEN ${outboxEvents.status} = 'PENDING' THEN 1 ELSE 0 END)`,
          processingCount: sql<number>`SUM(CASE WHEN ${outboxEvents.status} = 'PROCESSING' THEN 1 ELSE 0 END)`,
          failedCount: sql<number>`SUM(CASE WHEN ${outboxEvents.status} = 'FAILED' THEN 1 ELSE 0 END)`,
          oldestPendingAt: sql<string | null>`MIN(CASE WHEN ${outboxEvents.status} = 'PENDING' THEN ${outboxEvents.createdAt} ELSE NULL END)`,
        })
        .from(outboxEvents)
        .where(eq(outboxEvents.userId, userId))
        .get();
      return {
        pendingCount: result?.pendingCount ?? 0,
        processingCount: result?.processingCount ?? 0,
        failedCount: result?.failedCount ?? 0,
        oldestPendingAt: result?.oldestPendingAt ?? null,
      };
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error fetching stats', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to fetch outbox stats: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async getPendingCount(userId: string): Promise<number> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to count pending commands.');
      }
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: sql<number>`COUNT(*)` })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.userId, userId), eq(outboxEvents.status, 'PENDING')))
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error counting pending commands', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to count pending commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async countActionable(userId: string): Promise<number> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to count actionable commands.');
      }
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: sql<number>`COUNT(*)` })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.userId, userId),
            or(
              eq(outboxEvents.status, 'PENDING'),
              and(
                eq(outboxEvents.status, 'FAILED'),
                sql`${outboxEvents.retryCount} < ${outboxEvents.maxRetries}`
              )
            )
          )
        )
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error counting actionable commands', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to count actionable commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async getDeadLetterCount(userId: string): Promise<number> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to count dead letter commands.');
      }
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: sql<number>`COUNT(*)` })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.userId, userId), eq(outboxEvents.status, 'DEAD_LETTER')))
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error counting dead letter commands', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to count dead letter commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async getOldestPending(userId: string): Promise<string | null> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to fetch oldest pending command.');
      }
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ createdAt: outboxEvents.createdAt })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.userId, userId), eq(outboxEvents.status, 'PENDING')))
        .orderBy(asc(outboxEvents.createdAt))
        .limit(1)
        .get();
      return result?.createdAt ?? null;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error fetching oldest pending', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to fetch oldest pending: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async findEventIdByAggregateId(aggregateId: string, userId: string): Promise<string | null> {
    try {
      if (!aggregateId || !userId) {
        return null;
      }
      const drizzle = this.getDrizzle();
      const row = await drizzle
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.userId, userId),
            eq(outboxEvents.aggregateId, aggregateId),
            or(
              eq(outboxEvents.status, 'PENDING'),
              and(
                eq(outboxEvents.status, 'FAILED'),
                sql`${outboxEvents.retryCount} < ${outboxEvents.maxRetries}`
              )
            )
          )
        )
        .orderBy(desc(outboxEvents.createdAt))
        .limit(1)
        .get();
      return row?.id ?? null;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error finding event ID by aggregate ID', {
        aggregateId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to find event ID by aggregate: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getById(outboxEventId: string): Promise<OutboxCommand | null> {
    try {
      const drizzle = this.getDrizzle();
      const row = await drizzle
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.id, outboxEventId))
        .get();
      return row ? this.mapToCommand(row, true) : null;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error fetching command by ID — propagating to caller', {
        outboxEventId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to fetch command by ID ${outboxEventId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getByAggregateId(aggregateId: string): Promise<OutboxCommand[]> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, aggregateId))
        .orderBy(asc(outboxEvents.createdAt));
      return rows.map((row) => this.mapToCommand(row, true));
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error fetching commands by aggregate — propagating to caller', {
        aggregateId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to fetch commands by aggregate ${aggregateId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getStatusByAggregateIds(
    aggregateIds: string[],
    userId: string,
    aggregateType?: string
  ): Promise<Record<string, OutboxStatus | 'SYNCED'>> {
    const statusMap: Record<string, OutboxStatus | 'SYNCED'> = {};
    if (aggregateIds.length === 0) {
      return statusMap;
    }
    if (!userId) {
      throw new Error('[OutboxRepository] userId is required for batch status lookup.');
    }
    const BATCH_SIZE = 500;
    const batches: string[][] = [];
    for (let i = 0; i < aggregateIds.length; i += BATCH_SIZE) {
      batches.push(aggregateIds.slice(i, i + BATCH_SIZE));
    }
    try {
      const drizzle = this.getDrizzle();
      for (const batchIds of batches) {
        const whereConditions = aggregateType
          ? and(
              eq(outboxEvents.userId, userId),
              inArray(outboxEvents.aggregateId, batchIds),
              eq(outboxEvents.aggregateType, aggregateType)
            )
          : and(
              eq(outboxEvents.userId, userId),
              inArray(outboxEvents.aggregateId, batchIds)
            );
        const rows = await drizzle
          .select({
            aggregateId: outboxEvents.aggregateId,
            status: outboxEvents.status,
            createdAt: outboxEvents.createdAt,
          })
          .from(outboxEvents)
          .where(whereConditions)
          .orderBy(desc(outboxEvents.createdAt)); 
        for (const row of rows) {
          if (row.aggregateId && !statusMap[row.aggregateId]) {
            statusMap[row.aggregateId] = (row.status ?? 'PENDING') as OutboxStatus;
          }
        }
      }
      for (const id of aggregateIds) {
        if (!statusMap[id]) {
          statusMap[id] = 'SYNCED';
        }
      }
      logger.debug('[OutboxRepository] Batch status lookup completed', {
        requestedCount: aggregateIds.length,
        foundInOutbox: Object.values(statusMap).filter(s => s !== 'SYNCED').length,
        syncedCount: Object.values(statusMap).filter(s => s === 'SYNCED').length,
      });
      return statusMap;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error in batch status lookup — propagating to caller', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
        aggregateIdCount: aggregateIds.length,
        aggregateType,
      });
      throw new Error(
        `Failed to get batch status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getFailed(limit: number = 100, userId: string): Promise<OutboxCommand[]> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to fetch failed commands.');
      }
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.userId, userId), eq(outboxEvents.status, 'FAILED')))
        .orderBy(asc(outboxEvents.createdAt))
        .limit(limit);
      return rows.map((row) => this.mapToCommand(row, true));
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error fetching failed commands — propagating to caller', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
        limit,
      });
      throw new Error(
        `Failed to fetch failed commands: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getDeadLetter(limit: number = 100, userId: string): Promise<OutboxCommand[]> {
    try {
      if (!userId) {
        throw new Error('[OutboxRepository] userId is required to fetch dead letter commands.');
      }
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.userId, userId), eq(outboxEvents.status, 'DEAD_LETTER')))
        .orderBy(asc(outboxEvents.createdAt))
        .limit(limit);
      return rows.map((row) => this.mapToCommand(row, true));
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error fetching dead letter commands — propagating to caller', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
        limit,
      });
      throw new Error(
        `Failed to fetch dead letter commands: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async clearCompleted(daysToKeep: number = 7): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .delete(outboxEvents)
        .where(
          and(
            eq(outboxEvents.status, 'COMPLETED'),
            sql`datetime(${outboxEvents.updatedAt}) < datetime('now', '-' || ${daysToKeep} || ' days')`
          )
        );
      const deletedCount = (result as unknown as { changes?: number })?.changes ?? 0;
      logger.info('[OutboxRepository] Cleared completed commands', {
        daysToKeep,
        deletedCount,
      });
      return deletedCount;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error clearing completed commands', {
        daysToKeep,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(`Failed to clear completed commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async clearSynced(daysToKeep: number = 7): Promise<number> {
    return this.clearCompleted(daysToKeep);
  }
  async clearAll(): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle.delete(outboxEvents);
      const deletedCount = (result as unknown as { changes?: number })?.changes ?? 0;
      logger.warn('[OutboxRepository] Cleared all commands', { deletedCount });
      return deletedCount;
    } catch (error: unknown) {
      logger.error('[OutboxRepository] Error clearing all commands', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  private mapToCommand(row: DbOutboxEvent, lenient = false): OutboxCommand {
    const canonicalType = tryCanonicalizeEntityType(row.aggregateType) ?? row.aggregateType;
    return {
      id: row.id,
      userId: row.userId,
      aggregateId: row.aggregateId,
      aggregateType: canonicalType, 
      eventType: row.eventType as OutboxOperationType,
      payload: lenient
        ? this.parsePayloadLenient(row.id, row.payload)
        : this.parsePayloadStrict(row.id, row.payload),
      status: (row.status ?? 'PENDING') as OutboxStatus,
      retryCount: row.retryCount ?? 0,
      lastRetryAt: row.lastRetryAt ?? undefined,
      maxRetries: row.maxRetries ?? 5,
      processedAt: row.processedAt ?? undefined,
      error: row.error ?? undefined,
      errorDetails: row.errorDetails ?? undefined,
      createdAt: row.createdAt ?? undefined,
      updatedAt: row.updatedAt ?? undefined,
    };
  }
  private async mapRowsSafe(rows: DbOutboxEvent[]): Promise<OutboxCommand[]> {
    const commands: OutboxCommand[] = [];
    for (const row of rows) {
      try {
        commands.push(this.mapToCommand(row, false));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('[OutboxRepository] Corrupted outbox command quarantined to DEAD_LETTER', {
          outboxEventId: row.id,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          error: { name: 'CorruptedPayload', message: errorMsg },
        });
        try {
          await this.markDeadLetter(row.id, `Corrupted payload: ${errorMsg}`);
        } catch (dlError) {
          logger.error('[OutboxRepository] Failed to dead-letter corrupted command', {
            outboxEventId: row.id,
            error: dlError instanceof Error
              ? { name: dlError.name, message: dlError.message }
              : { name: 'Error', message: String(dlError) },
          });
        }
      }
    }
    return commands;
  }
  private parsePayloadStrict(outboxEventId: string, json: string | null | undefined): Record<string, unknown> {
    if (!json) return {}; 
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch (parseError) {
      throw new Error(
        `Corrupted JSON payload for outbox event ${outboxEventId}: ` +
        `${parseError instanceof Error ? parseError.message : String(parseError)}. ` +
        `Raw (first 200 chars): ${json.substring(0, 200)}`
      );
    }
  }
  private parsePayloadLenient(outboxEventId: string, json: string | null | undefined): Record<string, unknown> {
    if (!json) return {};
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      logger.warn('[OutboxRepository] Corrupted JSON payload in monitoring read (lenient mode)', {
        outboxEventId,
        rawLength: json.length,
        rawPrefix: json.substring(0, 100),
      });
      return {};
    }
  }
}
