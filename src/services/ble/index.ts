export * from './protocol';
export {
  AppDeviceProtocolService,
  getProtocolService,
  resetProtocolService,
  type BLESendFunction,
  type HitEventCallback,
  type BatteryStatusCallback,
  type HelloAckCallback,
  type ConnectionStateCallback,
  type ErrorCallback,
  type ProtocolServiceConfig,
} from './AppDeviceProtocolService';
export {
  EventSyncService,
  type ProcessedHitEventCallback,
  type HandshakeCompleteCallback,
  type EventSyncServiceConfig,
} from './EventSyncService';
export {
  DeviceSettingsService,
  getDeviceSettingsService,
  resetDeviceSettingsService,
  type DeviceSettings,
  type SettingsChangedCallback,
  type DeviceSettingsServiceConfig,
} from './DeviceSettingsService';
export {
  otaService,
  FlasherPhase,
  FlasherError,
  OTA_LOG_FILE_PATH,
  readOtaLogs,
  clearOtaLogs,
  type FlasherStatus,
  type OtaProgressCallback,
} from './OtaService';
export {
  OtaPostUpdateVerifier,
  BluetoothHandlerDeviceInfoProvider,
  OtaPostUpdateErrorCode,
  type OtaPostUpdateVerifyOptions,
  type OtaPostUpdateResult,
  type OtaPostUpdateProgress,
  type OtaPostUpdateProgressCallback,
} from './ota/OtaPostUpdateVerifier';
export { shouldUseNativeTransport } from './transport';
