import { createContext, useContext } from "react";
import { Alert, PermissionsAndroid, Platform, AppState, AppStateStatus } from "react-native";
import * as ExpoDevice from "expo-device";
import { BleError, BleManager, Characteristic, Device, BleErrorCode, Subscription } from 'react-native-ble-plx';
import base64 from "react-native-base64";
import { storageService } from "../services/StorageService";
import { dataChangeEmitter, deviceEvents } from "../utils/EventEmitter";
import {
    AppDeviceProtocolService,
    EventSyncService,
    HitEvent,
    HelloAckPayload,
    MessageType,
    PROTOCOL_SOF,
    ErrorCode,
    buildSimpleMessage,
    uint8ArrayToBase64,
    base64ToUint8Array,
    shouldUseNativeTransport,
    BatteryStatusPayload,
} from "../services/ble";
import { AppDeviceBLENative } from "../native/AppDeviceBLE";
import {
    APP_DEVICE_SERVICE_UUID,
    APP_DEVICE_CHARACTERISTIC_UUID,
    BLE_MTU_SIZE,
    BLE_CONNECTION_TIMEOUT_MS,
    BLE_HEARTBEAT_INTERVAL_MS,
    CIRCUIT_BREAKER_THRESHOLD,
    CIRCUIT_BREAKER_RESET_MS,
    DEVICE_UUIDS_STORAGE_KEY,
    HANDSHAKE_TIMEOUT_MS,
} from "../constants/ble";
const APP_PLATFORM_SERVICE_UUID = APP_DEVICE_SERVICE_UUID;
const APP_PLATFORM_CHARACTERISTIC_UUID = APP_DEVICE_CHARACTERISTIC_UUID;
const CONNECTION_TIMEOUT_MS = BLE_CONNECTION_TIMEOUT_MS;
const MTU_REQUEST_SIZE = BLE_MTU_SIZE;
enum ConnectionState {
    DISCONNECTED = 'DISCONNECTED',
    CONNECTING = 'CONNECTING',
    CONNECTED = 'CONNECTED',
    HANDSHAKING = 'HANDSHAKING',
    READY = 'READY',
    DISCONNECTING = 'DISCONNECTING',
}
interface CircuitBreakerState {
    failures: number;
    lastFailureTime: number;
    isOpen: boolean;
}
interface StateRestoredEvent {
    connectedPeripherals: Device[];
}
type ConnectedDevice = {
    device: Device;
    serviceUUID: string;
    characteristicUUID: string
}
type StoredDeviceUUIDs = {
    [deviceId: string]: {
        serviceUUID: string;
        characteristicUUID: string;
    }
}
interface BatteryStatus {
    percentage: number | null;
    isCharging: boolean | null;
    voltageMilliVolts?: number | null;
    source?: 'HELLO_ACK' | 'MSG_BATTERY_STATUS' | null;
    receivedAt?: number | null;
}
type BatteryStatusCallback = (percentage: number | null, isCharging: boolean | null) => void;
type HitEventCallback = (event: HitEvent, absoluteTimestamp: Date | null) => void;
type DeviceInfoCallback = (info: HelloAckPayload) => void;
export class BluetoothHandler {
    private static instance: BluetoothHandler | null = null;
    public static getInstance(): BluetoothHandler {
        if (!BluetoothHandler.instance) {
            BluetoothHandler.instance = new BluetoothHandler();
        }
        return BluetoothHandler.instance;
    }
    public static resetInstance(): void {
        if (BluetoothHandler.instance) {
            BluetoothHandler.instance.cleanup();
            BluetoothHandler.instance = null;
        }
    }
    private readonly useNativeTransport: boolean;
    private manager: BleManager | null = null;
    private connectedDevice: ConnectedDevice | null;
    private isRestoringState: boolean = false;
    private monitoringActive: boolean = false;
    private reconnectAttemptTimer: NodeJS.Timeout | null = null;
    private restorationMetrics = {
        attempts: 0,
        noState: 0,
        success: 0,
        failures: 0,
    };
    private lastBatteryStatus: BatteryStatus = { percentage: null, isCharging: null };
    private onBatteryStatusCallback: BatteryStatusCallback | null = null;
    private onBondingErrorCallback: ((deviceId: string) => void) | null = null;
    private appState: AppStateStatus = AppState.currentState;
    private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
    private connectionHealthTimer: NodeJS.Timeout | null = null;
    private lastSuccessfulWrite: number = 0;
    private connectionHealthCheckInterval: number = BLE_HEARTBEAT_INTERVAL_MS;
    private maxReconnectAttempts: number = 5;
    private currentReconnectAttempt: number = 0;
    private isDormantReconnectionMode: boolean = false;
    private dormantReconnectionTimer: NodeJS.Timeout | null = null;
    private dormantReconnectionDeviceId: string | null = null;
    private readonly DORMANT_RECONNECTION_INTERVAL_MS = 60000; 
    private handshakeTimeoutTimer: NodeJS.Timeout | null = null;
    private consecutiveHandshakeFailures: Map<string, number> = new Map();
    private readonly MAX_CONSECUTIVE_HANDSHAKE_FAILURES = 3;
    private handshakeTimeoutCounts: Map<string, number> = new Map();
    private connectionReadyTime: number = 0;
    private connectionInstabilityCount: Map<string, number> = new Map();
    private readonly MAX_INSTABILITY_COUNT = 3;
    private readonly STABLE_CONNECTION_THRESHOLD_MS = 20000; 
    private isSleepDisconnect: boolean = false;
    private shortConnectionBondFailureCount: Map<string, number> = new Map();
    private readonly SHORT_CONNECTION_BOND_FAILURE_MS = 4000; 
    private readonly MAX_SHORT_CONNECTION_BOND_FAILURES = 2; 
    private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
    private circuitBreaker: CircuitBreakerState = {
        failures: 0,
        lastFailureTime: 0,
        isOpen: false,
    };
    private currentConnectionAttemptId: string = "";
    private lastCompletedConnectionId: string = "";
    private pendingRestorations: StateRestoredEvent[] = [];
    private isInitialized: boolean = false;
    private protocolService: AppDeviceProtocolService;
    private eventSyncService: EventSyncService;
    private onHitEventCallback: HitEventCallback | null = null;
    private onDeviceInfoCallback: DeviceInfoCallback | null = null;
    private constructor() {
        if (BluetoothHandler.instance) {
            const error = new Error(
                '[BluetoothHandler] CRITICAL: Singleton violation! ' +
                'Use BluetoothHandler.getInstance() instead of new BluetoothHandler(). ' +
                'A second instance would cause "Split-Brain" bug where services talk to different handlers.'
            );
            console.error(error.message);
            throw error;
        }
        this.useNativeTransport = shouldUseNativeTransport();
        if (this.useNativeTransport) {
            console.log('[BluetoothHandler] v2.6.0: Using NATIVE TRANSPORT (Swift module owns CBCentralManager)');
            console.log('[BluetoothHandler] BleManager will NOT be created - single BLE stack architecture');
            this.manager = null;
        } else {
            console.log('[BluetoothHandler] Initializing BleManager with state restoration');
            this.manager = new BleManager({
                restoreStateIdentifier: "AppPlatformBluetoothRestoreID",
                restoreStateFunction: this.handleStateRestoration.bind(this)
            });
        }
        this.connectedDevice = null;
        this.protocolService = new AppDeviceProtocolService();
        this.eventSyncService = new EventSyncService(this.protocolService);
        this.setupAppStateListener();
        this.initializeAsync();
    }
    private requireManager(): BleManager {
        if (!this.manager) {
            throw new Error('[BluetoothHandler] BleManager not initialized (native transport mode?)');
        }
        return this.manager;
    }
    private async initializeAsync(): Promise<void> {
        try {
            await this.eventSyncService.initialize();
            this.protocolService.initialize(async (data: string) => {
                if (this.useNativeTransport) {
                    try {
                        await AppDeviceBLENative.write(data);
                    } catch (error) {
                        console.warn('[BluetoothHandler] Native BLE write failed:', error);
                        throw error;
                    }
                    return;
                }
                if (!this.connectedDevice) {
                    console.warn('[BluetoothHandler] Cannot send data: No device connected');
                    throw new Error('BLE_NOT_CONNECTED');
                }
                if (!this.manager) {
                    console.warn('[BluetoothHandler] Cannot send data: BleManager not initialized');
                    throw new Error('BLE_NOT_CONNECTED');
                }
                try {
                    await this.manager.writeCharacteristicWithoutResponseForDevice(
                        this.connectedDevice.device.id,
                        this.connectedDevice.serviceUUID,
                        this.connectedDevice.characteristicUUID,
                        data
                    );
                } catch (error) {
                    console.warn('[BluetoothHandler] BLE write failed:', error);
                    throw error;
                }
            });
            this.protocolService.setOnError((errorCode: ErrorCode, message: string) => {
                console.error(`[BluetoothHandler] Protocol error: ${message} (Code: ${errorCode})`);
                if (errorCode === ErrorCode.ERR_NOT_BONDED || 
                    message.includes('Not Bonded')) {
                    console.error('[BluetoothHandler] BONDING ERROR DETECTED VIA PROTOCOL');
                    if (this.connectedDevice) {
                        this.handleBondingError(this.connectedDevice.device.id);
                    }
                }
            });
            this.protocolService.setOnDeviceSleep(() => {
                console.log('[BluetoothHandler] Device signaled sleep entry (idle timeout)');
                console.log('[BluetoothHandler] Setting isSleepDisconnect flag for graceful disconnect');
                this.stopConnectionHealthMonitoring();
                this.isSleepDisconnect = true;
                if (this.useNativeTransport) {
                    try {
                        AppDeviceBLENative.setDeviceSleepFlag();
                        console.log('[BluetoothHandler] Forwarded sleep signal to native layer');
                    } catch (e) {
                        console.warn('[BluetoothHandler] Failed to forward sleep signal to native:', e);
                    }
                }
            });
            this.protocolService.setOnBatteryStatus((batteryPayload: BatteryStatusPayload) => {
                console.log('[BluetoothHandler] MSG_BATTERY_STATUS received from protocol');
                this.applyBatteryStatus({
                    percentage: batteryPayload.percentage,
                    isCharging: batteryPayload.isCharging,
                    voltageMilliVolts: batteryPayload.voltageMilliVolts,
                    source: 'MSG_BATTERY_STATUS',
                });
            });
            this.eventSyncService.setOnHandshakeComplete((info) => {
                console.log('[BluetoothHandler] Handshake complete via EventSyncService');
                this.clearHandshakeTimeout();
                this.connectionState = ConnectionState.READY;
                this.connectionReadyTime = Date.now();
                if (this.connectedDevice) {
                    const deviceId = this.connectedDevice.device.id;
                    this.consecutiveHandshakeFailures.delete(deviceId);
                    this.handshakeTimeoutCounts.delete(deviceId);
                    this.connectionInstabilityCount.delete(deviceId);
                    this.shortConnectionBondFailureCount.delete(deviceId); 
                    console.log(`[BluetoothHandler] Cleared all failure counters for ${deviceId}`);
                }
                if (typeof info.batteryPercent === 'number') {
                    console.log('[BluetoothHandler] Forwarding HELLO_ACK battery to applyBatteryStatus');
                    this.applyBatteryStatus({
                        percentage: info.batteryPercent,
                        isCharging: info.isCharging,
                        source: 'HELLO_ACK',
                    });
                } else {
                    console.warn('[BluetoothHandler] HELLO_ACK did not contain battery data');
                }
                if (this.onDeviceInfoCallback) {
                    this.onDeviceInfoCallback(info);
                }
            });
            this.isInitialized = true;
            console.log('[BluetoothHandler] Async initialization complete');
            if (this.pendingRestorations.length > 0) {
                console.log(`[BluetoothHandler] Processing ${this.pendingRestorations.length} pending state restorations`);
                for (const restoration of this.pendingRestorations) {
                    await this.processStateRestoration(restoration);
                }
                this.pendingRestorations = [];
            }
        } catch (error) {
            console.error('[BluetoothHandler] Async initialization failed:', error);
        }
    }
    private setupAppStateListener(): void {
        this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange.bind(this));
        console.log('[BluetoothHandler] AppState listener registered');
    }
    private handleAppStateChange(nextAppState: AppStateStatus): void {
        console.log(`[BluetoothHandler] AppState transition: ${this.appState} → ${nextAppState}`);
        if (this.appState.match(/inactive|background/) && nextAppState === 'active') {
            console.log('[BluetoothHandler] App foregrounded, verifying connection health...');
            if (this.connectedDevice) {
                this.verifyConnectionHealth()
                    .then(isHealthy => {
                        if (!isHealthy) {
                            console.warn('[BluetoothHandler] Connection unhealthy after foreground, attempting reconnect');
                            this.handleSilentDisconnection();
                        } else {
                            console.log('[BluetoothHandler] Connection healthy after foreground');
                            this.startConnectionHealthMonitoring();
                            if (this.connectedDevice) {
                                const deviceId = this.connectedDevice.device.id;
                                console.log(`[BluetoothHandler] Emitting connection state event for foreground sync: ${deviceId}`);
                                dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                                    deviceId,
                                    isConnected: true,
                                    reason: 'foreground_health_verified',
                                });
                            }
                        }
                    })
                    .catch(err => {
                        const error = err instanceof Error ? err : new Error(String(err));
                        console.error('[BluetoothHandler] Error verifying connection health:', error.message);
                        this.handleSilentDisconnection();
                    });
            }
        } else if (this.appState === 'active' && nextAppState.match(/inactive|background/)) {
            console.log('[BluetoothHandler] App backgrounding. Maintaining health checks to prevent iOS timeout.');
        }
        this.appState = nextAppState;
    }
    private startConnectionHealthMonitoring(): void {
        if (this.connectionHealthTimer) {
            return; 
        }
        console.log('[BluetoothHandler] Starting connection health monitoring');
        this.connectionHealthTimer = setInterval(() => {
            if (!this.connectedDevice) {
                this.stopConnectionHealthMonitoring();
                return;
            }
            const appStateInfo = this.appState !== 'active' ? ` (app state: ${this.appState})` : '';
            this.verifyConnectionHealth()
                .then(isHealthy => {
                    if (!isHealthy) {
                        console.warn(`[BluetoothHandler] Connection health check FAILED${appStateInfo}`);
                        this.handleSilentDisconnection();
                    }
                })
                .catch(err => {
                    const error = err instanceof Error ? err : new Error(String(err));
                    console.error(`[BluetoothHandler] Connection health check error${appStateInfo}:`, error.message);
                    this.handleSilentDisconnection();
                });
        }, this.connectionHealthCheckInterval);
    }
    private stopConnectionHealthMonitoring(): void {
        if (this.connectionHealthTimer) {
            clearInterval(this.connectionHealthTimer);
            this.connectionHealthTimer = null;
            console.log('[BluetoothHandler] Stopped connection health monitoring');
        }
    }
    private startHandshakeTimeout(): void {
        this.clearHandshakeTimeout(); 
        console.log(`[BluetoothHandler] Starting handshake timeout (${HANDSHAKE_TIMEOUT_MS}ms)`);
        this.handshakeTimeoutTimer = setTimeout(() => {
            if (this.connectionState === ConnectionState.HANDSHAKING) {
                console.error('[BluetoothHandler] HANDSHAKE TIMEOUT - handshake did not complete in time');
                this.handleHandshakeTimeout();
            }
        }, HANDSHAKE_TIMEOUT_MS);
    }
    private clearHandshakeTimeout(): void {
        if (this.handshakeTimeoutTimer) {
            clearTimeout(this.handshakeTimeoutTimer);
            this.handshakeTimeoutTimer = null;
            console.log('[BluetoothHandler] Cleared handshake timeout timer');
        }
    }
    private async handleHandshakeTimeout(): Promise<void> {
        if (this.appState !== 'active') {
            console.log(`[BluetoothHandler] Handshake timeout ignored (App state: ${this.appState})`);
            this.startHandshakeTimeout();
            return;
        }
        console.error('[BluetoothHandler] Handling handshake timeout - resetting connection');
        const deviceId = this.connectedDevice?.device.id;
        if (deviceId) {
            const failures = (this.consecutiveHandshakeFailures.get(deviceId) || 0) + 1;
            this.consecutiveHandshakeFailures.set(deviceId, failures);
            const timeouts = (this.handshakeTimeoutCounts.get(deviceId) || 0) + 1;
            this.handshakeTimeoutCounts.set(deviceId, timeouts);
            console.warn(`[BluetoothHandler] Handshake failure ${failures}/${this.MAX_CONSECUTIVE_HANDSHAKE_FAILURES} for ${deviceId}`);
            console.warn(`[BluetoothHandler] Total handshake timeouts for this device: ${timeouts}`);
            if (failures >= this.MAX_CONSECUTIVE_HANDSHAKE_FAILURES) {
                console.error(`[BluetoothHandler] Device ${deviceId} unreachable at protocol level after ${failures} failures. Forgetting.`);
                this.consecutiveHandshakeFailures.delete(deviceId);
                await this.cleanup();
                this.handleBondingError(deviceId, false); 
                Alert.alert(
                    'Connection Issue',
                    'We cannot verify the device identity after multiple attempts. The device has been removed.\n\nPlease scan and pair it again.',
                    [{ text: 'OK' }]
                );
                return; 
            }
        }
        this.recordConnectionFailure();
        await this.cleanup();
        if (deviceId && !this.circuitBreaker.isOpen) {
            console.log('[BluetoothHandler] Attempting reconnection after handshake timeout...');
            setTimeout(async () => {
                try {
                    await this.connectToDevice(deviceId);
                } catch (error) {
                    console.error('[BluetoothHandler] Reconnection after handshake timeout failed:', error);
                }
            }, 2000); 
        } else if (this.circuitBreaker.isOpen) {
            console.warn('[BluetoothHandler] Circuit breaker OPEN - not attempting reconnection');
        }
    }
    private async verifyConnectionHealth(): Promise<boolean> {
        if (!this.connectedDevice) {
            return false;
        }
        if (this.useNativeTransport) {
            try {
                const heartbeatFrame = buildSimpleMessage(MessageType.MSG_HEARTBEAT);
                const base64Heartbeat = uint8ArrayToBase64(heartbeatFrame);
                AppDeviceBLENative.write(base64Heartbeat);
                this.lastSuccessfulWrite = Date.now();
                console.log('[BluetoothHandler] Native heartbeat sent for health check');
                return true;
            } catch (error) {
                console.error('[BluetoothHandler] Native heartbeat failed:', error);
                return false;
            }
        }
        const manager = this.requireManager();
        try {
            const isConnected = await manager.isDeviceConnected(this.connectedDevice.device.id);
            if (!isConnected) {
                console.warn('[BluetoothHandler] BLE stack reports device NOT connected');
                return false;
            }
            const heartbeatFrame = buildSimpleMessage(MessageType.MSG_HEARTBEAT);
            const base64Heartbeat = uint8ArrayToBase64(heartbeatFrame);
            await manager.writeCharacteristicWithResponseForDevice(
                this.connectedDevice.device.id,
                this.connectedDevice.serviceUUID,
                this.connectedDevice.characteristicUUID,
                base64Heartbeat
            );
            this.lastSuccessfulWrite = Date.now();
            const appStateInfo = this.appState !== 'active' ? ` (app state: ${this.appState})` : '';
            console.log(`[BluetoothHandler] Connection health check: HEALTHY (HEARTBEAT successful)${appStateInfo}`);
            return true;
        } catch (error: unknown) {
            const err = error instanceof Error ? error : new Error(String(error));
            const errorMessage = err.message.toLowerCase();
            const isSecurityError = 
                errorMessage.includes('encryption') ||
                errorMessage.includes('rejected') ||
                errorMessage.includes('201') ||
                errorMessage.includes('514') ||
                errorMessage.includes('insufficient') ||
                errorMessage.includes('not bonded');
            if (isSecurityError) {
                console.warn('[BluetoothHandler] Health check: Security/encryption race detected -', err.message);
                console.warn('[BluetoothHandler] Treating as HEALTHY to prevent "Heartbeat Suicide" loop. OS will complete encryption.');
                return true;
            }
            console.error('[BluetoothHandler] Connection health check: UNHEALTHY -', err.message);
            return false;
        }
    }
    private handleSilentDisconnection(): void {
        if (this.connectionState === ConnectionState.CONNECTING) {
            console.log('[BluetoothHandler] Silent disconnection ignored - connection attempt in progress');
            return;
        }
        if (this.connectionState === ConnectionState.HANDSHAKING) {
            console.log('[BluetoothHandler] Silent disconnection ignored - handshake in progress');
            return;
        }
        console.log('[BluetoothHandler] Handling silent disconnection');
        const disconnectedDeviceId = this.connectedDevice?.device.id;
        this.stopConnectionHealthMonitoring();
        this.monitoringActive = false;
        this.connectedDevice = null;
        this.connectionState = ConnectionState.DISCONNECTED;
        this.protocolService.cleanup();
        this.eventSyncService.cleanup();
        this.lastBatteryStatus = { percentage: null, isCharging: null };
        if (this.onBatteryStatusCallback) {
            this.onBatteryStatusCallback(null, null);
        }
        if (disconnectedDeviceId) {
            dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                deviceId: disconnectedDeviceId,
                isConnected: false,
                reason: 'silent_disconnection',
            });
        }
        if (disconnectedDeviceId && !this.isCircuitBreakerOpen()) {
            console.log(`[BluetoothHandler] Attempting reconnection (app state: ${this.appState})`);
            this.attemptReconnectionWithBackoff(disconnectedDeviceId);
        }
    }
    private attemptReconnectionWithBackoff(deviceId: string, delayMs: number = 1000): void {
        if (this.currentReconnectAttempt >= this.maxReconnectAttempts) {
            console.warn(`[BluetoothHandler] Max aggressive reconnect attempts (${this.maxReconnectAttempts}) reached for ${deviceId}`);
            console.log('[BluetoothHandler] Entering dormant reconnection mode - will retry periodically');
            this.currentReconnectAttempt = 0;
            if (!this.isDormantReconnectionMode) {
                if (this.appState === 'active') {
                    Alert.alert(
                        'Connection Lost',
                        'Unable to reconnect immediately. The app will continue trying in the background. You can also reconnect manually from the Devices screen.',
                        [{ text: 'OK' }]
                    );
                }
                this.enterDormantReconnectionMode(deviceId);
            }
            return;
        }
        if (this.reconnectAttemptTimer) {
            clearTimeout(this.reconnectAttemptTimer);
        }
        this.currentReconnectAttempt++;
        const attemptNumber = this.currentReconnectAttempt;
        console.log(`[BluetoothHandler] Reconnect attempt ${attemptNumber}/${this.maxReconnectAttempts} in ${delayMs / 1000}s`);
        this.reconnectAttemptTimer = setTimeout(async () => {
            if (this.connectedDevice?.device.id === deviceId) {
                console.log(`[BluetoothHandler] Already reconnected to ${deviceId}, cancelling attempt ${attemptNumber}`);
                this.currentReconnectAttempt = 0;
                return;
            }
            if (this.appState !== 'active') {
                console.log(`[BluetoothHandler] App in background (state: ${this.appState}), using native autoConnect for persistence`);
            }
            console.log(`[BluetoothHandler] Executing reconnect attempt ${attemptNumber} for ${deviceId} with autoConnect=true`);
            if (this.useNativeTransport) {
                console.log(`[BluetoothHandler] Reconnecting via native transport: ${deviceId}`);
                AppDeviceBLENative.connect(deviceId);
                return;
            }
            const manager = this.requireManager();
            try {
                const device = await manager.connectToDevice(deviceId, {
                    autoConnect: true,
                    requestMTU: MTU_REQUEST_SIZE,
                });
                await this.handleSuccessfulReconnection(device);
                console.log(`[BluetoothHandler] Reconnection successful on attempt ${attemptNumber}`);
                this.currentReconnectAttempt = 0;
                this.exitDormantReconnectionMode(); 
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                console.error(`[BluetoothHandler] Reconnect attempt ${attemptNumber} failed:`, err.message);
                const nextDelay = Math.min(delayMs * 2, 30000);
                this.attemptReconnectionWithBackoff(deviceId, nextDelay);
            }
        }, delayMs);
    }
    private enterDormantReconnectionMode(deviceId: string): void {
        if (this.isDormantReconnectionMode && this.dormantReconnectionDeviceId === deviceId) {
            console.log(`[BluetoothHandler] Already in dormant reconnection mode for ${deviceId}`);
            return;
        }
        console.log(`[BluetoothHandler] Entering dormant reconnection mode for ${deviceId}`);
        console.log(`[BluetoothHandler] Will retry every ${this.DORMANT_RECONNECTION_INTERVAL_MS / 1000} seconds`);
        this.isDormantReconnectionMode = true;
        this.dormantReconnectionDeviceId = deviceId;
        if (this.dormantReconnectionTimer) {
            clearTimeout(this.dormantReconnectionTimer);
        }
        this.scheduleDormantReconnectionAttempt(deviceId);
    }
    private scheduleDormantReconnectionAttempt(deviceId: string): void {
        if (!this.isDormantReconnectionMode) {
            return;
        }
        this.dormantReconnectionTimer = setTimeout(async () => {
            if (!this.isDormantReconnectionMode || this.dormantReconnectionDeviceId !== deviceId) {
                console.log('[BluetoothHandler] Dormant reconnection cancelled - mode exited');
                return;
            }
            if (this.connectedDevice?.device.id === deviceId) {
                console.log(`[BluetoothHandler] Already reconnected to ${deviceId}, exiting dormant mode`);
                this.exitDormantReconnectionMode();
                return;
            }
            if (this.isCircuitBreakerOpen()) {
                console.warn('[BluetoothHandler] Dormant reconnection: Circuit breaker OPEN, scheduling next attempt');
                this.scheduleDormantReconnectionAttempt(deviceId);
                return;
            }
            console.log(`[BluetoothHandler] Dormant reconnection attempt for ${deviceId} with autoConnect=true`);
            if (this.useNativeTransport) {
                console.log(`[BluetoothHandler] Dormant reconnecting via native transport: ${deviceId}`);
                AppDeviceBLENative.connect(deviceId);
                return;
            }
            const manager = this.requireManager();
            try {
                const device = await manager.connectToDevice(deviceId, {
                    autoConnect: true,
                    requestMTU: MTU_REQUEST_SIZE,
                });
                await this.handleSuccessfulReconnection(device);
                console.log('[BluetoothHandler] Dormant reconnection successful!');
                this.exitDormantReconnectionMode();
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                console.log(`[BluetoothHandler] Dormant reconnection attempt failed: ${err.message}`);
                console.log(`[BluetoothHandler] Scheduling next dormant attempt in ${this.DORMANT_RECONNECTION_INTERVAL_MS / 1000}s`);
                this.scheduleDormantReconnectionAttempt(deviceId);
            }
        }, this.DORMANT_RECONNECTION_INTERVAL_MS);
    }
    private exitDormantReconnectionMode(): void {
        if (!this.isDormantReconnectionMode) {
            return;
        }
        console.log('[BluetoothHandler] Exiting dormant reconnection mode');
        this.isDormantReconnectionMode = false;
        this.dormantReconnectionDeviceId = null;
        if (this.dormantReconnectionTimer) {
            clearTimeout(this.dormantReconnectionTimer);
            this.dormantReconnectionTimer = null;
        }
    }
    private async handleSuccessfulReconnection(device: Device): Promise<void> {
        console.log(`[BluetoothHandler] Handling successful reconnection for ${device.id}`);
        await device.discoverAllServicesAndCharacteristics();
        const storedUUIDs = await this.getStoredUUIDs();
        let serviceUUID = APP_PLATFORM_SERVICE_UUID;
        let characteristicUUID = APP_PLATFORM_CHARACTERISTIC_UUID;
        if (storedUUIDs && storedUUIDs[device.id]) {
            const deviceUUIDs = storedUUIDs[device.id];
            serviceUUID = deviceUUIDs?.serviceUUID || APP_PLATFORM_SERVICE_UUID;
            characteristicUUID = deviceUUIDs?.characteristicUUID || APP_PLATFORM_CHARACTERISTIC_UUID;
        }
        const services = await device.services();
        const service = services.find(s => s.uuid === serviceUUID);
        if (!service) {
            throw new Error(`Service ${serviceUUID} not found on reconnected device`);
        }
        const characteristics = await service.characteristics();
        const characteristic = characteristics.find(c => c.uuid === characteristicUUID);
        if (!characteristic) {
            throw new Error(`Characteristic ${characteristicUUID} not found on reconnected device`);
        }
        await this.storeDeviceUUIDs(device.id, serviceUUID, characteristicUUID);
        this.connectedDevice = {
            device: device,
            serviceUUID: serviceUUID,
            characteristicUUID: characteristicUUID,
        };
        this.connectionState = ConnectionState.CONNECTED;
        this.protocolService.resetForNewConnection();
        this.eventSyncService.resetForNewConnection();
        this.streamOnConnectedDevice();
        this.startConnectionHealthMonitoring();
        this.resetCircuitBreaker();
        this.connectionState = ConnectionState.HANDSHAKING;
        this.startHandshakeTimeout();
        setTimeout(() => {
            this.eventSyncService.onDeviceConnected().catch(err => {
                console.error('[BluetoothHandler] Handshake after reconnection failed:', err);
            });
        }, 100);
    }
    public cleanup(): void {
        console.log('[BluetoothHandler] Cleaning up resources');
        if (this.appStateSubscription) {
            this.appStateSubscription.remove();
            this.appStateSubscription = null;
            console.log('[BluetoothHandler] AppState listener removed');
        }
        this.stopConnectionHealthMonitoring();
        this.clearHandshakeTimeout();
        if (this.reconnectAttemptTimer) {
            clearTimeout(this.reconnectAttemptTimer);
            this.reconnectAttemptTimer = null;
        }
        this.protocolService.cleanup();
        this.eventSyncService.cleanup();
        this.connectionState = ConnectionState.DISCONNECTED;
        this.resetCircuitBreaker();
        if (this.connectedDevice) {
            this.disconnectCurrentDevice().catch(err => {
                const error = err instanceof Error ? err : new Error(String(err));
                console.error('[BluetoothHandler] Error during cleanup disconnect:', error.message);
            });
        }
    }
    public getEventSyncService(): EventSyncService {
        return this.eventSyncService;
    }
    public getProtocolService(): AppDeviceProtocolService {
        return this.protocolService;
    }
    public getConnectionState(): ConnectionState {
        return this.connectionState;
    }
    public isDeviceSleeping(): boolean {
        return this.isSleepDisconnect;
    }
    private async handleStateRestoration(restoredState: StateRestoredEvent | null): Promise<void> {
        try {
            if (!restoredState) {
                console.log("[BluetoothHandler] No BLE state to restore.");
                this.restorationMetrics.noState += 1;
                this.logRestorationMetrics('no_state');
                return;
            }
            if (!this.isInitialized) {
                console.log("[BluetoothHandler] Not yet initialized, queueing state restoration");
                this.pendingRestorations.push(restoredState);
                return;
            }
            this.restorationMetrics.attempts += 1;
            await this.processStateRestoration(restoredState);
        } catch (error) {
            this.restorationMetrics.failures += 1;
            console.error('[BluetoothHandler] Error during state restoration:', error);
            this.logRestorationMetrics('error');
        }
    }
    private async processStateRestoration(restoredState: StateRestoredEvent): Promise<void> {
        if (this.useNativeTransport) {
            console.log("[BluetoothHandler] Skipping BLE state restoration (native transport mode)");
            return;
        }
        try {
            this.isRestoringState = true;
            console.log("[BluetoothHandler] Processing BLE state restoration...");
            const connectedPeripherals = restoredState.connectedPeripherals || [];
            console.log(`[BluetoothHandler] Found ${connectedPeripherals.length} connected peripheral(s) in restored state.`);
            if (connectedPeripherals.length === 0) {
                console.log("[BluetoothHandler] No connected peripherals to restore.");
                this.restorationMetrics.noState += 1;
                this.logRestorationMetrics('empty_restoration');
                return;
            }
            const storedUUIDs = await this.getStoredUUIDs();
            let restoredCount = 0;
            for (const peripheral of connectedPeripherals) {
                if (!peripheral || !peripheral.id) {
                    console.warn("[BluetoothHandler] Invalid peripheral in restored state");
                    continue;
                }
                console.log(`[BluetoothHandler] Attempting to restore connection for device: ${peripheral.id}`);
                if (storedUUIDs && storedUUIDs[peripheral.id]) {
                    const storedDevice = storedUUIDs[peripheral.id];
                    const serviceUUID = storedDevice?.serviceUUID;
                    const characteristicUUID = storedDevice?.characteristicUUID;
                    if (!serviceUUID || !characteristicUUID) {
                        console.warn(`[BluetoothHandler] Incomplete UUIDs for device ${peripheral.id}`);
                        continue;
                    }
                    console.log(`[BluetoothHandler] Found stored UUIDs for ${peripheral.id}: ${serviceUUID}, ${characteristicUUID}`);
                    try {
                        const isConnected = await this.requireManager().isDeviceConnected(peripheral.id);
                        if (!isConnected) {
                            console.warn(`[BluetoothHandler] Device ${peripheral.id} not actually connected, skipping restoration`);
                            continue;
                        }
                        this.connectedDevice = {
                            device: peripheral,
                            serviceUUID,
                            characteristicUUID
                        };
                        this.connectionState = ConnectionState.CONNECTED;
                        dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                            deviceId: peripheral.id,
                            isConnected: true,
                            reason: 'state_restoration',
                        });
                        if (!this.monitoringActive) {
                            this.streamOnConnectedDevice();
                            console.log(`[BluetoothHandler] Successfully re-attached monitor for ${peripheral.id}`);
                            this.startConnectionHealthMonitoring();
                            this.connectionState = ConnectionState.HANDSHAKING;
                            this.eventSyncService.onDeviceConnected().catch(err => {
                                console.error('[BluetoothHandler] Handshake during restoration failed:', err);
                            });
                            restoredCount += 1;
                        } else {
                            console.log(`[BluetoothHandler] Monitor already active for ${peripheral.id}, skipping setup`);
                        }
                    } catch (monitorError) {
                        console.error(`[BluetoothHandler] Error re-attaching monitor for ${peripheral.id}:`, monitorError);
                    }
                } else {
                    console.warn(`[BluetoothHandler] No stored UUIDs found for device ${peripheral.id}`);
                }
            }
            if (restoredCount > 0) {
                this.restorationMetrics.success += 1;
                this.logRestorationMetrics(`restored_${restoredCount}`);
            }
        } catch (error) {
            this.restorationMetrics.failures += 1;
            console.error('[BluetoothHandler] Error processing state restoration:', error);
            this.logRestorationMetrics('process_error');
        } finally {
            this.isRestoringState = false;
        }
    }
    private logRestorationMetrics(context: string): void {
        console.log('[BluetoothHandler] BLE restoration metrics', {
            context,
            attempts: this.restorationMetrics.attempts,
            noState: this.restorationMetrics.noState,
            success: this.restorationMetrics.success,
            failures: this.restorationMetrics.failures,
        });
    }
    private async getStoredUUIDs(): Promise<StoredDeviceUUIDs | null> {
        try {
            const storedUUIDs = await storageService.getValue<StoredDeviceUUIDs>(DEVICE_UUIDS_STORAGE_KEY);
            return storedUUIDs;
        } catch (error) {
            console.error('[BluetoothHandler] Error retrieving stored UUIDs:', error);
            return null;
        }
    }
    private async storeDeviceUUIDs(deviceId: string, serviceUUID: string, characteristicUUID: string): Promise<void> {
        try {
            const existingUUIDs = await this.getStoredUUIDs() || {};
            const existingEntry = existingUUIDs[deviceId];
            if (
                existingEntry?.serviceUUID === serviceUUID &&
                existingEntry?.characteristicUUID === characteristicUUID
            ) {
                return;
            }
            existingUUIDs[deviceId] = { serviceUUID, characteristicUUID };
            await storageService.setValue(DEVICE_UUIDS_STORAGE_KEY, existingUUIDs);
            console.log(`[BluetoothHandler] Stored UUIDs for device ${deviceId}`);
        } catch (error) {
            console.error('[BluetoothHandler] Error storing device UUIDs:', error);
        }
    }
    private async persistNativeKnownDevice(
        deviceId: string,
        serviceUUID: string,
        characteristicUUID: string
    ): Promise<void> {
        try {
            await this.storeDeviceUUIDs(deviceId, serviceUUID, characteristicUUID);
            if (!this.useNativeTransport) {
                return;
            }
            const storedUUIDs = await this.getStoredUUIDs();
            if (!storedUUIDs) {
                return;
            }
            const knownIds = Object.keys(storedUUIDs);
            if (knownIds.length === 0) {
                return;
            }
            AppDeviceBLENative.setKnownPeripheralIds(knownIds);
        } catch (error) {
            console.warn('[BluetoothHandler] Failed to persist native known device IDs:', error);
        }
    }
    public setOnBondingErrorCallback(callback: (deviceId: string) => void): void {
        this.onBondingErrorCallback = callback;
    }
    public handleBondingError(deviceId: string, showAlert: boolean = true): void {
        if (this.isSleepDisconnect) {
            console.log(`[BluetoothHandler] EC-SLEEP-BOND-FIX-001: Ignoring bonding error for ${deviceId} — device is in sleep disconnect mode (false positive from abrupt power-off)`);
            return;
        }
        console.error(`[BluetoothHandler] Handling bonding error for device ${deviceId}`);
        this.disconnectCurrentDevice().catch(e => console.error('[BluetoothHandler] Error disconnecting during bonding error handling:', e));
        this.removeDeviceUUIDs(deviceId).catch(e => console.error('[BluetoothHandler] Error removing UUIDs:', e));
        this.consecutiveHandshakeFailures.delete(deviceId);
        this.handshakeTimeoutCounts.delete(deviceId);
        this.connectionInstabilityCount.delete(deviceId);
        if (this.onBondingErrorCallback) {
            this.onBondingErrorCallback(deviceId);
        } else {
            console.warn('[BluetoothHandler] No bonding error callback registered!');
        }
        if (showAlert && this.appState === 'active') {
            Alert.alert(
                'Pairing Update Required',
                'The device security keys have changed (firmware update?).\n\n' +
                '1. The device has been removed from the app.\n' +
                '2. IMPORTANT: Go to iOS Settings > Bluetooth and "Forget" the App Device device before scanning again.',
                [{ text: 'OK' }]
            );
        }
    }
    private async clearDeviceState(
        deviceId: string,
        options: { notify: boolean },
    ): Promise<void> {
        console.log(`[BluetoothHandler] Clearing device state: ${deviceId} (notify=${options.notify})`);
        if (this.dormantReconnectionDeviceId === deviceId) {
            this.exitDormantReconnectionMode();
        }
        if (this.connectedDevice?.device.id === deviceId) {
            await this.disconnectCurrentDevice();
        }
        await this.removeDeviceUUIDs(deviceId);
        this.consecutiveHandshakeFailures.delete(deviceId);
        this.handshakeTimeoutCounts.delete(deviceId);
        this.connectionInstabilityCount.delete(deviceId);
        this.shortConnectionBondFailureCount.delete(deviceId); 
        if (options.notify && this.onBondingErrorCallback) {
            this.onBondingErrorCallback(deviceId);
        }
    }
    public async forgetDevice(deviceId: string): Promise<void> {
        console.log(`[BluetoothHandler] Forgetting device: ${deviceId} (bilateral bond clearing enabled)`);
        const isConnectedToThisDevice = this.connectedDevice?.device.id === deviceId;
        if (isConnectedToThisDevice) {
            console.log('[BluetoothHandler] Device is connected - sending CLEAR_BONDS command to ESP32');
            try {
                const clearBondsPromise = this.protocolService.sendClearBonds();
                const timeoutPromise = new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error('CLEAR_BONDS timeout')), 8000);
                });
                await Promise.race([clearBondsPromise, timeoutPromise]);
                console.log('[BluetoothHandler] ESP32 acknowledged CLEAR_BONDS - bond storage cleared on device');
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.warn('[BluetoothHandler] CLEAR_BONDS failed or timed out - proceeding with local cleanup', {
                    error: errorMessage,
                    note: 'Device may still have stale bond. User should factory reset device if pairing issues persist.',
                });
            }
        } else {
            console.log('[BluetoothHandler] Device not connected - cannot send CLEAR_BONDS command');
            console.log('[BluetoothHandler] Note: If device has stale bond, user may need to factory reset it');
        }
        await this.clearDeviceState(deviceId, { notify: true });
        console.log(`[BluetoothHandler] Device forgotten: ${deviceId}`);
        console.log('[BluetoothHandler] REMINDER: User should also "Forget This Device" in iOS Settings > Bluetooth');
    }
    public async cleanupDeviceState(deviceId: string): Promise<void> {
        await this.clearDeviceState(deviceId, { notify: false });
        console.log(`[BluetoothHandler] Device state cleaned: ${deviceId}`);
    }
    private handleSpecificBondingErrors(error: BleError | Error, deviceId: string): boolean {
        const msg = (error.message || '').toLowerCase();
        const errorCode = (error as BleError).errorCode;
        const isBondingError = 
            msg.includes('peer removed pairing') ||        
            msg.includes('encryption is insufficient') ||  
            msg.includes('insufficient authentication') ||
            msg.includes('authorization is insufficient') ||
            errorCode === BleErrorCode.ServicesDiscoveryFailed; 
        if (isBondingError) {
            console.error(`[BluetoothHandler] CRITICAL: Bonding mismatch detected for ${deviceId}. Device likely flashed.`);
            this.handleBondingError(deviceId, true);
            return true;
        }
        return false;
    }
    private async removeDeviceUUIDs(deviceId: string): Promise<void> {
         try {
            const existingUUIDs = await this.getStoredUUIDs() || {};
            if (existingUUIDs[deviceId]) {
                delete existingUUIDs[deviceId];
                await storageService.setValue(DEVICE_UUIDS_STORAGE_KEY, existingUUIDs);
                console.log(`[BluetoothHandler] Removed stored UUIDs for device ${deviceId}`);
                if (this.useNativeTransport) {
                    const remainingIds = Object.keys(existingUUIDs);
                    AppDeviceBLENative.setKnownPeripheralIds(remainingIds);
                    console.log(
                        `[BluetoothHandler] Native known IDs synced after removal: ${remainingIds.length} remaining`
                    );
                }
            }
        } catch (error) {
            console.error('[BluetoothHandler] Error removing device UUIDs:', error);
        }
    }
    public async checkBondHealth(deviceId: string): Promise<{
        isHealthy: boolean;
        shortConnectionFailures: number;
        handshakeFailures: number;
        hasStoredUUIDs: boolean;
        recommendation: 'proceed' | 'caution' | 'forget_required';
        message: string;
    }> {
        const shortFailures = this.shortConnectionBondFailureCount.get(deviceId) || 0;
        const handshakeFailures = this.consecutiveHandshakeFailures.get(deviceId) || 0;
        const storedUUIDs = await this.getStoredUUIDs();
        const hasStoredUUIDs = !!storedUUIDs?.[deviceId];
        let isHealthy = true;
        let recommendation: 'proceed' | 'caution' | 'forget_required' = 'proceed';
        let message = 'Bond appears healthy.';
        if (shortFailures >= this.MAX_SHORT_CONNECTION_BOND_FAILURES) {
            isHealthy = false;
            recommendation = 'forget_required';
            message = `Ghost Bond detected: ${shortFailures} short connection failures. ` +
                      'Device bonding keys likely mismatched. Please forget the device in iOS Bluetooth settings.';
        } else if (shortFailures > 0) {
            isHealthy = false;
            recommendation = 'caution';
            message = `${shortFailures} short connection failure(s) detected. ` +
                      'Connection may be unstable. Consider forgetting and re-pairing if issues persist.';
        }
        if (handshakeFailures >= 3) {
            isHealthy = false;
            recommendation = 'forget_required';
            message = `${handshakeFailures} consecutive handshake failures. ` +
                      'Device may need to be forgotten and re-paired.';
        } else if (handshakeFailures > 0 && recommendation === 'proceed') {
            recommendation = 'caution';
            message = `${handshakeFailures} handshake failure(s). Monitor connection stability.`;
        }
        console.log(`[BluetoothHandler] Bond health check for ${deviceId}:`, {
            isHealthy,
            shortFailures,
            handshakeFailures,
            hasStoredUUIDs,
            recommendation,
        });
        return {
            isHealthy,
            shortConnectionFailures: shortFailures,
            handshakeFailures,
            hasStoredUUIDs,
            recommendation,
            message,
        };
    }
    public clearBondFailureCounters(deviceId: string): void {
        this.shortConnectionBondFailureCount.delete(deviceId);
        this.consecutiveHandshakeFailures.delete(deviceId);
        this.handshakeTimeoutCounts.delete(deviceId);
        this.connectionInstabilityCount.delete(deviceId);
        console.log(`[BluetoothHandler] Cleared bond failure counters for ${deviceId}`);
    }
    public setOnDataCallback(_callback: (rawTimestamp: string, timestamp: string, duration: number) => void): void {
        console.warn('[BluetoothHandler] setOnDataCallback is DEPRECATED. Binary protocol uses EventSyncService.setOnProcessedHitEvent()');
    }
    public setOnBatteryStatusCallback(callback: BatteryStatusCallback | null): void {
        this.onBatteryStatusCallback = callback;
    }
    public setOnHitEventCallback(callback: HitEventCallback | null): void {
        this.onHitEventCallback = callback;
    }
    public notifyHitEvent(
        eventId: number,
        timestamp: Date,
        durationMs: number,
        bootCount: number
    ): void {
        if (this.onHitEventCallback) {
            const hitEvent: HitEvent = {
                eventId,
                timestampMs: timestamp.getTime(),
                bootCount,
                durationMs,
                timestamp: 0, 
                flags: 0,
                reserved: [0, 0, 0, 0, 0], 
            };
            this.onHitEventCallback(hitEvent, timestamp);
        }
    }
    public setOnDeviceInfoCallback(callback: DeviceInfoCallback | null): void {
        this.onDeviceInfoCallback = callback;
    }
    public getLastBatteryStatus(): BatteryStatus {
        return { ...this.lastBatteryStatus };
    }
    private applyBatteryStatus(update: {
        percentage: number | null;
        isCharging: number | boolean | null;
        voltageMilliVolts?: number | null;
        source: 'HELLO_ACK' | 'MSG_BATTERY_STATUS';
    }): void {
        const { percentage, isCharging, voltageMilliVolts, source } = update;
        const receivedAt = Date.now();
        if (percentage !== null) {
            if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
                console.error(`[BluetoothHandler] applyBatteryStatus: Invalid percentage ${percentage} from ${source}, rejecting update`);
                return;
            }
        }
        let chargingBool: boolean | null = null;
        if (typeof isCharging === 'boolean') {
            chargingBool = isCharging;
        } else if (typeof isCharging === 'number') {
            chargingBool = isCharging === 1;
        }
        const prev = this.lastBatteryStatus;
        const changed =
            prev.percentage !== percentage ||
            prev.isCharging !== chargingBool ||
            prev.voltageMilliVolts !== voltageMilliVolts;
        if (!changed) {
            console.log(`[BluetoothHandler] applyBatteryStatus: No change detected from ${source}, skipping`);
            return;
        }
        const newStatus: BatteryStatus = {
            percentage,
            isCharging: chargingBool,
            voltageMilliVolts: voltageMilliVolts ?? null,
            source,
            receivedAt,
        };
        this.lastBatteryStatus = newStatus;
        console.log(`[BluetoothHandler] applyBatteryStatus: Updated from ${source}`, {
            percentage,
            isCharging: chargingBool,
            voltageMilliVolts,
        });
        if (this.onBatteryStatusCallback) {
            this.onBatteryStatusCallback(percentage, chargingBool);
        } else {
            console.warn('[BluetoothHandler] applyBatteryStatus: onBatteryStatusCallback is not registered, service layer will not receive update');
        }
        dataChangeEmitter.emit(deviceEvents.DEVICE_BATTERY_UPDATED, {
            deviceId: this.connectedDevice?.device.id ?? 'unknown',
            data: {
                percentage,
                isCharging: chargingBool,
                voltageMilliVolts,
                source,
            },
            reason: 'battery_status_updated',
        });
    }
    public async requestBatteryStatus(): Promise<void> {
        if (!this.connectedDevice) {
            console.warn("[BluetoothHandler] Cannot request battery status: No device connected.");
            return;
        }
        console.log('[BluetoothHandler] Battery status is received automatically via binary protocol');
    }
    public async connectToDevice(deviceId: string): Promise<void> {
        if (this.useNativeTransport) {
            console.log(`[BluetoothHandler] Connecting via native transport: ${deviceId}`);
            if (this.isCircuitBreakerOpen()) {
                throw new Error('Connection attempts temporarily disabled due to repeated failures');
            }
            if (this.reconnectAttemptTimer) {
                clearTimeout(this.reconnectAttemptTimer);
                this.reconnectAttemptTimer = null;
            }
            this.exitDormantReconnectionMode();
            if (this.connectionState === ConnectionState.CONNECTING || this.connectionState === ConnectionState.HANDSHAKING) {
                console.warn(`[BluetoothHandler] Connection already in progress (state: ${this.connectionState})`);
                return;
            }
            this.connectionState = ConnectionState.CONNECTING;
            AppDeviceBLENative.connect(deviceId);
            return;
        }
        const manager = this.requireManager();
        if (this.isCircuitBreakerOpen()) {
            const error = new Error('Connection attempts temporarily disabled due to repeated failures');
            console.error(`[BluetoothHandler] Circuit breaker OPEN: ${error.message}`);
            throw error;
        }
        if (this.reconnectAttemptTimer) {
            clearTimeout(this.reconnectAttemptTimer);
            this.reconnectAttemptTimer = null;
            console.log("[BluetoothHandler] Cleared pending auto-reconnect before new connect request.");
        }
        this.exitDormantReconnectionMode();
        if (this.connectionState === ConnectionState.CONNECTING || this.connectionState === ConnectionState.HANDSHAKING) {
            console.warn(`[BluetoothHandler] Connection already in progress (state: ${this.connectionState})`);
            return;
        }
        const connectionAttemptId = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.currentConnectionAttemptId = connectionAttemptId;
        console.log(`[BluetoothHandler] Starting connection attempt: ${connectionAttemptId}`);
        if (this.connectedDevice?.device.id === deviceId) {
            if (this.monitoringActive && this.connectionState === ConnectionState.READY) {
                console.log(`[BluetoothHandler] Already connected and monitoring device: ${deviceId}`);
                return;
            } else {
                console.log(`[BluetoothHandler] Already connected to ${deviceId}, ensuring stream is active.`);
                this.streamOnConnectedDevice();
                return;
            }
        }
        if (this.connectedDevice && this.connectedDevice.device.id !== deviceId) {
            console.log(`[BluetoothHandler] Disconnecting from previous device: ${this.connectedDevice.device.id}`);
            this.connectionState = ConnectionState.DISCONNECTING;
            try {
                await manager.cancelDeviceConnection(this.connectedDevice.device.id);
                console.log(`[BluetoothHandler] Successfully cancelled previous connection.`);
            } catch (disconnectError: unknown) {
                const err = disconnectError instanceof Error ? disconnectError : new Error(String(disconnectError));
                console.warn(`[BluetoothHandler] Error during cancellation: ${err.message}. Proceeding.`);
            } finally {
                this.connectedDevice = null;
                this.monitoringActive = false;
                this.connectionState = ConnectionState.DISCONNECTED;
            }
        }
        this.connectionState = ConnectionState.CONNECTING;
        this.connectedDevice = null;
        let connectionTimeoutId: NodeJS.Timeout | null = null;
        let deviceConnection: Device | null = null;
        try {
            console.log(`[BluetoothHandler] Attempting to connect to device: ${deviceId}`);
            manager.stopDeviceScan();
            await new Promise(resolve => setTimeout(resolve, 500));
            const storedUUIDs = await this.getStoredUUIDs();
            const isBondedDevice = !!storedUUIDs?.[deviceId];
            if (isBondedDevice) {
                console.log(`[BluetoothHandler] EC-IOS-RPA-SECURITY-001: Bonded device detected, adding 1500ms delay for IRK resolution`);
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
            console.log(`[BluetoothHandler] Attempting direct connection to: ${deviceId}`);
            const timeoutPromise = new Promise<never>((_, reject) => {
                connectionTimeoutId = setTimeout(() => {
                    reject(new Error(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`));
                }, CONNECTION_TIMEOUT_MS);
            });
            deviceConnection = await Promise.race([
                manager.connectToDevice(deviceId, {
                    requestMTU: MTU_REQUEST_SIZE, 
                    autoConnect: false, 
                }),
                timeoutPromise,
            ]);
            if (connectionTimeoutId) {
                clearTimeout(connectionTimeoutId);
                connectionTimeoutId = null;
            }
            if (this.connectionState !== ConnectionState.CONNECTING) {
                console.warn(`[BluetoothHandler] State changed during connection (now: ${this.connectionState}), aborting`);
                await manager.cancelDeviceConnection(deviceId);
                return;
            }
            if (this.currentConnectionAttemptId !== connectionAttemptId) {
                console.warn(`[BluetoothHandler] Stale connection attempt detected (${connectionAttemptId}), aborting in favor of ${this.currentConnectionAttemptId}`);
                await manager.cancelDeviceConnection(deviceId);
                return;
            }
            await deviceConnection.discoverAllServicesAndCharacteristics();
            if (this.connectionState !== ConnectionState.CONNECTING) {
                console.warn(`[BluetoothHandler] State changed during discovery, aborting`);
                await manager.cancelDeviceConnection(deviceId);
                return;
            }
            if (this.currentConnectionAttemptId !== connectionAttemptId) {
                console.warn(`[BluetoothHandler] Stale connection attempt detected after discovery (${connectionAttemptId}), aborting`);
                await manager.cancelDeviceConnection(deviceId);
                return;
            }
            const service = (await deviceConnection.services()).find(s => s.uuid === APP_PLATFORM_SERVICE_UUID);
            if (!service) {
                throw new Error(`AppPlatform Service (UUID: ${APP_PLATFORM_SERVICE_UUID}) not found on device.`);
            }
            const characteristic = (await service.characteristics()).find(c => c.uuid === APP_PLATFORM_CHARACTERISTIC_UUID);
            if (!characteristic) {
                throw new Error(`AppPlatform Characteristic (UUID: ${APP_PLATFORM_CHARACTERISTIC_UUID}) not found.`);
            }
            await this.storeDeviceUUIDs(deviceId, service.uuid, characteristic.uuid);
            if (this.connectionState !== ConnectionState.CONNECTING) {
                console.warn(`[BluetoothHandler] State changed before finalization, aborting`);
                await manager.cancelDeviceConnection(deviceId);
                return;
            }
            if (this.currentConnectionAttemptId !== connectionAttemptId) {
                console.warn(`[BluetoothHandler] Stale connection attempt detected at finalization (${connectionAttemptId}), aborting`);
                await manager.cancelDeviceConnection(deviceId);
                return;
            }
            this.connectedDevice = {
                device: deviceConnection,
                serviceUUID: service.uuid,
                characteristicUUID: characteristic.uuid
            };
            this.connectionState = ConnectionState.CONNECTED;
            this.lastCompletedConnectionId = connectionAttemptId;
            console.log(`[BluetoothHandler] Connected to device ${deviceId}, MTU: ${MTU_REQUEST_SIZE}, attemptId: ${connectionAttemptId}`);
            dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                deviceId,
                isConnected: true,
            });
            this.protocolService.resetForNewConnection();
            this.eventSyncService.resetForNewConnection();
            this.streamOnConnectedDevice();
            this.startConnectionHealthMonitoring();
            this.currentReconnectAttempt = 0;
            this.resetCircuitBreaker();
            this.connectionState = ConnectionState.HANDSHAKING;
            this.startHandshakeTimeout();
            setTimeout(() => {
                this.eventSyncService.onDeviceConnected().catch(err => {
                    console.error('[BluetoothHandler] Handshake failed:', err);
                });
            }, 100); 
        } catch (error) {
            if (connectionTimeoutId) {
                clearTimeout(connectionTimeoutId);
            }
            if (deviceConnection) {
                try {
                    await manager.cancelDeviceConnection(deviceId);
                } catch (cancelError) {
                    console.warn('[BluetoothHandler] Error cancelling failed connection:', cancelError);
                }
            }
            this.recordConnectionFailure();
            console.error(`[BluetoothHandler] Error connecting to device ${deviceId}:`, error);
            const errorObj = error instanceof Error ? error : new Error(String(error));
            if (this.handleSpecificBondingErrors(errorObj as BleError, deviceId)) {
                throw error;
            }
            this.connectedDevice = null;
            this.monitoringActive = false;
            this.connectionState = ConnectionState.DISCONNECTED;
            throw error;
        } finally {
            manager.stopDeviceScan();
        }
    }
    private isCircuitBreakerOpen(): boolean {
        if (!this.circuitBreaker.isOpen) {
            return false;
        }
        const timeSinceLastFailure = Date.now() - this.circuitBreaker.lastFailureTime;
        if (timeSinceLastFailure >= CIRCUIT_BREAKER_RESET_MS) {
            console.log('[BluetoothHandler] Circuit breaker reset after timeout');
            this.resetCircuitBreaker();
            return false;
        }
        return true;
    }
    private recordConnectionFailure(): void {
        this.circuitBreaker.failures++;
        this.circuitBreaker.lastFailureTime = Date.now();
        if (this.circuitBreaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
            this.circuitBreaker.isOpen = true;
            console.warn(`[BluetoothHandler] Circuit breaker OPENED after ${this.circuitBreaker.failures} failures`);
            if (this.appState === 'active') {
                Alert.alert(
                    'Connection Issues',
                    `Multiple connection failures detected. Automatic reconnection paused for ${CIRCUIT_BREAKER_RESET_MS / 1000} seconds.`,
                    [{ text: 'OK' }]
                );
            }
        }
    }
    private resetCircuitBreaker(): void {
        this.circuitBreaker = {
            failures: 0,
            lastFailureTime: 0,
            isOpen: false,
        };
    }
    public async disconnectCurrentDevice(): Promise<void> {
        if (this.useNativeTransport) {
            console.log("[BluetoothHandler] Disconnecting via native transport");
            this.stopConnectionHealthMonitoring();
            this.clearHandshakeTimeout();
            this.monitoringActive = false;
            this.connectionState = ConnectionState.DISCONNECTING;
            AppDeviceBLENative.disconnect();
            return;
        }
        if (!this.connectedDevice) {
            console.log("[BluetoothHandler] No device currently connected. Nothing to disconnect.");
            return;
        }
        const deviceToDisconnect = this.connectedDevice.device;
        const deviceId = deviceToDisconnect.id;
        console.log(`[BluetoothHandler] User initiated disconnect from device: ${deviceId}`);
        this.connectionState = ConnectionState.DISCONNECTING;
        try {
            this.stopConnectionHealthMonitoring();
            this.clearHandshakeTimeout();
            this.monitoringActive = false;
            if (!this.manager) {
                console.warn("[BluetoothHandler] BleManager not available, skipping connection cancel");
            } else {
                await this.manager.cancelDeviceConnection(deviceToDisconnect.id);
                console.log(`[BluetoothHandler] Connection cancelled for ${deviceToDisconnect.id}.`);
            }
        } catch (error: unknown) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.error(`[BluetoothHandler] Error during manual disconnection from ${deviceToDisconnect.id}:`, err.message);
        } finally {
            this.connectedDevice = null;
            this.monitoringActive = false;
            this.connectionState = ConnectionState.DISCONNECTED;
            this.lastBatteryStatus = { percentage: null, isCharging: null };
            if (this.onBatteryStatusCallback) {
                this.onBatteryStatusCallback(null, null);
            }
            if (this.reconnectAttemptTimer) {
                clearTimeout(this.reconnectAttemptTimer);
                this.reconnectAttemptTimer = null;
                this.currentReconnectAttempt = 0; 
                console.log("[BluetoothHandler] Cleared pending reconnect attempts due to manual disconnect.");
            }
            dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                deviceId,
                isConnected: false,
                reason: 'user_initiated',
            });
            console.log("[BluetoothHandler] Current device state cleared after manual disconnect attempt.");
        }
    }
    public disconnectFromDevice(deviceToDisconnect?: Device, isSystemDisconnect: boolean = false) {
        if (this.useNativeTransport) {
            if (!isSystemDisconnect) {
                console.log('[BluetoothHandler] disconnectFromDevice called in native mode - delegating to native module');
                AppDeviceBLENative.disconnect();
            }
            return;
        }
        const targetDevice = deviceToDisconnect || this.connectedDevice?.device;
        if (targetDevice) {
            console.log(`[BluetoothHandler] Disconnecting from device: ${targetDevice.id}. System initiated: ${isSystemDisconnect}`);
            if (!isSystemDisconnect) {
                this.connectionState = ConnectionState.DISCONNECTING;
            }
            if (isSystemDisconnect) {
                this.stopConnectionHealthMonitoring();
            }
            if (isSystemDisconnect || (this.connectedDevice && this.connectedDevice.device.id === targetDevice.id)) {
                this.requireManager().cancelDeviceConnection(targetDevice.id)
                    .then(() => console.log(`[BluetoothHandler] Connection successfully cancelled for ${targetDevice.id} via disconnectFromDevice.`))
                    .catch((err: unknown) => {
                        const error = err instanceof Error ? err : new Error(String(err));
                        console.error(`[BluetoothHandler] Error cancelling connection for ${targetDevice.id} in disconnectFromDevice:`, error.message);
                    });
            }
            if (this.connectedDevice?.device.id === targetDevice.id) {
                this.connectedDevice = null;
                this.connectionState = ConnectionState.DISCONNECTED;
                this.lastBatteryStatus = { percentage: null, isCharging: null };
                if (this.onBatteryStatusCallback) {
                    this.onBatteryStatusCallback(null, null);
                }
                dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                    deviceId: targetDevice.id,
                    isConnected: false,
                    reason: isSystemDisconnect ? 'system_disconnect' : 'manual_disconnect',
                });
            }
            this.monitoringActive = false;
            if (this.reconnectAttemptTimer && isSystemDisconnect) {
                clearTimeout(this.reconnectAttemptTimer);
                this.reconnectAttemptTimer = null;
            }
        } else {
            console.log("[BluetoothHandler] No device specified or connected to disconnect.");
            this.connectedDevice = null;
            this.connectionState = ConnectionState.DISCONNECTED;
            this.lastBatteryStatus = { percentage: null, isCharging: null };
            if (this.onBatteryStatusCallback) {
                this.onBatteryStatusCallback(null, null);
            }
        }
    }
    public streamOnConnectedDevice() {
        if (this.connectedDevice === null) {
            console.error("[BluetoothHandler] Tried to stream with no device connected");
            return;
        }
        if (this.monitoringActive) {
            console.log(`[BluetoothHandler] Monitoring already active for device: ${this.connectedDevice.device.id}`);
            return;
        }
        if (this.useNativeTransport) {
            this.monitoringActive = true;
            console.log(
                `[BluetoothHandler] Native transport active — ` +
                `monitoring handled by native module for ${this.connectedDevice.device.id}`
            );
            return;
        }
        try {
            if (this.reconnectAttemptTimer) {
                clearTimeout(this.reconnectAttemptTimer);
                this.reconnectAttemptTimer = null;
            }
            const { device, serviceUUID, characteristicUUID } = this.connectedDevice;
            console.log(`[BluetoothHandler] Setting up monitoring for ${serviceUUID}, ${characteristicUUID} on ${device.id}`);
            const subscription = device.monitorCharacteristicForService(
                serviceUUID,
                characteristicUUID,
                (error, characteristic) => {
                    this.handleBluetoothConnection(error, characteristic, subscription);
                }
            );
            this.monitoringActive = true; 
            console.log(`[BluetoothHandler] Monitoring successfully set up for ${device.id}`);
        } catch (error) {
            console.error("[BluetoothHandler] Error starting stream:", error);
            this.monitoringActive = false; 
        }
    }
    private async handleBluetoothConnection(
        error: BleError | null,
        characteristic: Characteristic | null,
        subscription: Subscription 
    ): Promise<void> {
        if (error) {
            if (this.connectionState === ConnectionState.DISCONNECTING) {
                console.log('[BluetoothHandler] Ignoring stream error during manual disconnection');
                return;
            }
            console.error("[BluetoothHandler] Stream error:", error.message);
            console.log(`[BluetoothHandler] Error code: ${error.errorCode}, Reason: ${error.reason}`);
            const disconnectedDevice = this.connectedDevice?.device; 
            this.monitoringActive = false; 
            if (disconnectedDevice && this.handleSpecificBondingErrors(error, disconnectedDevice.id)) {
                return;
            }
            const errorMessage = error.message.toLowerCase();
            if (error.errorCode === BleErrorCode.DeviceDisconnected ||
                error.errorCode === BleErrorCode.OperationCancelled || 
                errorMessage.includes("was disconnected")) {
                console.log(`[BluetoothHandler] Device ${disconnectedDevice?.id} disconnected by system/error.`);
                if (this.isSleepDisconnect) {
                    console.log('[BluetoothHandler] Device-initiated sleep disconnect (EC-IDLE-SLEEP-001)');
                    console.log('[BluetoothHandler] Handling gracefully - no error alerts, no circuit breaker');
                    this.isSleepDisconnect = false;
                    this.stopConnectionHealthMonitoring();
                    this.monitoringActive = false;
                    this.connectedDevice = null;
                    this.connectionState = ConnectionState.DISCONNECTED;
                    this.protocolService.cleanup();
                    this.eventSyncService.cleanup('device_sleep');
                    this.lastBatteryStatus = { percentage: null, isCharging: null };
                    if (this.onBatteryStatusCallback) {
                        this.onBatteryStatusCallback(null, null);
                    }
                    if (disconnectedDevice) {
                        dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                            deviceId: disconnectedDevice.id,
                            isConnected: false,
                            reason: 'device_sleep', 
                        });
                        console.log(`[BluetoothHandler] Starting auto-reconnect for sleeping device ${disconnectedDevice.id}`);
                        this.attemptReconnectionWithBackoff(disconnectedDevice.id);
                    }
                    return; 
                }
                if (disconnectedDevice && this.connectionState === ConnectionState.READY) {
                    const stableConnectionDuration = Date.now() - this.connectionReadyTime;
                    const IDLE_SLEEP_HEURISTIC_THRESHOLD_MS = 55000; 
                    if (stableConnectionDuration > IDLE_SLEEP_HEURISTIC_THRESHOLD_MS) {
                        console.log(`[BluetoothHandler] EC-RACE-TO-SLEEP: Disconnect after ${stableConnectionDuration}ms stable connection`);
                        console.log('[BluetoothHandler] Assuming device sleep (MSG_SLEEP may have been lost)');
                        console.log('[BluetoothHandler] Handling gracefully - no error alerts, starting silent reconnect');
                        this.isSleepDisconnect = true;
                        this.stopConnectionHealthMonitoring();
                        this.monitoringActive = false;
                        this.connectedDevice = null;
                        this.connectionState = ConnectionState.DISCONNECTED;
                        this.protocolService.cleanup();
                        this.eventSyncService.cleanup('assumed_sleep');
                        this.lastBatteryStatus = { percentage: null, isCharging: null };
                        if (this.onBatteryStatusCallback) {
                            this.onBatteryStatusCallback(null, null);
                        }
                        dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                            deviceId: disconnectedDevice.id,
                            isConnected: false,
                            reason: 'assumed_sleep', 
                        });
                        console.log(`[BluetoothHandler] Starting silent auto-reconnect for assumed-sleeping device ${disconnectedDevice.id}`);
                        this.attemptReconnectionWithBackoff(disconnectedDevice.id);
                        this.isSleepDisconnect = false;
                        return; 
                    }
                }
                if (disconnectedDevice && this.connectionState === ConnectionState.HANDSHAKING) {
                    const failures = (this.consecutiveHandshakeFailures.get(disconnectedDevice.id) || 0) + 1;
                    this.consecutiveHandshakeFailures.set(disconnectedDevice.id, failures);
                    const timeouts = (this.handshakeTimeoutCounts.get(disconnectedDevice.id) || 0) + 1;
                    this.handshakeTimeoutCounts.set(disconnectedDevice.id, timeouts);
                    console.warn(`[BluetoothHandler] Disconnect during handshake (failure ${failures}/${this.MAX_CONSECUTIVE_HANDSHAKE_FAILURES}) for ${disconnectedDevice.id}`);
                    console.warn('[BluetoothHandler] NOTE: This is NOT necessarily a bonding error - could be timing/RF issue.');
                    if (failures >= this.MAX_CONSECUTIVE_HANDSHAKE_FAILURES) {
                        console.error(`[BluetoothHandler] Device ${disconnectedDevice.id} unreachable at protocol level after ${failures} failures. Forgetting.`);
                        this.handleBondingError(disconnectedDevice.id, false);
                        Alert.alert(
                            'Connection Issue',
                            'We cannot establish a stable connection after multiple attempts. The device has been removed.\n\nPlease scan and pair it again.',
                            [{ text: 'OK' }]
                        );
                        return; 
                    }
                }
                if (disconnectedDevice && this.connectionState === ConnectionState.READY) {
                    const connectionDuration = Date.now() - this.connectionReadyTime;
                    if (connectionDuration < this.SHORT_CONNECTION_BOND_FAILURE_MS) {
                        console.warn(`[BluetoothHandler] Short connection (${connectionDuration}ms) after READY state.`);
                        console.warn('[BluetoothHandler] Handshake completed successfully, so bonding keys are VALID.');
                        console.warn('[BluetoothHandler] Treating as instability, NOT Ghost Bond (keys verified).');
                        const instability = (this.connectionInstabilityCount.get(disconnectedDevice.id) || 0) + 1;
                        this.connectionInstabilityCount.set(disconnectedDevice.id, instability);
                    }
                    if (connectionDuration < this.STABLE_CONNECTION_THRESHOLD_MS) {
                        const instability = (this.connectionInstabilityCount.get(disconnectedDevice.id) || 0) + 1;
                        this.connectionInstabilityCount.set(disconnectedDevice.id, instability);
                        console.warn(`[BluetoothHandler] Connection unstable (${instability}/${this.MAX_INSTABILITY_COUNT + 1}) - lasted only ${connectionDuration}ms`);
                        if (instability > this.MAX_INSTABILITY_COUNT) {
                            console.warn('[BluetoothHandler] Repeated unstable connections detected - keeping bond, will retry connection');
                            console.warn('[BluetoothHandler] NOTE: If this persists, check firmware BLE timing and NVS flush frequency');
                            this.connectionInstabilityCount.delete(disconnectedDevice.id);
                        }
                    } else {
                        if (this.connectionInstabilityCount.has(disconnectedDevice.id)) {
                            console.log(`[BluetoothHandler] Connection was stable (${connectionDuration}ms), resetting instability count for ${disconnectedDevice.id}`);
                            this.connectionInstabilityCount.delete(disconnectedDevice.id);
                        }
                        if (this.shortConnectionBondFailureCount.has(disconnectedDevice.id)) {
                            console.log(`[BluetoothHandler] Connection was stable, resetting ghost bond counter for ${disconnectedDevice.id}`);
                            this.shortConnectionBondFailureCount.delete(disconnectedDevice.id);
                        }
                    }
                }
                console.log(`[BluetoothHandler] Clearing local state for ${disconnectedDevice?.id} (preserving native autoConnect)`);
                this.connectedDevice = null;
                this.monitoringActive = false;
                this.connectionState = ConnectionState.DISCONNECTED;
                this.lastBatteryStatus = { percentage: null, isCharging: null };
                if (this.onBatteryStatusCallback) {
                    this.onBatteryStatusCallback(null, null);
                }
                this.protocolService.cleanup();
                this.eventSyncService.cleanup();
                if (disconnectedDevice?.id) {
                    dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                        deviceId: disconnectedDevice.id,
                        isConnected: false,
                        reason: 'automatic_disconnect',
                    });
                }
                if (disconnectedDevice?.id) {
                    console.log(`[BluetoothHandler] Triggering native auto-reconnect for ${disconnectedDevice.id}`);
                    this.attemptReconnectionWithBackoff(disconnectedDevice.id);
                }
            } else {
                if (AppState.currentState === 'active') {
                    Alert.alert("Bluetooth Error", `Connection failed: ${error.reason || error.message}`);
                }
            }
            if (subscription && typeof subscription.remove === 'function') {
                console.log("[BluetoothHandler] Removing characteristic listener due to error.");
                subscription.remove();
            }
            return;
        }
        if (!characteristic?.value) {
            console.log("[BluetoothHandler] No data received in notification.");
            return;
        }
        try {
            const rawBytes = base64ToUint8Array(characteristic.value);
            if (rawBytes.length === 0) {
                console.error('[BluetoothHandler] Empty data received');
                return;
            }
            if (rawBytes[0] !== PROTOCOL_SOF) {
                const fullDecodedString = base64.decode(characteristic.value);
                console.error(`[BluetoothHandler] REJECTED: Non-binary data received. Binary protocol required.`);
                console.error(`[BluetoothHandler] Raw data (first 50 chars): "${fullDecodedString.substring(0, 50)}..."`);
                console.error('[BluetoothHandler] Firmware must be v2.1.x+ with binary protocol support.');
                return;
            }
            await this.protocolService.onDataReceived(characteristic.value);
        } catch (processingError) {
            console.error('[BluetoothHandler] Error processing Bluetooth data:', processingError);
            if (AppState.currentState === 'active') {
                Alert.alert('Processing Error', 'Failed to process data from device');
            }
        }
    }
    public getBLEManager(): BleManager {
        if (this.useNativeTransport || !this.manager) {
            throw new Error(
                '[BluetoothHandler] BleManager not available. ' +
                'Using native transport mode where Swift module owns BLE stack. ' +
                'Use AppDeviceBLENative methods for BLE operations.'
            );
        }
        return this.manager;
    }
    public isUsingNativeTransport(): boolean {
        return this.useNativeTransport;
    }
    public getConnectedDevice(): Device | undefined {
        return this.connectedDevice?.device;
    }
    public setNativeConnectionReady(
        deviceId: string,
        serviceUUID: string,
        characteristicUUID: string
    ): void {
        if (!this.useNativeTransport) {
            console.warn('[BluetoothHandler] setNativeConnectionReady called but not using native transport');
            return;
        }
        console.log(`[BluetoothHandler] Native connection READY: ${deviceId}`);
        const alreadyTrackingDevice = this.connectedDevice?.device.id === deviceId;
        const alreadyConnectedState =
            this.connectionState === ConnectionState.CONNECTED ||
            this.connectionState === ConnectionState.HANDSHAKING ||
            this.connectionState === ConnectionState.READY;
        if (alreadyTrackingDevice && alreadyConnectedState) {
            console.log(
                `[BluetoothHandler] Duplicate native READY ignored for ${deviceId} ` +
                `(state=${this.connectionState})`
            );
            return;
        }
        this.connectedDevice = {
            device: {
                id: deviceId,
            } as Device,
            serviceUUID,
            characteristicUUID,
        };
        this.connectionState = ConnectionState.CONNECTED;
        dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
            deviceId,
            isConnected: true,
            reason: 'native_ready',
        });
        void this.persistNativeKnownDevice(deviceId, serviceUUID, characteristicUUID);
        this.protocolService.resetForNewConnection();
        this.eventSyncService.resetForNewConnection();
        this.startConnectionHealthMonitoring();
        this.resetCircuitBreaker();
        this.connectionState = ConnectionState.HANDSHAKING;
        this.startHandshakeTimeout();
        console.log('[BluetoothHandler] Starting handshake via EventSyncService...');
        setTimeout(() => {
            this.eventSyncService.onDeviceConnected().catch(err => {
                console.error('[BluetoothHandler] Handshake after native connect failed:', err);
            });
        }, 100);
    }
    public reconcileConnectFailure(): void {
        if (this.connectionState !== ConnectionState.CONNECTING) {
            return;
        }
        console.log('[BluetoothHandler] Reconciling failed native connect attempt → DISCONNECTED');
        this.recordConnectionFailure();
        this.connectedDevice = null;
        this.monitoringActive = false;
        this.connectionState = ConnectionState.DISCONNECTED;
    }
    public setNativeDisconnected(
        reason?: string,
        shouldAutoReconnect: boolean = true,
        nativeDeviceId?: string
    ): void {
        if (!this.useNativeTransport) {
            console.warn('[BluetoothHandler] setNativeDisconnected called but not using native transport');
            return;
        }
        const deviceId = this.connectedDevice?.device.id ?? nativeDeviceId;
        console.log(`[BluetoothHandler] Native disconnected: ${deviceId || 'unknown'}, reason: ${reason || 'unknown'}`);
        const isUserInitiated = reason === 'userInitiated' || reason === 'normal';
        const rawIsBondingError = reason === 'bondingLost' || reason === 'encryptionFailed';
        const rawIsDeviceSleep = reason === 'deviceSleep';
        const sleepOverride = this.isSleepDisconnect && rawIsBondingError;
        if (sleepOverride) {
            console.log(`[BluetoothHandler] EC-SLEEP-BOND-FIX-001: Overriding bondingLost → deviceSleep (device signaled sleep before disconnect)`);
        }
        const isBondingError = rawIsBondingError && !sleepOverride;
        const isDeviceSleep = rawIsDeviceSleep || sleepOverride;
        if (this.isSleepDisconnect) {
            this.isSleepDisconnect = false;
        }
        const nativeTransportOwnsReconnect = Platform.OS === 'android';
        const shouldAttemptReconnect = shouldAutoReconnect &&
                                       !nativeTransportOwnsReconnect &&
                                       !isUserInitiated &&
                                       !isBondingError &&
                                       deviceId != null;
        this.stopConnectionHealthMonitoring();
        this.clearHandshakeTimeout();
        this.connectedDevice = null;
        this.monitoringActive = false;
        this.connectionState = ConnectionState.DISCONNECTED;
        const cleanupReason = isDeviceSleep ? 'device_sleep' : undefined;
        this.protocolService.cleanup();
        this.eventSyncService.cleanup(cleanupReason);
        this.lastBatteryStatus = { percentage: null, isCharging: null };
        if (this.onBatteryStatusCallback) {
            this.onBatteryStatusCallback(null, null);
        }
        if (deviceId) {
            dataChangeEmitter.emit(deviceEvents.DEVICE_CONNECTION_STATE_CHANGED, {
                deviceId,
                isConnected: false,
                reason: reason || 'native_disconnected',
            });
        }
        if (shouldAttemptReconnect && deviceId) {
            if (this.isCircuitBreakerOpen()) {
                console.warn('[BluetoothHandler] Native disconnect: Circuit breaker OPEN, skipping auto-reconnect');
                return;
            }
            if (isDeviceSleep) {
                console.log(`[BluetoothHandler] Native disconnect: Device sleep detected, starting auto-reconnect for ${deviceId}`);
            } else {
                console.log(`[BluetoothHandler] Native disconnect: Starting auto-reconnect for ${deviceId}`);
            }
            this.attemptReconnectionWithBackoff(deviceId);
        } else if (deviceId) {
            console.log(
                `[BluetoothHandler] Native disconnect: Skipping JS auto-reconnect ` +
                `(reason: ${reason}, shouldAutoReconnect: ${shouldAutoReconnect}, ` +
                `nativeTransportOwnsReconnect: ${nativeTransportOwnsReconnect})`
            );
        }
    }
    private async requestPermissions() {
        if (Platform.OS === "android") {
            if ((ExpoDevice.platformApiLevel ?? -1) < 31) {
                const locationPermission = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
                if (!locationPermission) {
                    console.warn('[BluetoothHandler] ACCESS_FINE_LOCATION permission not available');
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
                const isAndroid31PermissionsGranted = await this.requestAndroid31Permissions();
                return isAndroid31PermissionsGranted;
            }
        } else {
            return true;
        }
    }
    private async requestAndroid31Permissions() {
        const scanPermission = PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN;
        const connectPermission = PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT;
        const locationPermission = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
        if (!scanPermission || !connectPermission || !locationPermission) {
            console.warn('[BluetoothHandler] One or more Android 12+ permissions not available');
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
            bluetoothScanPermission === "granted" &&
            bluetoothConnectPermission === "granted" &&
            fineLocationPermission === "granted"
        );
    }
}
export const BluetoothContext = createContext<BluetoothHandler | undefined>(undefined);
export function useBluetoothContext(): BluetoothHandler {
  const context = useContext(BluetoothContext);
  if (context === undefined) {
    throw new Error(
      'useBluetoothContext must be used within a BluetoothContext.Provider. ' +
      'Ensure this hook is called inside a component wrapped by ThemedApp or similar.'
    );
  }
  return context;
}
export { ConnectionState };
export function getBluetoothHandler(): BluetoothHandler {
    return BluetoothHandler.getInstance();
}
