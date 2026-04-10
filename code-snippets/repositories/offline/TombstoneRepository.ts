import { eq, and, or, sql, count, min, desc, asc, lt, SQL } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import { tombstones, type DbTombstone, type DbTombstoneInsert } from '../../db/schema';
import { safeJsonParse, safeJsonStringify } from '../../db/schema-helpers';
import { BaseRepository } from '../BaseRepository';
import { logger } from '../../utils/logger';
export type TombstoneStatus = 'pending' | 'synced' | 'error';
export interface DomainTombstone {
  id?: number;
  userId: string;
  entityType: string;
  entityId: string;
  serverId?: string | null;
  deletedAt: string;
  syncStatus: TombstoneStatus;
  syncedAt?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}
export type Tombstone = DomainTombstone;
export interface TombstoneStats {
  pendingCount: number;
  syncedCount: number;
  errorCount: number;
  oldestPendingAt: string | null;
}
function mapDbTombstoneToDomain(db: DbTombstone): DomainTombstone {
  return {
    id: db.id,
    userId: db.userId ?? '',
    entityType: db.entityType,
    entityId: db.entityId,
    serverId: db.serverId,
    deletedAt: db.deletedAt,
    syncStatus: db.syncStatus as TombstoneStatus,
    syncedAt: db.syncedAt,
    errorMessage: db.errorMessage,
    metadata: safeJsonParse<Record<string, unknown> | null>(db.metadata, null),
    createdAt: db.createdAt,
  };
}
export class TombstoneRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  private static readonly DrizzleTransactionType: Parameters<
    Parameters<DrizzleDB['transaction']>[0]
  >[0] = null as never; 
  async addTombstone(
    userId: string,
    entityType: string,
    entityId: string,
    serverId?: string,
    metadata?: Record<string, unknown>,
    tx?: typeof TombstoneRepository.DrizzleTransactionType
  ): Promise<void> {
    try {
      if (!userId) {
        throw new Error('[TombstoneRepository] userId is required to add tombstones.');
      }
      const now = new Date().toISOString();
      const drizzle = tx ?? this.getDrizzle();
      const insertValues: DbTombstoneInsert = {
        userId,
        entityType,
        entityId,
        serverId: serverId ?? null,
        deletedAt: now,
        syncStatus: 'pending',
        syncedAt: null,
        errorMessage: null,
        metadata: metadata ? safeJsonStringify(metadata) : null,
        createdAt: now,
      };
      await drizzle
        .insert(tombstones)
        .values(insertValues)
        .onConflictDoUpdate({
          target: [tombstones.entityType, tombstones.entityId],
          set: {
            userId,
            serverId: serverId ?? null,
            deletedAt: now,
            syncStatus: 'pending',
            syncedAt: null,
            errorMessage: null,
            metadata: metadata ? safeJsonStringify(metadata) : null,
          },
        });
      logger.debug('[TombstoneRepository] Tombstone added', {
        entityType,
        entityId,
        serverId,
      });
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error adding tombstone', {
        entityType,
        entityId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to add tombstone: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async markSynced(entityId: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .update(tombstones)
        .set({
          syncStatus: 'synced',
          syncedAt: now,
          errorMessage: null,
        })
        .where(eq(tombstones.entityId, entityId));
      const rowsAffected = (result as unknown as { changes?: number })?.changes ?? 0;
      if (rowsAffected === 0) {
        logger.warn('[TombstoneRepository] markSynced affected 0 rows — tombstone may have been already synced, deleted, or entityId is invalid', {
          entityId,
        });
      } else {
        logger.debug('[TombstoneRepository] Tombstone marked as synced', { entityId });
      }
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error marking tombstone as synced', {
        entityId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to mark tombstone as synced: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async markFailed(entityId: string, errorMessage: string): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .update(tombstones)
        .set({
          syncStatus: 'error',
          errorMessage: errorMessage,
        })
        .where(eq(tombstones.entityId, entityId));
      const rowsAffected = (result as unknown as { changes?: number })?.changes ?? 0;
      if (rowsAffected === 0) {
        logger.warn('[TombstoneRepository] markFailed affected 0 rows — tombstone may have been deleted, synced, or entityId is invalid', {
          entityId,
          originalError: errorMessage,
        });
      } else {
        logger.debug('[TombstoneRepository] Tombstone marked as failed', {
          entityId,
          errorMessage,
        });
      }
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error marking tombstone as failed', {
        entityId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to mark tombstone as failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async addBulkTombstones(
    inputTombstones: Omit<DomainTombstone, 'id' | 'createdAt'>[]
  ): Promise<void> {
    try {
      await this.executeDrizzleTransaction(async (tx) => {
        const now = new Date().toISOString();
        for (const tombstone of inputTombstones) {
          if (!tombstone.userId) {
            throw new Error('[TombstoneRepository] userId is required for bulk tombstones.');
          }
          const insertValues: DbTombstoneInsert = {
            userId: tombstone.userId,
            entityType: tombstone.entityType,
            entityId: tombstone.entityId,
            serverId: tombstone.serverId ?? null,
            deletedAt: tombstone.deletedAt || now,
            syncStatus: 'pending',
            syncedAt: null,
            errorMessage: null,
            metadata: tombstone.metadata ? safeJsonStringify(tombstone.metadata) : null,
            createdAt: now,
          };
          await tx
            .insert(tombstones)
            .values(insertValues)
            .onConflictDoUpdate({
              target: [tombstones.entityType, tombstones.entityId],
              set: {
                userId: tombstone.userId,
                serverId: tombstone.serverId ?? null,
                deletedAt: tombstone.deletedAt || now,
                syncStatus: 'pending',
                syncedAt: null,
                errorMessage: null,
                metadata: tombstone.metadata ? safeJsonStringify(tombstone.metadata) : null,
              },
            });
        }
      });
      logger.info('[TombstoneRepository] Bulk tombstones added', {
        count: inputTombstones.length,
      });
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error adding bulk tombstones', {
        count: inputTombstones.length,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to add bulk tombstones: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getPendingTombstones(limit: number = 100, userId: string): Promise<DomainTombstone[]> {
    try {
      if (!userId) {
        throw new Error('[TombstoneRepository] userId is required to fetch pending tombstones.');
      }
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(tombstones)
        .where(and(eq(tombstones.userId, userId), eq(tombstones.syncStatus, 'pending')))
        .orderBy(asc(tombstones.deletedAt))
        .limit(limit);
      return rows.map(mapDbTombstoneToDomain);
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error getting pending tombstones', {
        limit,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get pending tombstones: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getActionableTombstones(limit: number = 100, userId: string): Promise<DomainTombstone[]> {
    try {
      if (!userId) {
        throw new Error('[TombstoneRepository] userId is required to fetch actionable tombstones.');
      }
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(tombstones)
        .where(
          and(
            eq(tombstones.userId, userId),
            or(
              eq(tombstones.syncStatus, 'pending'),
              eq(tombstones.syncStatus, 'error')
            )
          )
        )
        .orderBy(asc(tombstones.deletedAt))
        .limit(limit);
      return rows.map(mapDbTombstoneToDomain);
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error getting actionable tombstones', {
        limit,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get actionable tombstones: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getTombstone(entityId: string): Promise<DomainTombstone | null> {
    try {
      const drizzle = this.getDrizzle();
      const row = await drizzle
        .select()
        .from(tombstones)
        .where(eq(tombstones.entityId, entityId))
        .get();
      return row ? mapDbTombstoneToDomain(row) : null;
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error getting tombstone', {
        entityId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get tombstone: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async isTombstoned(entityId: string): Promise<boolean> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: count() })
        .from(tombstones)
        .where(
          and(
            eq(tombstones.entityId, entityId),
            eq(tombstones.syncStatus, 'pending')
          )
        )
        .get();
      return (result?.count ?? 0) > 0;
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error checking if tombstoned', {
        entityId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to check tombstone status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getStats(userId: string): Promise<TombstoneStats> {
    try {
      if (!userId) {
        throw new Error('[TombstoneRepository] userId is required to fetch tombstone stats.');
      }
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({
          pendingCount: sql<number>`SUM(CASE WHEN ${tombstones.syncStatus} = 'pending' THEN 1 ELSE 0 END)`,
          syncedCount: sql<number>`SUM(CASE WHEN ${tombstones.syncStatus} = 'synced' THEN 1 ELSE 0 END)`,
          errorCount: sql<number>`SUM(CASE WHEN ${tombstones.syncStatus} = 'error' THEN 1 ELSE 0 END)`,
          oldestPendingAt: sql<string | null>`MIN(CASE WHEN ${tombstones.syncStatus} = 'pending' THEN ${tombstones.deletedAt} ELSE NULL END)`,
        })
        .from(tombstones)
        .where(eq(tombstones.userId, userId))
        .get();
      return {
        pendingCount: result?.pendingCount ?? 0,
        syncedCount: result?.syncedCount ?? 0,
        errorCount: result?.errorCount ?? 0,
        oldestPendingAt: result?.oldestPendingAt ?? null,
      };
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error getting tombstone stats', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get tombstone stats: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getTombstonesByEntityType(entityType: string): Promise<DomainTombstone[]> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(tombstones)
        .where(eq(tombstones.entityType, entityType))
        .orderBy(desc(tombstones.deletedAt));
      return rows.map(mapDbTombstoneToDomain);
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error getting tombstones by entity type', {
        entityType,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get tombstones: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getPendingCount(userId: string): Promise<number> {
    try {
      if (!userId) {
        throw new Error('[TombstoneRepository] userId is required to count pending tombstones.');
      }
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: count() })
        .from(tombstones)
        .where(and(eq(tombstones.userId, userId), eq(tombstones.syncStatus, 'pending')))
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error counting pending tombstones', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to count pending tombstones: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async countActionable(userId: string): Promise<number> {
    try {
      if (!userId) {
        throw new Error('[TombstoneRepository] userId is required to count actionable tombstones.');
      }
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: count() })
        .from(tombstones)
        .where(
          and(
            eq(tombstones.userId, userId),
            or(
              eq(tombstones.syncStatus, 'pending'),
              eq(tombstones.syncStatus, 'error')
            )
          )
        )
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error counting actionable tombstones', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to count actionable tombstones: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async cleanup(daysToKeep: number = 30): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      const cutoffDateStr = cutoffDate.toISOString();
      const result = await drizzle
        .delete(tombstones)
        .where(
          and(
            eq(tombstones.syncStatus, 'synced'),
            lt(tombstones.syncedAt, cutoffDateStr)
          )
        );
      logger.info('[TombstoneRepository] Cleanup completed', {
        daysToKeep,
        cutoffDate: cutoffDateStr,
      });
      return 0; 
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error cleaning up tombstones', {
        daysToKeep,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to cleanup tombstones: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async deleteTombstone(entityId: string): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      await drizzle
        .delete(tombstones)
        .where(eq(tombstones.entityId, entityId));
      logger.debug('[TombstoneRepository] Tombstone deleted', { entityId });
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error deleting tombstone', {
        entityId,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to delete tombstone: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async clearAll(): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      await drizzle.delete(tombstones);
      logger.warn('[TombstoneRepository] All tombstones cleared');
    } catch (error: unknown) {
      logger.error('[TombstoneRepository] Error clearing all tombstones', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to clear all tombstones: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
