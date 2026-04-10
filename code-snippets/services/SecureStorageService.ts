import * as SecureStore from 'expo-secure-store';
export enum DataSensitivity {
  PUBLIC = 'public',
  PRIVATE = 'private',
  SENSITIVE = 'sensitive', 
  SECRET = 'secret'
}
export interface SecureStorageOptions {
  requireAuthentication?: boolean;
  showModal?: boolean;
  promptMessage?: string;
}
export class SecureStorageService {
  private static instance: SecureStorageService;
  private constructor() {}
  public static getInstance(): SecureStorageService {
    if (!SecureStorageService.instance) {
      SecureStorageService.instance = new SecureStorageService();
    }
    return SecureStorageService.instance;
  }
  async initialize(): Promise<void> {
    return Promise.resolve();
  }
  async setValue<T>(
    key: string,
    value: T,
    options?: { sensitivity?: DataSensitivity }
  ): Promise<void> {
    const sensitivity = options?.sensitivity || DataSensitivity.PUBLIC;
    const stringValue = JSON.stringify(value);
    return this.setItem(key, stringValue, sensitivity);
  }
  async getValue<T>(
    key: string,
    sensitivity: DataSensitivity = DataSensitivity.PUBLIC
  ): Promise<T | null> {
    const stringValue = await this.getItem(key, sensitivity);
    if (stringValue === null) {
      return null;
    }
    try {
      return JSON.parse(stringValue) as T;
    } catch (error) {
      console.error(`[SecureStorageService] Error parsing stored value for key '${key}':`, error);
      return null;
    }
  }
  async setItem(
    key: string, 
    value: string, 
    sensitivity: DataSensitivity,
    options?: SecureStorageOptions
  ): Promise<void> {
    try {
      const valueSize = value.length;
      if (valueSize > 2048) {
        console.warn(`[SecureStorageService] WARNING: Storing value for key '${key}' that is ${valueSize} bytes. iOS SecureStore has a 2048-byte limit and this may fail or be truncated.`);
      }
      const secureKey = this.buildKey(key, sensitivity);
      const secureOptions = this.buildSecureStoreOptions(sensitivity, options);
      await SecureStore.setItemAsync(secureKey, value, secureOptions);
    } catch (error) {
      throw this.handleStorageError(error, 'setItem', key);
    }
  }
  async getItem(
    key: string, 
    sensitivity: DataSensitivity,
    options?: SecureStorageOptions
  ): Promise<string | null> {
    try {
      const secureKey = this.buildKey(key, sensitivity);
      const secureOptions = this.buildSecureStoreOptions(sensitivity, options);
      return await SecureStore.getItemAsync(secureKey, secureOptions);
    } catch (error) {
      throw this.handleStorageError(error, 'getItem', key);
    }
  }
  async removeValue(
    key: string, 
    sensitivity: DataSensitivity
  ): Promise<void> {
    try {
      const secureKey = this.buildKey(key, sensitivity);
      await SecureStore.deleteItemAsync(secureKey);
    } catch (error) {
      throw this.handleStorageError(error, 'removeValue', key);
    }
  }
  async hasItem(
    key: string,
    sensitivity: DataSensitivity
  ): Promise<boolean> {
    try {
      const value = await this.getItem(key, sensitivity);
      return value !== null;
    } catch (error) {
      return false;
    }
  }
  async clearSensitivityLevel(sensitivity: DataSensitivity): Promise<void> {
    throw new Error('clearSensitivityLevel is not supported by expo-secure-store. Keys must be removed individually.');
  }
  private buildKey(key: string, sensitivity: DataSensitivity): string {
    return `appplatform_${sensitivity}_${key}`;
  }
  private buildSecureStoreOptions(
    sensitivity: DataSensitivity,
    options?: SecureStorageOptions
  ): SecureStore.SecureStoreOptions {
    const baseOptions: SecureStore.SecureStoreOptions = {};
    if (sensitivity === DataSensitivity.SECRET) {
      baseOptions.requireAuthentication = options?.requireAuthentication ?? true;
      baseOptions.authenticationPrompt = options?.promptMessage ?? 'Authenticate to access secure data';
    } else if (sensitivity === DataSensitivity.SENSITIVE) {
      baseOptions.keychainAccessible = SecureStore.AFTER_FIRST_UNLOCK;
      baseOptions.requireAuthentication = options?.requireAuthentication ?? false;
      if (options?.promptMessage) {
        baseOptions.authenticationPrompt = options.promptMessage;
      }
    } else if (sensitivity === DataSensitivity.PRIVATE) {
      baseOptions.keychainAccessible = SecureStore.AFTER_FIRST_UNLOCK;
      baseOptions.requireAuthentication = options?.requireAuthentication ?? false;
      if (options?.promptMessage) {
        baseOptions.authenticationPrompt = options.promptMessage;
      }
    } else {
      baseOptions.keychainAccessible = SecureStore.AFTER_FIRST_UNLOCK;
    }
    return baseOptions;
  }
  private handleStorageError(error: unknown, operation: string, key: string): Error {
    let errorMessage = 'Unknown storage error';
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
      errorMessage = error.message;
    } else if (error && typeof error === 'object' && 'toString' in error && typeof error.toString === 'function') {
      try {
        const stringified = error.toString();
        if (stringified !== '[object Object]') {
          errorMessage = stringified;
        }
      } catch {
      }
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    if (errorMessage.includes('UserCancel')) {
      return new Error(`User cancelled authentication for ${operation} operation on key: ${key}`);
    }
    if (errorMessage.includes('UserFallback')) {
      return new Error(`User chose fallback authentication for ${operation} operation on key: ${key}`);
    }
    if (errorMessage.includes('BiometryNotAvailable')) {
      return new Error(`Biometric authentication not available for ${operation} operation on key: ${key}`);
    }
    if (errorMessage.includes('BiometryNotEnrolled')) {
      return new Error(`Biometric authentication not enrolled for ${operation} operation on key: ${key}`);
    }
    if (errorMessage.includes('BiometryLockout')) {
      return new Error(`Biometric authentication locked out for ${operation} operation on key: ${key}`);
    }
    return new Error(`SecureStorage ${operation} failed for key '${key}': ${errorMessage}`);
  }
}
export const secureStorage = SecureStorageService.getInstance();