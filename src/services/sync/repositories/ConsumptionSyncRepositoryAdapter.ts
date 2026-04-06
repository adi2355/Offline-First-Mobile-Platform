import { type SQLiteDatabase } from 'expo-sqlite';
import {
  type SyncEntityRepository,
  type SyncStatus,
  type CreateOptions,
} from './SyncEntityRepository';
import { logger, toLogError } from '../../../utils/logger';
export interface Consumption {
  id: string;
  userId: string;
  sessionId?: string | null;
  timestamp: string; 
  method?: string | null;
  durationMs?: number | null;
  quantity?: string | null; 
  unit?: string | null;
  estimatedThcMg?: string | null; 
  estimatedCbdMg?: string | null; 
  productId?: string | null; 
  deviceId?: string | null;
  batchId?: string | null;
  temperature?: number | null;
  waterLevel?: string | null;
  onsetTimeMinutes?: number | null;
  peakTimeMinutes?: number | null;
  durationMinutes?: number | null;
  intensity?: number | null;
  smoothness?: number | null;
  flavor?: number | null;
  effectiveness?: number | null;
  notes?: string | null;
  photoUrls?: string | null; 
  purchaseId?: string | null;
  isJournaled?: boolean;
  clientConsumptionId?: string | null;
  clientPurchaseId?: string | null;
  version?: number;
  syncVersion?: number;
  localId?: string | null;
  conflictResolution?: string | null;
  serverId?: string | null;
  data?: string | null; 
  createdAt?: string;
  updatedAt?: string;
}
interface ConsumptionRow {
  id: string;
  user_id: string;
  session_id: string | null;
  consumed_at: string; 
  method: string | null;
  duration_ms: number | null;
  quantity: string | null;
  unit: string | null;
  estimated_thc_mg: string | null;
  estimated_cbd_mg: string | null;
  strain_id: string | null; 
  device_id: string | null;
  batch_id: string | null;
  temperature: number | null;
  water_level: string | null;
  onset_time_minutes: number | null;
  peak_time_minutes: number | null;
  duration_minutes: number | null;
  intensity: number | null;
  smoothness: number | null;
  flavor: number | null;
  effectiveness: number | null;
  notes: string | null;
  photo_urls: string | null;
  purchase_id: string | null;
  is_journaled: number | null; 
  client_consumption_id: string | null;
  client_purchase_id: string | null;
  version: number | null;
  sync_version: number | null;
  local_id: string | null;
  conflict_resolution: string | null;
  server_id: string | null;
  data: string | null;
  created_at: string | null;
  updated_at: string | null;
}
function mapRowToConsumption(row: ConsumptionRow): Consumption {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    timestamp: row.consumed_at,
    method: row.method,
    durationMs: row.duration_ms,
    quantity: row.quantity,
    unit: row.unit,
    estimatedThcMg: row.estimated_thc_mg,
    estimatedCbdMg: row.estimated_cbd_mg,
    productId: row.strain_id,
    deviceId: row.device_id,
    batchId: row.batch_id,
    temperature: row.temperature,
    waterLevel: row.water_level,
    onsetTimeMinutes: row.onset_time_minutes,
    peakTimeMinutes: row.peak_time_minutes,
    durationMinutes: row.duration_minutes,
    intensity: row.intensity,
    smoothness: row.smoothness,
    flavor: row.flavor,
    effectiveness: row.effectiveness,
    notes: row.notes,
    photoUrls: row.photo_urls,
    purchaseId: row.purchase_id,
    isJournaled: row.is_journaled === 1,
    clientConsumptionId: row.client_consumption_id,
    clientPurchaseId: row.client_purchase_id,
    version: row.version ?? 1,
    syncVersion: row.sync_version ?? 1,
    localId: row.local_id,
    conflictResolution: row.conflict_resolution,
    serverId: row.server_id,
    data: row.data,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}
interface ConsumptionInput extends Partial<Consumption> {
  consumedAt?: string;
}
function normalizeConsumptionInput(input: ConsumptionInput): Consumption {
  return {
    id: input.id!,
    userId: input.userId!,
    sessionId: input.sessionId,
    timestamp: input.timestamp ?? input.consumedAt ?? new Date().toISOString(),
    method: input.method,
    durationMs: input.durationMs,
    quantity: input.quantity,
    unit: input.unit,
    estimatedThcMg: input.estimatedThcMg,
    estimatedCbdMg: input.estimatedCbdMg,
    productId: input.productId,
    deviceId: input.deviceId,
    batchId: input.batchId,
    temperature: input.temperature,
    waterLevel: input.waterLevel,
    onsetTimeMinutes: input.onsetTimeMinutes,
    peakTimeMinutes: input.peakTimeMinutes,
    durationMinutes: input.durationMinutes,
    intensity: input.intensity,
    smoothness: input.smoothness,
    flavor: input.flavor,
    effectiveness: input.effectiveness,
    notes: input.notes,
    photoUrls: input.photoUrls,
    purchaseId: input.purchaseId,
    isJournaled: input.isJournaled,
    clientConsumptionId: input.clientConsumptionId,
    clientPurchaseId: input.clientPurchaseId,
    version: input.version,
    syncVersion: input.syncVersion,
    localId: input.localId,
    conflictResolution: input.conflictResolution,
    serverId: input.serverId,
    data: input.data,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}
export class ConsumptionSyncRepositoryAdapter implements SyncEntityRepository<Consumption> {
  readonly entityType = 'consumptions' as const;
  constructor(private readonly db: SQLiteDatabase) {
    if (!db) {
      throw new Error('[ConsumptionSyncRepositoryAdapter] Database is required');
    }
  }
  async findById(id: string): Promise<Consumption | null> {
    try {
      const result = await this.db.getFirstAsync<ConsumptionRow>(
        `SELECT * FROM consumptions WHERE id = ? OR server_id = ?`,
        [id, id]
      );
      return result ? mapRowToConsumption(result) : null;
    } catch (error) {
      logger.error('[ConsumptionSyncRepositoryAdapter] findById failed', {
        id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async findByClientId(clientId: string): Promise<Consumption | null> {
    try {
      const result = await this.db.getFirstAsync<ConsumptionRow>(
        `SELECT * FROM consumptions WHERE id = ?`,
        [clientId]
      );
      return result ? mapRowToConsumption(result) : null;
    } catch (error) {
      logger.error('[ConsumptionSyncRepositoryAdapter] findByClientId failed', {
        clientId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async findByServerId(serverId: string): Promise<Consumption | null> {
    try {
      const result = await this.db.getFirstAsync<ConsumptionRow>(
        `SELECT * FROM consumptions WHERE server_id = ?`,
        [serverId]
      );
      return result ? mapRowToConsumption(result) : null;
    } catch (error) {
      logger.error('[ConsumptionSyncRepositoryAdapter] findByServerId failed', {
        serverId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async create(consumption: Consumption | ConsumptionInput, options?: CreateOptions): Promise<Consumption> {
    const syncStatus = options?.syncStatus ?? 'synced';
    const now = new Date().toISOString();
    const normalized = normalizeConsumptionInput(consumption as ConsumptionInput);
    try {
      await this.db.runAsync(
        `INSERT INTO consumptions (
          id, user_id, session_id, consumed_at, method, duration_ms,
          quantity, unit, estimated_thc_mg, estimated_cbd_mg,
          strain_id, device_id, batch_id, temperature, water_level,
          onset_time_minutes, peak_time_minutes, duration_minutes,
          intensity, smoothness, flavor, effectiveness, notes, photo_urls,
          purchase_id, is_journaled, client_consumption_id, client_purchase_id,
          version, sync_version, local_id, conflict_resolution, server_id, data,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normalized.id,
          normalized.userId,
          normalized.sessionId ?? null,
          normalized.timestamp,
          normalized.method ?? null,
          normalized.durationMs ?? null,
          normalized.quantity ?? null,
          normalized.unit ?? null,
          normalized.estimatedThcMg ?? null,
          normalized.estimatedCbdMg ?? null,
          normalized.productId ?? null, 
          normalized.deviceId ?? null,
          normalized.batchId ?? null,
          normalized.temperature ?? null,
          normalized.waterLevel ?? null,
          normalized.onsetTimeMinutes ?? null,
          normalized.peakTimeMinutes ?? null,
          normalized.durationMinutes ?? null,
          normalized.intensity ?? null,
          normalized.smoothness ?? null,
          normalized.flavor ?? null,
          normalized.effectiveness ?? null,
          normalized.notes ?? null,
          normalized.photoUrls ?? null,
          normalized.purchaseId ?? null,
          normalized.isJournaled ? 1 : 0,
          normalized.clientConsumptionId ?? null,
          normalized.clientPurchaseId ?? null,
          normalized.version ?? 1,
          normalized.syncVersion ?? 1,
          normalized.localId ?? null,
          normalized.conflictResolution ?? null,
          normalized.serverId ?? null,
          normalized.data ?? null,
          normalized.createdAt ?? now,
          normalized.updatedAt ?? now,
        ]
      );
      logger.debug('[ConsumptionSyncRepositoryAdapter] Created consumption', {
        id: normalized.id,
        serverId: normalized.serverId,
        syncStatus,
      });
      return normalized;
    } catch (error) {
      logger.error('[ConsumptionSyncRepositoryAdapter] create failed', {
        id: normalized.id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async update(id: string, data: Partial<Consumption> | Partial<ConsumptionInput>): Promise<Consumption> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`[ConsumptionSyncRepositoryAdapter] Consumption not found: ${id}`);
    }
    const inputData = data as Partial<ConsumptionInput>;
    const normalizedData: Partial<Consumption> = {
      ...data,
      timestamp: inputData.timestamp ?? inputData.consumedAt ?? existing.timestamp,
    };
    const updated: Consumption = {
      ...existing,
      ...normalizedData,
      updatedAt: normalizedData.updatedAt ?? new Date().toISOString(),
    };
    try {
      await this.db.runAsync(
        `UPDATE consumptions SET
          session_id = ?,
          consumed_at = ?,
          method = ?,
          duration_ms = ?,
          quantity = ?,
          unit = ?,
          estimated_thc_mg = ?,
          estimated_cbd_mg = ?,
          strain_id = ?,
          device_id = ?,
          batch_id = ?,
          temperature = ?,
          water_level = ?,
          onset_time_minutes = ?,
          peak_time_minutes = ?,
          duration_minutes = ?,
          intensity = ?,
          smoothness = ?,
          flavor = ?,
          effectiveness = ?,
          notes = ?,
          photo_urls = ?,
          purchase_id = ?,
          is_journaled = ?,
          client_consumption_id = ?,
          client_purchase_id = ?,
          version = ?,
          sync_version = ?,
          local_id = ?,
          conflict_resolution = ?,
          server_id = ?,
          data = ?,
          updated_at = ?
        WHERE id = ?`,
        [
          updated.sessionId ?? null,
          updated.timestamp,
          updated.method ?? null,
          updated.durationMs ?? null,
          updated.quantity ?? null,
          updated.unit ?? null,
          updated.estimatedThcMg ?? null,
          updated.estimatedCbdMg ?? null,
          updated.productId ?? null,
          updated.deviceId ?? null,
          updated.batchId ?? null,
          updated.temperature ?? null,
          updated.waterLevel ?? null,
          updated.onsetTimeMinutes ?? null,
          updated.peakTimeMinutes ?? null,
          updated.durationMinutes ?? null,
          updated.intensity ?? null,
          updated.smoothness ?? null,
          updated.flavor ?? null,
          updated.effectiveness ?? null,
          updated.notes ?? null,
          updated.photoUrls ?? null,
          updated.purchaseId ?? null,
          updated.isJournaled ? 1 : 0,
          updated.clientConsumptionId ?? null,
          updated.clientPurchaseId ?? null,
          updated.version ?? 1,
          updated.syncVersion ?? 1,
          updated.localId ?? null,
          updated.conflictResolution ?? null,
          updated.serverId ?? null,
          updated.data ?? null,
          updated.updatedAt ?? new Date().toISOString(), 
          existing.id, 
        ]
      );
      logger.debug('[ConsumptionSyncRepositoryAdapter] Updated consumption', {
        id: existing.id,
        serverId: updated.serverId,
      });
      return updated;
    } catch (error) {
      logger.error('[ConsumptionSyncRepositoryAdapter] update failed', {
        id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async updateServerId(clientId: string, serverId: string): Promise<void> {
    try {
      await this.db.runAsync(
        `UPDATE consumptions SET server_id = ?, updated_at = ? WHERE id = ?`,
        [serverId, new Date().toISOString(), clientId]
      );
      logger.debug('[ConsumptionSyncRepositoryAdapter] Updated server_id', {
        clientId,
        serverId,
      });
    } catch (error) {
      logger.error('[ConsumptionSyncRepositoryAdapter] updateServerId failed', {
        clientId,
        serverId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async delete(id: string): Promise<Consumption | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }
    try {
      await this.db.runAsync(`DELETE FROM consumptions WHERE id = ?`, [existing.id]);
      logger.debug('[ConsumptionSyncRepositoryAdapter] Deleted consumption', {
        id: existing.id,
        serverId: existing.serverId,
      });
      return existing;
    } catch (error) {
      logger.error('[ConsumptionSyncRepositoryAdapter] delete failed', {
        id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async markSynced(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`[ConsumptionSyncRepositoryAdapter] Consumption not found: ${id}`);
    }
    try {
      const now = new Date().toISOString();
      const lastModified = Date.now();
      const syncId = `consumptions-${existing.id}`;
      await this.db.runAsync(
        `INSERT INTO sync_metadata (
          id, table_name, local_id, sync_status, last_modified, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sync_status = excluded.sync_status,
          last_modified = excluded.last_modified,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at`,
        [syncId, 'consumptions', existing.id, 'synced', lastModified, null, now, now]
      );
      logger.debug('[ConsumptionSyncRepositoryAdapter] Marked consumption as synced', {
        id: existing.id,
        serverId: existing.serverId,
      });
    } catch (error) {
      logger.error('[ConsumptionSyncRepositoryAdapter] markSynced failed', {
        id,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async markSyncError(id: string, error: string | Error): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : error;
    try {
      const existing = await this.findById(id);
      const entityId = existing?.id ?? id;
      const now = new Date().toISOString();
      const lastModified = Date.now();
      const syncId = `consumptions-${entityId}`;
      await this.db.runAsync(
        `INSERT INTO sync_metadata (
          id, table_name, local_id, sync_status, last_modified, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sync_status = excluded.sync_status,
          last_modified = excluded.last_modified,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at`,
        [syncId, 'consumptions', entityId, 'error', lastModified, errorMessage, now, now]
      );
      logger.warn('[ConsumptionSyncRepositoryAdapter] Marked consumption with sync error', {
        id: entityId,
        error: toLogError(error),
      });
    } catch (dbError) {
      logger.error('[ConsumptionSyncRepositoryAdapter] markSyncError failed', {
        id,
        originalError: errorMessage,
        dbError: toLogError(dbError),
      });
    }
  }
}
export function createConsumptionSyncRepositoryAdapter(
  db: SQLiteDatabase
): ConsumptionSyncRepositoryAdapter {
  return new ConsumptionSyncRepositoryAdapter(db);
}
