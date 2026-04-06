import { BluetoothHandler } from '../../../contexts/BluetoothContext';
import type { HelloAckPayload } from '../protocol/types';
import type { Device } from '../../../types';
import { logger } from '../../../utils/logger';
import { DeviceService } from '../../DeviceService';
export type BleConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'HANDSHAKING'
  | 'READY'
  | 'DISCONNECTING';
export interface BleDeviceInfoProvider {
  getConnectionState(): BleConnectionState;
  getConnectedDeviceId(): string | null;
  connect(deviceId: string): Promise<void>;
  getDeviceInfo(): HelloAckPayload | null;
}
export class BluetoothHandlerDeviceInfoProvider implements BleDeviceInfoProvider {
  constructor(private readonly handler: BluetoothHandler) {}
  getConnectionState(): BleConnectionState {
    return this.handler.getConnectionState() as BleConnectionState;
  }
  getConnectedDeviceId(): string | null {
    return this.handler.getConnectedDevice()?.id ?? null;
  }
  async connect(deviceId: string): Promise<void> {
    await this.handler.connectToDevice(deviceId);
  }
  getDeviceInfo(): HelloAckPayload | null {
    return this.handler.getEventSyncService().getDeviceInfo();
  }
}
export enum OtaPostUpdateErrorCode {
  BLE_TIMEOUT = 'BLE_TIMEOUT',
  DEVICE_INFO_TIMEOUT = 'DEVICE_INFO_TIMEOUT',
  DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',
  DEVICE_MISMATCH = 'DEVICE_MISMATCH',
  VERSION_MISMATCH = 'VERSION_MISMATCH',
}
export interface OtaPostUpdateError {
  code: OtaPostUpdateErrorCode;
  message: string;
  recovery: string;
}
export type OtaPostUpdatePhase =
  | 'WAITING_FOR_BLE'
  | 'WAITING_FOR_DEVICE_INFO'
  | 'VERIFYING_VERSION';
export interface OtaPostUpdateProgress {
  phase: OtaPostUpdatePhase;
  message: string;
  elapsedMs: number;
}
export type OtaPostUpdateProgressCallback = (progress: OtaPostUpdateProgress) => void;
export interface OtaPostUpdateVerifyOptions {
  deviceId?: string;
  expectedVersion?: string;
  timeoutMs?: number;
  deviceInfoTimeoutMs?: number;
  pollIntervalMs?: number;
  maxConnectAttempts?: number;
  connectBackoffMs?: number;
}
export interface OtaPostUpdateResult {
  verified: boolean;
  firmwareVersion?: string;
  deviceId?: string;
  hardwareId?: string;
  bluetoothId?: string;
  warning?: string;
  error?: OtaPostUpdateError;
}
const DEFAULT_VERIFY_TIMEOUT_MS = 60000;
const DEFAULT_DEVICE_INFO_TIMEOUT_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_MAX_CONNECT_ATTEMPTS = 2;
const DEFAULT_CONNECT_BACKOFF_MS = 2000;
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function formatFirmwareVersion(info: HelloAckPayload): string {
  return `${info.firmwareMajor}.${info.firmwareMinor}.${info.firmwarePatch}`;
}
export class OtaPostUpdateVerifier {
  constructor(
    private readonly bleProvider: BleDeviceInfoProvider,
    private readonly deviceService: DeviceService
  ) {}
  async verify(
    options: OtaPostUpdateVerifyOptions,
    onProgress?: OtaPostUpdateProgressCallback
  ): Promise<OtaPostUpdateResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    const deviceInfoTimeoutMs = options.deviceInfoTimeoutMs ?? DEFAULT_DEVICE_INFO_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxConnectAttempts = options.maxConnectAttempts ?? DEFAULT_MAX_CONNECT_ATTEMPTS;
    const connectBackoffMs = options.connectBackoffMs ?? DEFAULT_CONNECT_BACKOFF_MS;
    const startTime = Date.now();
    let readyAt: number | null = null;
    let localDevice: Device | null = null;
    if (options.deviceId) {
      localDevice = await this.deviceService.getDeviceById(options.deviceId);
      if (!localDevice) {
        return {
          verified: false,
          error: {
            code: OtaPostUpdateErrorCode.DEVICE_NOT_FOUND,
            message: `Device not found for verification: ${options.deviceId}`,
            recovery: 'Reconnect to the device and retry verification.',
          },
        };
      }
    }
    const targetBluetoothId = localDevice?.bluetoothId ?? null;
    let connectAttempts = 0;
    let lastConnectAttemptAt = 0;
    while (Date.now() - startTime < timeoutMs) {
      const elapsedMs = Date.now() - startTime;
      const connectionState = this.bleProvider.getConnectionState();
      if (connectionState !== 'READY') {
        readyAt = null;
      }
      if (connectionState === 'DISCONNECTED' && targetBluetoothId) {
        const canAttemptConnect = connectAttempts < maxConnectAttempts
          && (Date.now() - lastConnectAttemptAt >= connectBackoffMs);
        if (canAttemptConnect) {
          connectAttempts += 1;
          lastConnectAttemptAt = Date.now();
          onProgress?.({
            phase: 'WAITING_FOR_BLE',
            message: `Attempting BLE reconnect (${connectAttempts}/${maxConnectAttempts})...`,
            elapsedMs,
          });
          try {
            await this.bleProvider.connect(targetBluetoothId);
          } catch (error: unknown) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn('[OtaPostUpdateVerifier] BLE reconnect attempt failed', {
              bluetoothId: targetBluetoothId,
              attempt: connectAttempts,
              error: {
                name: err.name,
                message: err.message,
                stack: err.stack,
              },
            });
          }
        }
      }
      if (connectionState === 'READY') {
        if (!readyAt) {
          readyAt = Date.now();
        }
        const info = this.bleProvider.getDeviceInfo();
        if (!info) {
          if (readyAt && Date.now() - readyAt >= deviceInfoTimeoutMs) {
            return {
              verified: false,
              error: {
                code: OtaPostUpdateErrorCode.DEVICE_INFO_TIMEOUT,
                message: 'Timed out waiting for device info after BLE reconnect.',
                recovery: 'Reconnect to the device and retry verification.',
              },
            };
          }
          onProgress?.({
            phase: 'WAITING_FOR_DEVICE_INFO',
            message: 'Waiting for device info (HELLO_ACK)...',
            elapsedMs,
          });
          await sleep(pollIntervalMs);
          continue;
        }
        const firmwareVersion = formatFirmwareVersion(info);
        const hardwareId = info.hardwareId || undefined;
        const bluetoothId = this.bleProvider.getConnectedDeviceId() ?? undefined;
        onProgress?.({
          phase: 'VERIFYING_VERSION',
          message: `Verifying firmware version v${firmwareVersion}...`,
          elapsedMs,
        });
        if (options.deviceId && hardwareId) {
          const matchedDevice = await this.deviceService.findDeviceByMacAddress(hardwareId);
          if (matchedDevice && matchedDevice.id !== options.deviceId) {
            return {
              verified: false,
              firmwareVersion,
              hardwareId,
              bluetoothId,
              error: {
                code: OtaPostUpdateErrorCode.DEVICE_MISMATCH,
                message: `Connected device does not match expected device (${options.deviceId}).`,
                recovery: 'Connect to the correct device and retry verification.',
              },
            };
          }
        }
        if (options.expectedVersion && firmwareVersion !== options.expectedVersion) {
          return {
            verified: false,
            firmwareVersion,
            hardwareId,
            bluetoothId,
            error: {
              code: OtaPostUpdateErrorCode.VERSION_MISMATCH,
              message: `Firmware version mismatch (expected ${options.expectedVersion}, got ${firmwareVersion}).`,
              recovery: 'Retry the update with the correct firmware package.',
            },
          };
        }
        if (localDevice && localDevice.firmwareVersion !== firmwareVersion) {
          await this.deviceService.updateFirmwareVersion(localDevice.id, firmwareVersion);
        }
        const warning = !hardwareId && options.deviceId
          ? 'Firmware verified, but hardware ID is missing. Device identity could not be fully validated.'
          : undefined;
        return {
          verified: true,
          firmwareVersion,
          deviceId: localDevice?.id ?? options.deviceId,
          hardwareId,
          bluetoothId,
          warning,
        };
      }
      onProgress?.({
        phase: 'WAITING_FOR_BLE',
        message: 'Waiting for BLE reconnection...',
        elapsedMs,
      });
      await sleep(pollIntervalMs);
    }
    return {
      verified: false,
      error: {
        code: OtaPostUpdateErrorCode.BLE_TIMEOUT,
        message: 'Timed out waiting for device to reconnect over BLE.',
        recovery: 'Ensure the device is powered on and in range, then retry verification.',
      },
    };
  }
}
