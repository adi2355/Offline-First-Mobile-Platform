export const PROTOCOL_SOF = 0xa5;
export const PROTOCOL_VERSION = 0x01;
export const PROTOCOL_MAX_PAYLOAD_SIZE = 500;
export const PROTOCOL_HEADER_SIZE = 7;
export const PROTOCOL_CRC_SIZE = 2;
export const PROTOCOL_MIN_FRAME_SIZE = PROTOCOL_HEADER_SIZE + PROTOCOL_CRC_SIZE;
export enum MessageType {
  MSG_HELLO = 0x00,           
  MSG_HELLO_ACK = 0x01,       
  MSG_ACK = 0x02,             
  MSG_NACK = 0x03,            
  MSG_HEARTBEAT = 0x04,       
  MSG_PING = 0x05,            
  MSG_PONG = 0x06,            
  MSG_SLEEP = 0x07,           
  MSG_HIT_EVENT = 0x10,       
  MSG_BATTERY_STATUS = 0x11,  
  MSG_DEVICE_STATUS = 0x12,   
  MSG_SYNC_REQUEST = 0x13,    
  MSG_SYNC_DATA = 0x14,       
  MSG_SET_CONFIG = 0x20,      
  MSG_GET_CONFIG = 0x21,      
  MSG_CONFIG_DATA = 0x22,     
  MSG_CALIBRATE = 0x23,       
  MSG_TIME_SYNC = 0x24,       
  MSG_SET_COLORS = 0x25,      
  MSG_SET_WIFI = 0x26,        
  MSG_OTA_INFO = 0x30,        
  MSG_OTA_INFO_RESP = 0x31,   
  MSG_OTA_START = 0x32,       
  MSG_OTA_DATA = 0x33,        
  MSG_OTA_DATA_ACK = 0x34,    
  MSG_OTA_COMMIT = 0x35,      
  MSG_OTA_ABORT = 0x36,       
  MSG_OTA_STATUS = 0x37,      
  MSG_ENTER_OTA_MODE = 0x38,  
  MSG_LOG_REQUEST = 0x40,     
  MSG_LOG_DATA = 0x41,        
  MSG_FACTORY_RESET = 0x42,   
  MSG_PAIRING_MODE = 0x43,    
  MSG_CLEAR_BONDS = 0x44,     
  MSG_SYNC_RESPONSE = 0x14,
  MSG_OTA_BEGIN = 0x32,
}
export enum ErrorCode {
  ERR_NONE = 0x00,              
  ERR_CRC_MISMATCH = 0x01,      
  ERR_SEQ_OUT_OF_ORDER = 0x02,  
  ERR_INVALID_LENGTH = 0x03,    
  ERR_UNKNOWN_MSG = 0x04,       
  ERR_INVALID_STATE = 0x05,     
  ERR_BUSY = 0x06,              
  ERR_FLASH_WRITE = 0x07,       
  ERR_LOW_BATTERY = 0x08,       
  ERR_NOT_BONDED = 0x09,        
  ERR_INVALID_PAYLOAD = 0x0a,   
  ERR_TIMEOUT = 0x0b,           
  ERR_OTA_FAILED = 0x0c,        
  ERR_CALIBRATION = 0x0d,       
  ERR_SENSOR = 0x0e,            
  ERR_INTERNAL = 0xff,          
  ERR_UNKNOWN_MESSAGE = 0x04,
  ERR_SEQUENCE_ERROR = 0x02,
}
export interface HitEvent {
  eventId: number;      
  timestampMs: number;  
  bootCount: number;    
  durationMs: number;   
  timestamp: number;    
  flags: number;        
  reserved: number[];   
}
export const HIT_EVENT_SIZE = 24;
export const HIT_EVENT_FLAGS = {
  SYNCED: 0x01,
  OVERFLOW: 0x02,
  TIME_ESTIMATED: 0x04,
} as const;
export interface BatteryStatusPayload {
  percentage: number; 
  isCharging: number; 
  voltageMilliVolts: number; 
}
export const BATTERY_STATUS_SIZE = 4;
export interface HelloAckPayload {
  firmwareMajor: number;    
  firmwareMinor: number;    
  firmwarePatch: number;    
  buildType: number;        
  buildNumber: number;      
  batteryPercent: number;   
  isCharging: number;       
  lastEventId: number;      
  currentMillis: number;    
  bondedDevices: number;    
  sensitivity: number;      
  configCrc32: number;      
  configSignature: number;  
  hardwareId: string;       
}
export const HELLO_ACK_SIZE = 36;
export interface TimeSyncPayload {
  epochSeconds: number;           
  timezoneOffsetMinutes: number;  
}
export const TIME_SYNC_SIZE = 6;
export interface CalibrationResultPayload {
  wakeThreshold: number; 
  hitThreshold: number; 
  ambientLevel: number; 
  status: number; 
  reserved: number; 
}
export const CALIBRATION_RESULT_SIZE = 8;
export interface SyncRequestPayload {
  lastKnownEventId: number; 
}
export const SYNC_REQUEST_SIZE = 4;
export interface SyncResponseHeader {
  eventCount: number; 
  hasMore: number; 
}
export enum DeviceCapability {
  CAP_PROXIMITY_SENSOR = 1 << 0, 
  CAP_BATTERY_MONITOR = 1 << 1, 
  CAP_OTA_UPDATE = 1 << 2, 
  CAP_CALIBRATION = 1 << 3, 
  CAP_NVS_BACKUP = 1 << 4, 
  CAP_DEEP_SLEEP = 1 << 5, 
}
export interface ProtocolFrame {
  type: MessageType;
  version: number;
  sequenceNumber: number;
  payload: Uint8Array;
  receivedCrc: number;
  calculatedCrc: number;
  crcValid: boolean;
}
export interface ParseResult {
  frame: ProtocolFrame | null;
  error: string | null;
  bytesConsumed: number;
}
export interface MessageOptions {
  type: MessageType;
  payload?: Uint8Array;
  sequenceNumber?: number;
}
export interface AckPayload {
  ackSequence: number; 
}
export const ACK_PAYLOAD_SIZE = 2;
export interface NackPayload {
  nackSequence: number;   
  errorCode: ErrorCode;   
}
export const NACK_PAYLOAD_SIZE = 3;
export interface ConfigDataPayload {
  sensitivity: number;     
  ledBrightness: number;   
  reserved: number[];      
}
export const CONFIG_DATA_SIZE = 4;
export interface SetConfigPayload {
  configId: number;        
  value: number;           
  reserved: number[];      
}
export const SET_CONFIG_SIZE = 4;
export enum ConfigId {
  SENSITIVITY = 0x01,
  LED_BRIGHTNESS = 0x02,
}
export enum WifiState {
  DISABLED = 0,      
  DISCONNECTED = 1,  
  CONNECTING = 2,    
  CONNECTED = 3,     
  ERROR = 4,         
}
export enum WifiReason {
  NONE = 0,          
  AUTH_FAIL = 1,     
  NO_AP = 2,         
  TIMEOUT = 3,       
  LOST = 4,          
  UNKNOWN = 255,     
}
export interface DeviceStatusPayload {
  state: WifiState;       
  reason: WifiReason;     
  rssi: number;           
  ip: number;             
}
export const DEVICE_STATUS_SIZE = 7;
export function ipToString(ip: number): string {
  if (ip === 0) return '0.0.0.0';
  const a = ip & 0xFF;
  const b = (ip >> 8) & 0xFF;
  const c = (ip >> 16) & 0xFF;
  const d = (ip >> 24) & 0xFF;
  return `${a}.${b}.${c}.${d}`;
}
export function getWifiStateName(state: WifiState): string {
  switch (state) {
    case WifiState.DISABLED: return 'Disabled';
    case WifiState.DISCONNECTED: return 'Disconnected';
    case WifiState.CONNECTING: return 'Connecting';
    case WifiState.CONNECTED: return 'Connected';
    case WifiState.ERROR: return 'Error';
    default: return `Unknown(${state})`;
  }
}
export function getWifiReasonName(reason: WifiReason): string {
  switch (reason) {
    case WifiReason.NONE: return 'None';
    case WifiReason.AUTH_FAIL: return 'Wrong Password';
    case WifiReason.NO_AP: return 'Network Not Found';
    case WifiReason.TIMEOUT: return 'Connection Timeout';
    case WifiReason.LOST: return 'Connection Lost';
    case WifiReason.UNKNOWN: return 'Unknown Error';
    default: return `Unknown(${reason})`;
  }
}
