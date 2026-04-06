export enum DeviceType {
  SMART_DEVICE = 'SMART_DEVICE',
  VAPORIZER = 'VAPORIZER',
  BLUETOOTH_SCALE = 'BLUETOOTH_SCALE',
  SMART_GRINDER = 'SMART_GRINDER',
  TEMPERATURE_SENSOR = 'TEMPERATURE_SENSOR',
  HUMIDITY_SENSOR = 'HUMIDITY_SENSOR',
  SCALE = 'SCALE',
  GRINDER = 'GRINDER',
  STORAGE = 'STORAGE',
  SENSOR = 'SENSOR',
  OTHER = 'OTHER',
}
export enum DeviceStatus {
  UNPAIRED = 'UNPAIRED',        
  ACTIVE = 'ACTIVE',            
  INACTIVE = 'INACTIVE',        
  OFFLINE = 'OFFLINE',          
  CALIBRATING = 'CALIBRATING',  
  ERROR = 'ERROR',              
  DECOMMISSIONED = 'DECOMMISSIONED', 
}
export enum SessionStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  PAUSED = 'PAUSED',
  CANCELLED = 'CANCELLED',
}
export type EntitySyncStatus =
  | 'synced'      
  | 'pending'     
  | 'syncing'     
  | 'error'       
  | 'dead_letter'; 
export enum AuthProvider {
  COGNITO = 'COGNITO',
  GOOGLE = 'GOOGLE',
  PHONE = 'PHONE',
  EMAIL = 'EMAIL',
}
export interface Device {
  id: string;
  userId: string;
  deviceName: string;
  deviceType: string;
  type: DeviceType;
  status: DeviceStatus;
  model?: string | null;
  serialNumber?: string | null;
  macAddress?: string | null;
  bluetoothId?: string | null;
  firmwareVersion?: string | null;
  hardwareVersion?: string | null;
  brand?: string | null;
  settings?: string;
  specifications?: string;
  calibrationData?: string;
  requiresCalibration: boolean;
  isPaired: boolean;
  isActive: boolean;
  lastConnected?: string | null;
  lastSeen?: string | null;
  batteryLevel?: number | null;
  totalSessions: number;
  totalDurationMs: number;
  lastUsed?: string | null;
  pairedAt?: string | null;
  version: number;
  serverId?: string | null;
  syncStatus?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}
export interface SavedDevice {
  id: string;
  name: string;
  macAddress?: string;
  bluetoothId?: string;
  firmwareVersion?: string;
  batteryLevel?: number;
  isPaired: boolean;
  lastConnected?: string;
  pairedAt?: string;
}
export interface Session {
  id: string;
  userId: string;
  deviceId?: string | null;
  clientSessionId?: string | null;
  primaryProductId?: string | null;
  purchaseId?: string | null;
  sessionStartTimestamp: string;
  sessionEndTimestamp?: string | null;
  hitCount: number;
  totalDurationMs: number;
  avgHitDurationMs: number;
  sessionTypeHeuristic?: string | null;
  observationFeature?: number | null;
  status: SessionStatus | string;
  notes?: string | null;
  version: number;
  syncStatus?: string;
  syncVersion?: number;
  createdAt: string;
  updatedAt: string;
}
export type HealthValueKind =
  | 'SCALAR_NUM'      
  | 'CUMULATIVE_NUM'  
  | 'INTERVAL_NUM'    
  | 'CATEGORY';       
export type HealthUploadStatus =
  | 'pending'
  | 'staged'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'rejected';
export type ProjectionServerState =
  | 'UNKNOWN'
  | 'READY'
  | 'COMPUTING'
  | 'STALE'
  | 'FAILED'
  | 'NO_DATA'
  | 'PARTIAL'
  | 'EMPTY';
export interface StalenessEvaluation {
  isStale: boolean;
  reason:
    | 'no_data'
    | 'dirty_keys_present'
    | 'server_stale'
    | 'server_computing'
    | 'server_failed'
    | 'fresh';
  dirtyKeyCount?: number;
}
export interface HydrationOutcome {
  success: boolean;
  serverState: ProjectionServerState;
  truncated: boolean;
  error?: string;
}
export interface DeviceCalibrationData {
  lastCalibrated?: string;
  calibrationValues?: Record<string, number>;
  firmwareVersion?: string;
}
export interface DeviceSettings {
  brightness?: number;
  autoOff?: boolean;
  autoOffMinutes?: number;
  temperatureUnit?: 'celsius' | 'fahrenheit';
  ledColor?: string;
}
export interface DeviceSpecifications {
  maxTemperature?: number;
  minTemperature?: number;
  batteryCapacityMah?: number;
  bleVersion?: string;
  hardwareRevision?: string;
}
