import { FrontendSyncEntityHandler } from './FrontendSyncEntityHandler';
import { Device, DeviceStatus, DeviceType } from '../../../types';
import { logger } from '../../../utils/logger';
import { DatabaseManager } from '../../../DatabaseManager';
import { LocalDeviceRepository } from '../../../repositories/LocalDeviceRepository';
interface ServerDeviceData {
  id: string;
  userId: string;
  deviceName: string;
  type: string;
  status: string;
  macAddress?: string | null;
  bluetoothId?: string | null;
  serialNumber?: string | null;
  brand?: string | null;
  model?: string | null;
  firmwareVersion?: string | null;
  hardwareVersion?: string | null;
  isActive?: boolean;
  lastSeen?: string | null;
  batteryLevel?: number | null;
  requiresCalibration?: boolean;
  lastCalibrated?: string | null;
  settings?: Record<string, unknown> | null;
  specifications?: Record<string, unknown> | null;
  pairedAt?: string | null;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}
export class DeviceSyncHandler implements FrontendSyncEntityHandler<Device> {
  readonly entityType = 'devices' as const;
  private db: DatabaseManager | null = null;
  private localRepo: LocalDeviceRepository | null = null;
  setDatabaseManager(databaseManager: DatabaseManager): void {
    this.db = databaseManager;
    logger.debug('[DeviceSyncHandler] DatabaseManager set for ID replacement operations');
  }
  setLocalRepository(repo: LocalDeviceRepository): void {
    this.localRepo = repo;
    logger.debug('[DeviceSyncHandler] Local repository set for pull sync operations');
  }
  async handleIdReplacement(clientId: string, serverId: string): Promise<void> {
    if (!this.db) {
      logger.warn('[DeviceSyncHandler] No DatabaseManager set, skipping handleIdReplacement', {
        clientId,
        serverId,
        hint: 'Call setDatabaseManager() from AppProvider during initialization',
      });
      return;
    }
    try {
      const database = await this.db.getDatabase('DeviceEvents');
      await database.runAsync(
        `UPDATE devices SET server_id = ? WHERE id = ?`,
        [serverId, clientId],
      );
      if (clientId === serverId) {
        logger.debug('[DeviceSyncHandler] server_id linked (clientId === serverId)', {
          clientId,
          serverId,
        });
        return;
      }
      await database.runAsync(
        `UPDATE devices SET id = ?, server_id = ? WHERE id = ?`,
        [serverId, serverId, clientId],
      );
      await database.runAsync(
        `UPDATE consumptions SET device_id = ? WHERE device_id = ?`,
        [serverId, clientId],
      );
      await database.runAsync(
        `UPDATE sessions SET deviceId = ? WHERE deviceId = ?`,
        [serverId, clientId],
      );
      await database.runAsync(
        `UPDATE device_telemetry SET device_id = ? WHERE device_id = ?`,
        [serverId, clientId],
      );
      logger.info('[DeviceSyncHandler] ID replacement cascade completed', {
        clientId,
        serverId,
      });
    } catch (error) {
      logger.error('[DeviceSyncHandler] handleIdReplacement failed (non-fatal)', {
        clientId,
        serverId,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError', message: String(error) },
      });
    }
  }
  async handlePullCreate(
    userId: string,
    entityId: string,
    changeData: ServerDeviceData
  ): Promise<Device> {
    if (!this.localRepo) {
      logger.warn('[DeviceSyncHandler] No local repository set, skipping pull create');
      return this.mapServerDataToDevice(entityId, userId, changeData);
    }
    const device = this.mapServerDataToDevice(entityId, userId, changeData);
    try {
      let existing = await this.localRepo.getById(entityId) || await this.localRepo.getByServerId(entityId);
      if (!existing && device.macAddress) {
        existing = await this.localRepo.findByMacAddress(device.macAddress);
      }
      if (!existing && device.bluetoothId) {
        existing = await this.localRepo.findByBluetoothIdIncludingDeleted(device.bluetoothId);
      }
      if (existing) {
        logger.debug('[DeviceSyncHandler] Found existing device via identity markers, reconciling IDs', {
          entityId,
          existingId: existing.id,
          bluetoothId: existing.bluetoothId,
        });
        if (existing.id !== entityId) {
          await this.handleIdReplacement(existing.id, entityId);
        }
        return this.handlePullUpdate(userId, entityId, changeData);
      }
      await this.localRepo.upsertFromServer(device, entityId);
      logger.info('[DeviceSyncHandler] Created device from server', { entityId, userId });
      return device;
    } catch (error) {
      logger.error('[DeviceSyncHandler] Failed to create device from server', {
        entityId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async handlePullUpdate(
    userId: string,
    entityId: string,
    changeData: ServerDeviceData
  ): Promise<Device> {
    if (!this.localRepo) {
      logger.warn('[DeviceSyncHandler] No local repository set, skipping pull update');
      return this.mapServerDataToDevice(entityId, userId, changeData);
    }
    const serverDevice = this.mapServerDataToDevice(entityId, userId, changeData);
    try {
      let localDevice = await this.localRepo.getById(entityId) || await this.localRepo.getByServerId(entityId);
      if (!localDevice && serverDevice.macAddress) {
        localDevice = await this.localRepo.findByMacAddress(serverDevice.macAddress);
      }
      if (!localDevice && serverDevice.bluetoothId) {
        localDevice = await this.localRepo.findByBluetoothIdIncludingDeleted(serverDevice.bluetoothId);
      }
      if (!localDevice) {
        logger.debug('[DeviceSyncHandler] Device not found for update, creating instead', { entityId });
        return this.handlePullCreate(userId, entityId, changeData);
      }
      if (localDevice.id !== entityId) {
        await this.handleIdReplacement(localDevice.id, entityId);
        localDevice = await this.localRepo.getById(entityId) || localDevice;
      }
      const merged = this.merge(localDevice, serverDevice);
      await this.localRepo.upsertFromServer(merged, entityId);
      if (merged.status !== serverDevice.status && (merged.version ?? 0) > (serverDevice.version ?? 0)) {
        logger.info('[DeviceSyncHandler] Re-queueing local status override for push', {
          entityId,
          localStatus: merged.status,
          serverStatus: serverDevice.status,
        });
        await this.localRepo.updateSyncStatus(entityId, 'pending');
      }
      logger.info('[DeviceSyncHandler] Updated device from server', { entityId, userId });
      return merged;
    } catch (error) {
      logger.error('[DeviceSyncHandler] Failed to update device from server', {
        entityId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async handlePullDelete(
    userId: string,
    entityId: string
  ): Promise<Device | null> {
    if (!this.localRepo) {
      logger.warn('[DeviceSyncHandler] No local repository set, skipping pull delete');
      return null;
    }
    try {
      const device = await this.localRepo.getById(entityId) || await this.localRepo.getByServerId(entityId);
      if (!device) {
        logger.debug('[DeviceSyncHandler] Device not found for deletion', { entityId });
        return null;
      }
      await this.localRepo.softDelete(device.id);
      logger.info('[DeviceSyncHandler] Soft deleted device from server', { entityId, userId });
      return device;
    } catch (error) {
      logger.error('[DeviceSyncHandler] Failed to delete device', {
        entityId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  merge(localData: Device, serverData: Device): Device {
    logger.debug('[DeviceSyncHandler] Merging device data', {
      localId: localData.id,
      serverId: serverData.id,
      localVersion: localData.version,
      serverVersion: serverData.version,
      localStatus: localData.status,
      serverStatus: serverData.status,
    });
    const localUpdatedTime = localData.updatedAt
      ? new Date(localData.updatedAt).getTime()
      : 0;
    const serverUpdatedTime = serverData.updatedAt
      ? new Date(serverData.updatedAt).getTime()
      : 0;
    const localLastSeenTime = localData.lastSeen
      ? new Date(localData.lastSeen).getTime()
      : 0;
    const merged: Device = { ...serverData };
    merged.id = serverData.id;
    merged.userId = serverData.userId;
    merged.serialNumber = serverData.serialNumber;
    merged.macAddress = serverData.macAddress;
    merged.createdAt = serverData.createdAt;
    if (
      serverData.status === DeviceStatus.DECOMMISSIONED ||
      serverData.status === DeviceStatus.ERROR
    ) {
      merged.status = serverData.status;
      logger.debug('[DeviceSyncHandler] Server status takes precedence (destructive)', {
        serverStatus: serverData.status,
      });
    } else if (localUpdatedTime > serverUpdatedTime) {
      merged.status = localData.status;
    }
    if (localLastSeenTime > serverUpdatedTime) {
      if (localData.firmwareVersion) {
        merged.firmwareVersion = localData.firmwareVersion;
        logger.debug('[DeviceSyncHandler] Preserving local firmware version (EC-DEV-003)', {
          localFirmware: localData.firmwareVersion,
          serverFirmware: serverData.firmwareVersion,
        });
      }
      if (localData.hardwareVersion) {
        merged.hardwareVersion = localData.hardwareVersion;
      }
    }
    if (localUpdatedTime > serverUpdatedTime) {
      if (localData.lastSeen) {
        merged.lastSeen = localData.lastSeen;
      }
      if (localData.batteryLevel !== null && localData.batteryLevel !== undefined) {
        merged.batteryLevel = localData.batteryLevel;
      }
      logger.debug('[DeviceSyncHandler] Preserving local ephemeral data (EC-DEV-008)', {
        localLastSeen: localData.lastSeen,
        localBattery: localData.batteryLevel,
      });
    }
    if (localUpdatedTime > serverUpdatedTime) {
      if (localData.deviceName && localData.deviceName !== serverData.deviceName) {
        merged.deviceName = localData.deviceName;
        logger.debug('[DeviceSyncHandler] Preserving local device name', {
          localName: localData.deviceName,
          serverName: serverData.deviceName,
        });
      }
      if (localData.settings) {
        merged.settings = localData.settings;
      }
    }
    const localCalibratedTime = localData.lastCalibrated
      ? new Date(localData.lastCalibrated).getTime()
      : 0;
    const serverCalibratedTime = serverData.lastCalibrated
      ? new Date(serverData.lastCalibrated).getTime()
      : 0;
    if (localCalibratedTime > serverCalibratedTime && localData.calibrationData) {
      merged.calibrationData = localData.calibrationData;
      merged.lastCalibrated = localData.lastCalibrated;
      merged.requiresCalibration = localData.requiresCalibration;
    }
    merged.version = Math.max(localData.version || 0, serverData.version || 0) + 1;
    merged.updatedAt = new Date().toISOString();
    logger.debug('[DeviceSyncHandler] Merge complete', {
      mergedId: merged.id,
      mergedVersion: merged.version,
      mergedStatus: merged.status,
      mergedName: merged.deviceName,
    });
    return merged;
  }
  async handleConflict(
    userId: string,
    entityId: string,
    localData: Partial<Device>,
    serverData?: Device
  ): Promise<Device | null> {
    if (!this.localRepo || !this.db) return null;
    try {
      logger.info('[DeviceSyncHandler] Handling device conflict', { 
        entityId,
        hasServerData: !!serverData 
      });
      if (serverData) {
        const localDevice = await this.localRepo.getById(entityId) || await this.localRepo.getByServerId(entityId);
        if (!localDevice) return null;
        const merged = this.merge(localDevice, serverData);
        await this.localRepo.upsertFromServer(merged, entityId);
        logger.info('[DeviceSyncHandler] Proactively resolved device conflict via serverData', { entityId });
        return merged;
      }
      return null;
    } catch (error: unknown) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.warn('[DeviceSyncHandler] Conflict resolution failed', {
        entityId,
        error: { name: errorObj.name, message: errorObj.message }
      });
      return null;
    }
  }
  private mapServerDataToDevice(id: string, userId: string, data: ServerDeviceData): Device {
    const now = new Date().toISOString();
    return {
      id,
      userId: data.userId || userId,
      deviceName: data.deviceName || 'Unknown Device',
      type: (data.type as DeviceType) || DeviceType.OTHER,
      status: (data.status as DeviceStatus) || DeviceStatus.ACTIVE,
      macAddress: data.macAddress || null,
      bluetoothId: data.bluetoothId || null,
      serialNumber: data.serialNumber || null,
      brand: data.brand || null,
      model: data.model || null,
      firmwareVersion: data.firmwareVersion || null,
      hardwareVersion: data.hardwareVersion || null,
      isActive: data.isActive ?? true,
      lastSeen: data.lastSeen || null,
      batteryLevel: data.batteryLevel ?? null,
      requiresCalibration: data.requiresCalibration ?? false,
      lastCalibrated: data.lastCalibrated || null,
      settings: data.settings || null,
      specifications: data.specifications || null,
      pairedAt: data.pairedAt || null,
      version: data.version ?? 1,
      createdAt: data.createdAt || now,
      updatedAt: data.updatedAt || now,
    };
  }
}
