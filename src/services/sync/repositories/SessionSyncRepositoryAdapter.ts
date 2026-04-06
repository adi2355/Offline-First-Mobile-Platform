import { type SQLiteDatabase } from 'expo-sqlite';
import {
  type SyncEntityRepository,
  type SyncStatus,
  type CreateOptions,
} from './SyncEntityRepository';
import { logger, toLogError } from '../../../utils/logger';
export interface Session {
  id: string;
  userId: string;
  purchaseId?: string | null;
  deviceId?: string | null;
  clientSessionId?: string | null;
  primaryProductId?: string | null;
  sessionStartTimestamp: string;
  sessionEndTimestamp?: string | null;
  hitCount?: number;
  totalDurationMs?: number;
  avgHitDurationMs?: number;
  sessionTypeHeuristic?: string | null;
  observationFeature?: number | null;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  syncStatus?: string | null;
  syncVersion?: number;
  status?: string; 
  clientId?: string | null;
  notes?: string | null;
}
interface SessionRow {
  id: string;
  userId: string;
  purchaseId: string | null;
  deviceId: string | null;
  clientSessionId: string | null;
  primaryProductId: string | null;
  sessionStartTimestamp: string;
  sessionEndTimestamp: string | null;
  hitCount: number | null;
  totalDurationMs: number | null;
  avgHitDurationMs: number | null;
  sessionTypeHeuristic: string | null;
  observationFeature: number | null;
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  sync_status: string | null;
  sync_version: number | null;
  status: string | null;
  client_id: string | null;
  notes: string | null;
}
function mapRowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.userId,
    purchaseId: row.purchaseId,
    deviceId: row.deviceId,
    clientSessionId: row.clientSessionId,
    primaryProductId: row.primaryProductId,
    sessionStartTimestamp: row.sessionStartTimestamp,
    sessionEndTimestamp: row.sessionEndTimestamp,
    hitCount: row.hitCount ?? 0,
    totalDurationMs: row.totalDurationMs ?? 0,
    avgHitDurationMs: row.avgHitDurationMs ?? 0,
    sessionTypeHeuristic: row.sessionTypeHeuristic,
    observationFeature: row.observationFeature,
    version: row.version ?? 1,
    createdAt: row.createdAt ?? undefined,
    updatedAt: row.updatedAt ?? undefined,
    syncStatus: row.sync_status,
    syncVersion: row.sync_version ?? 1,
    status: row.status ?? 'ACTIVE',
    clientId: row.client_id,
    notes: row.notes,
  };
}
export class SessionSyncRepositoryAdapter implements SyncEntityRepository<Session> {
  readonly entityType = 'sessions' as const;
  constructor(private readonly db: SQLiteDatabase) {
    if (!db) {
      throw new Error('[SessionSyncRepositoryAdapter] Database is required');
    }
  }
  async findById(id: string): Promise<Session | null> {
    try {
      const result = await this.db.getFirstAsync<SessionRow>(
        `SELECT * FROM sessions WHERE id = ?`,
        [id]
      );
      return result ? mapRowToSession(result) : null;
    } catch (error) {
      logger.error('[SessionSyncRepositoryAdapter] findById failed', {
        id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async create(session: Session, options?: CreateOptions): Promise<Session> {
    const syncStatus = options?.syncStatus ?? 'synced';
    const now = new Date().toISOString();
    try {
      await this.db.runAsync(
        `INSERT INTO sessions (
          id, userId, purchaseId, deviceId, clientSessionId, primaryProductId,
          sessionStartTimestamp, sessionEndTimestamp, hitCount, totalDurationMs,
          avgHitDurationMs, sessionTypeHeuristic, observationFeature,
          version, createdAt, updatedAt,
          sync_status, sync_version, status, client_id, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.userId,
          session.purchaseId ?? null,
          session.deviceId ?? null,
          session.clientSessionId ?? null,
          session.primaryProductId ?? null,
          session.sessionStartTimestamp,
          session.sessionEndTimestamp ?? null,
          session.hitCount ?? 0,
          session.totalDurationMs ?? 0,
          session.avgHitDurationMs ?? 0,
          session.sessionTypeHeuristic ?? null,
          session.observationFeature ?? null,
          session.version ?? 1,
          session.createdAt ?? now,
          session.updatedAt ?? now,
          syncStatus,
          session.syncVersion ?? 1,
          session.status ?? 'ACTIVE',
          session.clientId ?? null,
          session.notes ?? null,
        ]
      );
      logger.debug('[SessionSyncRepositoryAdapter] Created session', {
        id: session.id,
        syncStatus,
        status: session.status,
      });
      return session;
    } catch (error) {
      logger.error('[SessionSyncRepositoryAdapter] create failed', {
        id: session.id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async update(id: string, data: Partial<Session>): Promise<Session> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`[SessionSyncRepositoryAdapter] Session not found: ${id}`);
    }
    const updated: Session = {
      ...existing,
      ...data,
      updatedAt: data.updatedAt ?? new Date().toISOString(),
    };
    try {
      await this.db.runAsync(
        `UPDATE sessions SET
          purchaseId = ?,
          deviceId = ?,
          clientSessionId = ?,
          primaryProductId = ?,
          sessionStartTimestamp = ?,
          sessionEndTimestamp = ?,
          hitCount = ?,
          totalDurationMs = ?,
          avgHitDurationMs = ?,
          sessionTypeHeuristic = ?,
          observationFeature = ?,
          version = ?,
          updatedAt = ?,
          sync_status = ?,
          sync_version = ?,
          status = ?,
          client_id = ?,
          notes = ?
        WHERE id = ?`,
        [
          updated.purchaseId ?? null,
          updated.deviceId ?? null,
          updated.clientSessionId ?? null,
          updated.primaryProductId ?? null,
          updated.sessionStartTimestamp,
          updated.sessionEndTimestamp ?? null,
          updated.hitCount ?? 0,
          updated.totalDurationMs ?? 0,
          updated.avgHitDurationMs ?? 0,
          updated.sessionTypeHeuristic ?? null,
          updated.observationFeature ?? null,
          updated.version ?? 1,
          updated.updatedAt ?? new Date().toISOString(), 
          updated.syncStatus ?? 'synced',
          updated.syncVersion ?? 1,
          updated.status ?? 'ACTIVE',
          updated.clientId ?? null,
          updated.notes ?? null,
          id,
        ]
      );
      logger.debug('[SessionSyncRepositoryAdapter] Updated session', { id });
      return updated;
    } catch (error) {
      logger.error('[SessionSyncRepositoryAdapter] update failed', {
        id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async delete(id: string): Promise<Session | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }
    try {
      await this.db.runAsync(`DELETE FROM sessions WHERE id = ?`, [id]);
      logger.debug('[SessionSyncRepositoryAdapter] Deleted session', { id });
      return existing;
    } catch (error) {
      logger.error('[SessionSyncRepositoryAdapter] delete failed', {
        id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async markSynced(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`[SessionSyncRepositoryAdapter] Session not found: ${id}`);
    }
    try {
      await this.db.runAsync(
        `UPDATE sessions SET sync_status = ? WHERE id = ?`,
        ['synced', id]
      );
      logger.debug('[SessionSyncRepositoryAdapter] Marked session as synced', { id });
    } catch (error) {
      logger.error('[SessionSyncRepositoryAdapter] markSynced failed', {
        id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async markSyncError(id: string, error: string | Error): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : error;
    try {
      await this.db.runAsync(
        `UPDATE sessions SET sync_status = ? WHERE id = ?`,
        ['error', id]
      );
      logger.warn('[SessionSyncRepositoryAdapter] Sync error for session', {
        id,
        error: toLogError(error),
      });
    } catch (err) {
      logger.error('[SessionSyncRepositoryAdapter] markSyncError failed', {
        id,
        error: toLogError(err),
      });
      throw err;
    }
  }
}
export function createSessionSyncRepositoryAdapter(
  db: SQLiteDatabase
): SessionSyncRepositoryAdapter {
  return new SessionSyncRepositoryAdapter(db);
}
