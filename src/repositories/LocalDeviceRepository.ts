import { eq, and, isNull, or, lt, sql } from 'drizzle-orm';
import { BaseRepository, BaseRepositoryOptions } from './BaseRepository';
import { devices, DbDevice, DbDeviceInsert } from '../db/schema';
import { Device, DeviceStatus, DeviceType } from '../types';
import type { DrizzleDB, DrizzleTransactionClient } from '../db/client';
import { logger } from '../utils/logger';
import {
  mapDbDeviceToDevice,
  mapDeviceToDb,
  isValidDeviceType,
  isValidDeviceStatus,
} from '../db/mappers';
function formatError(error: unknown): { name: string; message: string; stack?: string } {
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
export class LocalDeviceRepository extends BaseRepository {
  constructor(options: BaseRepositoryOptions) {
    super(options);
  }
  async getAll(): Promise<Device[]> {
    try {
      const db = this.getDrizzle();
      const rows = await db
        .select()
        .from(devices)
        .where(isNull(devices.deletedAt))
        .orderBy(sql`${devices.createdAt} DESC`);
      return rows.map((row) => this.mapRowToDevice(row));
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to get all devices', { error: formatError(error) });
      return [];
    }
  }
  async getAllByUserId(userId: string): Promise<Device[]> {
    try {
      const db = this.getDrizzle();
      const rows = await db
        .select()
        .from(devices)
        .where(and(eq(devices.userId, userId), isNull(devices.deletedAt)))
        .orderBy(sql`${devices.createdAt} DESC`);
      return rows.map((row) => this.mapRowToDevice(row));
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to get devices by user', { userId, error: formatError(error) });
      return [];
    }
  }
  async getById(id: string): Promise<Device | null> {
    try {
      const db = this.getDrizzle();
      const rows = await db
        .select()
        .from(devices)
        .where(eq(devices.id, id))
        .limit(1);
      const row = rows[0];
      return row ? this.mapRowToDevice(row) : null;
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to get device by ID', { id, error: formatError(error) });
      return null;
    }
  }
  async getByServerId(serverId: string): Promise<Device | null> {
    try {
      const db = this.getDrizzle();
      const rows = await db
        .select()
        .from(devices)
        .where(eq(devices.serverId, serverId))
        .limit(1);
      const row = rows[0];
      return row ? this.mapRowToDevice(row) : null;
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to get device by server ID', {
        serverId,
        error: formatError(error),
      });
      return null;
    }
  }
  async findByMacOrSerial(
    mac?: string | null,
    serial?: string | null
  ): Promise<Device | null> {
    if (!mac && !serial) return null;
    try {
      const db = this.getDrizzle();
      const conditions: ReturnType<typeof eq>[] = [isNull(devices.deletedAt)];
      const orConditions: ReturnType<typeof eq>[] = [];
      if (mac) {
        orConditions.push(eq(devices.macAddress, mac));
      }
      if (serial) {
        orConditions.push(eq(devices.serialNumber, serial));
      }
      const rows = await db
        .select()
        .from(devices)
        .where(
          and(
            isNull(devices.deletedAt),
            orConditions.length > 1 ? or(...orConditions) : orConditions[0]
          )
        )
        .limit(1);
      const row = rows[0];
      return row ? this.mapRowToDevice(row) : null;
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to find device by MAC/serial', {
        mac,
        serial,
        error: formatError(error),
      });
      return null;
    }
  }
  async findByBluetoothId(bluetoothId: string): Promise<Device | null> {
    try {
      const db = this.getDrizzle();
      const rows = await db
        .select()
        .from(devices)
        .where(and(eq(devices.bluetoothId, bluetoothId), isNull(devices.deletedAt)))
        .limit(1);
      const row = rows[0];
      return row ? this.mapRowToDevice(row) : null;
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to find device by Bluetooth ID', {
        bluetoothId,
        error: formatError(error),
      });
      return null;
    }
  }
  async findByMacAddress(macAddress: string): Promise<Device | null> {
    if (!macAddress) return null;
    try {
      const db = this.getDrizzle();
      const rows = await db
        .select()
        .from(devices)
        .where(and(eq(devices.macAddress, macAddress), isNull(devices.deletedAt)))
        .limit(1);
      const row = rows[0];
      if (row) {
        logger.debug('[LocalDeviceRepository] Found device by MAC address', {
          macAddress,
          deviceId: row.id,
        });
      }
      return row ? this.mapRowToDevice(row) : null;
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to find device by MAC address', {
        macAddress,
        error: formatError(error),
      });
      return null;
    }
  }
  async updateBluetoothId(id: string, newBluetoothId: string, tx?: DrizzleTransactionClient): Promise<void> {
    try {
      const db = tx ?? this.getDrizzle();
      await db
        .update(devices)
        .set({
          bluetoothId: newBluetoothId,
          updatedAt: new Date().toISOString(),
          version: sql`${devices.version} + 1`,
        })
        .where(eq(devices.id, id));
      logger.info('[LocalDeviceRepository] EC-DEVICE-ID-001: Updated Bluetooth ID', {
        deviceId: id,
        newBluetoothId,
      });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to update Bluetooth ID', {
        deviceId: id,
        newBluetoothId,
        error: formatError(error),
      });
      throw error;
    }
  }
  async updateMacAddress(id: string, newMacAddress: string, tx?: DrizzleTransactionClient): Promise<void> {
    try {
      const db = tx ?? this.getDrizzle();
      await db
        .update(devices)
        .set({
          macAddress: newMacAddress,
          updatedAt: new Date().toISOString(),
          version: sql`${devices.version} + 1`,
        })
        .where(eq(devices.id, id));
      logger.info('[LocalDeviceRepository] EC-DEVICE-ID-001: Updated MAC address', {
        deviceId: id,
        newMacAddress,
      });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to update MAC address', {
        deviceId: id,
        newMacAddress,
        error: formatError(error),
      });
      throw error;
    }
  }
  async updateFirmwareVersion(id: string, firmwareVersion: string, tx?: DrizzleTransactionClient): Promise<void> {
    try {
      const db = tx ?? this.getDrizzle();
      await db
        .update(devices)
        .set({
          firmwareVersion,
          updatedAt: new Date().toISOString(),
          version: sql`${devices.version} + 1`,
        })
        .where(eq(devices.id, id));
      logger.debug('[LocalDeviceRepository] Updated firmware version', {
        deviceId: id,
        firmwareVersion,
      });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to update firmware version', {
        deviceId: id,
        firmwareVersion,
        error: formatError(error),
      });
      throw error;
    }
  }
  async findByBluetoothIdIncludingDeleted(bluetoothId: string): Promise<Device | null> {
    try {
      const db = this.getDrizzle();
      const rows = await db
        .select()
        .from(devices)
        .where(eq(devices.bluetoothId, bluetoothId))
        .limit(1);
      const row = rows[0];
      return row ? this.mapRowToDevice(row) : null;
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to find device by Bluetooth ID (including deleted)', {
        bluetoothId,
        error: formatError(error),
      });
      return null;
    }
  }
  async hasBeenSynced(id: string): Promise<boolean> {
    try {
      const db = this.getDrizzle();
      const rows = await db
        .select({ serverId: devices.serverId })
        .from(devices)
        .where(eq(devices.id, id))
        .limit(1);
      const row = rows[0];
      return row?.serverId != null && row.serverId !== '';
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to check if device has been synced', {
        id,
        error: formatError(error),
      });
      return false;
    }
  }
  async getPendingSync(): Promise<Device[]> {
    try {
      const db = this.getDrizzle();
      const rows = await db
        .select()
        .from(devices)
        .where(eq(devices.syncStatus, 'pending'))
        .orderBy(sql`${devices.updatedAt} ASC`);
      return rows.map((row) => this.mapRowToDevice(row));
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to get pending sync devices', { error: formatError(error) });
      return [];
    }
  }
  async create(device: Device, tx?: DrizzleTransactionClient): Promise<void> {
    const now = new Date().toISOString();
    const dataJson = JSON.stringify(device);
    try {
      const db = tx ?? this.getDrizzle();
      const insertData: DbDeviceInsert = {
        id: device.id,
        userId: device.userId,
        deviceName: device.deviceName,
        type: device.type || DeviceType.OTHER,
        status: device.status || DeviceStatus.ACTIVE,
        macAddress: device.macAddress ?? null,
        bluetoothId: device.bluetoothId ?? null,
        serialNumber: device.serialNumber ?? null,
        firmwareVersion: device.firmwareVersion ?? null,
        hardwareVersion: device.hardwareVersion ?? null,
        brand: device.brand ?? null,
        model: device.model ?? null,
        isActive: device.isActive ?? true,
        lastSeen: device.lastSeen ?? null,
        batteryLevel: device.batteryLevel ?? null,
        requiresCalibration: device.requiresCalibration ?? false,
        lastCalibrated: device.lastCalibrated ?? null,
        calibrationData: device.calibrationData ? JSON.stringify(device.calibrationData) : null,
        settings: device.settings ? JSON.stringify(device.settings) : '{}',
        specifications: device.specifications ? JSON.stringify(device.specifications) : null,
        pairedAt: device.pairedAt ?? null,
        createdAt: device.createdAt || now,
        updatedAt: device.updatedAt || now,
        data: dataJson,
        syncStatus: 'pending',
        version: 1,
        deletedAt: null,
      };
      await db
        .insert(devices)
        .values(insertData)
        .onConflictDoUpdate({
          target: devices.id,
          set: {
            ...insertData,
            updatedAt: now,
          },
        });
      logger.debug('[LocalDeviceRepository] Device created', { id: device.id });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to create device', { id: device.id, error: formatError(error) });
      throw error; 
    }
  }
  async updateTelemetry(
    id: string,
    telemetry: {
      batteryLevel?: number;
      lastSeen?: string;
      status?: DeviceStatus;
      isActive?: boolean;
    }
  ): Promise<void> {
    const now = new Date().toISOString();
    try {
      const db = this.getDrizzle();
      const existing = await this.getById(id);
      if (!existing) return;
      const updates: any = {
        updatedAt: now,
      };
      if (telemetry.batteryLevel !== undefined) updates.batteryLevel = telemetry.batteryLevel;
      if (telemetry.lastSeen !== undefined) updates.lastSeen = telemetry.lastSeen;
      if (telemetry.status !== undefined) updates.status = telemetry.status;
      if (telemetry.isActive !== undefined) updates.isActive = telemetry.isActive;
      const updatedData = JSON.stringify({ ...existing, ...updates });
      updates.data = updatedData;
      await db
        .update(devices)
        .set(updates)
        .where(eq(devices.id, id));
      logger.debug('[LocalDeviceRepository] Telemetry updated', { id, fields: Object.keys(telemetry) });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to update telemetry', { id, error: formatError(error) });
    }
  }
  async update(device: Device, tx?: DrizzleTransactionClient): Promise<void> {
    const now = new Date().toISOString();
    const dataJson = JSON.stringify({ ...device, updatedAt: now });
    try {
      const db = tx ?? this.getDrizzle();
      await db
        .update(devices)
        .set({
          deviceName: device.deviceName,
          type: device.type || DeviceType.OTHER,
          status: device.status || DeviceStatus.ACTIVE,
          firmwareVersion: device.firmwareVersion ?? null,
          lastSeen: device.lastSeen ?? null,
          batteryLevel: device.batteryLevel ?? null,
          settings: device.settings ? JSON.stringify(device.settings) : null,
          specifications: device.specifications ? JSON.stringify(device.specifications) : null,
          brand: device.brand ?? null,
          isActive: device.isActive ?? true,
          updatedAt: now,
          data: dataJson,
          syncStatus: 'pending',
          syncError: null,
          version: sql`${devices.version} + 1`,
          deletedAt: device.deletedAt ?? null,
        })
        .where(eq(devices.id, device.id));
      logger.debug('[LocalDeviceRepository] Device updated', { id: device.id });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to update device', { id: device.id, error: formatError(error) });
      throw error;
    }
  }
  async softDelete(id: string, tx?: DrizzleTransactionClient): Promise<void> {
    const now = new Date().toISOString();
    try {
      const db = tx ?? this.getDrizzle();
      await db
        .update(devices)
        .set({
          deletedAt: now,
          status: DeviceStatus.DECOMMISSIONED,
          isActive: false,
          syncStatus: 'pending',
          updatedAt: now,
          version: sql`${devices.version} + 1`,
        })
        .where(eq(devices.id, id));
      logger.info('[LocalDeviceRepository] Device soft deleted', { id });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to soft delete device', { id, error: formatError(error) });
      throw error;
    }
  }
  async deleteStalePairingRecords(thresholdDate: string): Promise<number> {
    try {
      const db = this.getDrizzle();
      const result = await db
        .delete(devices)
        .where(
          and(
            or(
              eq(devices.status, 'PAIRING'),
              and(eq(devices.status, 'UNPAIRED'), eq(devices.isActive, false))
            ),
            lt(devices.createdAt, thresholdDate)
          )
        );
      const deletedCount = (result as unknown as { changes?: number }).changes || 0;
      if (deletedCount > 0) {
        logger.info('[LocalDeviceRepository] Cleaned up stale pairing records', {
          deletedCount,
          threshold: thresholdDate,
        });
      }
      return deletedCount;
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to delete stale pairing records', { error: formatError(error) });
      return 0; 
    }
  }
  async updateSyncStatus(
    id: string,
    status: 'synced' | 'pending' | 'error',
    serverId?: string
  ): Promise<void> {
    try {
      const db = this.getDrizzle();
      const now = new Date().toISOString();
      const updateData: Partial<DbDeviceInsert> = {
        syncStatus: status,
        lastSyncedAt: status === 'synced' ? now : null,
        syncError: null,
      };
      if (serverId) {
        updateData.serverId = serverId;
      }
      await db.update(devices).set(updateData).where(eq(devices.id, id));
      logger.debug('[LocalDeviceRepository] Sync status updated', { id, status, serverId });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to update sync status', { id, status, error: formatError(error) });
      throw error;
    }
  }
  async markForResync(id: string, reason?: string): Promise<void> {
    try {
      const db = this.getDrizzle();
      const now = new Date().toISOString();
      await db
        .update(devices)
        .set({
          serverId: null,
          syncStatus: 'pending',
          syncError: reason ?? null,
          lastSyncedAt: null,
          updatedAt: now,
        })
        .where(eq(devices.id, id));
      logger.warn('[LocalDeviceRepository] Device marked for resync', { id, reason });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to mark device for resync', {
        id,
        reason,
        error: formatError(error),
      });
      throw error;
    }
  }
  async markAsSyncError(id: string, errorMessage: string): Promise<void> {
    try {
      const db = this.getDrizzle();
      const now = new Date().toISOString();
      await db
        .update(devices)
        .set({
          status: DeviceStatus.ERROR,
          syncStatus: 'error',
          syncError: errorMessage,
          updatedAt: now,
        })
        .where(eq(devices.id, id));
      logger.warn('[LocalDeviceRepository] Device marked as sync error', { id, errorMessage });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to mark device as sync error', { id, error: formatError(error) });
      throw error;
    }
  }
  async upsertFromServer(device: Device, serverId: string): Promise<void> {
    const now = new Date().toISOString();
    const dataJson = JSON.stringify(device);
    try {
      const db = this.getDrizzle();
      let existing = await this.getByServerId(serverId);
      if (!existing && device.macAddress) {
        existing = await this.findByMacAddress(device.macAddress);
      }
      if (!existing && device.bluetoothId) {
        existing = await this.findByBluetoothIdIncludingDeleted(device.bluetoothId);
      }
      if (existing) {
        await db
          .update(devices)
          .set({
            deviceName: device.deviceName,
            type: device.type,
            status: device.status,
            firmwareVersion: device.firmwareVersion ?? null,
            lastSeen: device.lastSeen ?? null,
            batteryLevel: device.batteryLevel ?? null,
            settings: device.settings ? JSON.stringify(device.settings) : null,
            specifications: device.specifications ? JSON.stringify(device.specifications) : null,
            brand: device.brand ?? null,
            isActive: device.isActive ?? true,
            updatedAt: now,
            data: dataJson,
            syncStatus: 'synced',
            lastSyncedAt: now,
            version: device.version || 1,
            serverId: serverId,
            deletedAt: device.deletedAt ?? null, 
          })
          .where(eq(devices.id, existing.id));
      } else {
        const insertData: DbDeviceInsert = {
          id: device.id,
          userId: device.userId,
          deviceName: device.deviceName,
          type: device.type,
          status: device.status,
          macAddress: device.macAddress ?? null,
          bluetoothId: device.bluetoothId ?? null,
          serialNumber: device.serialNumber ?? null,
          firmwareVersion: device.firmwareVersion ?? null,
          hardwareVersion: device.hardwareVersion ?? null,
          brand: device.brand ?? null,
          model: device.model ?? null,
          isActive: device.isActive ?? true,
          lastSeen: device.lastSeen ?? null,
          batteryLevel: device.batteryLevel ?? null,
          requiresCalibration: device.requiresCalibration ?? false,
          settings: device.settings ? JSON.stringify(device.settings) : null,
          specifications: device.specifications ? JSON.stringify(device.specifications) : null,
          pairedAt: device.pairedAt ?? null,
          createdAt: device.createdAt || now,
          updatedAt: now,
          serverId: serverId,
          data: dataJson,
          syncStatus: 'synced',
          lastSyncedAt: now,
          version: device.version || 1,
        };
        await db.insert(devices).values(insertData);
      }
      logger.debug('[LocalDeviceRepository] Device upserted from server', { id: device.id, serverId });
    } catch (error) {
      logger.error('[LocalDeviceRepository] Failed to upsert device from server', {
        id: device.id,
        serverId,
        error: formatError(error),
      });
      throw error;
    }
  }
  private mapRowToDevice(row: DbDevice): Device {
    if (row.data) {
      try {
        const parsed = JSON.parse(row.data) as Device;
        return {
          ...parsed,
          id: row.id,
          version: row.version ?? parsed.version ?? 1,
          firmwareVersion: row.firmwareVersion ?? parsed.firmwareVersion ?? null,
          bluetoothId: row.bluetoothId ?? parsed.bluetoothId ?? null,
          macAddress: row.macAddress ?? parsed.macAddress ?? null,
          status: (row.status as DeviceStatus) ?? parsed.status ?? DeviceStatus.ACTIVE,
          batteryLevel: row.batteryLevel ?? parsed.batteryLevel ?? null,
          lastSeen: row.lastSeen ?? parsed.lastSeen ?? null,
          isActive: row.isActive ?? parsed.isActive ?? true,
        };
      } catch (e) {
        logger.warn('[LocalDeviceRepository] JSON parse error, falling back to column mapping', {
          id: row.id,
        });
      }
    }
    return mapDbDeviceToDevice(row);
  }
}
