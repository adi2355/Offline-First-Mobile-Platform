import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus, Alert, Platform } from 'react-native';
import {
  AppDeviceBLENative,
  onConnectionStateChange,
  onDataReceived,
  onBondingLost,
  onBluetoothStateChange,
  onBufferOverflow,
  onOperationRejected,
  ConnectionStateEvent,
  DataReceivedEvent,
  BondingLostEvent,
  BufferOverflowEvent,
  OperationRejectedEvent,
} from './AppDeviceBLE';
import { BluetoothHandler } from '../contexts/BluetoothContext';
import { storageService } from '../services/StorageService';
import {
  DEVICE_UUIDS_STORAGE_KEY,
  APP_DEVICE_SERVICE_UUID,
  APP_DEVICE_CHARACTERISTIC_UUID,
} from '../constants/ble';
export function useAppDeviceBLEIntegration(): void {
  if (!AppDeviceBLENative.isAvailable()) {
    return;
  }
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const bluetoothHandler = useRef<BluetoothHandler | null>(null);
  const getBluetoothHandler = useCallback((): BluetoothHandler | null => {
    if (!bluetoothHandler.current) {
      try {
        bluetoothHandler.current = BluetoothHandler.getInstance();
      } catch (e) {
        console.warn('[AppDeviceBLEIntegration] BluetoothHandler not yet available');
        return null;
      }
    }
    return bluetoothHandler.current;
  }, []);
  const syncKnownDevices = useCallback(async () => {
    try {
      const storedUUIDs = await storageService.getValue<Record<string, unknown>>(
        DEVICE_UUIDS_STORAGE_KEY
      );
      if (storedUUIDs) {
        const ids = Object.keys(storedUUIDs);
        if (ids.length > 0) {
          console.log('[AppDeviceBLEIntegration] Syncing known devices to native:', ids.length);
          AppDeviceBLENative.setKnownPeripheralIds(ids);
        }
      }
    } catch (error) {
      console.warn('[AppDeviceBLEIntegration] Failed to sync known devices:', error);
    }
  }, []);
  const handleConnectionStateChange = useCallback((event: ConnectionStateEvent) => {
    console.log('[AppDeviceBLEIntegration] Native state change:', event.state, event.deviceId);
    const handler = getBluetoothHandler();
    if (!handler) return;
    switch (event.state) {
      case 'READY':
        console.log('[AppDeviceBLEIntegration] Device READY via native module');
        handler.setNativeConnectionReady?.(
          event.deviceId,
          APP_DEVICE_SERVICE_UUID,
          APP_DEVICE_CHARACTERISTIC_UUID
        );
        break;
      case 'DISCONNECTED':
        console.log('[AppDeviceBLEIntegration] Device DISCONNECTED via native module, reason:', event.reason);
        const shouldJsAutoReconnect = Platform.OS !== 'android';
        handler.setNativeDisconnected?.(event.reason, shouldJsAutoReconnect, event.deviceId);
        if (event.reason === 'bondingLost' || event.reason === 'encryptionFailed') {
          console.error('[AppDeviceBLEIntegration] Bonding error:', event.reason);
        }
        break;
      case 'CONNECTING':
      case 'CONNECTED':
      case 'DISCOVERING':
      case 'SUBSCRIBING':
        console.log('[AppDeviceBLEIntegration] State:', event.state);
        break;
    }
  }, [getBluetoothHandler]);
  const handleDataReceived = useCallback((event: DataReceivedEvent) => {
    const handler = getBluetoothHandler();
    if (!handler) return;
    const protocolService = handler.getProtocolService?.();
    if (protocolService) {
      protocolService.onDataReceived(event.data).catch((error: Error) => {
        console.error('[AppDeviceBLEIntegration] Protocol error:', error);
      });
    }
  }, [getBluetoothHandler]);
  const handleBondingLost = useCallback((event: BondingLostEvent) => {
    const handler = getBluetoothHandler();
    if (handler?.isDeviceSleeping()) {
      console.log(
        '[AppDeviceBLEIntegration] EC-SLEEP-BOND-FIX-001: Ignoring bonding lost event for',
        event.deviceId,
        '— device is in sleep disconnect mode (false positive from abrupt power-off)'
      );
      return;
    }
    console.error('[AppDeviceBLEIntegration] Bonding lost:', event.deviceId);
    if (handler) {
      handler.handleBondingError(event.deviceId);
    }
    const remediationMessage = Platform.OS === 'android'
      ? 'The device pairing was lost. Please open Android Settings > Connected devices > Bluetooth, forget the AppPlatform device, then reconnect in the app.'
      : 'The device pairing was lost. Please go to Settings > Bluetooth, find "AppPlatform Device", tap the (i) button, and select "Forget This Device". Then reconnect in the app.';
    Alert.alert(
      'Pairing Issue Detected',
      remediationMessage,
      [{ text: 'OK', style: 'default' }]
    );
  }, [getBluetoothHandler]);
  const handleOperationRejected = useCallback((event: OperationRejectedEvent) => {
    console.warn(
      '[AppDeviceBLEIntegration] Native operation rejected:',
      event.operation,
      event.reason,
      event.detail ?? ''
    );
    if (event.operation === 'connect') {
      const handler = getBluetoothHandler();
      if (handler) {
        handler.reconcileConnectFailure();
      }
    }
  }, [getBluetoothHandler]);
  const handleAppStateChange = useCallback((nextAppState: AppStateStatus) => {
    const previousState = appStateRef.current;
    appStateRef.current = nextAppState;
    if (previousState.match(/inactive|background/) && nextAppState === 'active') {
      console.log('[AppDeviceBLEIntegration] App foregrounded, checking system connections');
      AppDeviceBLENative.checkSystemConnections();
    }
  }, []);
  const handleBufferOverflow = useCallback((event: BufferOverflowEvent) => {
    console.error(
      `[AppDeviceBLEIntegration] BUFFER OVERFLOW: ` +
      `Dropped event '${event.droppedEventName}' (total dropped: ${event.totalDropped})`
    );
    if (event.droppedEventName === 'onDataReceived') {
      console.error(
        '[AppDeviceBLEIntegration] WARNING: Data event dropped - potential hit data loss! ' +
        'Consider triggering device history resync when next connected.'
      );
    }
  }, []);
  useEffect(() => {
    console.log('[AppDeviceBLEIntegration] Initializing native BLE integration');
    const unsubConnectionState = onConnectionStateChange(handleConnectionStateChange);
    const unsubDataReceived = onDataReceived(handleDataReceived);
    const unsubBondingLost = onBondingLost(handleBondingLost);
    const unsubBluetoothState = onBluetoothStateChange((event) => {
      console.log('[AppDeviceBLEIntegration] Bluetooth state:', event.state);
    });
    const unsubOperationRejected = onOperationRejected(handleOperationRejected);
    const unsubBufferOverflow = onBufferOverflow(handleBufferOverflow);
    const appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
    (async () => {
      try {
        await syncKnownDevices();
        console.log('[AppDeviceBLEIntegration] Known devices synced to native module');
        console.log('[AppDeviceBLEIntegration] Checking for system connections...');
        AppDeviceBLENative.checkSystemConnections();
      } catch (error) {
        console.error('[AppDeviceBLEIntegration] Initialization error:', error);
      }
    })();
    return () => {
      console.log('[AppDeviceBLEIntegration] Cleaning up');
      unsubConnectionState();
      unsubDataReceived();
      unsubBondingLost();
      unsubBluetoothState();
      unsubOperationRejected();
      unsubBufferOverflow();
      appStateSubscription.remove();
    };
  }, [
    syncKnownDevices,
    handleConnectionStateChange,
    handleDataReceived,
    handleBondingLost,
    handleOperationRejected,
    handleAppStateChange,
    handleBufferOverflow,
  ]);
}
export function shouldUseNativeBLE(): boolean {
  return AppDeviceBLENative.isAvailable();
}
