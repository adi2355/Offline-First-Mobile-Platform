import { eq, and, isNull, isNotNull, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import { syncMetadata, type DbSyncMetadata, type DbSyncMetadataInsert } from '../../db/schema';
import { logger } from '../../utils/logger';
import { BaseRepository } from '../BaseRepository';
export interface IdMapping {
  id?: string;
  entity_type: string;
  client_id: string;
  server_id: string | null;
  sync_status?: string;
  created_at?: string;
  updated_at?: string;
}
function formatErrorForLogging(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: 'UnknownError',
    message: String(error),
  };
}
export class IdMapRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async saveMapping(
    entityType: string,
    clientId: string,
    serverId: string
  ): Promise<void> {
    const now = new Date().toISOString();
    const lastModified = Date.now();
    try {
      const mappingId = `${entityType}-${clientId}`;
      const drizzle = this.getDrizzle();
      await drizzle
        .insert(syncMetadata)
        .values({
          id: mappingId,
          tableName: entityType,
          localId: clientId,
          serverId: serverId,
          syncStatus: 'synced',
          lastModified: lastModified,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: syncMetadata.id,
          set: {
            serverId: serverId,
            syncStatus: 'synced',
            lastModified: lastModified,
            updatedAt: now,
          },
        });
      logger.debug('[IdMapRepository] Mapping saved', {
        entityType,
        clientId,
        serverId,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error saving mapping', {
        entityType,
        clientId,
        serverId,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to save ID mapping: ${errorMessage}`);
    }
  }
  async saveBulkMappings(mappings: IdMapping[]): Promise<void> {
    if (mappings.length === 0) {
      logger.debug('[IdMapRepository] No mappings to save');
      return;
    }
    try {
      await this.executeDrizzleTransaction(async (tx) => {
        const now = new Date().toISOString();
        const lastModified = Date.now();
        for (const mapping of mappings) {
          if (!mapping.server_id) {
            logger.warn('[IdMapRepository] Skipping mapping without server_id', {
              entityType: mapping.entity_type,
              clientId: mapping.client_id,
            });
            continue;
          }
          const mappingId = `${mapping.entity_type}-${mapping.client_id}`;
          await tx
            .insert(syncMetadata)
            .values({
              id: mappingId,
              tableName: mapping.entity_type,
              localId: mapping.client_id,
              serverId: mapping.server_id,
              syncStatus: 'synced',
              lastModified: lastModified,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: syncMetadata.id,
              set: {
                serverId: mapping.server_id,
                syncStatus: 'synced',
                lastModified: lastModified,
                updatedAt: now,
              },
            });
        }
      });
      logger.info('[IdMapRepository] Bulk mappings saved', {
        count: mappings.length,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error saving bulk mappings', {
        count: mappings.length,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to save bulk mappings: ${errorMessage}`);
    }
  }
  async getServerId(clientId: string): Promise<string | null> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ serverId: syncMetadata.serverId })
        .from(syncMetadata)
        .where(eq(syncMetadata.localId, clientId))
        .get();
      return result?.serverId ?? null;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error getting server ID', {
        clientId,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to get server ID: ${errorMessage}`);
    }
  }
  async getClientId(serverId: string): Promise<string | null> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ localId: syncMetadata.localId })
        .from(syncMetadata)
        .where(eq(syncMetadata.serverId, serverId))
        .get();
      return result?.localId ?? null;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error getting client ID', {
        serverId,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to get client ID: ${errorMessage}`);
    }
  }
  async getMapping(clientId: string): Promise<IdMapping | null> {
    try {
      const drizzle = this.getDrizzle();
      const row = await drizzle
        .select()
        .from(syncMetadata)
        .where(eq(syncMetadata.localId, clientId))
        .get();
      if (!row) return null;
      return this.mapToIdMapping(row);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error getting mapping', {
        clientId,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to get mapping: ${errorMessage}`);
    }
  }
  async isMapped(clientId: string): Promise<boolean> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ serverId: syncMetadata.serverId })
        .from(syncMetadata)
        .where(
          and(
            eq(syncMetadata.localId, clientId),
            isNotNull(syncMetadata.serverId)
          )
        )
        .get();
      return result !== undefined && result.serverId !== null;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error checking if mapped', {
        clientId,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to check mapping: ${errorMessage}`);
    }
  }
  async getMappingsByEntityType(entityType: string): Promise<IdMapping[]> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(syncMetadata)
        .where(eq(syncMetadata.tableName, entityType))
        .all();
      return rows.map((row) => this.mapToIdMapping(row));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error getting mappings by entity type', {
        entityType,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to get mappings: ${errorMessage}`);
    }
  }
  async getPendingMappings(): Promise<IdMapping[]> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(syncMetadata)
        .where(isNull(syncMetadata.serverId))
        .all();
      return rows.map((row) => this.mapToIdMapping(row));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error getting pending mappings', {
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to get pending mappings: ${errorMessage}`);
    }
  }
  async resolveClientIds<T extends Record<string, unknown>>(
    payload: T,
    idFields: string[]
  ): Promise<T> {
    try {
      const resolved = { ...payload } as Record<string, unknown>;
      for (const field of idFields) {
        const value = resolved[field];
        if (value && typeof value === 'string') {
          const serverId = await this.getServerId(value);
          if (serverId) {
            resolved[field] = serverId;
            logger.debug('[IdMapRepository] Resolved client ID to server ID', {
              field,
              clientId: value,
              serverId,
            });
          }
        }
      }
      return resolved as T;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error resolving client IDs', {
        fields: idFields,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to resolve client IDs: ${errorMessage}`);
    }
  }
  async deleteMapping(clientId: string): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      await drizzle
        .delete(syncMetadata)
        .where(eq(syncMetadata.localId, clientId));
      logger.debug('[IdMapRepository] Mapping deleted', { clientId });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error deleting mapping', {
        clientId,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to delete mapping: ${errorMessage}`);
    }
  }
  async deleteMappingsByEntityType(entityType: string): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      await drizzle
        .delete(syncMetadata)
        .where(eq(syncMetadata.tableName, entityType));
      logger.info('[IdMapRepository] Mappings deleted by entity type', { entityType });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error deleting mappings by entity type', {
        entityType,
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to delete mappings: ${errorMessage}`);
    }
  }
  async clearAllMappings(): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      await drizzle.delete(syncMetadata);
      logger.warn('[IdMapRepository] All mappings cleared');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error clearing all mappings', {
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to clear all mappings: ${errorMessage}`);
    }
  }
  async getMappedCount(): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: sql<number>`COUNT(*)` })
        .from(syncMetadata)
        .where(isNotNull(syncMetadata.serverId))
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error counting mapped records', {
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to count mapped records: ${errorMessage}`);
    }
  }
  async getUnmappedCount(): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: sql<number>`COUNT(*)` })
        .from(syncMetadata)
        .where(isNull(syncMetadata.serverId))
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error counting unmapped records', {
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to count unmapped records: ${errorMessage}`);
    }
  }
  async getTotalCount(): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: sql<number>`COUNT(*)` })
        .from(syncMetadata)
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[IdMapRepository] Error counting total records', {
        error: formatErrorForLogging(error),
      });
      throw new Error(`Failed to count total records: ${errorMessage}`);
    }
  }
  private mapToIdMapping(row: DbSyncMetadata): IdMapping {
    return {
      id: row.id,
      entity_type: row.tableName,
      client_id: row.localId,
      server_id: row.serverId,
      sync_status: row.syncStatus,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}
