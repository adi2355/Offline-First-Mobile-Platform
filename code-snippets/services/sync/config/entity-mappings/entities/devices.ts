import type { EntityColumnConfig, HardwareIdFieldMapping } from '../types';
import {
  toOptionalTimestamp,
  toBooleanInt,
} from '../transforms';
export const DEVICES_CONFIG: EntityColumnConfig = {
  baseColumns: {
    hasServerId: true,
    hasData: true,
    createdAtColumn: 'created_at',
    updatedAtColumn: 'updated_at',
  },
  requiredColumns: [
    { backendField: 'userId', sqliteColumn: 'user_id' },
    { backendField: 'deviceName', sqliteColumn: 'device_name' },
    { backendField: 'type', sqliteColumn: 'type' },
    { backendField: 'status', sqliteColumn: 'status' },
    { backendField: 'macAddress', sqliteColumn: 'mac_address' },
    { backendField: 'bluetoothId', sqliteColumn: 'bluetooth_id' },
    { backendField: 'serialNumber', sqliteColumn: 'serial_number' },
    { backendField: 'firmwareVersion', sqliteColumn: 'firmware_version' },
    { backendField: 'hardwareVersion', sqliteColumn: 'hardware_version' },
    { backendField: 'isActive', sqliteColumn: 'is_active', transform: toBooleanInt },
    { backendField: 'lastSeen', sqliteColumn: 'last_seen', transform: toOptionalTimestamp },
    { backendField: 'batteryLevel', sqliteColumn: 'battery_level' },
    { backendField: 'requiresCalibration', sqliteColumn: 'requires_calibration', transform: toBooleanInt },
    { backendField: 'lastCalibrated', sqliteColumn: 'last_calibrated', transform: toOptionalTimestamp },
    { backendField: 'version', sqliteColumn: 'version' },
  ],
  syncMode: 'SYNCED',
  clientIdBackendField: null,
};
export const DEVICES_USER_COLUMN = 'user_id';
export const DEVICES_HARDWARE_ID_FIELDS: HardwareIdFieldMapping[] = [
  { backendField: 'macAddress', sqliteColumn: 'mac_address' },
  { backendField: 'bluetoothId', sqliteColumn: 'bluetooth_id' },
];
