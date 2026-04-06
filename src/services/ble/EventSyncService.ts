import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AppDeviceProtocolService,
  HitEventCallback,
  HelloAckCallback,
} from './AppDeviceProtocolService';
import {
  HitEvent,
  HelloAckPayload,
} from './protocol/types';
import { DeviceSettingsService, getDeviceSettingsService } from './DeviceSettingsService';
const STORAGE_KEYS = {
  LAST_EVENT_ID: '@trakplus/lastEventId_v2',
  LAST_EVENT_ID_BACKUP: '@trakplus/lastEventId_backup_v2',
  LAST_PERSIST_TIMESTAMP: '@trakplus/lastPersistTimestamp_v2',
  LAST_BOOT_COUNT: '@trakplus/lastBootCount_v1',
  LAST_BOOT_COUNT_BACKUP: '@trakplus/lastBootCount_backup_v1',
} as const;
const BACKUP_WRITE_INTERVAL_MS = 5000; 
interface TimeSyncAnchor {
  phoneEpochMs: number;
  deviceMillis: number;
}
export type ProcessedHitEventCallback = (
  timestamp: Date,
  durationMs: number,
  eventId: number,
  bootCount: number
) => Promise<void>;
export type HandshakeCompleteCallback = (info: HelloAckPayload) => void;
export interface EventSyncServiceConfig {
  verbose: boolean;
}
const DEFAULT_CONFIG: EventSyncServiceConfig = {
  verbose: true,
};
export class EventSyncService {
  private protocolService: AppDeviceProtocolService;
  private config: EventSyncServiceConfig;
  private lastEventId: number = 0;
  private lastBootCount: number | null = null;
  private timeSyncAnchor: TimeSyncAnchor | null = null;
  private deviceInfo: HelloAckPayload | null = null;
  private isInitialized: boolean = false;
  private deviceSettingsService: DeviceSettingsService | null = null;
  private backupTimer: NodeJS.Timeout | null = null;
  private lastPersistedEventId: number = 0;
  private lastPersistedBootCount: number = 0;
  private pendingPersist: boolean = false;
  private onProcessedHitEvent: ProcessedHitEventCallback | null = null;
  private onHandshakeComplete: HandshakeCompleteCallback | null = null;
  constructor(
    protocolService: AppDeviceProtocolService,
    config: Partial<EventSyncServiceConfig> = {}
  ) {
    this.protocolService = protocolService;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.warn('[EventSync] Already initialized');
      return;
    }
    try {
      let loadedFromBackup = false;
      const storedId = await AsyncStorage.getItem(STORAGE_KEYS.LAST_EVENT_ID);
      if (storedId !== null) {
        const parsed = parseInt(storedId, 10);
        if (!isNaN(parsed) && parsed >= 0) {
          this.lastEventId = parsed;
          this.log(`Loaded lastEventId from primary: ${this.lastEventId}`);
        }
      }
      if (this.lastEventId === 0) {
        const backupId = await AsyncStorage.getItem(STORAGE_KEYS.LAST_EVENT_ID_BACKUP);
        if (backupId !== null) {
          const parsed = parseInt(backupId, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            this.lastEventId = parsed;
            loadedFromBackup = true;
            this.log(`Recovered lastEventId from backup: ${this.lastEventId}`);
            await AsyncStorage.setItem(STORAGE_KEYS.LAST_EVENT_ID, backupId);
          }
        }
      }
      this.lastPersistedEventId = this.lastEventId;
      if (loadedFromBackup) {
        console.warn('[EventSync] Primary storage was empty/corrupt, recovered from backup');
      }
      let bootCountLoadedFromBackup = false;
      const storedBootCount = await AsyncStorage.getItem(STORAGE_KEYS.LAST_BOOT_COUNT);
      if (storedBootCount !== null) {
        const parsed = parseInt(storedBootCount, 10);
        if (!isNaN(parsed) && parsed >= 0) {
          this.lastBootCount = parsed;
          this.log(`Loaded lastBootCount from primary: ${this.lastBootCount}`);
        }
      }
      if (this.lastBootCount === null) {
        const backupBootCount = await AsyncStorage.getItem(STORAGE_KEYS.LAST_BOOT_COUNT_BACKUP);
        if (backupBootCount !== null) {
          const parsed = parseInt(backupBootCount, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            this.lastBootCount = parsed;
            bootCountLoadedFromBackup = true;
            this.log(`Recovered lastBootCount from backup: ${this.lastBootCount}`);
            await AsyncStorage.setItem(STORAGE_KEYS.LAST_BOOT_COUNT, backupBootCount);
          }
        }
      }
      this.lastPersistedBootCount = this.lastBootCount ?? 0;
      if (bootCountLoadedFromBackup) {
        console.warn('[EventSync] BootCount primary storage was empty/corrupt, recovered from backup');
      }
    } catch (error) {
      console.error('[EventSync] Failed to load lastEventId from storage:', error);
    }
    this.protocolService.setOnHitEvent(this.handleHitEvent.bind(this));
    this.protocolService.setOnHelloAck(this.handleHelloAck.bind(this));
    this.deviceSettingsService = getDeviceSettingsService(this.protocolService);
    if (this.deviceSettingsService) {
      await this.deviceSettingsService.initialize();
    }
    this.startBackupTimer();
    this.isInitialized = true;
    this.log(`Initialized. Last Event ID: ${this.lastEventId}, Last Boot Count: ${this.lastBootCount ?? 'unknown'}`);
  }
  private startBackupTimer(): void {
    if (this.backupTimer) {
      return;
    }
    this.backupTimer = setInterval(() => {
      this.persistBackup();
    }, BACKUP_WRITE_INTERVAL_MS);
  }
  private stopBackupTimer(): void {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }
  private async persistBackup(): Promise<void> {
    if (!this.pendingPersist) {
      return;
    }
    try {
      await AsyncStorage.setItem(
        STORAGE_KEYS.LAST_EVENT_ID_BACKUP,
        this.lastEventId.toString()
      );
      if (this.lastBootCount !== null) {
        await AsyncStorage.setItem(
          STORAGE_KEYS.LAST_BOOT_COUNT_BACKUP,
          this.lastBootCount.toString()
        );
      }
      await AsyncStorage.setItem(
        STORAGE_KEYS.LAST_PERSIST_TIMESTAMP,
        Date.now().toString()
      );
      this.lastPersistedEventId = this.lastEventId;
      this.lastPersistedBootCount = this.lastBootCount ?? this.lastPersistedBootCount;
      this.pendingPersist = false;
      this.log(`Backup persisted: eventId=${this.lastEventId}, bootCount=${this.lastBootCount ?? 'unknown'}`);
    } catch (error) {
      console.error('[EventSync] Failed to persist backup:', error);
    }
  }
  private async persistBootCount(): Promise<void> {
    if (this.lastBootCount === null) {
      return;
    }
    try {
      await AsyncStorage.setItem(
        STORAGE_KEYS.LAST_BOOT_COUNT,
        this.lastBootCount.toString()
      );
      this.pendingPersist = true;
    } catch (error) {
      console.error('[EventSync] Failed to persist lastBootCount to primary:', error);
      this.pendingPersist = true;
    }
  }
  public cleanup(reason?: string): void {
    this.timeSyncAnchor = null;
    this.deviceInfo = null;
    if (this.deviceSettingsService) {
      this.deviceSettingsService.onDeviceDisconnected(reason);
      this.log(`Notified DeviceSettingsService of disconnection (reason: ${reason || 'unknown'})`);
    }
    if (this.pendingPersist) {
      this.persistBackup().catch(err => {
        console.error('[EventSync] Final backup persist failed:', err);
      });
    }
    this.stopBackupTimer();
    this.log('Cleaned up');
  }
  public resetForNewConnection(): void {
    this.timeSyncAnchor = null;
    this.deviceInfo = null;
    this.protocolService.resetForNewConnection();
    this.log('Reset for new connection');
  }
  public setOnProcessedHitEvent(callback: ProcessedHitEventCallback | null): void {
    this.onProcessedHitEvent = callback;
  }
  public setOnHandshakeComplete(callback: HandshakeCompleteCallback | null): void {
    this.onHandshakeComplete = callback;
  }
  public async onDeviceConnected(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('[EventSync] Service not initialized. Call initialize() first.');
    }
    this.log(`Device connected. Initiating handshake with lastEventId=${this.lastEventId}...`);
    try {
      await this.protocolService.sendHello(this.lastEventId);
    } catch (error) {
      console.error('[EventSync] Handshake initiation failed:', error);
      throw error;
    }
  }
  private async handleHelloAck(helloAck: HelloAckPayload): Promise<void> {
    this.deviceInfo = helloAck;
    this.timeSyncAnchor = {
      phoneEpochMs: Date.now(),
      deviceMillis: helloAck.currentMillis,
    };
    this.log(`HELLO_ACK received:`);
    this.log(`  Firmware: v${helloAck.firmwareMajor}.${helloAck.firmwareMinor}.${helloAck.firmwarePatch}`);
    this.log(`  Device Event ID: ${helloAck.lastEventId}, App Event ID: ${this.lastEventId}`);
    this.log(`  Sync anchor: phone=${this.timeSyncAnchor.phoneEpochMs}, device=${this.timeSyncAnchor.deviceMillis}`);
    if (helloAck.lastEventId < this.lastEventId) {
      this.log(`Device eventId behind app. Resetting app cursor to ${helloAck.lastEventId}`);
      this.lastEventId = helloAck.lastEventId;
      this.lastPersistedEventId = this.lastEventId;
      try {
        await AsyncStorage.setItem(STORAGE_KEYS.LAST_EVENT_ID, this.lastEventId.toString());
        this.pendingPersist = true;
      } catch (error) {
        console.error('[EventSync] Failed to persist lastEventId after rollback detection:', error);
      }
    }
    if (this.onHandshakeComplete) {
      this.onHandshakeComplete(helloAck);
    }
    await new Promise(resolve => setTimeout(resolve, 6000));
    if (this.deviceSettingsService && !this.deviceSettingsService.isSyncedWithDevice()) {
      if (this.deviceInfo === null) {
        this.log('Aborting post-handshake operations: connection lost during delay');
        return;
      }
    }
    if (this.deviceSettingsService) {
      try {
        const configMatches = this.deviceSettingsService.handleHelloAck(helloAck);
        if (!configMatches) {
          this.log('Device config mismatch detected (factory reset or sync issue)');
        }
        await this.deviceSettingsService.onDeviceConnected();
        await this.deviceSettingsService.syncSettingsAfterHandshake();
        this.log('Device settings sync initiated (post-handshake)');
      } catch (error) {
        console.warn('[EventSync] Failed to sync device settings:', error);
      }
    }
    try {
      await this.protocolService.sendTimeSync();
      this.log('TIME_SYNC sent');
    } catch (error) {
      console.error('[EventSync] Failed to send TIME_SYNC:', error);
    }
    if (helloAck.lastEventId > this.lastEventId) {
      const missedCount = helloAck.lastEventId - this.lastEventId;
      this.log(`Detected ${missedCount} missed events. Requesting sync...`);
      try {
        await this.protocolService.sendSyncRequest(this.lastEventId);
        this.log(`SYNC_REQUEST sent for events > ${this.lastEventId}`);
      } catch (error) {
        console.error('[EventSync] Failed to send SYNC_REQUEST:', error);
      }
    } else {
      this.log('Events up to date. No sync needed.');
    }
  }
  private async handleHitEvent(event: HitEvent): Promise<void> {
    if (this.lastBootCount === null) {
      this.lastBootCount = event.bootCount;
      await this.persistBootCount();
    } else if (event.bootCount > this.lastBootCount) {
      this.log(`Boot count advanced from ${this.lastBootCount} to ${event.bootCount}. Resetting event cursor.`);
      this.lastBootCount = event.bootCount;
      await this.persistBootCount();
      this.lastEventId = 0;
    } else if (event.bootCount < this.lastBootCount) {
      if (event.eventId > this.lastEventId) {
        this.log(`EC-BOOT-COUNT-RESET-001: Device appears to have reset. Accepting new bootCount ${event.bootCount} (was: ${this.lastBootCount})`);
        this.lastBootCount = event.bootCount;
        await this.persistBootCount();
      } else {
        this.log(`Ignoring event from older bootCount ${event.bootCount} (current: ${this.lastBootCount})`);
        return;
      }
    }
    if (event.eventId <= this.lastEventId) {
      this.log(`Ignoring old event ID ${event.eventId} (last: ${this.lastEventId})`);
      return;
    }
    let absoluteTimestamp: Date;
    let timestampSource: string;
    if (event.timestamp > 0) {
      const msPart = event.timestampMs % 1000;
      absoluteTimestamp = new Date(event.timestamp * 1000 + msPart);
      timestampSource = 'device-epoch';
      const isEstimated = (event.flags & 0x04) !== 0; 
      if (isEstimated) {
        this.log(`Event ${event.eventId}: Timestamp is ESTIMATED (forward-chained)`);
        timestampSource = 'device-epoch-estimated';
      }
    } else {
      const calculated = this.deviceMillisToAbsoluteTime(event.timestampMs);
      if (calculated) {
        absoluteTimestamp = calculated;
        timestampSource = 'anchor-calculated';
      } else {
        console.warn(`[EventSync] Event ${event.eventId}: No valid timestamp source. Using current time.`);
        absoluteTimestamp = new Date();
        timestampSource = 'fallback-now';
      }
    }
    this.log(`Event ${event.eventId}: timestamp source=${timestampSource}, time=${absoluteTimestamp.toISOString()}`);
    await this.processEvent(event, absoluteTimestamp);
  }
  private async processEvent(event: HitEvent, timestamp: Date): Promise<void> {
    this.log(`Processing Hit ${event.eventId} at ${timestamp.toISOString()}`);
    this.log(`  Duration: ${event.durationMs}ms, Boot: ${event.bootCount}`);
    this.lastEventId = event.eventId;
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.LAST_EVENT_ID, this.lastEventId.toString());
      if (this.lastBootCount !== null) {
        await AsyncStorage.setItem(STORAGE_KEYS.LAST_BOOT_COUNT, this.lastBootCount.toString());
      }
      this.pendingPersist = true; 
    } catch (error) {
      console.error('[EventSync] Failed to persist lastEventId to primary:', error);
      this.pendingPersist = true;
    }
    if (this.onProcessedHitEvent) {
      this.onProcessedHitEvent(
        timestamp,
        event.durationMs,
        event.eventId,
        event.bootCount
      ).catch(error => {
        console.error('[EventSync] Background processing failed:', error);
      });
    }
  }
  public deviceMillisToAbsoluteTime(deviceMillis: number): Date | null {
    if (!this.timeSyncAnchor) {
      return null;
    }
    const offsetMs = deviceMillis - this.timeSyncAnchor.deviceMillis;
    const absoluteMs = this.timeSyncAnchor.phoneEpochMs + offsetMs;
    return new Date(absoluteMs);
  }
  public getLastEventId(): number {
    return this.lastEventId;
  }
  public getDeviceInfo(): HelloAckPayload | null {
    return this.deviceInfo;
  }
  public hasTimeSyncAnchor(): boolean {
    return this.timeSyncAnchor !== null;
  }
  public isHandshakeComplete(): boolean {
    return this.deviceInfo !== null && this.timeSyncAnchor !== null;
  }
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[EventSync] ${message}`);
    }
  }
}
