import { AppState, AppStateStatus, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { z } from 'zod';
import { authService } from './auth.service';
import { DeviceService } from './DeviceService';
import { FrontendSessionService } from './domain/FrontendSessionService';
import { DeviceStatus } from '../types';
import { dataChangeEmitter, dbEvents, deviceEvents } from '../utils/EventEmitter';
import { logger } from '../utils/logger';
const SessionEventPayloadSchema = z.object({
  eventType: z.string(),
  sessionId: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  batteryPercent: z.number().int().min(0).max(100),
  flags: z.number().int().min(0).max(255),
  parsedFlags: z
    .object({
      sessionActive: z.boolean(),
      isCharging: z.boolean(),
      lowBattery: z.boolean(),
      criticalBattery: z.boolean(),
      wifiConnected: z.boolean(),
      bonded: z.boolean(),
    })
    .optional(),
  peripheralId: z.string(),
  recordedAt: z.number().optional(),
}).strict();
const ConnectionStateSchema = z.object({
  peripheralId: z.string(),
  connected: z.boolean(),
  error: z.string().optional(),
}).strict();
const DiagnosticsSchema = z.object({
  centralState: z.number().int(),
  knownPeripheralCount: z.number().int(),
  pendingEventCount: z.number().int(),
  isForeground: z.boolean(),
  allowConnectionsInForeground: z.boolean(),
  restorationLaunch: z.boolean(),
  lastRestoreAt: z.number().nullable().optional(),
  lastConnectionAttemptAt: z.number().nullable().optional(),
  lastConnectionSuccessAt: z.number().nullable().optional(),
  lastNotificationAt: z.number().nullable().optional(),
  metrics: z
    .object({
      willRestoreStateCalls: z.number().int(),
      peripheralsRestoredCount: z.number().int(),
      connectionAttempts: z.number().int(),
      connectionSuccesses: z.number().int(),
      connectionFailures: z.number().int(),
      disconnects: z.number().int(),
      subscriptionSuccesses: z.number().int(),
      subscriptionFailures: z.number().int(),
      sessionEventsReceived: z.number().int(),
      sessionEventFailures: z.number().int(),
      notificationsScheduled: z.number().int(),
      notificationsSuppressedForeground: z.number().int(),
      notificationsSkippedDedupe: z.number().int(),
      notificationsSkippedAuthorization: z.number().int(),
    })
    .optional(),
}).strict();
type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>;
type NativeRestorationModule = {
  initialize: () => void | Promise<void>;
  setKnownPeripheralIds: (ids: string[]) => void;
  setForegroundState: (isForeground: boolean) => void;
  setAllowConnectionsInForeground: (allow: boolean) => void;
  drainPendingEvents: () => Promise<Record<string, unknown>[]>;
  getConnectionDiagnostics: () => Promise<Record<string, unknown>>;
};
const nativeModule = NativeModules.AppPlatformBLERestorationModule as NativeRestorationModule | undefined;
export class BLERestorationService {
  private eventEmitter: NativeEventEmitter | null = null;
  private subscriptions: Array<{ remove: () => void }> = [];
  private appStateSubscription: { remove: () => void } | null = null;
  private deviceListSubscription: { remove: () => void } | null = null;
  private initialized = false;
  constructor(
    private readonly deviceService: DeviceService,
    private readonly sessionService: FrontendSessionService
  ) {}
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (Platform.OS !== 'ios' || !nativeModule) {
      logger.info('[BLERestorationService] Native BLE restoration module unavailable');
      return;
    }
    try {
      await Promise.resolve(nativeModule.initialize());
      nativeModule.setAllowConnectionsInForeground(false);
      this.eventEmitter = new NativeEventEmitter(nativeModule as never);
      this.subscriptions.push(
        this.eventEmitter.addListener('SessionStarted', this.handleSessionStarted),
        this.eventEmitter.addListener('SessionEnded', this.handleSessionEnded),
        this.eventEmitter.addListener('Heartbeat', this.handleHeartbeat),
        this.eventEmitter.addListener('BatteryStatus', this.handleBatteryStatus),
        this.eventEmitter.addListener('DeviceReady', this.handleDeviceReady),
        this.eventEmitter.addListener('FirmwareUpdateAvailable', this.handleFirmwareUpdate),
        this.eventEmitter.addListener('Calibrated', this.handleCalibrated),
        this.eventEmitter.addListener('ConnectionStateChanged', this.handleConnectionStateChanged)
      );
      this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
      this.deviceListSubscription = {
        remove: () => dataChangeEmitter.off(deviceEvents.DEVICE_LIST_UPDATED, this.handleDeviceListUpdated),
      };
      dataChangeEmitter.on(deviceEvents.DEVICE_LIST_UPDATED, this.handleDeviceListUpdated);
      await this.syncKnownPeripherals();
      await this.processPendingEvents();
      await this.logDiagnostics();
      this.handleAppStateChange(AppState.currentState);
      this.initialized = true;
      logger.info('[BLERestorationService] Initialized');
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[BLERestorationService] Initialization failed', {
        error: { name: err.name, message: err.message },
      });
      throw err;
    }
  }
  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions = [];
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    if (this.deviceListSubscription) {
      this.deviceListSubscription.remove();
      this.deviceListSubscription = null;
    }
    this.initialized = false;
  }
  private handleAppStateChange = (state: AppStateStatus): void => {
    if (!nativeModule) {
      return;
    }
    const isForeground = state === 'active';
    nativeModule.setForegroundState(isForeground);
  };
  private handleDeviceListUpdated = async (): Promise<void> => {
    await this.syncKnownPeripherals();
  };
  private async syncKnownPeripherals(): Promise<void> {
    if (!nativeModule) {
      return;
    }
    try {
      const devices = await this.deviceService.getAllDevices();
      const bluetoothIds = devices
        .map((device) => device.bluetoothId)
        .filter((id): id is string => Boolean(id));
      if (bluetoothIds.length > 0) {
        nativeModule.setKnownPeripheralIds(bluetoothIds);
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[BLERestorationService] Failed to sync known peripherals', {
        error: { name: err.name, message: err.message },
      });
    }
  }
  private async processPendingEvents(): Promise<void> {
    if (!nativeModule) {
      return;
    }
    try {
      const pending = await nativeModule.drainPendingEvents();
      for (const item of pending) {
        this.routeSessionEvent(item);
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[BLERestorationService] Failed to drain pending events', {
        error: { name: err.name, message: err.message },
      });
    }
  }
  private async logDiagnostics(): Promise<void> {
    if (!nativeModule) {
      return;
    }
    try {
      const diagnostics = await nativeModule.getConnectionDiagnostics();
      const parsed = DiagnosticsSchema.safeParse(diagnostics);
      if (!parsed.success) {
        logger.warn('[BLERestorationService] Invalid diagnostics payload', {
          errors: parsed.error.flatten(),
        });
        return;
      }
      logger.info('[BLERestorationService] Native diagnostics', parsed.data);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[BLERestorationService] Failed to fetch diagnostics', {
        error: { name: err.name, message: err.message },
      });
    }
  }
  private handleSessionStarted = (payload: unknown): void => {
    this.routeSessionEvent(payload, 'SessionStarted');
  };
  private handleSessionEnded = (payload: unknown): void => {
    this.routeSessionEvent(payload, 'SessionEnded');
  };
  private handleHeartbeat = (payload: unknown): void => {
    this.routeSessionEvent(payload, 'Heartbeat');
  };
  private handleBatteryStatus = (payload: unknown): void => {
    this.routeSessionEvent(payload, 'BatteryStatus');
  };
  private handleDeviceReady = (payload: unknown): void => {
    this.routeSessionEvent(payload, 'DeviceReady');
  };
  private handleFirmwareUpdate = (payload: unknown): void => {
    this.routeSessionEvent(payload, 'FirmwareUpdateAvailable');
  };
  private handleCalibrated = (payload: unknown): void => {
    this.routeSessionEvent(payload, 'Calibrated');
  };
  private handleConnectionStateChanged = async (payload: unknown): Promise<void> => {
    const parsed = ConnectionStateSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn('[BLERestorationService] Invalid connection payload', {
        errors: parsed.error.flatten(),
      });
      return;
    }
    const { peripheralId, connected } = parsed.data;
    const device = await this.deviceService.findDeviceByBluetoothId(peripheralId);
    if (!device) {
      return;
    }
    const batteryLevel = device.batteryLevel ?? undefined;
    await this.deviceService.updateDeviceConnection(
      device.id,
      connected ? DeviceStatus.ACTIVE : DeviceStatus.OFFLINE,
      batteryLevel
    );
    if (connected) {
      dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
        deviceId: peripheralId,
        isConnected: true,
        source: 'BLERestorationService',
      });
    }
  };
  private routeSessionEvent(payload: unknown, eventName?: string): void {
    const parsed = SessionEventPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn('[BLERestorationService] Invalid session event payload', {
        errors: parsed.error.flatten(),
        eventName,
      });
      return;
    }
    switch (parsed.data.eventType) {
      case 'SessionStarted':
        void this.processSessionStarted(parsed.data);
        break;
      case 'SessionEnded':
        void this.processSessionEnded(parsed.data);
        break;
      case 'Heartbeat':
        void this.processHeartbeat(parsed.data);
        break;
      case 'BatteryStatus':
        void this.processBattery(parsed.data);
        break;
      case 'DeviceReady':
        void this.processDeviceReady(parsed.data);
        break;
      case 'FirmwareUpdateAvailable':
        void this.processFirmwareUpdate(parsed.data);
        break;
      case 'Calibrated':
        void this.processCalibrated(parsed.data);
        break;
      default:
        logger.debug('[BLERestorationService] Unhandled event type', {
          eventType: parsed.data.eventType,
        });
    }
  }
  private async processSessionStarted(event: SessionEventPayload): Promise<void> {
    const device = await this.deviceService.findDeviceByBluetoothId(event.peripheralId);
    const userId = device?.userId ?? (await authService.getCachedUser())?.id ?? null;
    if (!userId) {
      logger.warn('[BLERestorationService] Session started without user context');
      return;
    }
    const clientSessionId = this.buildClientSessionId(event);
    const timestamp = new Date().toISOString();
    try {
      const { session } = await this.sessionService.startSession(userId, undefined, {
        timestamp,
        clientSessionId,
      });
      if (device) {
        await this.deviceService.updateDeviceConnection(
          device.id,
          DeviceStatus.ACTIVE,
          event.batteryPercent
        );
      }
      dataChangeEmitter.emit(dbEvents.DATA_CHANGED, {
        source: 'BLE_RESTORATION_SESSION_STARTED',
        entityType: 'session',
        entityId: session.id,
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[BLERestorationService] Failed to start session', {
        error: { name: err.name, message: err.message },
      });
    }
  }
  private async processSessionEnded(event: SessionEventPayload): Promise<void> {
    const device = await this.deviceService.findDeviceByBluetoothId(event.peripheralId);
    const userId = device?.userId ?? (await authService.getCachedUser())?.id ?? null;
    if (!userId) {
      return;
    }
    const clientSessionId = this.buildClientSessionId(event);
    const session = await this.sessionService.getSession(clientSessionId);
    if (!session) {
      return;
    }
    try {
      await this.sessionService.endSession(session.id);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[BLERestorationService] Failed to end session', {
        error: { name: err.name, message: err.message },
      });
    }
  }
  private async processHeartbeat(event: SessionEventPayload): Promise<void> {
    await this.updateDeviceTelemetry(event);
  }
  private async processBattery(event: SessionEventPayload): Promise<void> {
    await this.updateDeviceTelemetry(event);
  }
  private async processDeviceReady(event: SessionEventPayload): Promise<void> {
    await this.updateDeviceTelemetry(event);
  }
  private async processFirmwareUpdate(event: SessionEventPayload): Promise<void> {
    await this.updateDeviceTelemetry(event);
  }
  private async processCalibrated(event: SessionEventPayload): Promise<void> {
    await this.updateDeviceTelemetry(event);
  }
  private async updateDeviceTelemetry(event: SessionEventPayload): Promise<void> {
    const device = await this.deviceService.findDeviceByBluetoothId(event.peripheralId);
    if (!device) {
      return;
    }
    try {
      await this.deviceService.updateDeviceConnection(
        device.id,
        DeviceStatus.ACTIVE,
        event.batteryPercent
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[BLERestorationService] Failed to update device telemetry', {
        error: { name: err.name, message: err.message },
      });
    }
  }
  private buildClientSessionId(event: SessionEventPayload): string {
    return `ble:${event.peripheralId}:${event.sessionId}`;
  }
}
