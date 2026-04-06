import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, AppStateStatus } from 'react-native';
export const BACKGROUND_SAFE_KEYS = [
  'lastSessionHitTimestamp',    
  'lastActiveSessionId',        
  'lastSessionProductInfo',      
  'last_sync_timestamp',        
  'sync_conflicts',             
  'pendingJournalTimestamp',    
  'pendingJournalSessions',     
  'APP_PLATFORM_DEVICE_UUIDS',        
  'activeProductInfo',           
  'health_recent_first_reset_version', 
] as const;
export type BackgroundSafeKey = typeof BACKGROUND_SAFE_KEYS[number];
export function isBackgroundSafeKey(key: string): boolean {
  return BACKGROUND_SAFE_KEYS.includes(key as BackgroundSafeKey);
}
export class BackgroundSafeStorageService {
  private static instance: BackgroundSafeStorageService;
  private readonly keyPrefix = 'appplatform_bg_';
  private currentAppState: AppStateStatus = 'active';
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private constructor() {
    this.setupAppStateMonitoring();
  }
  public static getInstance(): BackgroundSafeStorageService {
    if (!BackgroundSafeStorageService.instance) {
      BackgroundSafeStorageService.instance = new BackgroundSafeStorageService();
    }
    return BackgroundSafeStorageService.instance;
  }
  private setupAppStateMonitoring(): void {
    this.currentAppState = AppState.currentState;
    this.appStateSubscription = AppState.addEventListener('change', (nextState) => {
      this.currentAppState = nextState;
    });
  }
  public cleanup(): void {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
  }
  private buildKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
  public async setValue<T>(key: string, value: T): Promise<void> {
    try {
      const prefixedKey = this.buildKey(key);
      const stringValue = JSON.stringify(value);
      await AsyncStorage.setItem(prefixedKey, stringValue);
    } catch (error) {
      console.error(
        `[BackgroundSafeStorageService] Failed to set value for key '${key}' (appState: ${this.currentAppState}):`,
        error
      );
      throw new Error(
        `BackgroundSafeStorage setItem failed for key '${key}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  public async getValue<T>(key: string): Promise<T | null> {
    try {
      const prefixedKey = this.buildKey(key);
      const stringValue = await AsyncStorage.getItem(prefixedKey);
      if (stringValue === null) {
        return null;
      }
      try {
        return JSON.parse(stringValue) as T;
      } catch (parseError) {
        console.error(
          `[BackgroundSafeStorageService] Failed to parse stored value for key '${key}':`,
          parseError
        );
        return null;
      }
    } catch (error) {
      console.error(
        `[BackgroundSafeStorageService] Failed to get value for key '${key}' (appState: ${this.currentAppState}):`,
        error
      );
      return null;
    }
  }
  public async removeValue(key: string): Promise<void> {
    try {
      const prefixedKey = this.buildKey(key);
      await AsyncStorage.removeItem(prefixedKey);
    } catch (error) {
      console.error(
        `[BackgroundSafeStorageService] Failed to remove value for key '${key}':`,
        error
      );
      throw new Error(
        `BackgroundSafeStorage removeItem failed for key '${key}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  public async hasKey(key: string): Promise<boolean> {
    try {
      const value = await this.getValue(key);
      return value !== null;
    } catch {
      return false;
    }
  }
  public async getMultipleValues<T>(keys: string[]): Promise<Record<string, T | null>> {
    const result: Record<string, T | null> = {};
    for (const key of keys) {
      result[key] = null;
    }
    try {
      const prefixedKeys = keys.map(k => this.buildKey(k));
      const pairs = await AsyncStorage.multiGet(prefixedKeys);
      pairs.forEach((pair, index) => {
        const originalKey = keys[index];
        if (!originalKey || !pair) {
          return;
        }
        const stringValue = pair[1];
        if (stringValue !== null && stringValue !== undefined) {
          try {
            result[originalKey] = JSON.parse(stringValue) as T;
          } catch {
          }
        }
      });
    } catch (error) {
      console.error('[BackgroundSafeStorageService] Failed to get multiple values:', error);
    }
    return result;
  }
  public async setMultipleValues<T>(entries: Record<string, T>): Promise<void> {
    try {
      const pairs: [string, string][] = Object.entries(entries).map(([key, value]) => [
        this.buildKey(key),
        JSON.stringify(value),
      ]);
      await AsyncStorage.multiSet(pairs);
    } catch (error) {
      console.error('[BackgroundSafeStorageService] Failed to set multiple values:', error);
      throw error;
    }
  }
  public async clearAll(): Promise<void> {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const bgKeys = allKeys.filter(k => k.startsWith(this.keyPrefix));
      if (bgKeys.length > 0) {
        await AsyncStorage.multiRemove(bgKeys);
        console.log(`[BackgroundSafeStorageService] Cleared ${bgKeys.length} keys`);
      }
    } catch (error) {
      console.error('[BackgroundSafeStorageService] Failed to clear all keys:', error);
      throw error;
    }
  }
  public async migrateFromSecureStorage<T>(key: string, secureStorageValue: T | null): Promise<void> {
    if (secureStorageValue === null) {
      return; 
    }
    try {
      const existingValue = await this.getValue<T>(key);
      if (existingValue !== null) {
        console.log(`[BackgroundSafeStorageService] Key '${key}' already migrated, skipping`);
        return;
      }
      await this.setValue(key, secureStorageValue);
      console.log(`[BackgroundSafeStorageService] Migrated key '${key}' from SecureStorage`);
    } catch (error) {
      console.error(`[BackgroundSafeStorageService] Failed to migrate key '${key}':`, error);
    }
  }
}
export const backgroundSafeStorage = BackgroundSafeStorageService.getInstance();
