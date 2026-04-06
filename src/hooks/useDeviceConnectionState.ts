import { useState, useEffect, useCallback, useRef } from 'react';
import { Device } from 'react-native-ble-plx';
import { useFocusEffect } from '@react-navigation/native';
import { SavedDevice } from '@/src/types';
import { useBluetoothService } from '@/src/providers/AppProvider';
import { ConnectionState, getBluetoothHandler } from '@/src/contexts/BluetoothContext';
import { dataChangeEmitter, deviceEvents, DataChangeEvent } from '@/src/utils/EventEmitter';
import { logger } from '@/src/utils/logger';
export type DeviceConnectionPhase =
  | 'IDLE'
  | 'SCANNING'
  | 'CONNECTING'
  | 'SYNCING'
  | 'READY'
  | 'DISCONNECTING'
  | 'RECONNECTING'
  | 'SLEEP'
  | 'CIRCUIT_BREAKER';
export interface DeviceConnectionState {
  connectionPhase: DeviceConnectionPhase;
  connectedDeviceId: string | null;
  connectedDevice: SavedDevice | null;
  batteryPercentage: number | null;
  isCharging: boolean | null;
  savedDevices: SavedDevice[];
  scannedDevices: Device[];
  isScanning: boolean;
  connectionError: string | null;
  connectingDeviceId: string | null;
  connect: (deviceId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  startScan: (durationMs?: number) => void;
  stopScan: () => void;
  refreshDevices: () => Promise<void>;
  clearError: () => void;
}
const RECONNECT_WINDOW_MS = 30_000;
const DEFAULT_SCAN_DURATION_MS = 10_000;
export function useDeviceConnectionState(): DeviceConnectionState {
  const bluetoothService = useBluetoothService();
  const [connectedDeviceId, setConnectedDeviceId] = useState<string | null>(null);
  const [savedDevices, setSavedDevices] = useState<SavedDevice[]>([]);
  const [scannedDevices, setScannedDevices] = useState<Device[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectingDeviceId, setConnectingDeviceId] = useState<string | null>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [batteryPercentage, setBatteryPercentage] = useState<number | null>(null);
  const [isCharging, setIsCharging] = useState<boolean | null>(null);
  const [lastDisconnectReason, setLastDisconnectReason] = useState<string | null>(null);
  const wasConnectedRef = useRef(false);
  const lastDisconnectTimeRef = useRef(0);
  const connectionPhase: DeviceConnectionPhase = (() => {
    if (isScanning && !connectedDeviceId && !connectingDeviceId) return 'SCANNING';
    if (connectingDeviceId) return 'CONNECTING';
    if (isDisconnecting) return 'DISCONNECTING';
    if (connectedDeviceId) {
      const handler = getBluetoothHandler();
      const rawState = handler.getConnectionState();
      if (rawState === ConnectionState.CONNECTED || rawState === ConnectionState.HANDSHAKING) {
        return 'SYNCING';
      }
      if (rawState === ConnectionState.READY) {
        return 'READY';
      }
      return 'SYNCING';
    }
    if (lastDisconnectReason === 'device_sleep' || lastDisconnectReason === 'assumed_sleep') {
      return 'SLEEP';
    }
    if (
      wasConnectedRef.current &&
      Date.now() - lastDisconnectTimeRef.current < RECONNECT_WINDOW_MS
    ) {
      return 'RECONNECTING';
    }
    return 'IDLE';
  })();
  const connectedDevice: SavedDevice | null = connectedDeviceId
    ? (savedDevices.find(
        (d) => d.id === connectedDeviceId || d.bluetoothId === connectedDeviceId,
      ) ?? null)
    : null;
  const refreshSavedDevices = useCallback(async () => {
    try {
      const devices = await bluetoothService.getSavedDevices();
      setSavedDevices(devices);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[useDeviceConnectionState] Error fetching saved devices', {
        error: { name: err.name, message: err.message },
      });
      setSavedDevices([]);
    }
  }, [bluetoothService]);
  const connect = useCallback(
    async (deviceId: string) => {
      if (connectedDeviceId === deviceId || connectingDeviceId === deviceId) {
        logger.debug('[useDeviceConnectionState] Connect ignored: already connected/connecting', {
          deviceId,
        });
        return;
      }
      if (connectingDeviceId) {
        logger.warn('[useDeviceConnectionState] Connect ignored: another connection in progress', {
          connectingDeviceId,
        });
        return;
      }
      if (isScanning) {
        setIsScanning(false);
      }
      logger.info('[useDeviceConnectionState] Connecting to device', { deviceId });
      setConnectingDeviceId(deviceId);
      setConnectionError(null);
      setConnectedDeviceId(null);
      setLastDisconnectReason(null);
      try {
        await bluetoothService.connectToDevice(deviceId);
        logger.info('[useDeviceConnectionState] Connected successfully', { deviceId });
        setConnectedDeviceId(deviceId);
        wasConnectedRef.current = true;
        const battery = bluetoothService.getBatteryStatus();
        setBatteryPercentage(battery.percentage);
        setIsCharging(battery.isCharging);
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('[useDeviceConnectionState] Connection failed', {
          deviceId,
          error: { name: err.name, message: err.message },
        });
        setConnectionError(
          `Failed to connect: ${(error as { reason?: string })?.reason || err.message}`,
        );
        setConnectedDeviceId(null);
      } finally {
        setConnectingDeviceId(null);
      }
    },
    [bluetoothService, connectedDeviceId, connectingDeviceId, isScanning],
  );
  const disconnect = useCallback(async () => {
    if (!connectedDeviceId) return;
    setIsDisconnecting(true);
    setConnectionError(null);
    try {
      await bluetoothService.disconnectCurrentDevice();
      logger.info('[useDeviceConnectionState] Disconnected', { deviceId: connectedDeviceId });
      setConnectedDeviceId(null);
      setBatteryPercentage(null);
      setIsCharging(null);
      setLastDisconnectReason(null);
      wasConnectedRef.current = false;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[useDeviceConnectionState] Disconnect failed', {
        error: { name: err.name, message: err.message },
      });
      setConnectionError(`Failed to disconnect: ${err.message}`);
    } finally {
      setIsDisconnecting(false);
    }
  }, [bluetoothService, connectedDeviceId]);
  const startScan = useCallback(
    (durationMs = DEFAULT_SCAN_DURATION_MS) => {
      setIsScanning(true);
      setScannedDevices([]);
      const currentSavedIds = new Set(savedDevices.map((d) => d.id));
      bluetoothService
        .scanForDevices(
          (device) => {
            if (device?.name) {
              setScannedDevices((prev) => {
                if (currentSavedIds.has(device.id) || prev.some((d) => d.id === device.id)) {
                  return prev;
                }
                return [...prev, device];
              });
            }
          },
          { timeoutMs: durationMs },
        )
        .then(() => setIsScanning(false))
        .catch((error) => {
          logger.error('[useDeviceConnectionState] Scan error', { error });
          setIsScanning(false);
        });
    },
    [bluetoothService, savedDevices],
  );
  const stopScan = useCallback(() => {
    setIsScanning(false);
  }, []);
  const refreshDevices = useCallback(async () => {
    const connected = bluetoothService.getConnectedDevice();
    if (connected) {
      setConnectedDeviceId(connected.id);
    } else {
      setConnectedDeviceId(null);
    }
    const battery = bluetoothService.getBatteryStatus();
    setBatteryPercentage(battery.percentage);
    setIsCharging(battery.isCharging);
    await refreshSavedDevices();
  }, [bluetoothService, refreshSavedDevices]);
  const clearError = useCallback(() => {
    setConnectionError(null);
  }, []);
  useEffect(() => {
    refreshSavedDevices();
    const connected = bluetoothService.getConnectedDevice();
    if (connected) {
      setConnectedDeviceId(connected.id);
      wasConnectedRef.current = true;
    }
    const handleDeviceListUpdated = (data?: DataChangeEvent) => {
      logger.info('[useDeviceConnectionState] Device list updated', { data });
      refreshSavedDevices();
      const targetDeviceId = data?.deviceId || data?.entityId;
      const eventAction = (data as DataChangeEvent & { action?: string })?.action;
      if (
        (eventAction === 'forgotten' ||
          data?.reason === 'forgotten' ||
          eventAction === 'removed') &&
        targetDeviceId
      ) {
        setConnectedDeviceId((currentId) => {
          if (targetDeviceId === currentId) {
            logger.info(
              '[useDeviceConnectionState] Connected device was removed, clearing state',
            );
            wasConnectedRef.current = false;
            return null;
          }
          return currentId;
        });
      }
    };
    const handleConnectionStateChanged = (data?: DataChangeEvent) => {
      logger.info('[useDeviceConnectionState] Connection state changed', { data });
      const eventDeviceId = data?.deviceId || data?.entityId;
      let isConnected: boolean | undefined;
      if (typeof data?.isConnected === 'boolean') {
        isConnected = data.isConnected;
      } else if (data?.data && typeof data.data === 'object' && 'isConnected' in data.data) {
        isConnected = (data.data as { isConnected?: boolean }).isConnected;
      } else {
        isConnected = data?.reason === 'connected';
      }
      if (eventDeviceId) {
        if (isConnected) {
          setConnectedDeviceId(eventDeviceId);
          wasConnectedRef.current = true;
          setLastDisconnectReason(null);
        } else {
          setConnectedDeviceId((currentId) => {
            if (eventDeviceId === currentId) {
              lastDisconnectTimeRef.current = Date.now();
              setLastDisconnectReason(data?.reason ?? null);
              return null;
            }
            return currentId;
          });
        }
      }
    };
    const handleBatteryUpdate = (event?: DataChangeEvent) => {
      if (!event?.data) return;
      const batteryData = event.data as {
        percentage?: number | null;
        isCharging?: boolean | null;
      };
      setBatteryPercentage(batteryData.percentage ?? null);
      setIsCharging(batteryData.isCharging ?? null);
    };
    dataChangeEmitter.on(deviceEvents.DEVICE_LIST_UPDATED, handleDeviceListUpdated);
    dataChangeEmitter.on(
      deviceEvents.DEVICE_CONNECTION_STATE_CHANGED,
      handleConnectionStateChanged,
    );
    dataChangeEmitter.on(deviceEvents.DEVICE_BATTERY_UPDATED, handleBatteryUpdate);
    const currentBattery = bluetoothService.getBatteryStatus();
    setBatteryPercentage(currentBattery.percentage);
    setIsCharging(currentBattery.isCharging);
    return () => {
      dataChangeEmitter.off(deviceEvents.DEVICE_LIST_UPDATED, handleDeviceListUpdated);
      dataChangeEmitter.off(
        deviceEvents.DEVICE_CONNECTION_STATE_CHANGED,
        handleConnectionStateChanged,
      );
      dataChangeEmitter.off(deviceEvents.DEVICE_BATTERY_UPDATED, handleBatteryUpdate);
    };
  }, []); 
  useFocusEffect(
    useCallback(() => {
      logger.debug('[useDeviceConnectionState] Screen focused - syncing state');
      const connected = bluetoothService.getConnectedDevice();
      if (connected) {
        setConnectedDeviceId((currentId) => {
          if (currentId !== connected.id) {
            wasConnectedRef.current = true;
            return connected.id;
          }
          return currentId;
        });
      } else {
        setConnectedDeviceId((currentId) => {
          if (currentId !== null) return null;
          return currentId;
        });
      }
      const battery = bluetoothService.getBatteryStatus();
      setBatteryPercentage(battery.percentage);
      setIsCharging(battery.isCharging);
      refreshSavedDevices();
    }, [bluetoothService, refreshSavedDevices]),
  );
  return {
    connectionPhase,
    connectedDeviceId,
    connectedDevice,
    batteryPercentage,
    isCharging,
    savedDevices,
    scannedDevices,
    isScanning,
    connectionError,
    connectingDeviceId,
    connect,
    disconnect,
    startScan,
    stopScan,
    refreshDevices,
    clearError,
  };
}
