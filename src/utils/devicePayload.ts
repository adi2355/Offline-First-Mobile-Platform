import { Device } from '../types';
export type DevicePayloadSource = Partial<Device> & {
  name?: string;
  deviceName?: string;
  status?: string;
};
const DEVICE_METADATA_FIELDS = [
  'type',
  'status',
  'macAddress',
  'bluetoothId',
  'serialNumber',
  'brand',
  'model',
  'firmwareVersion',
  'hardwareVersion',
  'isActive',
  'requiresCalibration',
  'lastCalibrated',
  'calibrationData',
  'settings',
  'specifications',
  'pairedAt',
  'deviceType',
  'version', 
] as const;
type DeviceMetadataField = (typeof DEVICE_METADATA_FIELDS)[number];
function resolveDeviceName(source: DevicePayloadSource): string | undefined {
  if (typeof source.name === 'string') {
    return source.name;
  }
  if (typeof source.deviceName === 'string') {
    return source.deviceName;
  }
  return undefined;
}
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}
function addDefinedField(
  target: Record<string, unknown>,
  source: DevicePayloadSource,
  field: DeviceMetadataField,
): void {
  const value = source[field as keyof DevicePayloadSource];
  if (value !== undefined) {
    target[field] = value;
  }
}
export function buildDeviceCreatePayload(source: DevicePayloadSource): Record<string, unknown> {
  const deviceName = resolveDeviceName(source);
  if (!deviceName || isBlank(deviceName)) {
    throw new Error('[DevicePayload] deviceName is required for device create payload');
  }
  const payload: Record<string, unknown> = { deviceName };
  DEVICE_METADATA_FIELDS.forEach((field) => addDefinedField(payload, source, field));
  return payload;
}
export function buildDeviceUpdatePayload(source: DevicePayloadSource): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const deviceName = resolveDeviceName(source);
  if (deviceName !== undefined) {
    if (isBlank(deviceName)) {
      throw new Error('[DevicePayload] deviceName cannot be blank for device update payload');
    }
    payload.deviceName = deviceName;
  }
  DEVICE_METADATA_FIELDS.forEach((field) => addDefinedField(payload, source, field));
  return payload;
}
