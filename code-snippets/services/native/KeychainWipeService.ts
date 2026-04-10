import { NativeModules, Platform } from 'react-native';
interface KeychainWipeResult {
  success: boolean;
}
interface KeychainWipeNativeModule {
  wipeKeychain(): Promise<KeychainWipeResult>;
}
const KeychainWipeNative = NativeModules.KeychainWipe as KeychainWipeNativeModule | undefined;
export async function wipeKeychain(): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    console.warn('[KeychainWipeService] Keychain wipe only available on iOS');
    return false;
  }
  if (!KeychainWipeNative) {
    const error = new Error(
      '[KeychainWipeService] CRITICAL: Native KeychainWipe module not available on iOS. ' +
      'This is a configuration error - the native module should be linked. ' +
      'Keychain wipe cannot proceed.'
    );
    console.error(error.message);
    throw error;
  }
  try {
    console.log('[KeychainWipeService] Starting Keychain wipe...');
    const result = await KeychainWipeNative.wipeKeychain();
    console.log('[KeychainWipeService] Wipe result:', result);
    return result?.success ?? false;
  } catch (error) {
    console.error('[KeychainWipeService] Wipe failed:', error);
    throw error;
  }
}
export function isKeychainWipeAvailable(): boolean {
  return Platform.OS === 'ios' && KeychainWipeNative !== undefined;
}
