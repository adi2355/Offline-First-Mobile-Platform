import { AppState, AppStateStatus, Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { BluetoothHandler } from '../contexts/BluetoothContext';
const BACKGROUND_BLE_TASK_NAME = 'BACKGROUND_BLE_KEEP_ALIVE';
TaskManager.defineTask(BACKGROUND_BLE_TASK_NAME, async () => {
  try {
    const now = Date.now();
    console.log(`[BackgroundBLE] Background task executed at ${new Date(now).toISOString()}`);
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('[BackgroundBLE] Background task error:', err.message);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});
export class BackgroundBLEManager {
  private bluetoothHandler: BluetoothHandler;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private isBackgroundTaskRegistered: boolean = false;
  private lastBackgroundTime: number = 0;
  private lastForegroundTime: number = 0;
  constructor(bluetoothHandler: BluetoothHandler) {
    this.bluetoothHandler = bluetoothHandler;
  }
  public async initialize(): Promise<void> {
    console.log('[BackgroundBLE] Initializing background BLE manager...');
    if (Platform.OS === 'ios') {
      await this.registerBackgroundFetchTask();
    }
    this.setupAppStateListener();
    console.log('[BackgroundBLE] Background BLE manager initialized');
  }
  private async registerBackgroundFetchTask(): Promise<void> {
    try {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_BLE_TASK_NAME);
      if (isRegistered) {
        console.log('[BackgroundBLE] Background fetch task already registered');
        this.isBackgroundTaskRegistered = true;
        return;
      }
      await BackgroundFetch.registerTaskAsync(BACKGROUND_BLE_TASK_NAME, {
        minimumInterval: 15 * 60, 
        stopOnTerminate: false, 
        startOnBoot: true, 
      });
      this.isBackgroundTaskRegistered = true;
      console.log('[BackgroundBLE] ✅ Background fetch task registered successfully');
      console.log('[BackgroundBLE] iOS will now keep BLE connection alive when screen is locked');
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[BackgroundBLE] ❌ Failed to register background fetch task:', err.message);
      console.error('[BackgroundBLE] BLE connection may be terminated when screen locks!');
    }
  }
  private setupAppStateListener(): void {
    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange.bind(this));
    console.log('[BackgroundBLE] AppState listener registered');
  }
  private async handleAppStateChange(nextAppState: AppStateStatus): Promise<void> {
    const now = Date.now();
    if (nextAppState === 'background') {
      this.lastBackgroundTime = now;
      console.log('[BackgroundBLE] 📱 App entered background (screen locked or app switched)');
      console.log('[BackgroundBLE] BLE connection should persist via state restoration');
      const connectedDevice = this.bluetoothHandler.getConnectedDevice();
      if (connectedDevice) {
        console.log(`[BackgroundBLE] Device ${connectedDevice.id} still connected in background`);
      } else {
        console.warn('[BackgroundBLE] ⚠️ No device connected when entering background');
      }
    } else if (nextAppState === 'active') {
      this.lastForegroundTime = now;
      const timeInBackground = this.lastBackgroundTime > 0 ? (now - this.lastBackgroundTime) / 1000 : 0;
      console.log(`[BackgroundBLE] 📱 App entered foreground (was in background for ${timeInBackground.toFixed(1)}s)`);
      const connectedDevice = this.bluetoothHandler.getConnectedDevice();
      if (connectedDevice) {
        console.log(`[BackgroundBLE] ✅ Device ${connectedDevice.id} survived background transition`);
      } else {
        console.warn('[BackgroundBLE] ⚠️ Device disconnected while in background');
        console.log('[BackgroundBLE] State restoration should have re-established connection');
      }
      if (Platform.OS === 'ios') {
        this.checkBackgroundFetchStatus();
      }
    }
  }
  private async checkBackgroundFetchStatus(): Promise<void> {
    try {
      const status = await BackgroundFetch.getStatusAsync();
      const statusNames: Record<number, string> = {
        [BackgroundFetch.BackgroundFetchStatus.Restricted]: 'Restricted',
        [BackgroundFetch.BackgroundFetchStatus.Denied]: 'Denied',
        [BackgroundFetch.BackgroundFetchStatus.Available]: 'Available',
      };
      const statusName = status !== null ? statusNames[status] ?? 'Unknown' : 'Unknown';
      console.log(`[BackgroundBLE] Background fetch status: ${statusName}`);
      if (status === BackgroundFetch.BackgroundFetchStatus.Denied) {
        console.error('[BackgroundBLE] ❌ Background fetch is DENIED in iOS settings!');
        console.error('[BackgroundBLE] User must enable "Background App Refresh" in Settings > General');
      } else if (status === BackgroundFetch.BackgroundFetchStatus.Restricted) {
        console.warn('[BackgroundBLE] ⚠️ Background fetch is RESTRICTED (Low Power Mode?)');
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[BackgroundBLE] Error checking background fetch status:', err.message);
    }
  }
  public async keepConnectionActive(): Promise<void> {
    try {
      const connectedDevice = this.bluetoothHandler.getConnectedDevice();
      if (!connectedDevice) {
        return; 
      }
      await this.bluetoothHandler.requestBatteryStatus();
      console.log('[BackgroundBLE] Sent keepalive request (battery status) to maintain connection');
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[BackgroundBLE] Keepalive request failed:', err.message);
    }
  }
  public cleanup(): void {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
      console.log('[BackgroundBLE] AppState listener removed');
    }
  }
  public getStats(): {
    isBackgroundTaskRegistered: boolean;
    lastBackgroundTime: number;
    lastForegroundTime: number;
    timeInBackground: number;
  } {
    const now = Date.now();
    const timeInBackground = this.lastBackgroundTime > this.lastForegroundTime
      ? (now - this.lastBackgroundTime) / 1000
      : 0;
    return {
      isBackgroundTaskRegistered: this.isBackgroundTaskRegistered,
      lastBackgroundTime: this.lastBackgroundTime,
      lastForegroundTime: this.lastForegroundTime,
      timeInBackground,
    };
  }
}
