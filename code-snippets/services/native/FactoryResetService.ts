import { NativeModules, Platform } from 'react-native';
interface FactoryResetResult {
  success: boolean;
}
interface FactoryResetNativeModule {
  wipeSQLite(): Promise<FactoryResetResult>;
  wipeAsyncStorageRN(): Promise<FactoryResetResult>;
  wipeAll(): Promise<FactoryResetResult>;
}
const FactoryResetNative = NativeModules.FactoryReset as FactoryResetNativeModule | undefined;
export async function wipeSQLiteNative(): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    console.warn('[FactoryResetService] Native SQLite wipe only available on iOS');
    return false;
  }
  if (!FactoryResetNative) {
    console.error('[FactoryResetService] Native module not available');
    throw new Error('FactoryReset native module not available');
  }
  try {
    console.log('[FactoryResetService] Starting native SQLite wipe...');
    const result = await FactoryResetNative.wipeSQLite();
    console.log('[FactoryResetService] SQLite wipe result:', result);
    return result?.success ?? false;
  } catch (error) {
    console.error('[FactoryResetService] SQLite wipe failed:', error);
    throw error;
  }
}
export async function wipeAsyncStorageNative(): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    console.warn('[FactoryResetService] Native AsyncStorage wipe only available on iOS');
    return false;
  }
  if (!FactoryResetNative) {
    console.error('[FactoryResetService] Native module not available');
    throw new Error('FactoryReset native module not available');
  }
  try {
    console.log('[FactoryResetService] Starting native AsyncStorage wipe...');
    const result = await FactoryResetNative.wipeAsyncStorageRN();
    console.log('[FactoryResetService] AsyncStorage wipe result:', result);
    return result?.success ?? false;
  } catch (error) {
    console.error('[FactoryResetService] AsyncStorage wipe failed:', error);
    throw error;
  }
}
export async function wipeAllLocalStorageNative(): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    console.warn('[FactoryResetService] Native wipeAll only available on iOS');
    return false;
  }
  if (!FactoryResetNative) {
    console.error('[FactoryResetService] Native module not available');
    throw new Error('FactoryReset native module not available');
  }
  try {
    console.log('[FactoryResetService] Starting native full wipe (SQLite + AsyncStorage)...');
    const result = await FactoryResetNative.wipeAll();
    console.log('[FactoryResetService] Full wipe result:', result);
    return result?.success ?? false;
  } catch (error) {
    console.error('[FactoryResetService] Full wipe failed:', error);
    throw error;
  }
}
export function isFactoryResetAvailable(): boolean {
  return Platform.OS === 'ios' && FactoryResetNative !== undefined;
}
