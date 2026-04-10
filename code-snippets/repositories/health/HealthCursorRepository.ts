import { eq, and, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/client';
import {
  healthIngestCursors,
  type DbHealthIngestCursor,
  type DbHealthIngestCursorInsert,
} from '../../db/schema';
import { BaseRepository } from '../BaseRepository';
import { logger } from '../../utils/logger';
export const MAX_ANCHOR_SIZE_BYTES = 32 * 1024; 
export type CursorScope = 'change_anchor' | 'hot_anchor' | 'cold_time';
export const DEFAULT_CURSOR_SCOPE: CursorScope = 'change_anchor';
export interface DomainHealthCursor {
  id?: number;
  userId: string;
  sourceId: string;
  sampleType: string;
  scope: CursorScope;
  anchorData: string | null;
  cursorVersion: number;
  lastIngestTimestamp: number | null;
  totalSamplesIngested: number;
  coldBackfillEndTs: number | null;
  coldBackfillStartTs: number | null;
  coldPageFromTs: number | null;
  lastSyncAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}
export interface UpdateCursorInput {
  anchorData: string | null;
  expectedVersion: number;
  samplesIngested?: number;
  lastIngestTimestamp?: number;
  coldBackfillEndTs?: number;
  coldBackfillStartTs?: number;
  coldPageFromTs?: number | null;
}
export interface CursorUpdateResult {
  success: boolean;
  newVersion?: number;
  currentVersion?: number;
}
function mapDbCursorToDomain(db: DbHealthIngestCursor): DomainHealthCursor {
  return {
    id: db.id,
    userId: db.userId,
    sourceId: db.sourceId,
    sampleType: db.sampleType,
    scope: (db.scope ?? DEFAULT_CURSOR_SCOPE) as CursorScope,
    anchorData: db.anchorData,
    cursorVersion: typeof db.cursorVersion === 'string' ? Number(db.cursorVersion) : db.cursorVersion,
    lastIngestTimestamp: db.lastIngestTimestamp != null ? Number(db.lastIngestTimestamp) : null,
    totalSamplesIngested: db.totalSamplesIngested != null ? Number(db.totalSamplesIngested) : 0,
    coldBackfillEndTs: db.coldBackfillEndTs != null ? Number(db.coldBackfillEndTs) : null,
    coldBackfillStartTs: db.coldBackfillStartTs != null ? Number(db.coldBackfillStartTs) : null,
    coldPageFromTs: db.coldPageFromTs != null ? Number(db.coldPageFromTs) : null,
    lastSyncAt: db.lastSyncAt != null ? Number(db.lastSyncAt) : null,
    createdAt: db.createdAt,
    updatedAt: db.updatedAt,
  };
}
export class HealthCursorRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  async getCursor(
    userId: string,
    sourceId: string,
    sampleType: string,
    scope: CursorScope = DEFAULT_CURSOR_SCOPE
  ): Promise<DomainHealthCursor | null> {
    try {
      const drizzle = this.getDrizzle();
      const row = await drizzle
        .select()
        .from(healthIngestCursors)
        .where(
          and(
            eq(healthIngestCursors.userId, userId),
            eq(healthIngestCursors.sourceId, sourceId),
            eq(healthIngestCursors.sampleType, sampleType),
            eq(healthIngestCursors.scope, scope)
          )
        )
        .get();
      return row ? mapDbCursorToDomain(row) : null;
    } catch (error: unknown) {
      logger.error('[HealthCursorRepository] Error getting cursor', {
        userId,
        sourceId,
        sampleType,
        scope,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get cursor: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getCursorsForUser(userId: string): Promise<DomainHealthCursor[]> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(healthIngestCursors)
        .where(eq(healthIngestCursors.userId, userId));
      return rows.map(mapDbCursorToDomain);
    } catch (error: unknown) {
      logger.error('[HealthCursorRepository] Error getting user cursors', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get cursors: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getCursorsBySource(
    userId: string,
    sourceId: string
  ): Promise<DomainHealthCursor[]> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(healthIngestCursors)
        .where(
          and(
            eq(healthIngestCursors.userId, userId),
            eq(healthIngestCursors.sourceId, sourceId)
          )
        );
      return rows.map(mapDbCursorToDomain);
    } catch (error: unknown) {
      logger.error('[HealthCursorRepository] Error getting source cursors', {
        userId,
        sourceId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get cursors: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async updateCursor(
    userId: string,
    sourceId: string,
    sampleType: string,
    input: UpdateCursorInput,
    scope: CursorScope = DEFAULT_CURSOR_SCOPE
  ): Promise<CursorUpdateResult> {
    if (input.anchorData && input.anchorData.length > MAX_ANCHOR_SIZE_BYTES) {
      const error = new Error(
        `anchorData exceeds maximum size of ${MAX_ANCHOR_SIZE_BYTES} bytes ` +
        `(got ${input.anchorData.length} bytes). This may indicate a bug in the ` +
        `health data provider or a malformed anchor.`
      );
      logger.error('[HealthCursorRepository] Anchor size validation failed', {
        userId,
        sourceId,
        sampleType,
        scope,
        anchorSize: input.anchorData.length,
        maxSize: MAX_ANCHOR_SIZE_BYTES,
      });
      throw error;
    }
    try {
      const drizzle = this.getDrizzle();
      const now = Date.now();
      const newVersion = input.expectedVersion + 1;
      if (input.expectedVersion === 0) {
        return this.createCursor(userId, sourceId, sampleType, input, scope);
      }
      const samplesIngested = input.samplesIngested ?? 0;
      const coldEndTs = input.coldBackfillEndTs !== undefined ? input.coldBackfillEndTs : null;
      const coldStartTs = input.coldBackfillStartTs !== undefined ? input.coldBackfillStartTs : null;
      const coldPageFromTsExplicit = input.coldPageFromTs !== undefined ? 1 : 0;
      const coldPageFromTsValue = typeof input.coldPageFromTs === 'number' ? input.coldPageFromTs : null;
      await drizzle.run(sql`
        UPDATE ${healthIngestCursors}
        SET
          anchor_data = ${input.anchorData},
          cursor_version = ${newVersion},
          last_ingest_timestamp = ${now},
          total_samples_ingested = total_samples_ingested + ${samplesIngested},
          cold_backfill_end_ts = COALESCE(${coldEndTs}, cold_backfill_end_ts),
          cold_backfill_start_ts = COALESCE(${coldStartTs}, cold_backfill_start_ts),
          cold_page_from_ts = IIF(${coldPageFromTsExplicit} = 1, ${coldPageFromTsValue}, cold_page_from_ts),
          last_sync_at = ${now},
          updated_at = ${now}
        WHERE
          user_id = ${userId}
          AND source_id = ${sourceId}
          AND sample_type = ${sampleType}
          AND scope = ${scope}
          AND cursor_version = ${input.expectedVersion}
      `);
      const changesResult = await drizzle.get<{ changes: number }>(
        sql`SELECT changes() as changes`
      );
      const rowsAffected = changesResult?.changes ?? 0;
      if (rowsAffected === 1) {
        logger.debug('[HealthCursorRepository] Cursor updated (CAS success)', {
          userId,
          sourceId,
          sampleType,
          scope,
          oldVersion: input.expectedVersion,
          newVersion,
          samplesIngested,
        });
        return {
          success: true,
          newVersion,
        };
      } else {
        const current = await this.getCursor(userId, sourceId, sampleType, scope);
        logger.warn('[HealthCursorRepository] Cursor update failed - CAS mismatch', {
          userId,
          sourceId,
          sampleType,
          scope,
          expectedVersion: input.expectedVersion,
          actualVersion: current?.cursorVersion,
          cursorExists: current !== null,
        });
        return {
          success: false,
          currentVersion: current?.cursorVersion ?? 0,
        };
      }
    } catch (error: unknown) {
      logger.error('[HealthCursorRepository] Error updating cursor', {
        userId,
        sourceId,
        sampleType,
        scope,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to update cursor: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  private async createCursor(
    userId: string,
    sourceId: string,
    sampleType: string,
    input: UpdateCursorInput,
    scope: CursorScope = DEFAULT_CURSOR_SCOPE
  ): Promise<CursorUpdateResult> {
    if (input.anchorData && input.anchorData.length > MAX_ANCHOR_SIZE_BYTES) {
      const error = new Error(
        `anchorData exceeds maximum size of ${MAX_ANCHOR_SIZE_BYTES} bytes ` +
        `(got ${input.anchorData.length} bytes). This may indicate a bug in the ` +
        `health data provider or a malformed anchor.`
      );
      logger.error('[HealthCursorRepository] Anchor size validation failed (create)', {
        userId,
        sourceId,
        sampleType,
        scope,
        anchorSize: input.anchorData.length,
        maxSize: MAX_ANCHOR_SIZE_BYTES,
      });
      throw error;
    }
    try {
      const drizzle = this.getDrizzle();
      const now = Date.now();
      const insertValue: DbHealthIngestCursorInsert = {
        userId,
        sourceId,
        sampleType,
        scope,
        anchorData: input.anchorData,
        cursorVersion: 1,
        lastIngestTimestamp: now,
        totalSamplesIngested: input.samplesIngested ?? 0,
        coldBackfillEndTs: input.coldBackfillEndTs ?? null,
        coldBackfillStartTs: input.coldBackfillStartTs ?? null,
        coldPageFromTs: input.coldPageFromTs ?? null,
        lastSyncAt: now,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await drizzle
          .insert(healthIngestCursors)
          .values(insertValue);
        logger.debug('[HealthCursorRepository] Cursor created', {
          userId,
          sourceId,
          sampleType,
          scope,
          samplesIngested: input.samplesIngested,
        });
        return {
          success: true,
          newVersion: 1,
        };
      } catch (insertError: unknown) {
        const errorMessage = insertError instanceof Error ? insertError.message : String(insertError);
        if (
          errorMessage.includes('UNIQUE constraint failed') ||
          errorMessage.includes('duplicate')
        ) {
          const existingCursor = await this.getCursor(userId, sourceId, sampleType, scope);
          logger.warn('[HealthCursorRepository] Cursor already exists (expected new)', {
            userId,
            sourceId,
            sampleType,
            scope,
            existingVersion: existingCursor?.cursorVersion,
          });
          return {
            success: false,
            currentVersion: existingCursor?.cursorVersion ?? 0,
          };
        }
        throw insertError;
      }
    } catch (error: unknown) {
      logger.error('[HealthCursorRepository] Error creating cursor', {
        userId,
        sourceId,
        sampleType,
        scope,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to create cursor: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async resetCursor(
    userId: string,
    sourceId: string,
    sampleType: string,
    scope: CursorScope = DEFAULT_CURSOR_SCOPE
  ): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      const now = Date.now();
      await drizzle
        .update(healthIngestCursors)
        .set({
          anchorData: null,
          cursorVersion: sql`${healthIngestCursors.cursorVersion} + 1`,
          lastIngestTimestamp: null,
          totalSamplesIngested: 0,
          coldBackfillEndTs: null,
          coldBackfillStartTs: null,
          coldPageFromTs: null,
          lastSyncAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(healthIngestCursors.userId, userId),
            eq(healthIngestCursors.sourceId, sourceId),
            eq(healthIngestCursors.sampleType, sampleType),
            eq(healthIngestCursors.scope, scope)
          )
        );
      logger.info('[HealthCursorRepository] Cursor reset', {
        userId,
        sourceId,
        sampleType,
        scope,
      });
    } catch (error: unknown) {
      logger.error('[HealthCursorRepository] Error resetting cursor', {
        userId,
        sourceId,
        sampleType,
        scope,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to reset cursor: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async deleteCursor(
    userId: string,
    sourceId: string,
    sampleType: string,
    scope: CursorScope = DEFAULT_CURSOR_SCOPE
  ): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      await drizzle
        .delete(healthIngestCursors)
        .where(
          and(
            eq(healthIngestCursors.userId, userId),
            eq(healthIngestCursors.sourceId, sourceId),
            eq(healthIngestCursors.sampleType, sampleType),
            eq(healthIngestCursors.scope, scope)
          )
        );
      logger.debug('[HealthCursorRepository] Cursor deleted', {
        userId,
        sourceId,
        sampleType,
        scope,
      });
    } catch (error: unknown) {
      logger.error('[HealthCursorRepository] Error deleting cursor', {
        userId,
        sourceId,
        sampleType,
        scope,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to delete cursor: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async clearAllForUser(userId: string): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      await drizzle
        .delete(healthIngestCursors)
        .where(eq(healthIngestCursors.userId, userId));
      logger.warn('[HealthCursorRepository] All cursors cleared for user', { userId });
    } catch (error: unknown) {
      logger.error('[HealthCursorRepository] Error clearing cursors', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to clear cursors: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async clearAllForSource(userId: string, sourceId: string): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      await drizzle
        .delete(healthIngestCursors)
        .where(
          and(
            eq(healthIngestCursors.userId, userId),
            eq(healthIngestCursors.sourceId, sourceId)
          )
        );
      logger.warn('[HealthCursorRepository] All cursors cleared for source', {
        userId,
        sourceId,
      });
    } catch (error: unknown) {
      logger.error('[HealthCursorRepository] Error clearing source cursors', {
        userId,
        sourceId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to clear cursors: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
