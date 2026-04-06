export const FIRMWARE_PROTOCOL = {
  SOF: 0xa5,
  VERSION: 0x01,
  HEADER_SIZE: 7,
  CRC_SIZE: 2,
  MIN_PACKET_SIZE: 9,
  MAX_PAYLOAD_SIZE: 236, 
  MAX_RETRIES: 3,
  ACK_TIMEOUT_MS: 500,
} as const;
export enum FirmwareMessageType {
  MSG_HELLO = 0x00,
  MSG_HELLO_ACK = 0x01,
  MSG_ACK = 0x02,
  MSG_NACK = 0x03,
  MSG_HEARTBEAT = 0x04,
  MSG_PING = 0x05,
  MSG_PONG = 0x06,
  MSG_HIT_EVENT = 0x10,
  MSG_BATTERY_STATUS = 0x11,
  MSG_THRESHOLD_DATA = 0x12,
  MSG_SYNC_REQUEST = 0x13,
  MSG_SYNC_DATA = 0x14,
  MSG_SET_CONFIG = 0x20,
  MSG_GET_CONFIG = 0x21,
  MSG_CONFIG_RESPONSE = 0x22,
  MSG_CALIBRATE = 0x23,
  MSG_TIME_SYNC = 0x24,
  MSG_SLEEP_REQUEST = 0x25,
  MSG_OTA_START = 0x30,
  MSG_OTA_DATA = 0x31,
  MSG_OTA_END = 0x32,
  MSG_OTA_ABORT = 0x33,
  MSG_OTA_STATUS = 0x34,
  MSG_ENTER_OTA_MODE = 0x38,
  MSG_LED_SET_COLOR = 0x40,
  MSG_LED_SET_PATTERN = 0x41,
}
export enum FirmwareErrorCode {
  ERR_NONE = 0x00,
  ERR_INVALID_SOF = 0x01,
  ERR_INVALID_CRC = 0x02,
  ERR_INVALID_LENGTH = 0x03,
  ERR_INVALID_TYPE = 0x04,
  ERR_INVALID_SEQ = 0x05,
  ERR_BUFFER_FULL = 0x06,
  ERR_TIMEOUT = 0x07,
  ERR_INVALID_PAYLOAD = 0x08,
  ERR_BUSY = 0x09,
  ERR_NOT_READY = 0x0a,
  ERR_OTA_FAILED = 0x0b,
  ERR_LOW_BATTERY = 0x0c,
}
export interface FirmwareHitEvent {
  id: number;
  timestampMs: number;
  bootCount: number;
  durationMs: number;
  flags: number;
}
export interface FirmwareBatteryStatus {
  percent: number;
  flags: number;
}
export interface FirmwareThresholdData {
  wakeThreshold: number;
  hitThreshold: number;
}
export interface FirmwareTimeSyncPayload {
  epochSeconds: number;
  deviceMillis: number;
}
export interface FirmwareLedColor {
  red: number;
  green: number;
  blue: number;
}
interface FirmwareMessageBase {
  seqNum: number;
  version: number;
  rawBytes?: Uint8Array;
}
export interface FirmwareAckMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_ACK;
  ackedSeqNum: number;
}
export interface FirmwareNackMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_NACK;
  nackedSeqNum: number;
  errorCode: FirmwareErrorCode;
}
export interface FirmwarePongMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_PONG;
  receivedAt: number;
}
export interface FirmwareHeartbeatMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_HEARTBEAT;
  connectionAgeSeconds?: number;
}
export interface FirmwareHitEventMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_HIT_EVENT;
  event: FirmwareHitEvent;
}
export interface FirmwareBatteryMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_BATTERY_STATUS;
  percent: number;
  isCharging: boolean;
}
export interface FirmwareThresholdMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_THRESHOLD_DATA;
  wakeThreshold: number;
  hitThreshold: number;
}
export interface FirmwareHelloMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_HELLO;
  firmwareVersion?: string;
  capabilities?: number;
}
export interface FirmwareSyncDataMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_SYNC_DATA;
  events: FirmwareHitEvent[];
  remainingCount: number;
}
export interface FirmwareOtaStatusMessage extends FirmwareMessageBase {
  type: FirmwareMessageType.MSG_OTA_STATUS;
  progress: number;
  status: number;
}
export interface FirmwareUnknownMessage extends FirmwareMessageBase {
  type: 'UNKNOWN';
  originalType: number;
  payload: Uint8Array;
  error?: string;
}
export interface FirmwareParseError {
  type: 'PARSE_ERROR';
  error: string;
  rawBytes?: Uint8Array;
}
export type FirmwareParsedMessage =
  | FirmwareAckMessage
  | FirmwareNackMessage
  | FirmwarePongMessage
  | FirmwareHeartbeatMessage
  | FirmwareHitEventMessage
  | FirmwareBatteryMessage
  | FirmwareThresholdMessage
  | FirmwareHelloMessage
  | FirmwareSyncDataMessage
  | FirmwareOtaStatusMessage
  | FirmwareUnknownMessage
  | FirmwareParseError;
export function isHitEventMessage(
  msg: FirmwareParsedMessage
): msg is FirmwareHitEventMessage {
  return 'type' in msg && msg.type === FirmwareMessageType.MSG_HIT_EVENT;
}
export function isBatteryMessage(
  msg: FirmwareParsedMessage
): msg is FirmwareBatteryMessage {
  return 'type' in msg && msg.type === FirmwareMessageType.MSG_BATTERY_STATUS;
}
export function isPongMessage(
  msg: FirmwareParsedMessage
): msg is FirmwarePongMessage {
  return 'type' in msg && msg.type === FirmwareMessageType.MSG_PONG;
}
export function isAckMessage(
  msg: FirmwareParsedMessage
): msg is FirmwareAckMessage {
  return 'type' in msg && msg.type === FirmwareMessageType.MSG_ACK;
}
export function isNackMessage(
  msg: FirmwareParsedMessage
): msg is FirmwareNackMessage {
  return 'type' in msg && msg.type === FirmwareMessageType.MSG_NACK;
}
export function isHeartbeatMessage(
  msg: FirmwareParsedMessage
): msg is FirmwareHeartbeatMessage {
  return 'type' in msg && msg.type === FirmwareMessageType.MSG_HEARTBEAT;
}
export function isThresholdMessage(
  msg: FirmwareParsedMessage
): msg is FirmwareThresholdMessage {
  return 'type' in msg && msg.type === FirmwareMessageType.MSG_THRESHOLD_DATA;
}
export function isParseError(
  msg: FirmwareParsedMessage
): msg is FirmwareParseError {
  return 'type' in msg && msg.type === 'PARSE_ERROR';
}
export function isUnknownMessage(
  msg: FirmwareParsedMessage
): msg is FirmwareUnknownMessage {
  return 'type' in msg && msg.type === 'UNKNOWN';
}
export interface FirmwareCommand {
  type: FirmwareMessageType;
  payload?: Uint8Array;
  requiresAck?: boolean;
}
