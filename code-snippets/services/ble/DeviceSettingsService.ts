import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppDeviceProtocolService } from './AppDeviceProtocolService';
import { ConfigDataPayload, HelloAckPayload } from './protocol/types';
const STORAGE_KEYS = {
  SENSITIVITY: '@trakplus/sensitivity',
  LED_BRIGHTNESS: '@trakplus/ledBrightness',
  LAST_SYNC_TIME: '@trakplus/settingsLastSync',
  CONFIG_SIGNATURE: '@trakplus/configSignature',
  PENDING_SENSITIVITY: '@trakplus/pendingSensitivity',
} as const;
const DEBOUNCE_DELAY_MS = 500;
const DEFAULT_SENSITIVITY = 50;
const DEFAULT_LED_BRIGHTNESS = 128;
export interface DeviceSettings {
  sensitivity: number;
  ledBrightness: number;
}
export type SettingsChangedCallback = (settings: DeviceSettings) => void;
export interface DeviceSettingsServiceConfig {
  verbose: boolean;
  debounceMs: number;
}
const DEFAULT_CONFIG: DeviceSettingsServiceConfig = {
  verbose: true,
  debounceMs: DEBOUNCE_DELAY_MS,
};
export class DeviceSettingsService {
  private protocolService: AppDeviceProtocolService;
  private config: DeviceSettingsServiceConfig;
  private sensitivity: number = DEFAULT_SENSITIVITY;
  private ledBrightness: number = DEFAULT_LED_BRIGHTNESS;
  private configSignature: number = 0;
  private isInitialized: boolean = false;
  private isSynced: boolean = false;
  private isConnected: boolean = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingSensitivity: number | null = null;
  private onSettingsChanged: SettingsChangedCallback | null = null;
  private onSensitivityUpdate: ((sensitivity: number) => void) | null = null;
  constructor(
    protocolService: AppDeviceProtocolService,
    config: Partial<DeviceSettingsServiceConfig> = {}
  ) {
    this.protocolService = protocolService;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.log('Already initialized');
      return;
    }
    this.protocolService.setOnConfigData(this.handleConfigData.bind(this));
    await this.loadFromStorage();
    this.isInitialized = true;
    this.log(`Initialized. Sensitivity: ${this.sensitivity}`);
  }
  public cleanup(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.isSynced = false;
    this.isConnected = false;
    this.log('Cleaned up');
  }
  public async onDeviceConnected(): Promise<void> {
    this.isConnected = true;
    this.isSynced = false;
    this.log('Device connected. Waiting for handshake before requesting settings...');
  }
  public async syncSettingsAfterHandshake(): Promise<void> {
    if (!this.isConnected) {
      this.log('Cannot sync settings: device not connected');
      return;
    }
    this.log('Handshake complete. Requesting settings from device...');
    const pendingValue = await this.loadPendingSensitivity();
    const hasPendingConfig = pendingValue !== null;
    const maxRetries = 3;
    const baseDelayMs = 500;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (!this.isConnected) {
        this.log(`Aborting config sync: device disconnected (detected before attempt ${attempt})`);
        return;
      }
      try {
        await this.protocolService.sendGetConfig();
        this.log(`GET_CONFIG sent successfully (attempt ${attempt}/${maxRetries})`);
        if (hasPendingConfig && pendingValue !== null) {
          this.log(`EC-ZOMBIE-CONFIG-001: Pushing pending sensitivity=${pendingValue} to device`);
          await new Promise(resolve => setTimeout(resolve, 200));
          if (this.isConnected) {
            try {
              await this.protocolService.sendSetSensitivity(pendingValue);
              this.log('EC-ZOMBIE-CONFIG-001: Pending config pushed successfully');
              await this.clearPendingSensitivity();
            } catch (pushError) {
              console.warn('[DeviceSettings] EC-ZOMBIE-CONFIG-001: Failed to push pending config:', pushError);
            }
          }
        }
        return; 
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('BLE_NOT_CONNECTED')) {
          this.log(`Aborting config sync: BLE disconnected (immediate abort, no retry)`);
          this.isConnected = false; 
          return; 
        }
        if (!this.isConnected) {
          this.log(`Aborting config sync: device disconnected during attempt ${attempt}`);
          return;
        }
        if (attempt < maxRetries) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          this.log(`GET_CONFIG attempt ${attempt}/${maxRetries} failed: ${errorMsg}`);
          this.log(`Retrying in ${delayMs}ms (encryption may still be in progress)...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          if (!this.isConnected) {
            this.log('Aborting config sync: device disconnected during backoff wait');
            return;
          }
        } else {
          console.error(`[DeviceSettings] GET_CONFIG failed after ${maxRetries} attempts:`, error);
          this.log('Using cached settings (device sync failed)');
        }
      }
    }
  }
  public async onDeviceDisconnected(reason?: string): Promise<void> {
    this.isConnected = false;
    this.isSynced = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingSensitivity !== null) {
      const isSleepDisconnect = reason === 'device_sleep' || reason === 'assumed_sleep';
      if (isSleepDisconnect) {
        this.log(`EC-ZOMBIE-CONFIG-001: Preserving pending sensitivity=${this.pendingSensitivity} for sleep disconnect`);
        await this.savePendingSensitivity(this.pendingSensitivity);
        this.sensitivity = this.pendingSensitivity;
        await this.saveToStorage();
      } else {
        this.log(`EC-ZOMBIE-CONFIG-001: Preserving pending sensitivity=${this.pendingSensitivity} for unexpected disconnect`);
        await this.savePendingSensitivity(this.pendingSensitivity);
      }
    }
    this.pendingSensitivity = null;
    this.log(`Device disconnected (reason: ${reason || 'unknown'})`);
  }
  public handleHelloAck(helloAck: HelloAckPayload): boolean {
    const storedSignature = this.configSignature;
    const deviceSignature = helloAck.configSignature;
    if (storedSignature !== 0 && deviceSignature !== storedSignature) {
      this.log(`FACTORY RESET DETECTED: signature mismatch (stored=0x${storedSignature.toString(16)}, device=0x${deviceSignature.toString(16)})`);
      this.sensitivity = helloAck.sensitivity;
      this.configSignature = deviceSignature;
      this.saveToStorage();
      this.notifySettingsChanged();
      return false; 
    }
    if (storedSignature === 0 && deviceSignature !== 0) {
      this.log(`First connection, storing signature: 0x${deviceSignature.toString(16)}`);
      this.configSignature = deviceSignature;
      this.sensitivity = helloAck.sensitivity;
      this.saveToStorage();
      this.notifySettingsChanged();
    }
    if (this.sensitivity !== helloAck.sensitivity) {
      this.log(`Sensitivity from HelloAck: ${helloAck.sensitivity}`);
      this.sensitivity = helloAck.sensitivity;
      this.notifySettingsChanged();
    }
    return true; 
  }
  public setOnSettingsChanged(callback: SettingsChangedCallback | null): void {
    this.onSettingsChanged = callback;
  }
  public setOnSensitivityUpdate(callback: ((sensitivity: number) => void) | null): void {
    this.onSensitivityUpdate = callback;
  }
  public getSensitivity(): number {
    return this.sensitivity;
  }
  public getLedBrightness(): number {
    return this.ledBrightness;
  }
  public getSettings(): DeviceSettings {
    return {
      sensitivity: this.sensitivity,
      ledBrightness: this.ledBrightness,
    };
  }
  public isSyncedWithDevice(): boolean {
    return this.isSynced;
  }
  private previousSensitivity: number | null = null;
  public setSensitivity(sensitivity: number, immediate: boolean = false): void {
    const clampedValue = Math.max(0, Math.min(100, sensitivity));
    if (this.previousSensitivity === null) {
      this.previousSensitivity = this.sensitivity;
    }
    this.sensitivity = clampedValue;
    this.notifySettingsChanged();
    if (!this.isConnected) {
      this.saveToStorage();
      this.previousSensitivity = null; 
      this.log(`Sensitivity set to ${clampedValue} (device not connected, saved locally)`);
      return;
    }
    if (immediate) {
      this.sendSensitivityToDevice(clampedValue);
    } else {
      this.debounceSensitivityUpdate(clampedValue);
    }
  }
  public flushPendingSensitivity(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingSensitivity !== null) {
      this.sendSensitivityToDevice(this.pendingSensitivity);
      this.pendingSensitivity = null;
    }
  }
  private handleConfigData(config: ConfigDataPayload): void {
    this.log(`Received CONFIG_DATA: sensitivity=${config.sensitivity}, ledBrightness=${config.ledBrightness}`);
    this.sensitivity = config.sensitivity;
    this.ledBrightness = config.ledBrightness;
    this.isSynced = true;
    this.saveToStorage();
    this.clearPendingSensitivity();
    this.notifySettingsChanged();
  }
  private debounceSensitivityUpdate(sensitivity: number): void {
    this.pendingSensitivity = sensitivity;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      if (this.pendingSensitivity !== null) {
        this.sendSensitivityToDevice(this.pendingSensitivity);
        this.pendingSensitivity = null;
      }
      this.debounceTimer = null;
    }, this.config.debounceMs);
  }
  private async sendSensitivityToDevice(sensitivity: number): Promise<void> {
    this.log(`Sending sensitivity ${sensitivity} to device`);
    try {
      await this.protocolService.sendSetSensitivity(sensitivity);
      this.log('Sensitivity sent successfully');
      this.saveToStorage();
      this.previousSensitivity = null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[DeviceSettings] Failed to send sensitivity:', errorMsg);
      if (this.isDisconnectError(errorMsg)) {
        this.log(`EC-ZOMBIE-CONFIG-001: Send failed due to disconnect/sleep, queueing sensitivity=${sensitivity}`);
        await this.savePendingSensitivity(sensitivity);
        this.sensitivity = sensitivity;
        this.previousSensitivity = null;
        await this.saveToStorage();
        return;
      }
      if (this.previousSensitivity !== null) {
        this.log(`Rolling back sensitivity: ${sensitivity} -> ${this.previousSensitivity}`);
        this.sensitivity = this.previousSensitivity;
        this.previousSensitivity = null;
        this.notifySettingsChanged();
      }
    }
  }
  private isDisconnectError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('ble_not_connected') ||
      normalized.includes('device_sleep') ||
      normalized.includes('device disconnected') ||
      normalized.includes('connection closed') ||
      normalized.includes('timeout')
    );
  }
  private async loadFromStorage(): Promise<void> {
    try {
      const [sensitivityStr, ledBrightnessStr, signatureStr] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.SENSITIVITY),
        AsyncStorage.getItem(STORAGE_KEYS.LED_BRIGHTNESS),
        AsyncStorage.getItem(STORAGE_KEYS.CONFIG_SIGNATURE),
      ]);
      if (sensitivityStr !== null) {
        const parsed = parseInt(sensitivityStr, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
          this.sensitivity = parsed;
        }
      }
      if (ledBrightnessStr !== null) {
        const parsed = parseInt(ledBrightnessStr, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 255) {
          this.ledBrightness = parsed;
        }
      }
      if (signatureStr !== null) {
        const parsed = parseInt(signatureStr, 10);
        if (!isNaN(parsed)) {
          this.configSignature = parsed;
        }
      }
      this.log(`Loaded from storage: sensitivity=${this.sensitivity}, ledBrightness=${this.ledBrightness}, signature=0x${this.configSignature.toString(16)}`);
    } catch (error) {
      console.error('[DeviceSettings] Failed to load from storage:', error);
    }
  }
  private async saveToStorage(): Promise<void> {
    try {
      await Promise.all([
        AsyncStorage.setItem(STORAGE_KEYS.SENSITIVITY, this.sensitivity.toString()),
        AsyncStorage.setItem(STORAGE_KEYS.LED_BRIGHTNESS, this.ledBrightness.toString()),
        AsyncStorage.setItem(STORAGE_KEYS.LAST_SYNC_TIME, Date.now().toString()),
        AsyncStorage.setItem(STORAGE_KEYS.CONFIG_SIGNATURE, this.configSignature.toString()),
      ]);
    } catch (error) {
      console.error('[DeviceSettings] Failed to save to storage:', error);
    }
  }
  private async savePendingSensitivity(value: number): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.PENDING_SENSITIVITY, value.toString());
      this.log(`EC-ZOMBIE-CONFIG-001: Saved pending sensitivity=${value} to storage`);
    } catch (error) {
      console.error('[DeviceSettings] Failed to save pending sensitivity:', error);
    }
  }
  private async loadPendingSensitivity(): Promise<number | null> {
    try {
      const value = await AsyncStorage.getItem(STORAGE_KEYS.PENDING_SENSITIVITY);
      if (value !== null) {
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
          this.log(`EC-ZOMBIE-CONFIG-001: Loaded pending sensitivity=${parsed} from storage`);
          return parsed;
        }
      }
      return null;
    } catch (error) {
      console.error('[DeviceSettings] Failed to load pending sensitivity:', error);
      return null;
    }
  }
  private async clearPendingSensitivity(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEYS.PENDING_SENSITIVITY);
      this.log('EC-ZOMBIE-CONFIG-001: Cleared pending sensitivity from storage');
    } catch (error) {
      console.error('[DeviceSettings] Failed to clear pending sensitivity:', error);
    }
  }
  private notifySettingsChanged(): void {
    if (this.onSettingsChanged) {
      this.onSettingsChanged(this.getSettings());
    }
    if (this.onSensitivityUpdate) {
      this.onSensitivityUpdate(this.sensitivity);
    }
  }
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[DeviceSettings] ${message}`);
    }
  }
}
let deviceSettingsInstance: DeviceSettingsService | null = null;
export function getDeviceSettingsService(
  protocolService?: AppDeviceProtocolService
): DeviceSettingsService | null {
  if (!deviceSettingsInstance && protocolService) {
    deviceSettingsInstance = new DeviceSettingsService(protocolService);
  }
  return deviceSettingsInstance;
}
export function resetDeviceSettingsService(): void {
  if (deviceSettingsInstance) {
    deviceSettingsInstance.cleanup();
  }
  deviceSettingsInstance = null;
}
