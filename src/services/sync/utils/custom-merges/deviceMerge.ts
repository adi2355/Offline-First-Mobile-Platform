import {
  type MergeContext,
  type MergeResult,
} from '@shared/contracts';
import { DeviceStatus, DeviceType } from '../../../../types';
export { DeviceStatus, DeviceType };
export interface DeviceMergeData {
  id: string;
  userId: string;
  serverId?: string | null;
  deviceName: string;
  type: DeviceType;
  status: DeviceStatus;
  macAddress?: string | null;
  bluetoothId?: string | null;
  serialNumber?: string | null;
  brand?: string | null;
  model?: string | null;
  firmwareVersion?: string | null;
  hardwareVersion?: string | null;
  isActive?: boolean;
  lastSeen?: string | null;
  batteryLevel?: number | null;
  requiresCalibration?: boolean;
  lastCalibrated?: string | null;
  calibrationData?: Record<string, unknown> | null;
  settings?: Record<string, unknown> | null;
  specifications?: Record<string, unknown> | null;
  pairedAt?: string | null;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}
function parseTimestamp(timestamp: string | null | undefined): number {
  if (!timestamp) return 0;
  const parsed = new Date(timestamp).getTime();
  return isNaN(parsed) ? 0 : parsed;
}
export function mergeDevice(
  local: DeviceMergeData,
  server: DeviceMergeData,
  context: MergeContext
): MergeResult<DeviceMergeData> {
  const resolvedFromLocal: string[] = [];
  const resolvedFromServer: string[] = [];
  const mergedFields: string[] = [];
  const localUpdatedTime = parseTimestamp(context.localUpdatedAt);
  const serverUpdatedTime = parseTimestamp(context.serverUpdatedAt);
  const localLastSeenTime = parseTimestamp(local.lastSeen);
  const merged: DeviceMergeData = { ...server };
  merged.id = local.id ?? server.id;
  if (local.id) {
    resolvedFromLocal.push('id');
  } else {
    resolvedFromServer.push('id');
  }
  if (server.id !== undefined) {
    merged.serverId = server.id;
    resolvedFromServer.push('serverId');
  } else if (local.serverId !== undefined) {
    merged.serverId = local.serverId;
    resolvedFromLocal.push('serverId');
  }
  merged.userId = server.userId;
  resolvedFromServer.push('userId');
  merged.serialNumber = server.serialNumber;
  resolvedFromServer.push('serialNumber');
  merged.macAddress = server.macAddress;
  resolvedFromServer.push('macAddress');
  merged.createdAt = server.createdAt;
  resolvedFromServer.push('createdAt');
  if (
    server.status === DeviceStatus.DECOMMISSIONED ||
    server.status === DeviceStatus.ERROR
  ) {
    merged.status = server.status;
    resolvedFromServer.push('status');
  } else if (localUpdatedTime > serverUpdatedTime) {
    merged.status = local.status;
    resolvedFromLocal.push('status');
  } else {
    merged.status = server.status;
    resolvedFromServer.push('status');
  }
  if (localLastSeenTime > serverUpdatedTime) {
    if (local.firmwareVersion) {
      merged.firmwareVersion = local.firmwareVersion;
      resolvedFromLocal.push('firmwareVersion');
    } else {
      resolvedFromServer.push('firmwareVersion');
    }
    if (local.hardwareVersion) {
      merged.hardwareVersion = local.hardwareVersion;
      resolvedFromLocal.push('hardwareVersion');
    } else {
      resolvedFromServer.push('hardwareVersion');
    }
  } else {
    resolvedFromServer.push('firmwareVersion', 'hardwareVersion');
  }
  if (localUpdatedTime > serverUpdatedTime) {
    if (local.lastSeen) {
      merged.lastSeen = local.lastSeen;
      resolvedFromLocal.push('lastSeen');
    } else {
      resolvedFromServer.push('lastSeen');
    }
    if (local.batteryLevel !== null && local.batteryLevel !== undefined) {
      merged.batteryLevel = local.batteryLevel;
      resolvedFromLocal.push('batteryLevel');
    } else {
      resolvedFromServer.push('batteryLevel');
    }
  } else {
    resolvedFromServer.push('lastSeen', 'batteryLevel');
  }
  if (localUpdatedTime > serverUpdatedTime) {
    if (local.deviceName && local.deviceName !== server.deviceName) {
      merged.deviceName = local.deviceName;
      resolvedFromLocal.push('deviceName');
    } else {
      resolvedFromServer.push('deviceName');
    }
    if (local.settings) {
      merged.settings = local.settings;
      resolvedFromLocal.push('settings');
    } else {
      resolvedFromServer.push('settings');
    }
  } else {
    resolvedFromServer.push('deviceName', 'settings');
  }
  const localCalibratedTime = parseTimestamp(local.lastCalibrated);
  const serverCalibratedTime = parseTimestamp(server.lastCalibrated);
  if (localCalibratedTime > serverCalibratedTime && local.calibrationData) {
    merged.calibrationData = local.calibrationData;
    merged.lastCalibrated = local.lastCalibrated;
    merged.requiresCalibration = local.requiresCalibration;
    resolvedFromLocal.push('calibrationData', 'lastCalibrated', 'requiresCalibration');
  } else {
    resolvedFromServer.push('calibrationData', 'lastCalibrated', 'requiresCalibration');
  }
  merged.type = server.type;
  resolvedFromServer.push('type');
  merged.brand = server.brand;
  resolvedFromServer.push('brand');
  merged.model = server.model;
  resolvedFromServer.push('model');
  merged.bluetoothId = server.bluetoothId;
  resolvedFromServer.push('bluetoothId');
  merged.isActive = server.isActive;
  resolvedFromServer.push('isActive');
  merged.specifications = server.specifications;
  resolvedFromServer.push('specifications');
  merged.pairedAt = server.pairedAt;
  resolvedFromServer.push('pairedAt');
  const newVersion = Math.max(context.localVersion, context.serverVersion) + 1;
  merged.version = newVersion;
  merged.updatedAt = context.now;
  return {
    data: merged,
    version: newVersion,
    resolvedFromLocal: Object.freeze(resolvedFromLocal),
    resolvedFromServer: Object.freeze(resolvedFromServer),
    mergedFields: Object.freeze(mergedFields),
    updatedAt: context.now,
  };
}
