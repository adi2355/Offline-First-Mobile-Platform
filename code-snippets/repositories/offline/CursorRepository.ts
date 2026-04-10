import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import { cursorState, type DbCursorState } from '../../db/schema';
import { logger } from '../../utils/logger';
import { BaseRepository } from '../BaseRepository';
import {
  type EntityType,
  ENTITY_TYPES,
  isEntityType,
  type EntityCursor,
  decodeEntityCursor,
  encodeEntityCursor,
  tryDecodeEntityCursor,
  advanceEntityCursor,
  InvalidCursorError,
  CursorBackwardError,
} from '@shared/contracts';
export type SyncStatus = 'idle' | 'syncing' | 'completed' | 'error';
export interface DomainCursorState {
  id?: number;
  entityType: EntityType;
  cursorValue: string | null;
  lastSyncTimestamp: string;
  recordsSynced: number;
  hasMore: boolean;
  syncStatus: SyncStatus;
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface CursorUpdateStats {
  records_synced: number;
  has_more: boolean;
}
export class CursorRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async getCursor(entityType: EntityType): Promise<string | null> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ cursorValue: cursorState.cursorValue })
        .from(cursorState)
        .where(eq(cursorState.entityType, entityType))
        .get();
      return result?.cursorValue ?? null;
    } catch (error: unknown) {
      logger.error('[CursorRepository] Error getting cursor', {
        entityType,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get cursor: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getCursorState(entityType: EntityType): Promise<DomainCursorState | null> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select()
        .from(cursorState)
        .where(eq(cursorState.entityType, entityType))
        .get();
      if (!result) return null;
      return this.mapToDomain(result);
    } catch (error: unknown) {
      logger.error('[CursorRepository] Error getting cursor state', {
        entityType,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get cursor state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getAllCursors(): Promise<DomainCursorState[]> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(cursorState)
        .orderBy(cursorState.entityType);
      return rows.map((row) => this.mapToDomain(row));
    } catch (error: unknown) {
      logger.error('[CursorRepository] Error getting all cursors', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get all cursors: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getSyncStatus(entityType: EntityType): Promise<SyncStatus> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ syncStatus: cursorState.syncStatus })
        .from(cursorState)
        .where(eq(cursorState.entityType, entityType))
        .get();
      return (result?.syncStatus as SyncStatus) ?? 'idle';
    } catch (error: unknown) {
      logger.error('[CursorRepository] Error getting sync status', {
        entityType,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get sync status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async hasMore(entityType: EntityType): Promise<boolean> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ hasMore: cursorState.hasMore })
        .from(cursorState)
        .where(eq(cursorState.entityType, entityType))
        .get();
      return result?.hasMore ?? false;
    } catch (error: unknown) {
      logger.error('[CursorRepository] Error checking hasMore', {
        entityType,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to check hasMore: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getLastSyncTimestamp(entityType: EntityType): Promise<string | null> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ lastSyncTimestamp: cursorState.lastSyncTimestamp })
        .from(cursorState)
        .where(eq(cursorState.entityType, entityType))
        .get();
      return result?.lastSyncTimestamp ?? null;
    } catch (error: unknown) {
      logger.error('[CursorRepository] Error getting last sync timestamp', {
        entityType,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get last sync timestamp: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async setCursor(
    entityType: EntityType,
    cursorValue: string | null,
    stats: CursorUpdateStats
  ): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      const now = new Date().toISOString();
      if (cursorValue !== null) {
        const proposedCursor = decodeEntityCursor(cursorValue);
        const currentCursorStr = await this.getCursor(entityType);
        if (currentCursorStr !== null) {
          const currentCursor = decodeEntityCursor(currentCursorStr);
          advanceEntityCursor(currentCursor, proposedCursor);
        }
        cursorValue = encodeEntityCursor(proposedCursor);
        logger.debug('[CursorRepository] Cursor validation passed', {
          entityType,
          proposedTimestamp: proposedCursor.lastCreatedAt,
          proposedId: proposedCursor.lastId.substring(0, 8) + '...',
        });
      }
      await drizzle
        .insert(cursorState)
        .values({
          entityType,
          cursorValue,
          lastSyncTimestamp: now,
          recordsSynced: stats.records_synced,
          hasMore: stats.has_more,
          syncStatus: 'completed',
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: cursorState.entityType,
          set: {
            cursorValue,
            lastSyncTimestamp: now,
            recordsSynced: stats.records_synced,
            hasMore: stats.has_more,
            syncStatus: 'completed',
            errorMessage: null,
            updatedAt: now,
          },
        });
      logger.debug('[CursorRepository] Cursor set successfully', {
        entityType,
        hasMore: stats.has_more,
        recordsSynced: stats.records_synced,
      });
    } catch (error: unknown) {
      if (error instanceof InvalidCursorError || error instanceof CursorBackwardError) {
        logger.error('[CursorRepository] Cursor validation failed', {
          entityType,
          errorType: error.name,
          errorMessage: error.message,
        });
        throw error;
      }
      logger.error('[CursorRepository] Error setting cursor', {
        entityType,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to set cursor: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getValidatedCursor(entityType: EntityType): Promise<EntityCursor | null> {
    const cursorStr = await this.getCursor(entityType);
    if (cursorStr === null) {
      return null;
    }
    return decodeEntityCursor(cursorStr);
  }
  async tryGetValidatedCursor(entityType: EntityType): Promise<EntityCursor | null> {
    const cursorStr = await this.getCursor(entityType);
    if (cursorStr === null) {
      return null;
    }
    return tryDecodeEntityCursor(cursorStr);
  }
  async resetCursor(entityType: EntityType): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      const now = new Date().toISOString();
      await drizzle
        .update(cursorState)
        .set({
          cursorValue: null,
          recordsSynced: 0,
          hasMore: false,
          syncStatus: 'idle',
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(cursorState.entityType, entityType));
      logger.debug('[CursorRepository] Cursor reset', { entityType });
    } catch (error: unknown) {
      logger.error('[CursorRepository] Error resetting cursor', {
        entityType,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to reset cursor: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async updateStatus(
    entityType: EntityType,
    status: SyncStatus,
    errorMessage?: string
  ): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      const now = new Date().toISOString();
      await drizzle
        .insert(cursorState)
        .values({
          entityType,
          syncStatus: status,
          errorMessage: errorMessage ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: cursorState.entityType,
          set: {
            syncStatus: status,
            errorMessage: errorMessage ?? null,
            updatedAt: now,
          },
        });
      logger.debug('[CursorRepository] Status updated', {
        entityType,
        status,
        hasError: !!errorMessage,
      });
    } catch (error: unknown) {
      logger.error('[CursorRepository] Error updating status', {
        entityType,
        status,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to update status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async setMultipleCursors(
    updates: Array<{
      entityType: EntityType;
      cursor: string | null;
      stats: CursorUpdateStats;
    }>
  ): Promise<void> {
    if (updates.length === 0) {
      logger.debug('[CursorRepository] No cursor updates to commit');
      return;
    }
    try {
      await this.executeDrizzleTransaction(async (tx) => {
        const now = new Date().toISOString();
        for (const update of updates) {
          let cursorValue = update.cursor;
          if (cursorValue !== null) {
            const proposedCursor = decodeEntityCursor(cursorValue);
            const currentResult = await tx
              .select({ cursorValue: cursorState.cursorValue })
              .from(cursorState)
              .where(eq(cursorState.entityType, update.entityType))
              .get();
            const currentCursorStr = currentResult?.cursorValue ?? null;
            if (currentCursorStr !== null) {
              try {
                const currentCursor = decodeEntityCursor(currentCursorStr);
                advanceEntityCursor(currentCursor, proposedCursor);
              } catch (cursorError) {
                if (cursorError instanceof InvalidCursorError) {
                  logger.warn('[CursorRepository] Current cursor corrupted, allowing overwrite', {
                    entityType: update.entityType,
                    corruptedPrefix: currentCursorStr.substring(0, 50),
                    reason: cursorError.reason,
                  });
                } else {
                  throw cursorError; 
                }
              }
            }
            cursorValue = encodeEntityCursor(proposedCursor);
          }
          await tx
            .insert(cursorState)
            .values({
              entityType: update.entityType,
              cursorValue,
              lastSyncTimestamp: now,
              recordsSynced: update.stats.records_synced,
              hasMore: update.stats.has_more,
              syncStatus: 'completed',
              errorMessage: null,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: cursorState.entityType,
              set: {
                cursorValue,
                lastSyncTimestamp: now,
                recordsSynced: update.stats.records_synced,
                hasMore: update.stats.has_more,
                syncStatus: 'completed',
                errorMessage: null,
                updatedAt: now,
              },
            });
        }
      });
      logger.info('[CursorRepository] Multiple cursors set atomically', {
        count: updates.length,
        entityTypes: updates.map((u) => u.entityType),
      });
    } catch (error: unknown) {
      if (error instanceof InvalidCursorError || error instanceof CursorBackwardError) {
        logger.error('[CursorRepository] Cursor validation failed in batch update', {
          errorType: error.name,
          errorMessage: error.message,
          updateCount: updates.length,
        });
        throw error;
      }
      logger.error('[CursorRepository] Error setting multiple cursors', {
        count: updates.length,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to set multiple cursors: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async resetAllCursors(): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      const now = new Date().toISOString();
      await drizzle
        .update(cursorState)
        .set({
          cursorValue: null,
          recordsSynced: 0,
          hasMore: false,
          syncStatus: 'idle',
          errorMessage: null,
          updatedAt: now,
        });
      logger.info('[CursorRepository] All cursors reset');
    } catch (error: unknown) {
      logger.error('[CursorRepository] Error resetting all cursors', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to reset all cursors: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  private mapToDomain(row: DbCursorState): DomainCursorState {
    return {
      id: row.id,
      entityType: row.entityType as EntityType,
      cursorValue: row.cursorValue,
      lastSyncTimestamp: row.lastSyncTimestamp,
      recordsSynced: row.recordsSynced,
      hasMore: row.hasMore, 
      syncStatus: row.syncStatus as SyncStatus,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
