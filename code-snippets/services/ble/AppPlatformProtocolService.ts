import {
  MessageType,
  ErrorCode,
  HitEvent,
  BatteryStatusPayload,
  HelloAckPayload,
  ProtocolFrame,
  ConfigDataPayload,
  DeviceStatusPayload,
} from './protocol/types';
import {
  buildSimpleMessage,
  buildHelloMessage,
  buildAckMessage,
  buildNackMessage,
  buildTimeSyncMessage,
  buildSyncRequestMessage,
  buildSetSensitivityMessage,
  buildGetConfigMessage,
  buildClearBondsMessage,
  buildSetWifiConfigMessage,
  buildEnterOtaModeMessage,
  parseFrame,
  parseHitEvent,
  parseBatteryStatus,
  parseHelloAck,
  parseAckPayload,
  parseNackPayload,
  parseConfigData,
  parseDeviceStatus,
  getMessageTypeName,
  getErrorCodeName,
  toHexString,
  base64ToUint8Array,
  uint8ArrayToBase64,
  resetSequenceCounter,
} from './protocol';
import {
  PROTOCOL_ACK_TIMEOUT_MS,
  PROTOCOL_MAX_RETRIES,
  PROTOCOL_RETRY_INTERVAL_MS,
  MAX_DEDUPLICATION_EVENTS,
  MAX_RECEIVE_BUFFER_SIZE,
} from '../../constants/ble';
export type BLESendFunction = (data: string) => Promise<void>;
export type HitEventCallback = (event: HitEvent) => void;
export type BatteryStatusCallback = (status: BatteryStatusPayload) => void;
export type HelloAckCallback = (ack: HelloAckPayload) => void;
export type ConnectionStateCallback = (connected: boolean) => void;
export type ErrorCallback = (errorCode: ErrorCode, message: string) => void;
export type ConfigDataCallback = (config: ConfigDataPayload) => void;
export type DeviceStatusCallback = (status: DeviceStatusPayload) => void;
export type DeviceSleepCallback = () => void;
interface PendingMessage {
  sequenceNumber: number;
  type: MessageType;
  frame: Uint8Array;
  sentAt: number;
  retryCount: number;
  resolve: () => void;
  reject: (error: Error) => void;
}
export interface ProtocolServiceConfig {
  ackTimeoutMs: number;
  maxRetries: number;
  retryIntervalMs: number;
  maxDeduplicationEvents: number;
  maxReceiveBufferSize: number;
}
const DEFAULT_CONFIG: ProtocolServiceConfig = {
  ackTimeoutMs: PROTOCOL_ACK_TIMEOUT_MS,          
  maxRetries: PROTOCOL_MAX_RETRIES,               
  retryIntervalMs: PROTOCOL_RETRY_INTERVAL_MS,    
  maxDeduplicationEvents: MAX_DEDUPLICATION_EVENTS, 
  maxReceiveBufferSize: MAX_RECEIVE_BUFFER_SIZE,  
};
export class AppDeviceProtocolService {
  private sendFunction: BLESendFunction | null = null;
  private config: ProtocolServiceConfig;
  private pendingMessages: Map<number, PendingMessage> = new Map();
  private retryTimer: NodeJS.Timeout | null = null;
  private processedEventIds: Set<number> = new Set();
  private eventIdOrder: number[] = []; 
  private deviceInfo: HelloAckPayload | null = null;
  private onHitEvent: HitEventCallback | null = null;
  private onBatteryStatus: BatteryStatusCallback | null = null;
  private onHelloAck: HelloAckCallback | null = null;
  private onConnectionState: ConnectionStateCallback | null = null;
  private onError: ErrorCallback | null = null;
  private onConfigData: ConfigDataCallback | null = null;
  private onDeviceSleep: DeviceSleepCallback | null = null;
  private onDeviceStatus: DeviceStatusCallback | null = null;
  private receiveBuffer: Uint8Array = new Uint8Array(0);
  private pendingHitEvents: HitEvent[] = [];
  private lastAckedSequence: number = -1;
  private lastAckedTime: number = 0;
  constructor(config: Partial<ProtocolServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  public initialize(sendFunction: BLESendFunction): void {
    this.sendFunction = sendFunction;
    this.startRetryTimer();
    console.log('[AppDeviceProtocol] Service initialized');
  }
  public cleanup(): void {
    this.stopRetryTimer();
    this.clearPendingMessages();
    this.receiveBuffer = new Uint8Array(0);
    this.deviceInfo = null;
    resetSequenceCounter();
    console.log('[AppDeviceProtocol] Service cleaned up');
  }
  public resetForNewConnection(): void {
    this.clearPendingMessages();
    this.processedEventIds.clear();
    this.eventIdOrder = [];
    this.receiveBuffer = new Uint8Array(0);
    if (this.pendingHitEvents.length > 0) {
      console.log(`[AppDeviceProtocol] Preserving ${this.pendingHitEvents.length} buffered hits across reconnection`);
    }
    this.deviceInfo = null;
    this.lastAckedSequence = -1; 
    resetSequenceCounter();
    this.startRetryTimer();
    console.log('[AppDeviceProtocol] Reset for new connection (buffers preserved)');
  }
  public setOnHitEvent(callback: HitEventCallback | null): void {
    this.onHitEvent = callback;
  }
  public setOnBatteryStatus(callback: BatteryStatusCallback | null): void {
    this.onBatteryStatus = callback;
  }
  public setOnHelloAck(callback: HelloAckCallback | null): void {
    this.onHelloAck = callback;
  }
  public setOnConnectionState(callback: ConnectionStateCallback | null): void {
    this.onConnectionState = callback;
  }
  public setOnError(callback: ErrorCallback | null): void {
    this.onError = callback;
  }
  public setOnConfigData(callback: ConfigDataCallback | null): void {
    this.onConfigData = callback;
  }
  public setOnDeviceSleep(callback: DeviceSleepCallback | null): void {
    this.onDeviceSleep = callback;
  }
  public setOnDeviceStatus(callback: DeviceStatusCallback | null): void {
    this.onDeviceStatus = callback;
  }
  public async onDataReceived(base64Data: string): Promise<void> {
    try {
      const data = base64ToUint8Array(base64Data);
      console.log(`[AppDeviceProtocol] Received ${data.length} bytes: ${toHexString(data)}`);
      const newBuffer = new Uint8Array(this.receiveBuffer.length + data.length);
      newBuffer.set(this.receiveBuffer);
      newBuffer.set(data, this.receiveBuffer.length);
      this.receiveBuffer = newBuffer;
      if (this.receiveBuffer.length > this.config.maxReceiveBufferSize) {
        console.error(
          `[AppDeviceProtocol] BUFFER OVERFLOW: ${this.receiveBuffer.length} bytes exceeds ` +
          `max ${this.config.maxReceiveBufferSize}. Stream likely corrupted. Clearing buffer.`
        );
        const debugBytes = this.receiveBuffer.slice(0, Math.min(32, this.receiveBuffer.length));
        console.error(`[AppDeviceProtocol] Buffer head: ${toHexString(debugBytes)}`);
        this.receiveBuffer = new Uint8Array(0);
        if (this.onError) {
          this.onError(
            ErrorCode.ERR_INVALID_PAYLOAD,
            'BLE stream buffer overflow - connection may be unstable'
          );
        }
        return; 
      }
      await this.processReceiveBuffer();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AppDeviceProtocol] Error processing received data:', err.message);
    }
  }
  private async processReceiveBuffer(): Promise<void> {
    let offset = 0;
    while (offset < this.receiveBuffer.length) {
      const remaining = this.receiveBuffer.slice(offset);
      const result = parseFrame(remaining);
      if (result.error && result.bytesConsumed === 0) {
        break;
      }
      if (result.bytesConsumed > 0) {
        offset += result.bytesConsumed;
      }
      if (result.frame) {
        if (result.frame.crcValid) {
          await this.handleFrame(result.frame);
        } else {
          console.error(`[AppDeviceProtocol] CRC error: ${result.error}`);
          await this.sendNack(result.frame.sequenceNumber, ErrorCode.ERR_CRC_MISMATCH);
        }
      } else if (result.error) {
        console.warn(`[AppDeviceProtocol] Parse warning: ${result.error}`);
      }
    }
    if (offset > 0) {
      this.receiveBuffer = this.receiveBuffer.slice(offset);
    }
  }
  private async handleFrame(frame: ProtocolFrame): Promise<void> {
    const typeName = getMessageTypeName(frame.type);
    console.log(`[AppDeviceProtocol] Handling ${typeName} (seq=${frame.sequenceNumber})`);
    switch (frame.type) {
      case MessageType.MSG_ACK:
        this.handleAck(frame);
        break;
      case MessageType.MSG_NACK:
        this.handleNack(frame);
        break;
      case MessageType.MSG_HELLO_ACK:
        this.handleHelloAck(frame);
        break;
      case MessageType.MSG_HIT_EVENT:
        await this.handleHitEvent(frame);
        break;
      case MessageType.MSG_BATTERY_STATUS:
        this.handleBatteryStatus(frame);
        break;
      case MessageType.MSG_CONFIG_DATA:
        this.handleConfigData(frame);
        break;
      case MessageType.MSG_DEVICE_STATUS:
        this.handleDeviceStatus(frame);
        break;
      case MessageType.MSG_HEARTBEAT:
        break;
      case MessageType.MSG_SLEEP:
        this.handleDeviceSleep(frame);
        break;
      default:
        console.warn(`[AppDeviceProtocol] Unknown message type: 0x${frame.type.toString(16)}`);
        this.sendNack(frame.sequenceNumber, ErrorCode.ERR_UNKNOWN_MSG);
    }
  }
  private handleAck(frame: ProtocolFrame): void {
    const ackPayload = parseAckPayload(frame.payload);
    if (!ackPayload) {
      console.error('[AppDeviceProtocol] Invalid ACK payload');
      return;
    }
    const pending = this.pendingMessages.get(ackPayload.ackSequence);
    if (pending) {
      console.log(`[AppDeviceProtocol] ACK received for seq=${ackPayload.ackSequence}`);
      this.pendingMessages.delete(ackPayload.ackSequence);
      pending.resolve();
    } else {
      console.warn(`[AppDeviceProtocol] ACK for unknown seq=${ackPayload.ackSequence}`);
    }
  }
  private handleNack(frame: ProtocolFrame): void {
    const nackPayload = parseNackPayload(frame.payload);
    if (!nackPayload) {
      console.error('[AppDeviceProtocol] Invalid NACK payload');
      return;
    }
    const errorName = getErrorCodeName(nackPayload.errorCode);
    console.error(`[AppDeviceProtocol] NACK received for seq=${nackPayload.nackSequence}: ${errorName}`);
    const pending = this.pendingMessages.get(nackPayload.nackSequence);
    if (pending) {
      this.pendingMessages.delete(nackPayload.nackSequence);
      pending.reject(new Error(`NACK: ${errorName}`));
    }
    if (this.onError) {
      this.onError(nackPayload.errorCode, errorName);
    }
  }
  private handleHelloAck(frame: ProtocolFrame): void {
    const helloAck = parseHelloAck(frame.payload);
    if (!helloAck) {
      console.error('[AppDeviceProtocol] Invalid HELLO_ACK payload');
      this.sendNack(frame.sequenceNumber, ErrorCode.ERR_INVALID_PAYLOAD);
      return;
    }
    this.deviceInfo = helloAck;
    console.log('[AppDeviceProtocol] HELLO_ACK received:');
    console.log(`  Firmware: v${helloAck.firmwareMajor}.${helloAck.firmwareMinor}.${helloAck.firmwarePatch}`);
    console.log(`  Battery: ${helloAck.batteryPercent}% (charging: ${helloAck.isCharging === 1})`);
    console.log(`  Latest eventId: ${helloAck.lastEventId}`);
    if (this.onHelloAck) {
      this.onHelloAck(helloAck);
    }
    if (this.pendingHitEvents.length > 0) {
      console.log(`[AppDeviceProtocol] Flushing ${this.pendingHitEvents.length} buffered hit events`);
      this.pendingHitEvents.forEach((event) => {
        if (this.onHitEvent) {
          this.onHitEvent(event);
        }
      });
      this.pendingHitEvents = [];
    }
  }
  private async handleHitEvent(frame: ProtocolFrame): Promise<void> {
    const hitEvent = parseHitEvent(frame.payload);
    if (!hitEvent) {
      console.error('[AppDeviceProtocol] Invalid HIT_EVENT payload');
      await this.sendNack(frame.sequenceNumber, ErrorCode.ERR_INVALID_PAYLOAD);
      return;
    }
    try {
      await this.sendAck(frame.sequenceNumber);
    } catch (e) {
      console.warn('[AppDeviceProtocol] ACK send failed, proceeding with storage:', e);
    }
    if (this.processedEventIds.has(hitEvent.eventId)) {
      console.log(`[AppDeviceProtocol] Duplicate HIT_EVENT ignored (eventId=${hitEvent.eventId})`);
      return;
    }
    this.processedEventIds.add(hitEvent.eventId);
    this.eventIdOrder.push(hitEvent.eventId);
    while (this.eventIdOrder.length > this.config.maxDeduplicationEvents) {
      const oldestId = this.eventIdOrder.shift();
      if (oldestId !== undefined) {
        this.processedEventIds.delete(oldestId);
      }
    }
    console.log(`[AppDeviceProtocol] HIT_EVENT received: id=${hitEvent.eventId}, duration=${hitEvent.durationMs}ms`);
    if (!this.deviceInfo) {
      console.log('[AppDeviceProtocol] Buffering HIT_EVENT until HELLO_ACK received (no sync anchor)');
      this.pendingHitEvents.push(hitEvent);
      return;
    }
    if (this.onHitEvent) {
      this.onHitEvent(hitEvent);
    }
  }
  private handleBatteryStatus(frame: ProtocolFrame): void {
    const batteryStatus = parseBatteryStatus(frame.payload);
    if (!batteryStatus) {
      console.error('[AppDeviceProtocol] Invalid BATTERY_STATUS payload');
      this.sendNack(frame.sequenceNumber, ErrorCode.ERR_INVALID_PAYLOAD);
      return;
    }
    console.log('[AppDeviceProtocol] BATTERY_STATUS received:');
    console.log(`  percentage: ${batteryStatus.percentage}%`);
    console.log(`  isCharging: ${batteryStatus.isCharging === 1}`);
    console.log(`  voltage: ${batteryStatus.voltageMilliVolts}mV`);
    if (this.onBatteryStatus) {
      this.onBatteryStatus(batteryStatus);
    } else {
      console.warn('[AppDeviceProtocol] BATTERY_STATUS received but onBatteryStatus callback is not registered - battery data dropped');
    }
  }
  private handleConfigData(frame: ProtocolFrame): void {
    const configData = parseConfigData(frame.payload);
    if (!configData) {
      console.error('[AppDeviceProtocol] Invalid CONFIG_DATA payload');
      this.sendNack(frame.sequenceNumber, ErrorCode.ERR_INVALID_PAYLOAD);
      return;
    }
    console.log('[AppDeviceProtocol] CONFIG_DATA received:');
    console.log(`  sensitivity: ${configData.sensitivity}`);
    console.log(`  ledBrightness: ${configData.ledBrightness}`);
    if (this.onConfigData) {
      this.onConfigData(configData);
    }
  }
  private handleDeviceStatus(frame: ProtocolFrame): void {
    const status = parseDeviceStatus(frame.payload);
    if (!status) {
      console.error('[AppDeviceProtocol] Invalid DEVICE_STATUS payload');
      this.sendNack(frame.sequenceNumber, ErrorCode.ERR_INVALID_PAYLOAD);
      return;
    }
    console.log('[AppDeviceProtocol] DEVICE_STATUS received:');
    console.log(`  state: ${status.state}`);
    console.log(`  reason: ${status.reason}`);
    console.log(`  rssi: ${status.rssi}dBm`);
    console.log(`  ip: ${status.ip}`);
    if (this.onDeviceStatus) {
      this.onDeviceStatus(status);
    }
  }
  private handleDeviceSleep(frame: ProtocolFrame): void {
    console.log('[AppDeviceProtocol] MSG_SLEEP received from device (device-initiated sleep)');
    console.log(`  Device entering deep sleep due to idle timeout`);
    this.rejectPendingMessages('DEVICE_SLEEP');
    if (this.onDeviceSleep) {
      this.onDeviceSleep();
    }
  }
  public async sendHello(lastEventId: number = 0): Promise<void> {
    const frame = buildHelloMessage(lastEventId);
    await this.sendWithAck(frame, MessageType.MSG_HELLO);
  }
  public async sendGoodbye(): Promise<void> {
    const frame = buildSimpleMessage(MessageType.MSG_SLEEP);
    await this.sendFrame(frame);
  }
  public async sendHeartbeat(): Promise<void> {
    const frame = buildSimpleMessage(MessageType.MSG_HEARTBEAT);
    await this.sendFrame(frame);
  }
  public async sendTimeSync(): Promise<void> {
    const epochSeconds = Math.floor(Date.now() / 1000);
    const timezoneOffset = -new Date().getTimezoneOffset(); 
    const frame = buildTimeSyncMessage(epochSeconds, timezoneOffset);
    await this.sendWithAck(frame, MessageType.MSG_TIME_SYNC);
  }
  public async sendCalibrate(): Promise<void> {
    const frame = buildSimpleMessage(MessageType.MSG_CALIBRATE);
    await this.sendWithAck(frame, MessageType.MSG_CALIBRATE);
  }
  public async sendSleep(): Promise<void> {
    const frame = buildSimpleMessage(MessageType.MSG_SLEEP);
    await this.sendWithAck(frame, MessageType.MSG_SLEEP);
  }
  public async sendSyncRequest(lastKnownEventId: number): Promise<void> {
    const frame = buildSyncRequestMessage(lastKnownEventId);
    await this.sendWithAck(frame, MessageType.MSG_SYNC_REQUEST);
  }
  public async sendSetSensitivity(sensitivity: number): Promise<void> {
    const clampedValue = Math.max(0, Math.min(100, sensitivity));
    console.log(`[AppDeviceProtocol] Sending SET_CONFIG (sensitivity=${clampedValue})`);
    const frame = buildSetSensitivityMessage(clampedValue);
    await this.sendWithAck(frame, MessageType.MSG_SET_CONFIG);
  }
  public async sendGetConfig(): Promise<void> {
    console.log('[AppDeviceProtocol] Sending GET_CONFIG');
    const frame = buildGetConfigMessage();
    await this.sendWithAck(frame, MessageType.MSG_GET_CONFIG);
  }
  public async sendClearBonds(): Promise<void> {
    console.log('[AppDeviceProtocol] Sending CLEAR_BONDS (bilateral bond clearing)');
    const frame = buildClearBondsMessage();
    await this.sendWithAck(frame, MessageType.MSG_CLEAR_BONDS);
    console.log('[AppDeviceProtocol] CLEAR_BONDS acknowledged by device');
  }
  public async sendWifiConfig(ssid: string, password: string): Promise<void> {
    console.log(`[AppDeviceProtocol] Sending SET_WIFI (Tier 1 Time Sync): SSID="${ssid}"`);
    try {
      const frame = buildSetWifiConfigMessage(ssid, password);
      await this.sendWithAck(frame, MessageType.MSG_SET_WIFI);
      console.log('[AppDeviceProtocol] Wi-Fi credentials saved on device. Connection will be attempted.');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[AppDeviceProtocol] SET_WIFI failed: ${errMsg}`);
      throw error;
    }
  }
  public async sendEnterOtaMode(): Promise<void> {
    console.log('[AppDeviceProtocol] Sending MSG_ENTER_OTA_MODE (Safe Recoverable OTA)');
    try {
      const frame = buildEnterOtaModeMessage();
      await this.sendWithAck(frame, MessageType.MSG_ENTER_OTA_MODE);
      console.log('[AppDeviceProtocol] MSG_ENTER_OTA_MODE acknowledged. Device will reboot into Flasher Mode.');
      console.log('[AppDeviceProtocol] BLE connection will be lost. Connect to "AppDevice_Update" Wi-Fi for firmware upload.');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[AppDeviceProtocol] ENTER_OTA_MODE failed: ${errMsg}`);
      throw error;
    }
  }
  private async sendAck(sequenceNumber: number): Promise<void> {
    const now = Date.now();
    if (sequenceNumber === this.lastAckedSequence && (now - this.lastAckedTime < 500)) {
      console.log(`[AppDeviceProtocol] Skipping duplicate ACK for seq=${sequenceNumber} (debounce)`);
      return;
    }
    this.lastAckedSequence = sequenceNumber;
    this.lastAckedTime = now;
    const frame = buildAckMessage(sequenceNumber);
    await this.sendFrame(frame);
  }
  private async sendNack(sequenceNumber: number, errorCode: ErrorCode): Promise<void> {
    const frame = buildNackMessage(sequenceNumber, errorCode);
    await this.sendFrame(frame);
  }
  private async sendFrame(frame: Uint8Array): Promise<void> {
    if (!this.sendFunction) {
      throw new Error('Protocol service not initialized');
    }
    const base64Data = uint8ArrayToBase64(frame);
    console.log(`[AppDeviceProtocol] Sending ${frame.length} bytes: ${toHexString(frame)}`);
    await this.sendFunction(base64Data);
  }
  private async sendWithAck(frame: Uint8Array, type: MessageType): Promise<void> {
    const sequenceNumber = (frame[3]! << 8) | frame[4]!;
    return new Promise((resolve, reject) => {
      const pending: PendingMessage = {
        sequenceNumber,
        type,
        frame,
        sentAt: Date.now(),
        retryCount: 0,
        resolve,
        reject,
      };
      this.pendingMessages.set(sequenceNumber, pending);
      this.sendFrame(frame).catch(reject);
    });
  }
  private startRetryTimer(): void {
    if (this.retryTimer) {
      return;
    }
    this.retryTimer = setInterval(() => {
      this.processRetries();
    }, this.config.retryIntervalMs);
  }
  private stopRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }
  private processRetries(): void {
    const now = Date.now();
    const toDelete: number[] = [];
    this.pendingMessages.forEach((pending, seq) => {
      const elapsed = now - pending.sentAt;
      if (elapsed > this.config.ackTimeoutMs) {
        if (pending.retryCount >= this.config.maxRetries) {
          console.error(`[AppDeviceProtocol] Max retries exceeded for seq=${seq}`);
          toDelete.push(seq);
          pending.reject(new Error(`Timeout: no ACK after ${this.config.maxRetries} retries`));
        } else {
          pending.retryCount++;
          pending.sentAt = now;
          console.log(`[AppDeviceProtocol] Retry ${pending.retryCount}/${this.config.maxRetries} for seq=${seq}`);
          this.sendFrame(pending.frame).catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes('BLE_NOT_CONNECTED')) {
              console.warn(`[AppDeviceProtocol] BLE disconnected during retry for seq=${seq}. Aborting ALL pending.`);
              pending.reject(new Error('BLE_NOT_CONNECTED'));
              setTimeout(() => this.handleDisconnection(), 0);
            } else {
              console.error(`[AppDeviceProtocol] Retry send failed:`, err);
            }
          });
        }
      }
    });
    toDelete.forEach((seq) => this.pendingMessages.delete(seq));
  }
  private handleDisconnection(): void {
    console.log('[AppDeviceProtocol] Handling disconnection - clearing all pending messages');
    this.rejectPendingMessages('BLE_NOT_CONNECTED');
    this.stopRetryTimer();
  }
  private clearPendingMessages(): void {
    this.rejectPendingMessages('Connection closed');
  }
  private rejectPendingMessages(reason: string): void {
    this.pendingMessages.forEach((pending, seq) => {
      console.log(`[AppDeviceProtocol] Rejecting pending seq=${seq} due to ${reason}`);
      pending.reject(new Error(reason));
    });
    this.pendingMessages.clear();
  }
  public getDeviceInfo(): HelloAckPayload | null {
    return this.deviceInfo;
  }
}
let protocolServiceInstance: AppDeviceProtocolService | null = null;
export function getProtocolService(): AppDeviceProtocolService {
  if (!protocolServiceInstance) {
    protocolServiceInstance = new AppDeviceProtocolService();
  }
  return protocolServiceInstance;
}
export function resetProtocolService(): void {
  if (protocolServiceInstance) {
    protocolServiceInstance.cleanup();
  }
  protocolServiceInstance = null;
}
