import type { AppStateStatus } from 'react-native';
import type { Device } from '../types';
export enum BLEMessageType {
  HIT_DATA = 'HIT_DATA',
  BATTERY = 'BATTERY',
  PONG = 'PONG',
  KEEPALIVE = 'KEEPALIVE',
  THRESHOLD = 'THRESHOLD',
  UNKNOWN = 'UNKNOWN',
}
export interface BLEHitDataMessage {
  readonly type: BLEMessageType.HIT_DATA;
  readonly timestamp: string;
  readonly durationSeconds: number;
  readonly rawTimestamp: string;
}
export interface BLEBatteryMessage {
  readonly type: BLEMessageType.BATTERY;
  readonly percent: number;
  readonly isCharging: boolean;
}
export interface BLEPongMessage {
  readonly type: BLEMessageType.PONG;
  readonly receivedAt: number;
}
export interface BLEKeepaliveMessage {
  readonly type: BLEMessageType.KEEPALIVE;
  readonly connectionAgeSeconds: number;
}
export interface BLEThresholdMessage {
  readonly type: BLEMessageType.THRESHOLD;
  readonly wakeThreshold: number;
  readonly hitThreshold: number;
}
export interface BLEUnknownMessage {
  readonly type: BLEMessageType.UNKNOWN;
  readonly rawData: string;
}
export type BLEParsedMessage =
  | BLEHitDataMessage
  | BLEBatteryMessage
  | BLEPongMessage
  | BLEKeepaliveMessage
  | BLEThresholdMessage
  | BLEUnknownMessage;
export function isHitDataMessage(msg: BLEParsedMessage): msg is BLEHitDataMessage {
  return msg.type === BLEMessageType.HIT_DATA;
}
export function isBatteryMessage(msg: BLEParsedMessage): msg is BLEBatteryMessage {
  return msg.type === BLEMessageType.BATTERY;
}
export function isPongMessage(msg: BLEParsedMessage): msg is BLEPongMessage {
  return msg.type === BLEMessageType.PONG;
}
export function isKeepaliveMessage(msg: BLEParsedMessage): msg is BLEKeepaliveMessage {
  return msg.type === BLEMessageType.KEEPALIVE;
}
export function isThresholdMessage(msg: BLEParsedMessage): msg is BLEThresholdMessage {
  return msg.type === BLEMessageType.THRESHOLD;
}
export function isUnknownMessage(msg: BLEParsedMessage): msg is BLEUnknownMessage {
  return msg.type === BLEMessageType.UNKNOWN;
}
export type BLEConnectionHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
export interface BLECalibrationThresholds {
  readonly wake: number;
  readonly hit: number;
}
export interface BLEProtocolCallbacks {
  onHitData?: (hit: BLEHitDataMessage) => void;
  onBatteryUpdate?: (battery: BLEBatteryMessage) => void;
  onPong?: (pong: BLEPongMessage) => void;
  onKeepalive?: (keepalive: BLEKeepaliveMessage) => void;
  onCalibrationComplete?: (threshold: BLEThresholdMessage) => void;
  onHealthCheckFailure?: (deviceId: string) => void;
  onDisconnection?: (deviceId: string) => void;
  onTimestampSyncFailure?: (deviceId: string, error: Error) => void;
  onAppStateChange?: (state: AppStateStatus) => void;
  onConnectionHealthChange?: (health: BLEConnectionHealth, previousHealth: BLEConnectionHealth) => void;
}
export interface BLEContextState {
  isConnected: boolean;
  connectedDevice: Device | null;
  isScanning: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  batteryLevel: number | null;
  isCharging: boolean;
  lastPongTime: number | null;
  connectionHealth: BLEConnectionHealth;
  calibrationThresholds: BLECalibrationThresholds | null;
  connectionAgeSeconds: number | null;
  missedPongCount: number;
  error: string | null;
}
export type BLECommand =
  | 'HEARTBEAT'
  | 'PING'
  | 'SLEEP'
  | 'GET_BATTERY'
  | 'CALIBRATE'
  | `ACTIVE_COLOR ${string}`    
  | `HIT_COLOR ${string}`       
  | string;                     
export interface BLEScanResult {
  id: string;
  name: string | null;
  rssi: number | null;
  isConnectable: boolean | null;
  serviceUUIDs: string[] | null;
  localName: string | null;
  manufacturerData: string | null;
}
export interface BLEScanOptions {
  broadScan?: boolean;
  timeoutMs?: number;
  allowDuplicates?: boolean;
}
export interface BLEReconnectionState {
  attempt: number;
  maxAttempts: number;
  nextDelayMs: number;
  isReconnecting: boolean;
  lastError: string | null;
}
