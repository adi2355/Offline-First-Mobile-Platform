import { NativeModules, NativeEventEmitter } from 'react-native';
export interface BufferDiagnostics {
  currentBufferSize: number;
  totalBuffered: number;
  totalDropped: number;
  hasListeners: boolean;
  pendingOverflowCount?: number;
}
interface AppDeviceBLENativeModule {
  startScan: (broadScan: boolean) => void;
  stopScan: () => void;
  connect: (uuid: string) => void;
  disconnect: () => void;
  write: (base64Data: string) => Promise<void>;
  getConnectionState: () => Promise<ConnectionStateResult>;
  checkSystemConnections: () => void;
  setKnownPeripheralIds: (ids: string[]) => void;
  setDeviceSleepFlag: () => void;
  getBufferDiagnostics: () => Promise<BufferDiagnostics>;
}
const { AppDeviceBLE } = NativeModules as { AppDeviceBLE?: AppDeviceBLENativeModule };
export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCOVERING'
  | 'SUBSCRIBING'
  | 'READY';
export type DisconnectReason =
  | 'normal'
  | 'bondingLost'
  | 'encryptionFailed'
  | 'connectionFailed'
  | 'timeout'
  | 'unknown'
  | 'deviceSleep'
  | 'serviceDiscoveryFailed'     
  | 'serviceNotFound'            
  | 'characteristicDiscoveryFailed' 
  | 'characteristicNotFound'     
  | 'subscriptionFailed'         
  | 'subscriptionLost'           
  | 'discoveryTimeout'           
  | 'subscriptionTimeout';       
export type BluetoothAdapterState =
  | 'unknown'
  | 'resetting'
  | 'unsupported'
  | 'unauthorized'
  | 'poweredOff'
  | 'poweredOn';
export interface ConnectionStateResult {
  state: ConnectionState;
  bluetoothState: BluetoothAdapterState;
  deviceId?: string;
  foregroundServiceActive?: boolean;
}
export interface ConnectionStateEvent {
  state: ConnectionState;
  deviceId: string;
  reason?: DisconnectReason;
  timestamp: number;
  foregroundServiceActive?: boolean;
}
export interface DataReceivedEvent {
  data: string; 
  deviceId: string;
  timestamp: number;
}
export interface BondingLostEvent {
  deviceId: string;
}
export interface BluetoothStateEvent {
  state: BluetoothAdapterState;
}
export interface BufferOverflowEvent {
  droppedEventName: string;
  droppedEventTimestamp: number;
  totalDropped: number;
  bufferSize: number;
  timestamp: number;
}
export interface DeviceFoundEvent {
  id: string;
  name: string | null;
  rssi: number;
  isConnectable: boolean;
}
export type OperationType = 'connect' | 'write';
export type OperationRejectedReason =
  | 'notInitialized'
  | 'unauthorized'
  | 'unsupported'
  | 'busy'
  | 'notReady'
  | 'invalidPayload'
  | 'queueFull';
export interface OperationRejectedEvent {
  operation: OperationType;
  reason: OperationRejectedReason;
  detail?: string;
  deviceId?: string;
  timestamp: number;
}
const isNativeModuleAvailable = AppDeviceBLE != null;
export const AppDeviceBLENative = {
  isAvailable: (): boolean => isNativeModuleAvailable,
  startScan: (broadScan: boolean = false): void => {
    if (!isNativeModuleAvailable) return;
    AppDeviceBLE!.startScan(broadScan);
  },
  stopScan: (): void => {
    if (!isNativeModuleAvailable) return;
    AppDeviceBLE!.stopScan();
  },
  connect: (uuid: string): void => {
    if (!isNativeModuleAvailable) return;
    AppDeviceBLE!.connect(uuid);
  },
  disconnect: (): void => {
    if (!isNativeModuleAvailable) return;
    AppDeviceBLE!.disconnect();
  },
  write: async (base64Data: string): Promise<void> => {
    if (!isNativeModuleAvailable) {
      throw new Error('BLE_NOT_AVAILABLE');
    }
    return AppDeviceBLE!.write(base64Data);
  },
  getConnectionState: async (): Promise<ConnectionStateResult> => {
    if (!isNativeModuleAvailable) {
      return {
        state: 'DISCONNECTED',
        bluetoothState: 'unknown',
      };
    }
    return AppDeviceBLE!.getConnectionState();
  },
  checkSystemConnections: (): void => {
    if (!isNativeModuleAvailable) return;
    AppDeviceBLE!.checkSystemConnections();
  },
  setKnownPeripheralIds: (ids: string[]): void => {
    if (!isNativeModuleAvailable) return;
    AppDeviceBLE!.setKnownPeripheralIds(ids);
  },
  setDeviceSleepFlag: (): void => {
    if (!isNativeModuleAvailable) return;
    AppDeviceBLE!.setDeviceSleepFlag();
  },
  getBufferDiagnostics: async (): Promise<BufferDiagnostics> => {
    if (!isNativeModuleAvailable) {
      return {
        currentBufferSize: 0,
        totalBuffered: 0,
        totalDropped: 0,
        hasListeners: false,
      };
    }
    return AppDeviceBLE!.getBufferDiagnostics();
  },
};
const eventEmitter = isNativeModuleAvailable
  ? new NativeEventEmitter(AppDeviceBLE as any)
  : null;
export function onConnectionStateChange(
  callback: (event: ConnectionStateEvent) => void
): () => void {
  if (!eventEmitter) return () => {};
  const subscription = eventEmitter.addListener('onConnectionStateChange', callback);
  return () => subscription.remove();
}
export function onDataReceived(
  callback: (event: DataReceivedEvent) => void
): () => void {
  if (!eventEmitter) return () => {};
  const subscription = eventEmitter.addListener('onDataReceived', callback);
  return () => subscription.remove();
}
export function onBondingLost(
  callback: (event: BondingLostEvent) => void
): () => void {
  if (!eventEmitter) return () => {};
  const subscription = eventEmitter.addListener('onBondingLost', callback);
  return () => subscription.remove();
}
export function onBluetoothStateChange(
  callback: (event: BluetoothStateEvent) => void
): () => void {
  if (!eventEmitter) return () => {};
  const subscription = eventEmitter.addListener('onBluetoothStateChange', callback);
  return () => subscription.remove();
}
export function onDeviceFound(
  callback: (event: DeviceFoundEvent) => void
): () => void {
  if (!eventEmitter) return () => {};
  const subscription = eventEmitter.addListener('onDeviceFound', callback);
  return () => subscription.remove();
}
export function onBufferOverflow(
  callback: (event: BufferOverflowEvent) => void
): () => void {
  if (!eventEmitter) return () => {};
  const subscription = eventEmitter.addListener('onBufferOverflow', callback);
  return () => subscription.remove();
}
export function onOperationRejected(
  callback: (event: OperationRejectedEvent) => void
): () => void {
  if (!eventEmitter) return () => {};
  const subscription = eventEmitter.addListener('onOperationRejected', callback);
  return () => subscription.remove();
}
