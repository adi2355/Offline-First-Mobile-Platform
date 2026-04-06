import { randomUUID } from 'expo-crypto';
import { secureStorage, DataSensitivity } from '../services/SecureStorageService';
import { logger } from './logger';
const DEVICE_ID_KEY = 'device_unique_id';
export class DeviceIdManager {
  private static deviceId: string | null = null;
  private static initializationPromise: Promise<string> | null = null;
  public static async getDeviceId(): Promise<string> {
    if (this.deviceId) {
      return this.deviceId;
    }
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    this.initializationPromise = this.initialize();
    try {
      const deviceId = await this.initializationPromise;
      return deviceId;
    } finally {
      this.initializationPromise = null;
    }
  }
  private static async initialize(): Promise<string> {
    try {
      const existingId = await secureStorage.getItem(
        DEVICE_ID_KEY,
        DataSensitivity.PRIVATE
      );
      if (existingId) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(existingId)) {
          this.deviceId = existingId;
          logger.debug('DeviceIdManager: Loaded existing device ID', {
            deviceId: `${existingId.substring(0, 8)}...`
          });
          return existingId;
        } else {
          logger.warn('DeviceIdManager: Invalid device ID format in storage, generating new one', {
            invalidId: `${existingId.substring(0, 8)}...`
          });
        }
      }
      const newDeviceId = randomUUID();
      await secureStorage.setItem(
        DEVICE_ID_KEY,
        newDeviceId,
        DataSensitivity.PRIVATE
      );
      this.deviceId = newDeviceId;
      logger.info('DeviceIdManager: Generated and stored new device ID', {
        deviceId: `${newDeviceId.substring(0, 8)}...`
      });
      return newDeviceId;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DeviceIdManager: Failed to initialize device ID', {
        error: { name: err.name, message: err.message, stack: err.stack }
      });
      const fallbackId = randomUUID();
      this.deviceId = fallbackId;
      logger.warn('DeviceIdManager: Using in-memory fallback device ID (not persisted)', {
        deviceId: `${fallbackId.substring(0, 8)}...`
      });
      return fallbackId;
    }
  }
  public static async clearDeviceId(): Promise<void> {
    try {
      await secureStorage.removeValue(DEVICE_ID_KEY, DataSensitivity.PRIVATE);
      this.deviceId = null;
      this.initializationPromise = null;
      logger.info('DeviceIdManager: Device ID cleared');
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DeviceIdManager: Failed to clear device ID', {
        error: { name: err.name, message: err.message, stack: err.stack }
      });
      throw err;
    }
  }
  public static getCachedDeviceId(): string | null {
    return this.deviceId;
  }
}
