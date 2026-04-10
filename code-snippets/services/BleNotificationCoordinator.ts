import { AppState, NativeModules, Platform } from 'react-native';
import { dataChangeEmitter, dbEvents, deviceEvents, DataChangeEvent } from '../utils/EventEmitter';
import { DeviceService } from './DeviceService';
import { LocalSessionRepository } from '../repositories/LocalSessionRepository';
import { LocalProductRepository } from '../repositories/LocalProductRepository';
import { SessionEvents } from './domain/FrontendSessionService';
import { localNotificationService } from './LocalNotificationService';
import { logger } from '../utils/logger';
export class BleNotificationCoordinator {
  private initialized = false;
  private readonly shouldHandleNotifications =
    Platform.OS !== 'ios' || !NativeModules.AppPlatformBLERestorationModule;
  constructor(
    private readonly deviceService: DeviceService,
    private readonly sessionRepository: LocalSessionRepository,
    private readonly productRepository: LocalProductRepository
  ) {}
  initialize(): void {
    if (this.initialized) {
      return;
    }
    if (!this.shouldHandleNotifications) {
      logger.info('[BleNotificationCoordinator] Native iOS restoration handles notifications; skipping JS coordinator');
      this.initialized = true;
      return;
    }
    dataChangeEmitter.on(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, this.handleDeviceConnection);
    dataChangeEmitter.on(dbEvents.DATA_CHANGED, this.handleSessionEvents);
    this.initialized = true;
  }
  cleanup(): void {
    if (!this.initialized) {
      return;
    }
    dataChangeEmitter.off(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, this.handleDeviceConnection);
    dataChangeEmitter.off(dbEvents.DATA_CHANGED, this.handleSessionEvents);
    this.initialized = false;
  }
  private handleDeviceConnection = async (event?: DataChangeEvent): Promise<void> => {
    if (!event?.isConnected || !event.deviceId) {
      return;
    }
    if (AppState.currentState === 'active') {
      return;
    }
    try {
      const device = await this.deviceService.findDeviceByBluetoothId(event.deviceId);
      if (!device) {
        return;
      }
      const deviceName = device.deviceName || 'Device';
      await localNotificationService.scheduleNotification({
        title: 'Session started',
        body: `Device connected: ${deviceName}`,
        data: {
          type: 'device_connected',
          deviceId: device.id,
          bluetoothId: event.deviceId,
        },
        dedupeKey: `device_connected_${device.id}`,
      });
    } catch (error) {
      logger.warn('[BleNotificationCoordinator] Failed to handle device connection notification', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
    }
  };
  private handleSessionEvents = async (event?: DataChangeEvent): Promise<void> => {
    if (!event || event.source !== SessionEvents.SESSION_STARTED || !event.entityId) {
      return;
    }
    if (AppState.currentState === 'active') {
      return;
    }
    try {
      const session = await this.sessionRepository.getById(event.entityId);
      if (!session) {
        return;
      }
      let productName: string | null = null;
      if (session.primaryProductId) {
        const product = await this.productRepository.getById(session.primaryProductId);
        productName = product?.name ?? null;
      }
      const body = productName
        ? `Product: ${productName}`
        : 'Your device detected a new session.';
      await localNotificationService.scheduleNotification({
        title: 'Session started',
        body,
        data: {
          type: 'session_started',
          sessionId: session.id,
        },
        dedupeKey: `session_started_${session.id}`,
      });
    } catch (error) {
      logger.warn('[BleNotificationCoordinator] Failed to handle session notification', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
    }
  };
}
