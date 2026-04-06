import { Device, DeviceStatus, DeviceType, SavedDevice } from '../types';
import { LocalDeviceRepository } from '../repositories/LocalDeviceRepository';
import { OutboxRepository, type OutboxOperationType } from '../repositories/offline';
import { StorageService } from './StorageService';
import { dataChangeEmitter, deviceEvents } from '../utils/EventEmitter';
import { logger } from '../utils/logger';
import { buildDeviceCreatePayload, buildDeviceUpdatePayload } from '../utils/devicePayload';
import { authService } from './auth.service';
import { v4 as uuidv4 } from 'uuid';
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
interface DeviceServiceConfig {
  stalePairingThresholdMinutes: number;
}
const DEFAULT_CONFIG: DeviceServiceConfig = {
  stalePairingThresholdMinutes: 15,
};
export class DeviceService {
  private config: DeviceServiceConfig;
  private isInitialized = false;
  constructor(
    private storageService: StorageService,
    private localDeviceRepository: LocalDeviceRepository,
    private outboxRepository: OutboxRepository,
    config: Partial<DeviceServiceConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.debug('[DeviceService] Already initialized');
      return;
    }
    try {
      const thresholdMs = this.config.stalePairingThresholdMinutes * 60 * 1000;
      const thresholdDate = new Date(Date.now() - thresholdMs).toISOString();
      const deletedCount =
        await this.localDeviceRepository.deleteStalePairingRecords(thresholdDate);
      if (deletedCount > 0) {
        logger.info('[DeviceService] Cleaned up stale pairing records', { deletedCount });
      }
      this.isInitialized = true;
      logger.info('[DeviceService] Initialized successfully');
    } catch (error) {
      logger.error('[DeviceService] Initialization failed', { error: formatError(error) });
      this.isInitialized = true;
    }
  }
  private async resolveDeviceUserId(deviceId: string): Promise<string | null> {
    const localDevice = await this.localDeviceRepository.getById(deviceId);
    if (localDevice?.userId) {
      return localDevice.userId;
    }
    const cachedUser = await authService.getCachedUser();
    return cachedUser?.id ?? null;
  }
  async handleSyncFailure(
    deviceId: string,
    errorMessage: string,
    statusCode?: number
  ): Promise<void> {
    const isNonRetryable = statusCode && statusCode >= 400 && statusCode < 500;
    if (isNonRetryable) {
      logger.warn('[DeviceService] Device creation rejected by backend', {
        id: deviceId,
        errorMessage,
        statusCode,
      });
      await this.localDeviceRepository.markAsSyncError(
        deviceId,
        errorMessage || 'Registration failed'
      );
      dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED, {
        source: 'DeviceService',
        entityType: 'device',
        entityId: deviceId,
        reason: 'sync_error',
      });
    }
  }
  async getSavedDevices(): Promise<SavedDevice[]> {
    try {
      const userId = (await authService.getCachedUser())?.id;
      if (!userId) {
        logger.warn('[DeviceService] No user context - returning empty device list');
        return [];
      }
      const devices = await this.localDeviceRepository.getAllByUserId(userId);
      return devices.map((d) => ({
        id: d.bluetoothId || d.macAddress || d.id, 
        name: d.deviceName,
        deviceName: d.deviceName,
        lastConnected: d.lastSeen ? new Date(d.lastSeen).getTime() : undefined,
        backendDeviceId: d.id, 
        firmwareVersion: d.firmwareVersion ?? undefined, 
        macAddress: d.macAddress ?? undefined, 
        bluetoothId: d.bluetoothId ?? undefined, 
        status: d.status, 
      }));
    } catch (error) {
      logger.error('[DeviceService] Error getting saved devices', { error: formatError(error) });
      return [];
    }
  }
  async getAllDevices(): Promise<Device[]> {
    try {
      const userId = (await authService.getCachedUser())?.id;
      if (!userId) {
        logger.warn('[DeviceService] No user context - returning empty device list');
        return [];
      }
      return await this.localDeviceRepository.getAllByUserId(userId);
    } catch (error) {
      logger.error('[DeviceService] Error getting all devices', { error: formatError(error) });
      return [];
    }
  }
  async getDeviceById(deviceId: string): Promise<Device | null> {
    return this.localDeviceRepository.getById(deviceId);
  }
  async findDeviceByBluetoothId(bluetoothId: string): Promise<Device | null> {
    return this.localDeviceRepository.findByBluetoothId(bluetoothId);
  }
  async findDeviceByMacAddress(macAddress: string): Promise<Device | null> {
    return this.localDeviceRepository.findByMacAddress(macAddress);
  }
  async updateBluetoothId(id: string, newBluetoothId: string): Promise<void> {
    const existing = await this.localDeviceRepository.getById(id);
    if (!existing) {
      logger.warn('[DeviceService] Cannot update Bluetooth ID for unknown device', { id });
      return;
    }
    const userId = existing.userId || await this.resolveDeviceUserId(id);
    const hasPendingCreate = userId
      ? await this.outboxRepository.hasPendingCreateForAggregate(id, userId)
      : false;
    const needsOutbox = !!userId && !hasPendingCreate;
    if (needsOutbox) {
      const syncPayload = buildDeviceUpdatePayload({
        bluetoothId: newBluetoothId,
        version: (existing.version ?? 1) + 1,
      });
      const drizzleDb = this.outboxRepository.getDrizzleDb();
      await drizzleDb.transaction(async (tx) => {
        await this.localDeviceRepository.updateBluetoothId(id, newBluetoothId, tx);
        await this.outboxRepository.enqueue({
          userId: userId!,
          aggregateType: 'Device',
          aggregateId: id,
          eventType: 'UPDATE',
          payload: syncPayload,
        }, tx);
      });
    } else {
      await this.localDeviceRepository.updateBluetoothId(id, newBluetoothId);
      if (!userId) {
        logger.warn('[DeviceService] Skipping outbox update - no user context', { deviceId: id });
      } else {
        logger.debug('[DeviceService] Skipping outbox UPDATE for Bluetooth ID: CREATE already pending', { deviceId: id });
      }
    }
    dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED);
  }
  async updateMacAddress(id: string, newMacAddress: string): Promise<void> {
    const existing = await this.localDeviceRepository.getById(id);
    if (!existing) {
      logger.warn('[DeviceService] Cannot update MAC address for unknown device', { id });
      return;
    }
    const userId = existing.userId || await this.resolveDeviceUserId(id);
    const hasPendingCreate = userId
      ? await this.outboxRepository.hasPendingCreateForAggregate(id, userId)
      : false;
    const needsOutbox = !!userId && !hasPendingCreate;
    if (needsOutbox) {
      const syncPayload = buildDeviceUpdatePayload({
        macAddress: newMacAddress,
        version: (existing.version ?? 1) + 1,
      });
      const drizzleDb = this.outboxRepository.getDrizzleDb();
      await drizzleDb.transaction(async (tx) => {
        await this.localDeviceRepository.updateMacAddress(id, newMacAddress, tx);
        await this.outboxRepository.enqueue({
          userId: userId!,
          aggregateType: 'Device',
          aggregateId: id,
          eventType: 'UPDATE',
          payload: syncPayload,
        }, tx);
      });
    } else {
      await this.localDeviceRepository.updateMacAddress(id, newMacAddress);
      if (!userId) {
        logger.warn('[DeviceService] Skipping outbox update - no user context', { deviceId: id });
      } else {
        logger.debug('[DeviceService] Skipping outbox UPDATE for MAC address: CREATE already pending', { deviceId: id });
      }
    }
    dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED);
  }
  async updateFirmwareVersion(id: string, firmwareVersion: string): Promise<void> {
    const existing = await this.localDeviceRepository.getById(id);
    if (!existing) {
      logger.warn('[DeviceService] Cannot update firmware version for unknown device', { id });
      return;
    }
    const userId = existing.userId || await this.resolveDeviceUserId(id);
    const hasPendingCreate = userId
      ? await this.outboxRepository.hasPendingCreateForAggregate(id, userId)
      : false;
    const needsOutbox = !!userId && !hasPendingCreate;
    if (needsOutbox) {
      const syncPayload = buildDeviceUpdatePayload({
        firmwareVersion,
        version: (existing.version ?? 1) + 1,
      });
      const drizzleDb = this.outboxRepository.getDrizzleDb();
      await drizzleDb.transaction(async (tx) => {
        await this.localDeviceRepository.updateFirmwareVersion(id, firmwareVersion, tx);
        await this.outboxRepository.enqueue({
          userId: userId!,
          aggregateType: 'Device',
          aggregateId: id,
          eventType: 'UPDATE',
          payload: syncPayload,
        }, tx);
      });
    } else {
      await this.localDeviceRepository.updateFirmwareVersion(id, firmwareVersion);
      if (!userId) {
        logger.warn('[DeviceService] Skipping outbox update - no user context', { deviceId: id });
      } else {
        logger.debug('[DeviceService] Skipping outbox UPDATE for firmware version: CREATE already pending', { deviceId: id });
      }
    }
    dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED);
  }
  async updateDeviceConnection(
    id: string,
    status: DeviceStatus,
    batteryLevel?: number
  ): Promise<void> {
    const existing = await this.localDeviceRepository.getById(id);
    if (!existing) {
      logger.warn('[DeviceService] Cannot update connection for unknown device', { id });
      return;
    }
    const now = new Date().toISOString();
    const telemetry = {
      status,
      isActive: status === DeviceStatus.ACTIVE,
      lastSeen: now,
      batteryLevel,
    };
    await this.localDeviceRepository.updateTelemetry(id, telemetry);
    const hasBeenSynced = await this.localDeviceRepository.hasBeenSynced(id);
    const hasPendingCreate = await this.outboxRepository.hasPendingCreateForAggregate(id, existing.userId);
    const statusChanged = existing.status !== status;
    const batteryChangedSignificantly = batteryLevel !== undefined &&
      (existing.batteryLevel === undefined || existing.batteryLevel === null || Math.abs(existing.batteryLevel - batteryLevel) >= 5);
    if (hasBeenSynced && !hasPendingCreate && (statusChanged || batteryChangedSignificantly)) {
      const syncPayload = buildDeviceUpdatePayload({
        status: telemetry.status,
        isActive: telemetry.isActive,
        batteryLevel: batteryLevel,
        version: (existing.version ?? 0) + 1,
      });
      try {
        const drizzleDb = this.outboxRepository.getDrizzleDb();
        await drizzleDb.transaction(async (tx) => {
          await this.localDeviceRepository.update({
            ...existing,
            ...telemetry,
          }, tx);
          await this.outboxRepository.enqueue({
            userId: existing.userId,
            aggregateType: 'Device',
            aggregateId: id,
            eventType: 'UPDATE',
            payload: syncPayload,
          }, tx);
        });
        logger.debug('[DeviceService] Status/Battery update queued for sync', {
          id,
          statusChanged,
          batteryChangedSignificantly,
          newBatteryLevel: batteryLevel,
          newVersion: (existing.version ?? 0) + 1,
        });
      } catch (error) {
        logger.error('[DeviceService] Atomic status sync transaction failed', {
          id,
          error: formatError(error),
        });
      }
    } else {
      logger.debug('[DeviceService] Status update outbox entry skipped', {
        id,
        hasBeenSynced,
        hasPendingCreate,
        statusChanged,
        batteryChangedSignificantly,
        reason: !hasBeenSynced ? 'Device not yet on server' :
                hasPendingCreate ? 'CREATE already pending' :
                'No significant change in telemetry'
      });
    }
    dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED, {
      source: 'DeviceService',
      entityType: 'device',
      entityId: id,
      reason: 'connection_status_updated',
    });
  }
  async pairDevice(deviceData: Partial<Device>): Promise<Device> {
    const userId = (await authService.getCachedUser())?.id;
    if (!userId) {
      throw new Error('User not authenticated');
    }
    let existing = await this.localDeviceRepository.findByMacOrSerial(
      deviceData.macAddress,
      deviceData.serialNumber
    );
    if (!existing && deviceData.bluetoothId) {
      existing = await this.localDeviceRepository.findByBluetoothIdIncludingDeleted(deviceData.bluetoothId);
      if (existing) {
        logger.info('[DeviceService] Found existing device by bluetooth_id (may be soft-deleted)', {
          id: existing.id,
          bluetoothId: deviceData.bluetoothId,
          wasDeleted: !!existing.deletedAt,
        });
      }
    }
    if (existing) {
      const wasDeleted = !!existing.deletedAt;
      const now = new Date().toISOString();
      const reactivated: Device = {
        ...existing,
        ...deviceData,
        status: DeviceStatus.ACTIVE,
        isActive: true,
        deletedAt: undefined, 
        lastSeen: now,
        updatedAt: now,
      };
      const hasBeenSynced = await this.localDeviceRepository.hasBeenSynced(reactivated.id);
      const outboxCommand = hasBeenSynced
        ? {
            eventType: 'UPDATE' as const,
            payload: buildDeviceUpdatePayload({
              status: DeviceStatus.ACTIVE,
              isActive: true,
              version: existing.version,
            }),
          }
        : {
            eventType: 'CREATE' as const,
            payload: buildDeviceCreatePayload(reactivated),
          };
      const drizzleDb = this.outboxRepository.getDrizzleDb();
      await drizzleDb.transaction(async (tx) => {
        await this.localDeviceRepository.update(reactivated, tx);
        await this.outboxRepository.enqueue({
          userId,
          aggregateType: 'Device',
          aggregateId: reactivated.id,
          eventType: outboxCommand.eventType,
          payload: outboxCommand.payload,
        }, tx);
      });
      if (hasBeenSynced) {
        logger.debug('[DeviceService] Device has server_id, queued UPDATE', { id: reactivated.id });
      } else {
        logger.info('[DeviceService] Device missing server_id, queued CREATE instead of UPDATE', {
          id: reactivated.id,
          wasDeleted,
        });
      }
      dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED, {
        source: 'DeviceService',
        entityType: 'device',
        entityId: reactivated.id,
        reason: wasDeleted ? 'reactivated_from_deleted' : 'reactivated',
      });
      logger.info('[DeviceService] Reactivated existing device', {
        id: reactivated.id,
        wasDeleted,
        bluetoothId: reactivated.bluetoothId,
      });
      return reactivated;
    }
    const now = new Date().toISOString();
    const newDevice: Device = {
      id: uuidv4(),
      userId,
      deviceName: deviceData.deviceName || 'New Device',
      type: deviceData.type || DeviceType.OTHER,
      status: DeviceStatus.ACTIVE,
      isActive: true,
      requiresCalibration: deviceData.requiresCalibration ?? false,
      createdAt: now,
      updatedAt: now,
      lastSeen: now,
      pairedAt: now,
      version: 1,
      macAddress: deviceData.macAddress,
      bluetoothId: deviceData.bluetoothId,
      serialNumber: deviceData.serialNumber,
      firmwareVersion: deviceData.firmwareVersion,
      hardwareVersion: deviceData.hardwareVersion,
      brand: deviceData.brand,
      batteryLevel: deviceData.batteryLevel,
      settings: deviceData.settings,
      specifications: deviceData.specifications,
    };
    const createPayload = buildDeviceCreatePayload(newDevice);
    const drizzleDb = this.outboxRepository.getDrizzleDb();
    await drizzleDb.transaction(async (tx) => {
      await this.localDeviceRepository.create(newDevice, tx);
      await this.outboxRepository.enqueue({
        userId,
        aggregateType: 'Device',
        aggregateId: newDevice.id,
        eventType: 'CREATE',
        payload: createPayload,
      }, tx);
    });
    dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED, {
      source: 'DeviceService',
      entityType: 'device',
      entityId: newDevice.id,
      reason: 'added',
    });
    logger.info('[DeviceService] Device paired locally and queued for sync', {
      id: newDevice.id,
      name: newDevice.deviceName,
    });
    return newDevice;
  }
  async saveDevices(bleDevices: Array<{ id: string; name: string | null }>): Promise<void> {
    for (const bleDevice of bleDevices) {
      try {
        await this.pairDevice({
          bluetoothId: bleDevice.id,
          deviceName: bleDevice.name || 'Unknown Device',
          type: DeviceType.OTHER,
        });
      } catch (error) {
        logger.error('[DeviceService] Failed to save BLE device', {
          bleId: bleDevice.id,
          error: formatError(error),
        });
      }
    }
  }
  async updateDevice(id: string, updates: Partial<Device>): Promise<void> {
    const existing = await this.localDeviceRepository.getById(id);
    if (!existing) {
      throw new Error(`Device ${id} not found locally`);
    }
    const updatedDevice: Device = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    const hasBeenSynced = await this.localDeviceRepository.hasBeenSynced(id);
    let outboxCommand: { eventType: OutboxOperationType; payload: Record<string, unknown> } | null = null;
    if (hasBeenSynced) {
      const syncPayload = buildDeviceUpdatePayload({
        ...updates,
        version: existing.version,
      });
      const payloadKeys = Object.keys(syncPayload).filter(k => k !== 'version');
      if (payloadKeys.length > 0) {
        outboxCommand = { eventType: 'UPDATE', payload: syncPayload };
      }
    } else {
      outboxCommand = { eventType: 'CREATE', payload: buildDeviceCreatePayload(updatedDevice) };
    }
    if (outboxCommand) {
      const drizzleDb = this.outboxRepository.getDrizzleDb();
      await drizzleDb.transaction(async (tx) => {
        await this.localDeviceRepository.update(updatedDevice, tx);
        await this.outboxRepository.enqueue({
          userId: existing.userId,
          aggregateType: 'Device',
          aggregateId: id,
          eventType: outboxCommand!.eventType,
          payload: outboxCommand!.payload,
        }, tx);
      });
      if (!hasBeenSynced) {
        logger.info('[DeviceService] Device missing server_id, queued CREATE instead of UPDATE', { id });
      }
    } else {
      await this.localDeviceRepository.update(updatedDevice);
      logger.debug('[DeviceService] Telemetry-only update skipped for outbox', {
        id,
        fields: Object.keys(updates),
      });
    }
    dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED, {
      source: 'DeviceService',
      entityType: 'device',
      entityId: id,
      reason: 'updated',
    });
    logger.debug('[DeviceService] Device updated', { id, updates: Object.keys(updates) });
  }
  async updateDeviceStatus(
    id: string,
    batteryLevel?: number,
    lastSeen?: string
  ): Promise<void> {
    const existing = await this.localDeviceRepository.getById(id);
    if (!existing) {
      logger.warn('[DeviceService] Cannot update status for unknown device', { id });
      return;
    }
    const telemetry = {
      lastSeen: lastSeen || new Date().toISOString(),
      batteryLevel,
    };
    await this.localDeviceRepository.updateTelemetry(id, telemetry);
    dataChangeEmitter.emit(deviceEvents.DEVICE_BATTERY_UPDATED, {
      source: 'DeviceService',
      deviceId: id,
      data: {
        batteryLevel,
        lastSeen: telemetry.lastSeen,
      },
    });
    logger.debug('[DeviceService] Device status updated', { id, batteryLevel, lastSeen: telemetry.lastSeen });
  }
  async removeDevice(
    deviceId: string,
    action: 'removed' | 'forgotten' = 'removed'
  ): Promise<void> {
    let device = await this.localDeviceRepository.getById(deviceId);
    if (!device) {
      device = await this.localDeviceRepository.findByBluetoothId(deviceId);
    }
    if (!device) {
      device = await this.localDeviceRepository.findByMacOrSerial(deviceId, deviceId);
    }
    if (!device) {
      throw new Error(`Device ${deviceId} not found locally`);
    }
    const resolvedId = device.id;
    const hasBeenSynced = await this.localDeviceRepository.hasBeenSynced(resolvedId);
    const userId = device.userId || (await this.resolveDeviceUserId(resolvedId)) || undefined;
    const needsOutbox = hasBeenSynced && !!userId;
    const drizzleDb = this.outboxRepository.getDrizzleDb();
    await drizzleDb.transaction(async (tx) => {
      await this.localDeviceRepository.softDelete(resolvedId, tx);
      if (needsOutbox) {
        await this.outboxRepository.enqueue({
          userId: userId!,
          aggregateType: 'Device',
          aggregateId: resolvedId,
          eventType: 'UPDATE',
          payload: buildDeviceUpdatePayload({
            status: DeviceStatus.DECOMMISSIONED,
            version: device!.version,
          }),
        }, tx);
      }
    });
    if (hasBeenSynced && !userId) {
      logger.warn('[DeviceService] Skipping backend notification - no user context', { id: resolvedId });
    } else if (!hasBeenSynced) {
      logger.debug('[DeviceService] Device never synced, skipping backend notification', {
        id: resolvedId
      });
    }
    await this.storageService.clearDeviceSpecificData(resolvedId);
    dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED, {
      source: 'DeviceService',
      entityType: 'device',
      entityId: resolvedId,
      reason: action,
    });
    logger.info('[DeviceService] Device removed', { id: resolvedId, action });
  }
  async forgetDevice(deviceId: string): Promise<void> {
    logger.info('[DeviceService] Forgetting device', { deviceId });
    await this.removeDevice(deviceId, 'forgotten');
  }
  async forgetDeviceByBluetoothId(bluetoothId: string): Promise<void> {
    logger.info('[DeviceService] Forgetting device by Bluetooth ID', { bluetoothId });
    const device = await this.localDeviceRepository.findByBluetoothIdIncludingDeleted(bluetoothId);
    if (!device) {
      logger.warn('[DeviceService] Device not found by Bluetooth ID (not in database)', { 
        bluetoothId,
      });
      return;
    }
    const wasAlreadyDeleted = !!device.deletedAt;
    logger.info('[DeviceService] Found device for bonding cleanup', {
      deviceId: device.id,
      bluetoothId,
      wasAlreadyDeleted,
      status: device.status,
    });
    await this.removeDeviceComplete(device.id, 'forgotten');
    logger.info('[DeviceService] Device completely removed (bonding error cleanup)', {
      deviceId: device.id,
      bluetoothId,
      wasAlreadyDeleted,
    });
  }
  private async removeDeviceComplete(
    deviceId: string,
    action: 'removed' | 'forgotten' = 'removed'
  ): Promise<void> {
    const device = await this.localDeviceRepository.getById(deviceId)
      || await this.localDeviceRepository.findByBluetoothIdIncludingDeleted(deviceId);
    const hasBeenSynced = await this.localDeviceRepository.hasBeenSynced(deviceId);
    const userId = device?.userId || await this.resolveDeviceUserId(deviceId);
    const needsOutbox = hasBeenSynced && !!userId;
    const drizzleDb = this.outboxRepository.getDrizzleDb();
    await drizzleDb.transaction(async (tx) => {
      await this.localDeviceRepository.softDelete(deviceId, tx);
      if (needsOutbox) {
        await this.outboxRepository.enqueue({
          userId: userId!,
          aggregateType: 'Device',
          aggregateId: deviceId,
          eventType: 'UPDATE',
          payload: buildDeviceUpdatePayload({
            status: DeviceStatus.DECOMMISSIONED,
            version: device?.version,
          }),
        }, tx);
      }
    });
    if (hasBeenSynced && !userId) {
      logger.warn('[DeviceService] Skipping backend notification - no user context', { id: deviceId });
    } else if (!hasBeenSynced) {
      logger.debug('[DeviceService] Device never synced, skipping backend notification', {
        id: deviceId
      });
    }
    await this.storageService.clearDeviceSpecificData(deviceId);
    dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED, {
      source: 'DeviceService',
      entityType: 'device',
      entityId: deviceId,
      reason: action,
    });
  }
  async clearDevices(): Promise<void> {
    try {
      const userId = (await authService.getCachedUser())?.id;
      if (!userId) {
        logger.warn('[DeviceService] No user context - skipping device clear');
        return;
      }
      const devices = await this.localDeviceRepository.getAllByUserId(userId);
      for (const device of devices) {
        await this.localDeviceRepository.softDelete(device.id);
      }
      dataChangeEmitter.emit(deviceEvents.DEVICE_LIST_UPDATED, {
        source: 'DeviceService',
        entityType: 'device',
        entityId: 'all',
        reason: 'cleared',
      });
      logger.info('[DeviceService] All devices cleared', { count: devices.length });
    } catch (error) {
      logger.error('[DeviceService] Failed to clear devices', { error: formatError(error) });
      throw error;
    }
  }
}
