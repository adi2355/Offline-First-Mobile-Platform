import { Alert, PermissionsAndroid, Platform, AppState } from "react-native";
import * as ExpoDevice from "expo-device";
import { Device } from 'react-native-ble-plx';
import { BluetoothHandler, ConnectionState } from "../contexts/BluetoothContext";
import { DeviceService } from "./DeviceService";
import { FrontendConsumptionService } from "./domain/FrontendConsumptionService";
import { dataChangeEmitter, dbEvents, achievementEvents, achievementEmitter, deviceEvents, DataChangeEvent } from "../utils/EventEmitter";
import {
  ACHIEVEMENT_ACTION_TYPES,
  BLE_UUIDS,
  BLE_TIMING,
  BLE_DEVICE_NAME_PATTERNS,
} from "../constants";
import { StorageService } from './StorageService';
import { authService } from './auth.service';
import { notificationService } from './NotificationService';
import { logger } from '../utils/logger';
import { CreateConsumptionDto, DeviceType, DeviceStatus } from '../types';
import type { HelloAckPayload } from './ble/protocol/types';
import { AppDeviceProtocolService, EventSyncService } from './ble';
import { AppDeviceBLENative, onDeviceFound, onOperationRejected, type DeviceFoundEvent } from '../native/AppDeviceBLE';
import { BLE_CONNECTION_TIMEOUT_MS } from '../constants/ble';
const DUPLICATE_DETECTION = {
  TIMESTAMP_TOLERANCE_MS: 1000,
  DURATION_TOLERANCE_MS: 100,
  SIGNATURE_TTL_MS: 5 * 60 * 1000,
  CLEANUP_INTERVAL_MS: 60 * 1000,
} as const;
const NATIVE_CONNECT_AWAIT_TIMEOUT_MS = BLE_CONNECTION_TIMEOUT_MS + 5000;
interface HitSignature {
  deviceId: string;
  timestampMs: number;
  durationMs: number;
  recordedAt: number;
}
export class BluetoothService {
  private bluetoothHandler: BluetoothHandler;
  private deviceService: DeviceService; 
  private frontendConsumptionService: FrontendConsumptionService; 
  private storageService: StorageService;
  private pendingPairingDeviceIds = new Set<string>();
  private ghostBondNotifiedIds = new Set<string>();
  private readonly deviceListListener = (event?: DataChangeEvent): void => {
    void this.handleDeviceListUpdated(event);
  };
  private readonly connectionStateListener = (event?: DataChangeEvent): void => {
    void this.handleDeviceConnectionStateChanged(event);
  };
  private activeUserId: string | null = null;
  private recentHitSignatures: HitSignature[] = [];
  private signatureCleanupTimer: NodeJS.Timeout | null = null;
  constructor(
    deviceService: DeviceService,
    frontendConsumptionService: FrontendConsumptionService
  ) {
    this.bluetoothHandler = BluetoothHandler.getInstance();
    this.deviceService = deviceService;
    this.frontendConsumptionService = frontendConsumptionService;
    this.storageService = new StorageService();
    this.wireUpEventSyncService();
    this.bluetoothHandler.setOnBatteryStatusCallback(this.handleBatteryUpdate.bind(this));
    this.bluetoothHandler.setOnDeviceInfoCallback(this.handleDeviceInfo.bind(this));
    this.bluetoothHandler.setOnBondingErrorCallback(this.handleBondingError.bind(this));
    this.startSignatureCleanupTimer();
    this.registerDeviceEventListeners();
    logger.info('[BluetoothService] Initialized with BluetoothHandler singleton (binary protocol, EC-CON-001 duplicate detection enabled)');
  }
  public setActiveUserId(userId: string | null): void {
    this.activeUserId = userId;
    logger.info('[BluetoothService] Active user context updated', {
      userId: userId ?? 'none',
    });
  }
  private wireUpEventSyncService(): void {
    const eventSyncService = this.bluetoothHandler.getEventSyncService();
    eventSyncService.setOnProcessedHitEvent(async (
      timestamp: Date,
      durationMs: number,
      eventId: number,
      bootCount: number
    ): Promise<void> => {
      await this.handleProcessedHitEvent(timestamp, durationMs, eventId, bootCount);
    });
    logger.debug('[BluetoothService] EventSyncService wired up for binary protocol hits');
  }
  private registerDeviceEventListeners(): void {
    dataChangeEmitter.on(deviceEvents.DEVICE_LIST_UPDATED, this.deviceListListener);
    dataChangeEmitter.on(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, this.connectionStateListener);
  }
  private async handleDeviceListUpdated(event?: DataChangeEvent): Promise<void> {
    if (!event || event.entityType !== 'device' || !event.entityId) {
      return;
    }
    if (event.source === 'BluetoothService') {
      return;
    }
    if (event.reason !== 'removed' && event.reason !== 'forgotten') {
      return;
    }
    const deviceId = event.entityId;
    const device = await this.deviceService.getDeviceById(deviceId);
    const bluetoothId = device?.bluetoothId;
    if (!bluetoothId) {
      logger.warn('[BluetoothService] Device removed without bluetoothId; cannot clear BLE state', {
        deviceId,
        reason: event.reason,
      });
      return;
    }
    try {
      await this.bluetoothHandler.cleanupDeviceState(bluetoothId);
      logger.info('[BluetoothService] Cleared BLE state for removed device', {
        deviceId,
        bluetoothId,
        reason: event.reason,
      });
    } catch (error) {
      logger.warn('[BluetoothService] Failed to clear BLE state for removed device', {
        deviceId,
        bluetoothId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
    }
  }
  private async handleDeviceConnectionStateChanged(event?: DataChangeEvent): Promise<void> {
    if (!event?.isConnected || !event.deviceId) {
      return;
    }
    const bleDeviceId = event.deviceId;
    if (this.pendingPairingDeviceIds.has(bleDeviceId)) {
      return;
    }
    const knownDevice = await this.deviceService.findDeviceByBluetoothId(bleDeviceId);
    if (knownDevice) {
      return;
    }
    logger.warn('[BluetoothService] Ghost bond detected: connected device not in local database', {
      bleDeviceId,
    });
    try {
      await this.bluetoothHandler.cleanupDeviceState(bleDeviceId);
    } catch (error) {
      logger.warn('[BluetoothService] Failed to clean up ghost bond connection', {
        bleDeviceId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
    }
    if (!this.ghostBondNotifiedIds.has(bleDeviceId)) {
      this.ghostBondNotifiedIds.add(bleDeviceId);
      notificationService.showWarning(
        'A device connected at the OS level but is not registered in the app.\n\n' +
        'Please remove it from Bluetooth settings if you no longer use it.',
        { useAlertFallback: true, dismissible: true }
      );
    }
  }
  private startSignatureCleanupTimer(): void {
    if (this.signatureCleanupTimer) {
      clearInterval(this.signatureCleanupTimer);
    }
    this.signatureCleanupTimer = setInterval(() => {
      this.cleanupExpiredSignatures();
    }, DUPLICATE_DETECTION.CLEANUP_INTERVAL_MS);
  }
  private cleanupExpiredSignatures(): void {
    const now = Date.now();
    const beforeCount = this.recentHitSignatures.length;
    this.recentHitSignatures = this.recentHitSignatures.filter(
      sig => (now - sig.recordedAt) < DUPLICATE_DETECTION.SIGNATURE_TTL_MS
    );
    const removed = beforeCount - this.recentHitSignatures.length;
    if (removed > 0) {
      logger.debug('[BluetoothService] Cleaned up expired hit signatures', {
        removed,
        remaining: this.recentHitSignatures.length,
      });
    }
  }
  private isDuplicateHit(deviceId: string, timestamp: Date, durationMs: number): boolean {
    const timestampMs = timestamp.getTime();
    const duplicate = this.recentHitSignatures.find(sig => {
      if (sig.deviceId !== deviceId) return false;
      const timeDiff = Math.abs(sig.timestampMs - timestampMs);
      if (timeDiff > DUPLICATE_DETECTION.TIMESTAMP_TOLERANCE_MS) return false;
      const durationDiff = Math.abs(sig.durationMs - durationMs);
      if (durationDiff > DUPLICATE_DETECTION.DURATION_TOLERANCE_MS) return false;
      return true;
    });
    if (duplicate) {
      logger.warn('[BluetoothService] EC-CON-001: Duplicate hit detected, ignoring', {
        deviceId,
        timestamp: timestamp.toISOString(),
        durationMs,
        matchedSignature: {
          timestampMs: duplicate.timestampMs,
          durationMs: duplicate.durationMs,
          recordedAt: new Date(duplicate.recordedAt).toISOString(),
        },
      });
      return true;
    }
    return false;
  }
  private recordHitSignature(deviceId: string, timestamp: Date, durationMs: number): void {
    this.recentHitSignatures.push({
      deviceId,
      timestampMs: timestamp.getTime(),
      durationMs,
      recordedAt: Date.now(),
    });
    logger.debug('[BluetoothService] Hit signature recorded for duplicate detection', {
      deviceId: deviceId.substring(0, 8) + '...',
      timestamp: timestamp.toISOString(),
      durationMs,
      totalSignatures: this.recentHitSignatures.length,
    });
  }
  private async handleProcessedHitEvent(
    timestamp: Date,
    durationMs: number,
    eventId: number,
    bootCount: number
  ): Promise<void> {
    try {
      logger.info('[BluetoothService] Processing binary hit event', {
        eventId,
        timestamp: timestamp.toISOString(),
        durationMs,
        bootCount,
      });
      if (durationMs <= 0) {
        logger.warn('[BluetoothService] Invalid duration in hit event', { eventId, durationMs });
        return;
      }
      const connectedBleDeviceForDedup = this.bluetoothHandler.getConnectedDevice();
      const deviceIdForDedup = connectedBleDeviceForDedup?.id || 'unknown';
      if (this.isDuplicateHit(deviceIdForDedup, timestamp, durationMs)) {
        return;
      }
      this.recordHitSignature(deviceIdForDedup, timestamp, durationMs);
      const durationMsInt = Math.round(durationMs);
      const uniqueTimestampForDb: string = timestamp.toISOString();
      const activeVariantInfo = await this.storageService.getActiveStrain();
      const productId = activeVariantInfo?.productId ?? null;
      const productName = activeVariantInfo?.productName ?? null;
      logger.debug('[BluetoothService] Active product for hit', {
        eventId,
        productId: productId ?? 'None',
        productName: productName ?? 'None',
      });
      if (Platform.OS === 'ios' && AppState.currentState === 'active') {
        const strainText = productName ? `\nProduct: ${productName}` : '';
        Alert.alert(`Hit recorded!\nDuration: ${durationMsInt}ms${strainText}`);
      }
      const currentUser = await authService.getCurrentUser();
      if (this.activeUserId && currentUser && currentUser.id !== this.activeUserId) {
        logger.warn('[BluetoothService] Active user mismatch, skipping hit', {
          activeUserId: this.activeUserId,
          authUserId: currentUser.id,
        });
        this._notifyUnauthenticatedUser('record consumption');
        return;
      }
      const resolvedUserId = this.activeUserId ?? currentUser?.id ?? null;
      if (!resolvedUserId) {
        this._notifyUnauthenticatedUser('record consumption');
        return;
      }
      const connectedBleDevice = this.bluetoothHandler.getConnectedDevice();
      let localDeviceId: string | undefined;
      if (connectedBleDevice) {
        const localDevice = await this.deviceService.findDeviceByBluetoothId(connectedBleDevice.id);
        if (localDevice) {
          localDeviceId = localDevice.id;
        } else {
          try {
            const paired = await this.deviceService.pairDevice({
              bluetoothId: connectedBleDevice.id,
              deviceName: connectedBleDevice.name || `App Device ${connectedBleDevice.id.slice(-4)}`,
              type: DeviceType.SMART_DEVICE,
            });
            localDeviceId = paired.id;
          } catch (error) {
            logger.warn('[BluetoothService] Failed to auto-pair unknown device locally', {
              bleDeviceId: connectedBleDevice.id,
              error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
            });
          }
        }
      }
      const consumptionData: CreateConsumptionDto = {
        timestamp: uniqueTimestampForDb,
        durationMs: durationMsInt,
        productId: productId ? String(productId) : null,
        deviceId: localDeviceId,
        isJournaled: false,
      };
      const result = await this.frontendConsumptionService.create(resolvedUserId, consumptionData);
      const consumption = result.consumption;
      logger.info('[BluetoothService] Hit recorded via FrontendConsumptionService', {
        consumptionId: consumption.id,
        sessionId: consumption.sessionId,
        eventId,
        bootCount,
        mode: result.mode,
        queuedForSync: result.queuedForSync || false,
      });
      this.bluetoothHandler.notifyHitEvent(eventId, timestamp, durationMsInt, bootCount);
      achievementEmitter.emit(achievementEvents.TRIGGER_CHECK, {
        actionType: ACHIEVEMENT_ACTION_TYPES.LOG_CONSUMPTION,
        actionData: {
          consumptionId: consumption.id,
          sessionId: consumption.sessionId,
          timestamp: consumption.timestamp,
          durationMs: consumption.durationMs,
          productId: consumption.productId,
          deviceId: consumption.deviceId,
          source: 'BLUETOOTH_BINARY_HIT_EVENT',
        },
      });
      dataChangeEmitter.emit(dbEvents.DATA_CHANGED, {
        source: 'BLUETOOTH_BINARY_HIT_EVENT',
        consumptionId: consumption.id,
        sessionId: consumption.sessionId ?? undefined,
        payload: {
          productId: consumption.productId ?? null,
          strainName: productName ?? null,
          timestamp: consumption.timestamp,
          durationMs: consumption.durationMs,
        },
      });
    } catch (error) {
      logger.error('[BluetoothService] Error handling hit event', {
        eventId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'Error', message: String(error) }
      });
      if (Platform.OS === 'ios' && AppState.currentState === 'active') {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          Alert.alert('Error', 'Duplicate hit detected. Could not record.');
        } else {
          Alert.alert('Error', 'Failed to process hit event');
        }
      }
    }
  }
  private async handleBatteryUpdate(
    percentage: number | null,
    isCharging: boolean | null
  ): Promise<void> {
    if (percentage === null) {
      return;
    }
    const connectedBleDevice = this.bluetoothHandler.getConnectedDevice();
    const bleDeviceId = connectedBleDevice?.id ?? 'unknown';
    logger.debug('[BluetoothService] Battery update received', {
      bleDeviceId,
      percentage,
      isCharging,
    });
    try {
      const localDevice = connectedBleDevice
        ? await this.deviceService.findDeviceByBluetoothId(connectedBleDevice.id)
        : null;
      if (!localDevice) {
        logger.debug('[BluetoothService] No local device found for battery update', { bleDeviceId });
        return;
      }
      await this.deviceService.updateDeviceConnection(
        localDevice.id,
        localDevice.status, 
        percentage
      );
      if (percentage <= 10 && !isCharging) {
        notificationService.showWarning(
          `Device battery is critically low (${percentage}%). Please charge your device.`,
          { useAlertFallback: true, dismissible: true }
        );
      } else if (percentage <= 20 && !isCharging) {
        notificationService.showInfo(
          `Device battery is low (${percentage}%). Consider charging soon.`,
          { useAlertFallback: false, dismissible: true }
        );
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[BluetoothService] Failed to sync battery update', {
        bleDeviceId,
        error: { name: 'BatteryUpdateError', message: errorMessage }
      });
    }
  }
  private async handleDeviceInfo(info: HelloAckPayload): Promise<void> {
    logger.info('[BluetoothService] Device info received (HELLO_ACK)', {
      firmwareVersion: `${info.firmwareMajor}.${info.firmwareMinor}.${info.firmwarePatch}`,
      lastEventId: info.lastEventId,
      batteryPercent: info.batteryPercent,
      isCharging: info.isCharging,
      sensitivity: info.sensitivity,
      hardwareId: info.hardwareId || 'not_supported_by_firmware',
    });
    if (info.hardwareId) {
      const connectedBleDevice = this.bluetoothHandler.getConnectedDevice();
      if (connectedBleDevice) {
        try {
          let localDevice = await this.deviceService.findDeviceByMacAddress(info.hardwareId);
          if (localDevice) {
            if (localDevice.bluetoothId !== connectedBleDevice.id) {
              logger.info('[BluetoothService] EC-DEVICE-ID-001: Updating BLE peripheral ID for device', {
                deviceId: localDevice.id,
                hardwareId: info.hardwareId,
                oldBluetoothId: localDevice.bluetoothId,
                newBluetoothId: connectedBleDevice.id,
              });
              await this.deviceService.updateBluetoothId(localDevice.id, connectedBleDevice.id);
            }
          } else {
            localDevice = await this.deviceService.findDeviceByBluetoothId(connectedBleDevice.id);
            if (localDevice) {
              logger.info('[BluetoothService] EC-DEVICE-ID-001: Migrating device to use hardware ID', {
                deviceId: localDevice.id,
                bluetoothId: connectedBleDevice.id,
                hardwareId: info.hardwareId,
              });
              await this.deviceService.updateMacAddress(localDevice.id, info.hardwareId);
            } else {
              logger.info('[BluetoothService] EC-DEVICE-ID-001: Pairing new device with hardware ID', {
                bluetoothId: connectedBleDevice.id,
                hardwareId: info.hardwareId,
              });
              await this.deviceService.pairDevice({
                bluetoothId: connectedBleDevice.id,
                macAddress: info.hardwareId,  
                deviceName: connectedBleDevice.name || `App Device ${connectedBleDevice.id.slice(-4)}`,
                type: DeviceType.SMART_DEVICE,
                firmwareVersion: `${info.firmwareMajor}.${info.firmwareMinor}.${info.firmwarePatch}`,
              });
            }
          }
          if (localDevice) {
            const currentVersion = `${info.firmwareMajor}.${info.firmwareMinor}.${info.firmwarePatch}`;
            if (localDevice.firmwareVersion !== currentVersion) {
              await this.deviceService.updateFirmwareVersion(localDevice.id, currentVersion);
            }
          }
        } catch (error) {
          logger.error('[BluetoothService] EC-DEVICE-ID-001: Failed to update device with hardware ID', {
            hardwareId: info.hardwareId,
            error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
          });
        }
      }
    }
  }
  private async handleBondingError(deviceId: string): Promise<void> {
    logger.warn('[BluetoothService] Bonding error detected, removing device', { 
      bleDeviceId: deviceId,
    });
    try {
      await this.deviceService.forgetDeviceByBluetoothId(deviceId);
      logger.info('[BluetoothService] Device removed from local storage due to bonding error', { 
        bleDeviceId: deviceId,
      });
    } catch (error) {
      logger.debug('[BluetoothService] Device removal during bonding error handling', {
        bleDeviceId: deviceId,
        result: error instanceof Error ? error.message : 'Device may not exist',
      });
    }
    const remediationMessage = Platform.OS === 'android'
      ? 'Device security keys have changed. The device has been removed from the app.\n\n' +
        'IMPORTANT: Please also go to Android Settings > Connected devices > Bluetooth and "Forget" the AppPlatform device before re-pairing.'
      : 'Device security keys have changed. The device has been removed from the app.\n\n' +
        'IMPORTANT: Please also go to iOS Settings > Bluetooth and "Forget This Device" before re-pairing.';
    notificationService.showWarning(
      remediationMessage,
      { useAlertFallback: true, dismissible: true }
    );
  }
  private _notifyUnauthenticatedUser(actionDescription: string): void {
    logger.warn(`[BluetoothService] Cannot ${actionDescription}: user not authenticated.`);
    notificationService.showWarning(
      `Cannot ${actionDescription}. Please log in to enable device tracking and record your sessions.`,
      { useAlertFallback: true, dismissible: true }
    );
  }
  public async connectToDevice(
    deviceId: string,
    options: { skipBondHealthCheck?: boolean } = {}
  ): Promise<void> {
    this.pendingPairingDeviceIds.add(deviceId);
    try {
      if (!options.skipBondHealthCheck) {
        const bondHealth = await this.bluetoothHandler.checkBondHealth(deviceId);
        if (bondHealth.recommendation === 'forget_required') {
          logger.warn('[BluetoothService] Bond health check failed - cleanup required', {
            deviceId,
            ...bondHealth,
          });
          try {
            await this.deviceService.forgetDeviceByBluetoothId(deviceId);
          } catch {
          }
          await this.bluetoothHandler.forgetDevice(deviceId);
          const bondRemediationSuffix = Platform.OS === 'android'
            ? '\n\nPlease go to Android Settings > Connected devices > Bluetooth and "Forget" the AppPlatform device before re-scanning.'
            : '\n\nPlease go to iOS Settings > Bluetooth and "Forget This Device" before re-scanning.';
          notificationService.showWarning(
            bondHealth.message + bondRemediationSuffix,
            { useAlertFallback: true, dismissible: true }
          );
          throw new Error(`Bond health check failed: ${bondHealth.message}`);
        } else if (bondHealth.recommendation === 'caution') {
          logger.info('[BluetoothService] Bond health check: caution - proceeding with connection', {
            deviceId,
            ...bondHealth,
          });
        }
      }
      const isNativeTransport = this.bluetoothHandler.isUsingNativeTransport();
      const currentlyConnectedDevice = this.bluetoothHandler.getConnectedDevice();
      const isAlreadyConnectedToTarget = currentlyConnectedDevice?.id === deviceId;
      const nativeConnectAwaiter = !isAlreadyConnectedToTarget && isNativeTransport
        ? this.createNativeConnectionAwaiter(deviceId, NATIVE_CONNECT_AWAIT_TIMEOUT_MS)
        : null;
      if (!isAlreadyConnectedToTarget) {
        try {
          await this.bluetoothHandler.connectToDevice(deviceId);
        } catch (error) {
          nativeConnectAwaiter?.cancel();
          throw error;
        }
      }
      if (nativeConnectAwaiter) {
        await nativeConnectAwaiter.promise;
      }
      const connectedDevice = this.bluetoothHandler.getConnectedDevice();
      if (!connectedDevice || connectedDevice.id !== deviceId) {
        throw new Error(
          `[BluetoothService] Connection did not produce expected target device. ` +
          `Expected ${deviceId}, got ${connectedDevice?.id ?? 'none'}`
        );
      }
      const paired = await this.pairDeviceLocally(connectedDevice);
      if (paired) {
        logger.info('[BluetoothService] BLE device connected and paired locally', { deviceId });
      } else {
        logger.warn('[BluetoothService] BLE device connected without local pairing', { deviceId });
      }
      await this.setupDeviceListeners();
      const localDevice = await this.deviceService.findDeviceByBluetoothId(deviceId);
      if (localDevice) {
        await this.deviceService.updateDeviceConnection(localDevice.id, DeviceStatus.ACTIVE);
      }
      this.bluetoothHandler.clearBondFailureCounters(deviceId);
      logger.info('[BluetoothService] Device fully integrated (local BLE + local pairing)', { deviceId });
    } catch (error) {
      this.bluetoothHandler.reconcileConnectFailure();
      logger.error('[BluetoothService] Error connecting to device', {
        deviceId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) }
      });
      throw error;
    } finally {
      this.pendingPairingDeviceIds.delete(deviceId);
    }
  }
  public async checkBondHealth(deviceId: string): Promise<{
    isHealthy: boolean;
    recommendation: 'proceed' | 'caution' | 'forget_required';
    message: string;
  }> {
    return this.bluetoothHandler.checkBondHealth(deviceId);
  }
  private async pairDeviceLocally(bleDevice: Device): Promise<boolean> {
    const bleDeviceId = bleDevice.id;
    try {
      const currentUser = await authService.getCachedUser();
      if (!currentUser) {
        this._notifyUnauthenticatedUser('pair device');
        return false;
      }
      await this.deviceService.pairDevice({
        bluetoothId: bleDeviceId,
        deviceName: bleDevice.name || `AppPlatform Device ${bleDeviceId.substring(0, 8)}`,
        type: DeviceType.SMART_DEVICE,
        specifications: {
          bleDeviceInfo: {
            rssi: bleDevice.rssi ?? null,
            mtu: bleDevice.mtu ?? null,
            isConnectable: bleDevice.isConnectable ?? true,
          },
          connectionMethod: 'bluetooth_le',
          deviceDiscoveredAt: new Date().toISOString(),
        },
      });
      return true;
    } catch (error) {
      logger.error('[BluetoothService] Failed to pair device locally', {
        bleDeviceId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  private async setupDeviceListeners(): Promise<void> {
    try {
      this.bluetoothHandler.streamOnConnectedDevice();
    } catch (error) {
      logger.error('[BluetoothService] Error setting up device listeners', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) }
      });
      throw error;
    }
  }
  public async scanForDevices(
    onDeviceFound: (device: Device) => void,
    options: {
      timeoutMs?: number;
      broadScan?: boolean;
    } = {}
  ): Promise<void> {
    const { timeoutMs = BLE_TIMING.SCAN_TIMEOUT_MS, broadScan = false } = options;
    try {
      const hasPermission = await this.requestPermissions();
      if (!hasPermission) {
        throw new Error('Bluetooth permissions not granted');
      }
      if (this.bluetoothHandler.isUsingNativeTransport()) {
        await this.scanForDevicesViaNative(onDeviceFound, { timeoutMs, broadScan });
        return;
      }
      const manager = this.bluetoothHandler.getBLEManager();
      const serviceUUIDs = broadScan ? null : [BLE_UUIDS.SERVICE];
      logger.info('[BluetoothService] Starting device scan', {
        uuidFilter: !broadScan ? BLE_UUIDS.SERVICE : 'none'
      });
      manager.startDeviceScan(serviceUUIDs, null, (error, device) => {
        if (error) {
          logger.error('[BluetoothService] Scan error', {
            error: { name: error.name, message: error.message }
          });
          return;
        }
        if (!device) {
          return;
        }
        if (broadScan && device.name) {
          const isAppDeviceDevice = this.isAppDeviceDevice(device);
          if (!isAppDeviceDevice) {
            return;
          }
        }
        if (device.name) {
          logger.debug('[BluetoothService] Found compatible device', {
            name: device.name,
            id: device.id
          });
          onDeviceFound(device);
        }
      });
      return new Promise((resolve) => {
        setTimeout(() => {
          manager.stopDeviceScan();
          logger.info('[BluetoothService] Device scan complete');
          resolve();
        }, timeoutMs);
      });
    } catch (error) {
      logger.error('[BluetoothService] Error scanning for devices', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) }
      });
      throw error;
    }
  }
  private async scanForDevicesViaNative(
    onDeviceFoundCallback: (device: Device) => void,
    options: { timeoutMs: number; broadScan: boolean }
  ): Promise<void> {
    const { timeoutMs, broadScan } = options;
    const discoveredIds = new Set<string>();
    logger.info('[BluetoothService] Starting native device scan', {
      uuidFilter: !broadScan ? BLE_UUIDS.SERVICE : 'none',
      timeoutMs,
    });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      const complete = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        unsubscribeDeviceFound();
        try {
          AppDeviceBLENative.stopScan();
        } catch (stopError) {
          logger.warn('[BluetoothService] Native stopScan failed during cleanup', {
            error: stopError instanceof Error
              ? { name: stopError.name, message: stopError.message }
              : { name: 'Error', message: String(stopError) },
          });
        }
        if (error) {
          reject(error);
          return;
        }
        logger.info('[BluetoothService] Native device scan complete');
        resolve();
      };
      const unsubscribeDeviceFound = onDeviceFound((nativeDevice) => {
        if (!nativeDevice?.id || discoveredIds.has(nativeDevice.id)) {
          return;
        }
        const mappedDevice = this.mapNativeDiscoveredDevice(nativeDevice);
        if (broadScan && mappedDevice.name && !this.isAppDeviceDevice(mappedDevice)) {
          return;
        }
        if (!mappedDevice.name) {
          return;
        }
        discoveredIds.add(mappedDevice.id);
        logger.debug('[BluetoothService] Found compatible native device', {
          name: mappedDevice.name,
          id: mappedDevice.id,
        });
        onDeviceFoundCallback(mappedDevice);
      });
      timeoutHandle = setTimeout(() => complete(), timeoutMs);
      try {
        AppDeviceBLENative.startScan(broadScan);
      } catch (error) {
        complete(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private mapNativeDiscoveredDevice(device: DeviceFoundEvent): Device {
    return {
      id: device.id,
      name: device.name,
      localName: device.name ?? null,
      rssi: device.rssi,
      isConnectable: device.isConnectable,
    } as Device;
  }
  private createNativeConnectionAwaiter(
    deviceId: string,
    timeoutMs: number
  ): { promise: Promise<void>; cancel: () => void } {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let listenerRef: ((event?: DataChangeEvent) => void) | null = null;
    let operationRejectedUnsubscribe: (() => void) | null = null;
    const cleanup = (): void => {
      if (listenerRef) {
        dataChangeEmitter.off(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, listenerRef);
        listenerRef = null;
      }
      if (operationRejectedUnsubscribe) {
        operationRejectedUnsubscribe();
        operationRejectedUnsubscribe = null;
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };
    const promise = new Promise<void>((resolve, reject) => {
      const listener = (event?: DataChangeEvent): void => {
        if (settled) {
          return;
        }
        const eventDeviceId = event?.deviceId ?? event?.entityId;
        if (eventDeviceId !== deviceId) {
          return;
        }
        let isConnected: boolean | undefined;
        if (typeof event?.isConnected === 'boolean') {
          isConnected = event.isConnected;
        } else if (event?.data && typeof event.data === 'object') {
          const nestedData = event.data as Record<string, unknown>;
          if (typeof nestedData.isConnected === 'boolean') {
            isConnected = nestedData.isConnected;
          }
        }
        if (isConnected === true) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
        if (isConnected === false) {
          settled = true;
          cleanup();
          reject(new Error(`Native connection failed for ${deviceId}: ${event?.reason ?? 'unknown'}`));
        }
      };
      listenerRef = listener;
      dataChangeEmitter.on(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, listener);
      operationRejectedUnsubscribe = onOperationRejected((event) => {
        if (settled) {
          return;
        }
        if (event.operation !== 'connect') {
          return;
        }
        if (event.deviceId && event.deviceId !== deviceId) {
          return;
        }
        settled = true;
        cleanup();
        reject(
          new Error(
            `Native connect rejected for ${deviceId}: ${event.reason}` +
            `${event.detail ? ` (${event.detail})` : ''}`
          )
        );
      });
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error(`Native connection timed out for ${deviceId} after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return {
      promise,
      cancel: () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
      },
    };
  }
  private isAppDeviceDevice(device: Device): boolean {
    if (!device.name) {
      return false;
    }
    return (
      BLE_DEVICE_NAME_PATTERNS.TRAK_PLUS.test(device.name) ||
      BLE_DEVICE_NAME_PATTERNS.APP_PLATFORM.test(device.name)
    );
  }
  public async disconnectCurrentDevice(): Promise<void> {
    logger.info('[BluetoothService] Requesting disconnection from current device');
    try {
      await this.bluetoothHandler.disconnectCurrentDevice();
      logger.info('[BluetoothService] Disconnection process completed');
    } catch (error) {
      logger.error('[BluetoothService] Error during disconnectCurrentDevice', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) }
      });
      throw error;
    }
  }
  public disconnectFromCurrentDevice(): void {
    const device = this.bluetoothHandler.getConnectedDevice();
    if (device) {
      this.bluetoothHandler.disconnectFromDevice(device);
      logger.info('[BluetoothService] Disconnected from device', { deviceId: device.id });
    }
  }
  public getConnectedDevice(): Device | undefined {
    return this.bluetoothHandler.getConnectedDevice();
  }
  public async getSavedDevices() {
    return this.deviceService.getSavedDevices();
  }
  public async forgetDevice(deviceId: string): Promise<void> {
    try {
      logger.info('[BluetoothService] Forgetting device', { deviceId });
      const connectedDevice = this.getConnectedDevice();
      if (connectedDevice && connectedDevice.id === deviceId) {
        logger.info('[BluetoothService] Device is connected, disconnecting first', { deviceId });
        await this.disconnectCurrentDevice();
      }
      await this.deviceService.removeDevice(deviceId);
      await this.bluetoothHandler.forgetDevice(deviceId);
      dataChangeEmitter.emit('deviceListUpdated', {
        source: 'BluetoothService',
        entityType: 'device',
        entityId: deviceId,
        reason: 'forgotten'
      });
      logger.info('[BluetoothService] Device forgotten successfully', { deviceId });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[BluetoothService] Failed to forget device', {
        deviceId,
        error: { name: err.name, message: err.message }
      });
      throw err;
    }
  }
  public getBatteryStatus(): { percentage: number | null; isCharging: boolean | null } {
    const status = this.bluetoothHandler.getLastBatteryStatus();
    return {
      percentage: status.percentage,
      isCharging: status.isCharging
    };
  }
  private async requestPermissions(): Promise<boolean> {
    if (Platform.OS === "android") {
      if ((ExpoDevice.platformApiLevel ?? -1) < 31) {
        const locationPermission = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
        if (!locationPermission) {
          logger.warn('[BluetoothService] ACCESS_FINE_LOCATION permission not available');
          return false;
        }
        const granted = await PermissionsAndroid.request(
          locationPermission,
          {
            title: "Location Permission",
            message: "Bluetooth Low Energy requires Location",
            buttonPositive: "OK",
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        return this.requestAndroid31Permissions();
      }
    } else {
      return true;
    }
  }
  private async requestAndroid31Permissions(): Promise<boolean> {
    const scanPermission = PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN;
    const connectPermission = PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT;
    const locationPermission = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
    if (!scanPermission || !connectPermission || !locationPermission) {
      logger.warn('[BluetoothService] One or more Android 12+ permissions not available');
      return false;
    }
    const bluetoothScanPermission = await PermissionsAndroid.request(
      scanPermission,
      {
        title: "Bluetooth Scan Permission",
        message: "App needs permission to scan for Bluetooth devices",
        buttonPositive: "OK",
      }
    );
    const bluetoothConnectPermission = await PermissionsAndroid.request(
      connectPermission,
      {
        title: "Bluetooth Connect Permission",
        message: "App needs permission to connect to Bluetooth devices",
        buttonPositive: "OK",
      }
    );
    const fineLocationPermission = await PermissionsAndroid.request(
      locationPermission,
      {
        title: "Location Permission",
        message: "Bluetooth scanning requires precise location",
        buttonPositive: "OK",
      }
    );
    return (
      bluetoothScanPermission === PermissionsAndroid.RESULTS.GRANTED &&
      bluetoothConnectPermission === PermissionsAndroid.RESULTS.GRANTED &&
      fineLocationPermission === PermissionsAndroid.RESULTS.GRANTED
    );
  }
  public async configureWifi(ssid: string, password: string): Promise<void> {
    const connectedDevice = this.bluetoothHandler.getConnectedDevice();
    if (!connectedDevice) {
      throw new Error("Device must be connected to configure Wi-Fi");
    }
    await this.bluetoothHandler.getProtocolService().sendWifiConfig(ssid, password);
  }
  public async enterOtaMode(): Promise<void> {
    const connectedDevice = this.bluetoothHandler.getConnectedDevice();
    if (!connectedDevice) {
      throw new Error("Device must be connected via BLE to enter OTA mode");
    }
    const connectionState = this.bluetoothHandler.getConnectionState();
    if (connectionState !== ConnectionState.READY) {
      throw new Error(
        `Bluetooth session not ready (${connectionState}). Wait for secure connection before updating.`
      );
    }
    const deviceId = connectedDevice.id;
    logger.info('[BluetoothService] Initiating OTA Flasher Mode entry', {
      deviceId,
    });
    try {
      await this.bluetoothHandler.getProtocolService().sendEnterOtaMode();
      logger.info('[BluetoothService] OTA Flasher Mode command acknowledged', {
        deviceId,
        nextStep: 'Device will reboot into Wi-Fi SoftAP mode',
        expectedSsid: 'AppDevice_Update',
        expectedPassword: '12345678',
      });
    } catch (error) {
      logger.error('[BluetoothService] Failed to enter OTA Flasher Mode', {
        deviceId,
        error: error instanceof Error 
          ? { name: error.name, message: error.message } 
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  public getProtocolService(): AppDeviceProtocolService {
    return this.bluetoothHandler.getProtocolService();
  }
  public getEventSyncService(): EventSyncService {
    return this.bluetoothHandler.getEventSyncService();
  }
  public dispose(): void {
    if (this.signatureCleanupTimer) {
      clearInterval(this.signatureCleanupTimer);
      this.signatureCleanupTimer = null;
    }
    this.recentHitSignatures = [];
    logger.info('[BluetoothService] Disposed - all timers cleared and state reset');
  }
}
