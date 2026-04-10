import * as FileSystem from 'expo-file-system';
import { Asset } from 'expo-asset';
import { frontendLogger } from '../../utils/FrontendLoggerService';
import { OtaStateMachine } from './ota/OtaStateMachine';
import {
  OtaPostUpdateVerifier,
  type OtaPostUpdateVerifyOptions,
  type OtaPostUpdateResult,
  type OtaPostUpdateProgressCallback,
} from './ota/OtaPostUpdateVerifier';
const OTA_LOG_FILENAME = 'ota_debug_log.txt';
const OTA_LOG_PATH = `${FileSystem.documentDirectory}${OTA_LOG_FILENAME}`;
const MAX_LOG_SIZE_BYTES = 500 * 1024; 
type OtaLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
class OtaFileLogger {
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string;
  private isInitialized = false;
  constructor() {
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
  async init(): Promise<void> {
    if (this.isInitialized) return;
    try {
      const fileInfo = await FileSystem.getInfoAsync(OTA_LOG_PATH);
      if (fileInfo.exists && fileInfo.size && fileInfo.size > MAX_LOG_SIZE_BYTES) {
        const backupPath = `${FileSystem.documentDirectory}ota_debug_log_backup.txt`;
        await FileSystem.deleteAsync(backupPath, { idempotent: true });
        await FileSystem.moveAsync({ from: OTA_LOG_PATH, to: backupPath });
      }
      const header = [
        '',
        '═'.repeat(80),
        `OTA DEBUG LOG - NEW SESSION`,
        `Session ID: ${this.sessionId}`,
        `Started: ${new Date().toISOString()}`,
        `App Version: v2.6.0 (Explicit Erase Protocol)`,
        '═'.repeat(80),
        '',
      ].join('\n');
      await this.appendToFile(header);
      this.isInitialized = true;
      console.log(`[OtaFileLogger] Initialized. Log file: ${OTA_LOG_PATH}`);
    } catch (error) {
      console.error('[OtaFileLogger] Failed to initialize:', error);
    }
  }
  private async appendToFile(content: string): Promise<void> {
    try {
      let existingContent = '';
      const fileInfo = await FileSystem.getInfoAsync(OTA_LOG_PATH);
      if (fileInfo.exists) {
        existingContent = await FileSystem.readAsStringAsync(OTA_LOG_PATH, {
          encoding: FileSystem.EncodingType.UTF8,
        });
      }
      await FileSystem.writeAsStringAsync(
        OTA_LOG_PATH,
        existingContent + content,
        { encoding: FileSystem.EncodingType.UTF8 }
      );
    } catch (error) {
      await FileSystem.writeAsStringAsync(
        OTA_LOG_PATH,
        content,
        { encoding: FileSystem.EncodingType.UTF8 }
      );
    }
  }
  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString().replace('T', ' ').replace('Z', '');
  }
  async log(level: OtaLogLevel, message: string, data?: Record<string, unknown>): Promise<void> {
    const timestamp = this.formatTimestamp();
    const levelPadded = level.padEnd(5);
    let logLine = `[${timestamp}] [${levelPadded}] ${message}`;
    if (data && Object.keys(data).length > 0) {
      const dataStr = Object.entries(data)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' | ');
      logLine += ` | ${dataStr}`;
    }
    this.buffer.push(logLine);
    if (__DEV__) {
      console.log(`[OTA] ${logLine}`);
    }
    this.scheduleFlush();
  }
  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => this.flush(), 100);
  }
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const lines = this.buffer.join('\n') + '\n';
    this.buffer = [];
    try {
      await this.appendToFile(lines);
    } catch (error) {
      console.error('[OtaFileLogger] Flush failed:', error);
    }
  }
  async forceFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
  debug(message: string, data?: Record<string, unknown>): Promise<void> {
    return this.log('DEBUG', message, data);
  }
  info(message: string, data?: Record<string, unknown>): Promise<void> {
    return this.log('INFO', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): Promise<void> {
    return this.log('WARN', message, data);
  }
  error(message: string, error?: unknown, data?: Record<string, unknown>): Promise<void> {
    const errorData = {
      ...data,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3).join(' → ') : undefined,
    };
    return this.log('ERROR', message, errorData);
  }
  async separator(title?: string): Promise<void> {
    if (title) {
      this.buffer.push(`\n${'─'.repeat(40)}`);
      this.buffer.push(`  ${title}`);
      this.buffer.push(`${'─'.repeat(40)}`);
    } else {
      this.buffer.push('─'.repeat(60));
    }
    this.scheduleFlush();
  }
  getLogFilePath(): string {
    return OTA_LOG_PATH;
  }
  async readLogs(): Promise<string> {
    try {
      const exists = await FileSystem.getInfoAsync(OTA_LOG_PATH);
      if (!exists.exists) {
        return '(No OTA log file found)';
      }
      return await FileSystem.readAsStringAsync(OTA_LOG_PATH);
    } catch (error) {
      return `(Error reading log file: ${error})`;
    }
  }
  async clearLogs(): Promise<void> {
    try {
      await FileSystem.deleteAsync(OTA_LOG_PATH, { idempotent: true });
      this.isInitialized = false;
      console.log('[OtaFileLogger] Logs cleared');
    } catch (error) {
      console.error('[OtaFileLogger] Failed to clear logs:', error);
    }
  }
}
const otaLogger = new OtaFileLogger();
let FIRMWARE_MODULE: number | null = null;
try {
  FIRMWARE_MODULE = require('../../../assets/firmware/firmware.bin');
} catch {
  frontendLogger.warn('Firmware binary not bundled. Add firmware.bin to assets/firmware/');
}
const FLASHER_IP = '192.168.4.1';
const BASE_URL = `http://${FLASHER_IP}`;
const STATUS_URL = `${BASE_URL}/status`;
const ABORT_URL = `${BASE_URL}/abort`;
const START_URL = `${BASE_URL}/start`;
const UPDATE_CHUNK_URL = `${BASE_URL}/update_chunk`;
const UPDATE_URL_LEGACY = `${BASE_URL}/update`;
const STATUS_TIMEOUT_MS = 3000;
const ABORT_TIMEOUT_MS = 2000;
const START_TIMEOUT_MS = 5000;
const POST_ABORT_DELAY_MS = 1500;
const CHUNK_SIZE = 4 * 1024; 
const MULTIPART_BOUNDARY = '----ESP32OTABoundary';
const INTER_CHUNK_DELAY_MS = 15;
const CHUNK_TIMEOUT_MS = 5000;
const ERASE_TIMEOUT_MS = 30000;
const ERASE_POLL_INTERVAL_MS = 1000;
const CHUNK_ACK_TIMEOUT_MS = 8000;
const CHUNK_ACK_POLL_INTERVAL_MS = 250;
const MAX_CHUNK_RETRIES = 3;
const TOTAL_UPLOAD_TIMEOUT_MS = 300000;
function buildMultipartBody(chunk: Uint8Array, boundary: string): ArrayBuffer {
  const header =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="firmware"; filename="chunk.bin"\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(header);
  const footerBytes = encoder.encode(footer);
  const totalSize = headerBytes.length + chunk.length + footerBytes.length;
  const combined = new Uint8Array(totalSize);
  combined.set(headerBytes, 0);
  combined.set(chunk, headerBytes.length);
  combined.set(footerBytes, headerBytes.length + chunk.length);
  return combined.buffer;
}
export enum FlasherError {
  NONE = 0,
  LOW_BATTERY_IDLE = 1,
  LOW_BATTERY_LOAD = 2,
  WIFI_FAILED = 3,
  NO_CONTENT_LENGTH = 4,
  SIZE_TOO_LARGE = 5,
  FLASH_BEGIN_FAILED = 6,
  FLASH_WRITE_FAILED = 7,
  FLASH_END_FAILED = 8,
  CRC_MISMATCH = 9,
  TIMEOUT_IDLE = 10,
  TIMEOUT_PROGRESS = 11,
  SESSION_MISMATCH = 12,
  BUSY = 13,
  INVALID_CHUNK = 14,
  USER_ABORT = 15,
}
export enum FlasherPhase {
  INIT = 'INIT',
  BATTERY_CHECK = 'BATTERY_CHECK',
  WIFI_START = 'WIFI_START',
  READY = 'READY',
  ERASING = 'ERASING',     
  RECEIVING = 'RECEIVING',
  VERIFYING = 'VERIFYING',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR',
}
export interface FlasherStatus {
  session: number;
  phase: FlasherPhase;
  written: number;
  total: number;
  code: number;
  err: number;
  msg: string;
  v_batt: number;
  v_idle: number;
  v_load: number;
  idle: number;
  lastChunk?: number;
  chunkState?: string;
  pendingChunk?: number;
  pendingSize?: number;
}
export type OtaProgressCallback = (status: FlasherStatus) => void;
function getErrorMessage(errorCode: FlasherError): string {
  switch (errorCode) {
    case FlasherError.NONE:
      return 'No error';
    case FlasherError.LOW_BATTERY_IDLE:
      return 'Battery too low. Charge device above 20% before updating.';
    case FlasherError.LOW_BATTERY_LOAD:
      return 'Battery cannot sustain Wi-Fi. Charge device and try again.';
    case FlasherError.WIFI_FAILED:
      return 'Device failed to start Wi-Fi. Try power cycling the device.';
    case FlasherError.NO_CONTENT_LENGTH:
      return 'Missing upload headers. Check app/firmware compatibility.';
    case FlasherError.SIZE_TOO_LARGE:
      return 'Firmware too large for device partition.';
    case FlasherError.FLASH_BEGIN_FAILED:
      return 'Flash erase failed. Try again or contact support.';
    case FlasherError.FLASH_WRITE_FAILED:
      return 'Flash write error. Try again or contact support.';
    case FlasherError.FLASH_END_FAILED:
      return 'Firmware verification failed. File may be corrupted.';
    case FlasherError.CRC_MISMATCH:
      return 'Firmware checksum mismatch. File may be corrupted.';
    case FlasherError.TIMEOUT_IDLE:
      return 'Update timed out. Reconnect to Wi-Fi and try again.';
    case FlasherError.TIMEOUT_PROGRESS:
      return 'Upload stalled. Check Wi-Fi signal and try again.';
    case FlasherError.SESSION_MISMATCH:
      return 'Session mismatch. Restart the update from the beginning.';
    case FlasherError.BUSY:
      return 'Device busy. Wait briefly and retry.';
    case FlasherError.INVALID_CHUNK:
      return 'Invalid chunk payload. Restart the update.';
    case FlasherError.USER_ABORT:
      return 'Update was cancelled.';
    default:
      return `Unknown error (code: ${errorCode})`;
  }
}
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
class OtaService {
  async getStatus(): Promise<FlasherStatus> {
    await otaLogger.debug('getStatus() called', { url: STATUS_URL, timeout: STATUS_TIMEOUT_MS });
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
      const fetchStart = Date.now();
      const response = await fetch(STATUS_URL, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const fetchDuration = Date.now() - fetchStart;
      if (!response.ok) {
        await otaLogger.error('Status check HTTP error', null, { 
          status: response.status, 
          duration: fetchDuration 
        });
        throw new Error(`Status check failed: HTTP ${response.status}`);
      }
      const status: FlasherStatus = await response.json();
      await otaLogger.info('Device status received', {
        session: status.session,
        phase: status.phase,
        written: status.written,
        total: status.total,
        v_batt: status.v_batt,
        lastChunk: status.lastChunk,
        chunkState: status.chunkState,
        pendingChunk: status.pendingChunk,
        err: status.err,
        duration: fetchDuration,
      });
      return status;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('aborted') || errMsg.includes('Network request failed')) {
        await otaLogger.warn('Status check failed - network error', { error: errMsg });
        throw new Error(
          'Cannot reach device. Ensure you are connected to Wi-Fi network "AppDevice_Update" (password: 12345678).'
        );
      }
      await otaLogger.error('Status check failed', error);
      throw new Error(`Device communication error: ${errMsg}`);
    }
  }
  async checkDeviceReadiness(): Promise<FlasherStatus> {
    await otaLogger.separator('READINESS CHECK');
    await otaLogger.info('Checking device readiness for OTA update');
    const status = await this.getStatus();
    if (status.err !== FlasherError.NONE) {
      const errorMessage = getErrorMessage(status.err as FlasherError);
      await otaLogger.error('Device reported error', null, {
        errorCode: status.err,
        errorMessage,
        phase: status.phase,
      });
      throw new Error(errorMessage);
    }
    if (status.phase !== FlasherPhase.READY) {
      await otaLogger.warn('Device not in READY phase', { 
        phase: status.phase, 
        written: status.written, 
        total: status.total 
      });
      if (status.phase === FlasherPhase.ERASING) {
        throw new Error('Flash erase in progress. Wait for completion.');
      }
      if (status.phase === FlasherPhase.RECEIVING || status.phase === FlasherPhase.VERIFYING) {
        throw new Error('Update already in progress. Wait for completion or abort first.');
      }
      if (status.phase === FlasherPhase.COMPLETE) {
        throw new Error('Update already completed. Device will reboot shortly.');
      }
      throw new Error(`Device is busy (${status.phase}). Wait a moment and try again.`);
    }
    await otaLogger.info('✓ Device ready for OTA update', {
      session: status.session,
      v_batt: status.v_batt,
      v_idle: status.v_idle,
      v_load: status.v_load,
    });
    return status;
  }
  async abortUpdate(): Promise<void> {
    await otaLogger.info('Sending abort request to device', { 
      url: ABORT_URL, 
      timeout: ABORT_TIMEOUT_MS 
    });
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ABORT_TIMEOUT_MS);
      const abortStart = Date.now();
      const response = await fetch(ABORT_URL, {
        method: 'POST',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const abortDuration = Date.now() - abortStart;
      await otaLogger.info('✓ Abort request successful', { 
        status: response.status,
        duration: abortDuration,
      });
      await otaLogger.debug(`Waiting ${POST_ABORT_DELAY_MS}ms for device to process abort`);
      await sleep(POST_ABORT_DELAY_MS);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await otaLogger.warn('Abort request failed (device may have rebooted)', { error: errMsg });
      await sleep(1000);
    }
  }
  async startSession(sessionId: number, totalSize: number): Promise<void> {
    await otaLogger.separator('START SESSION (Phase 1)');
    await otaLogger.info('Starting OTA session', {
      sessionId,
      totalSize,
      url: START_URL,
    });
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), START_TIMEOUT_MS);
      const startTime = Date.now();
      const response = await fetch(START_URL, {
        method: 'POST',
        headers: {
          'X-Session-ID': sessionId.toString(),
          'X-Total-Size': totalSize.toString(),
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;
      const responseText = await response.text();
      if (!response.ok) {
        await otaLogger.error('/start request failed', null, {
          status: response.status,
          response: responseText,
          duration,
        });
        throw new Error(`Failed to start session: ${response.status} - ${responseText}`);
      }
      await otaLogger.info('✓ Session start accepted', {
        status: response.status,
        response: responseText,
        duration,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('aborted') || errMsg.includes('Network request failed')) {
        await otaLogger.error('Start request failed - network error', error);
        throw new Error(
          'Cannot reach device. Ensure you are connected to Wi-Fi network "AppDevice_Update".'
        );
      }
      await otaLogger.error('Start request failed', error);
      throw error;
    }
  }
  async waitForPhase(
    targetPhase: FlasherPhase,
    timeoutMs: number,
    onProgress?: OtaProgressCallback
  ): Promise<FlasherStatus> {
    await otaLogger.separator('WAIT FOR PHASE (Phase 2)');
    await otaLogger.info(`Waiting for device phase: ${targetPhase}`, {
      timeout: timeoutMs,
      pollInterval: ERASE_POLL_INTERVAL_MS,
    });
    const startTime = Date.now();
    let lastPhase: FlasherPhase | null = null;
    while (Date.now() - startTime < timeoutMs) {
      try {
        const status = await this.getStatus();
        if (onProgress) {
          onProgress(status);
        }
        if (status.phase !== lastPhase) {
          await otaLogger.info(`Phase transition: ${lastPhase || 'start'} → ${status.phase}`);
          lastPhase = status.phase;
        }
        if (status.phase === targetPhase) {
          await otaLogger.info(`✓ Reached target phase: ${targetPhase}`, {
            elapsed: Date.now() - startTime,
          });
          return status;
        }
        if (status.phase === FlasherPhase.ERROR) {
          const errorMessage = getErrorMessage(status.err as FlasherError);
          await otaLogger.error('Device entered ERROR phase while waiting', null, {
            errorCode: status.err,
            errorMessage,
            msg: status.msg,
          });
          throw new Error(`Device error: ${errorMessage}`);
        }
        await sleep(ERASE_POLL_INTERVAL_MS);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes('Device error:')) {
          throw error; 
        }
        await otaLogger.warn('Poll failed, retrying...', { error: errMsg });
        await sleep(ERASE_POLL_INTERVAL_MS);
      }
    }
    await otaLogger.error(`Timeout waiting for phase: ${targetPhase}`, null, {
      elapsed: Date.now() - startTime,
      lastPhase,
    });
    throw new Error(`Timeout waiting for device to reach ${targetPhase} phase (${timeoutMs / 1000}s)`);
  }
  private async waitForChunkCommit(
    sessionId: number,
    chunkIndex: number,
    timeoutMs: number,
    onProgress?: OtaProgressCallback
  ): Promise<FlasherStatus> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getStatus();
      if (onProgress) {
        onProgress(status);
      }
      if (status.session !== sessionId) {
        throw new Error(`Session mismatch while awaiting chunk ${chunkIndex} commit`);
      }
      if (status.phase === FlasherPhase.ERROR) {
        const errorMessage = getErrorMessage(status.err as FlasherError);
        throw new Error(`Device error: ${errorMessage}`);
      }
      if (typeof status.lastChunk === 'number' && status.lastChunk >= chunkIndex) {
        return status;
      }
      await sleep(CHUNK_ACK_POLL_INTERVAL_MS);
    }
    throw new Error(`Timeout waiting for chunk ${chunkIndex} commit`);
  }
  async uploadFirmware(
    localUri: string,
    onProgress?: OtaProgressCallback,
    options?: { stateMachine?: OtaStateMachine }
  ): Promise<void> {
    await otaLogger.init();
    const stateMachine = options?.stateMachine ?? new OtaStateMachine();
    await otaLogger.separator('═══ EXPLICIT ERASE OTA UPLOAD START (v2.6.0) ═══');
    await otaLogger.info('uploadFirmware() called', { uri: localUri });
    const uploadStartTime = Date.now();
    try {
      stateMachine.transition({ type: 'BEGIN' });
    await otaLogger.info('Step 1: Validating firmware file');
    const fileInfo = await FileSystem.getInfoAsync(localUri);
    if (!fileInfo.exists) {
      await otaLogger.error('Firmware file not found', null, { uri: localUri });
      throw new Error('Firmware file not found. Please download the update again.');
    }
    const fileSize = fileInfo.size;
    if (!fileSize || fileSize === 0) {
      await otaLogger.error('Firmware file is empty', null, { uri: localUri });
      throw new Error('Firmware file is empty. Please download the update again.');
    }
    await otaLogger.info('✓ Firmware file validated', { 
      sizeBytes: fileSize, 
      sizeKB: Math.round(fileSize / 1024),
    });
    await otaLogger.separator('Step 2: Loading firmware binary');
    const base64Data = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64
    });
    const binaryData = base64ToUint8Array(base64Data);
    const totalSize = binaryData.length;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    const sessionId = Math.floor(Date.now() / 1000);
    await otaLogger.info('✓ Firmware loaded', {
      totalBytes: totalSize,
      totalChunks,
      chunkSize: CHUNK_SIZE,
      sessionId,
    });
    await otaLogger.separator('Step 3: Abort previous session');
    await this.abortUpdate();
    await otaLogger.separator('Step 4: Check device readiness');
    const initialStatus = await this.checkDeviceReadiness();
    stateMachine.transition({ type: 'READY' });
    await otaLogger.separator('Step 5: Start session (trigger flash erase)');
    await this.startSession(sessionId, totalSize);
    stateMachine.transition({ type: 'START_SESSION' });
    await otaLogger.separator('Step 6: Wait for flash erase to complete');
    if (onProgress) {
      onProgress({
        session: sessionId,
        phase: FlasherPhase.ERASING,
        written: 0,
        total: totalSize,
        code: 200,
        err: FlasherError.NONE,
        msg: 'Erasing flash partition...',
        v_batt: initialStatus.v_batt,
        v_idle: initialStatus.v_idle,
        v_load: initialStatus.v_load,
        idle: 0,
        lastChunk: -1,
      });
    }
    await this.waitForPhase(FlasherPhase.RECEIVING, ERASE_TIMEOUT_MS, onProgress);
    stateMachine.transition({ type: 'ERASE_COMPLETE' });
    await otaLogger.info('✓ Flash erase complete - ready for chunks');
    await otaLogger.separator('Step 7: Upload firmware chunks');
    await otaLogger.info('Starting chunked upload', {
      sessionId,
      totalChunks,
      chunkSize: CHUNK_SIZE,
      totalBytes: totalSize,
    });
    let bytesUploaded = 0;
    let lastLoggedPercent = 0;
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const chunk = binaryData.slice(start, end);
      const chunkSize = chunk.byteLength;
      let success = false;
      let attempts = 0;
      while (!success && attempts < MAX_CHUNK_RETRIES) {
        attempts++;
        try {
          if (Date.now() - uploadStartTime > TOTAL_UPLOAD_TIMEOUT_MS) {
            throw new Error('Total upload timeout exceeded (5 minutes). Try again with stable connection.');
          }
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
          const chunkStart = Date.now();
          const multipartBody = buildMultipartBody(chunk, MULTIPART_BOUNDARY);
          const response = await fetch(UPDATE_CHUNK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
              'Content-Length': multipartBody.byteLength.toString(),
              'X-Session-ID': sessionId.toString(),
              'X-Chunk-Index': chunkIndex.toString(),
              'X-Total-Chunks': totalChunks.toString(),
              'X-Chunk-Size': chunkSize.toString(),
            },
            body: multipartBody,
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          const chunkDuration = Date.now() - chunkStart;
          if (response.ok) {
            const status = await this.waitForChunkCommit(
              sessionId,
              chunkIndex,
              CHUNK_ACK_TIMEOUT_MS,
              onProgress
            );
            success = true;
            bytesUploaded = status.written || end;
            stateMachine.transition({ type: 'CHUNK_COMMITTED' });
            const percent = Math.floor((bytesUploaded / totalSize) * 100);
            if (percent >= lastLoggedPercent + 10) {
              lastLoggedPercent = percent;
              const elapsed = Date.now() - uploadStartTime;
              const rate = bytesUploaded / (elapsed / 1000);
              await otaLogger.info(`Upload progress: ${percent}%`, {
                chunk: `${chunkIndex + 1}/${totalChunks}`,
                bytes: bytesUploaded,
                elapsed: `${(elapsed / 1000).toFixed(1)}s`,
                rate: `${(rate / 1024).toFixed(1)} KB/s`,
                chunkTime: `${chunkDuration}ms`,
              });
            }
          } else {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await otaLogger.warn(`Chunk ${chunkIndex} attempt ${attempts} failed`, {
            error: errMsg,
            willRetry: attempts < MAX_CHUNK_RETRIES,
          });
          if (attempts >= MAX_CHUNK_RETRIES) {
            await otaLogger.error(`Chunk ${chunkIndex} failed after ${MAX_CHUNK_RETRIES} attempts`, error);
            throw new Error(`Failed to upload chunk ${chunkIndex + 1}/${totalChunks}: ${errMsg}`);
          }
          const backoffMs = 1000 * Math.pow(2, attempts - 1);
          await otaLogger.debug(`Retrying chunk ${chunkIndex} in ${backoffMs}ms`);
          await sleep(backoffMs);
        }
      }
      if (onProgress) {
        onProgress({
          session: sessionId,
          phase: FlasherPhase.RECEIVING,
          written: bytesUploaded,
          total: totalSize,
          code: 200,
          err: FlasherError.NONE,
          msg: `Uploading chunk ${chunkIndex + 1}/${totalChunks}`,
          v_batt: initialStatus.v_batt,
          v_idle: initialStatus.v_idle,
          v_load: initialStatus.v_load,
          idle: 0,
          lastChunk: chunkIndex,
        });
      }
      if (chunkIndex < totalChunks - 1) {
        await sleep(INTER_CHUNK_DELAY_MS);
      }
    }
    await otaLogger.separator('Step 8: Verify & wait for completion');
    stateMachine.transition({ type: 'VERIFYING' });
    await this.waitForCompletion(onProgress);
    stateMachine.transition({ type: 'COMPLETE' });
    const totalDuration = Date.now() - uploadStartTime;
    const avgRate = totalSize / (totalDuration / 1000);
    await otaLogger.separator('═══ EXPLICIT ERASE OTA UPLOAD SUCCESS ═══');
    await otaLogger.info('All chunks uploaded successfully', {
      sessionId,
      totalChunks,
      totalBytes: totalSize,
      duration: `${(totalDuration / 1000).toFixed(1)}s`,
      avgRate: `${(avgRate / 1024).toFixed(1)} KB/s`,
    });
    await otaLogger.forceFlush();
    frontendLogger.info('OTA upload successful - device rebooting', {
      component: 'OtaService',
      sessionId,
      duration: totalDuration,
    });
    } catch (error) {
      try {
        stateMachine.transition({ type: 'ERROR', message: String(error) });
      } catch {
      }
      throw error;
    }
  }
  async verifyAfterReboot(
    verifier: OtaPostUpdateVerifier,
    verifyOptions: OtaPostUpdateVerifyOptions,
    onVerifyProgress?: OtaPostUpdateProgressCallback
  ): Promise<OtaPostUpdateResult> {
    await otaLogger.separator('Step 9: Verify firmware after reboot');
    const result = await verifier.verify(verifyOptions, onVerifyProgress);
    if (result.verified) {
      await otaLogger.info('✓ Firmware verified after reboot', {
        firmwareVersion: result.firmwareVersion,
        deviceId: result.deviceId,
        hardwareId: result.hardwareId,
      });
    } else {
      await otaLogger.warn('Firmware verification incomplete', {
        error: result.error?.message ?? 'Unknown verification error',
        code: result.error?.code,
      });
    }
    return result;
  }
  async uploadFirmwareWithVerification(
    localUri: string,
    verifier: OtaPostUpdateVerifier,
    verifyOptions: OtaPostUpdateVerifyOptions,
    onProgress?: OtaProgressCallback,
    onVerifyProgress?: OtaPostUpdateProgressCallback
  ): Promise<OtaPostUpdateResult> {
    const stateMachine = new OtaStateMachine();
    await this.uploadFirmware(localUri, onProgress, { stateMachine });
    stateMachine.transition({ type: 'REBOOTING' });
    const verifyResult = await this.verifyAfterReboot(
      verifier,
      verifyOptions,
      onVerifyProgress
    );
    if (verifyResult.verified) {
      stateMachine.transition({ type: 'VERIFIED' });
    } else {
      const message = verifyResult.error?.message ?? 'Firmware verification failed';
      stateMachine.transition({ type: 'ERROR', message });
    }
    return verifyResult;
  }
  async waitForCompletion(onProgress?: OtaProgressCallback): Promise<void> {
    let retryCount = 0;
    const maxRetries = 30;
    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const status = await this.getStatus();
          if (onProgress) onProgress(status);
          if (status.phase === FlasherPhase.COMPLETE) {
            clearInterval(interval);
            resolve();
          } else if (status.phase === FlasherPhase.ERROR) {
            clearInterval(interval);
            reject(new Error(`Update failed: ${status.msg}`));
          }
        } catch (e) {
          retryCount++;
          if (retryCount > maxRetries) {
            clearInterval(interval);
            reject(new Error('Timeout waiting for device completion status'));
          }
        }
      }, 1000);
    });
  }
  async uploadBundledFirmware(onProgress?: OtaProgressCallback): Promise<void> {
    await otaLogger.init();
    await otaLogger.separator('BUNDLED FIRMWARE UPLOAD');
    await otaLogger.info('uploadBundledFirmware() called');
    if (FIRMWARE_MODULE === null) {
      await otaLogger.error('Firmware binary not bundled with app');
      throw new Error(
        'Firmware binary not bundled with app. ' +
        'Add firmware.bin to assets/firmware/ and rebuild.'
      );
    }
    await otaLogger.info('Loading bundled firmware asset...');
    const asset = Asset.fromModule(FIRMWARE_MODULE);
    await asset.downloadAsync();
    if (!asset.localUri) {
      await otaLogger.error('Failed to resolve local URI for bundled firmware');
      throw new Error('Failed to resolve local URI for bundled firmware');
    }
    await otaLogger.info('Asset resolved', { localUri: asset.localUri });
    const fileInfo = await FileSystem.getInfoAsync(asset.localUri);
    if (!fileInfo.exists) {
      await otaLogger.error('Bundled firmware asset not found on disk');
      throw new Error('Bundled firmware asset not found on disk');
    }
    if (!fileInfo.size || fileInfo.size === 0) {
      await otaLogger.error('Bundled firmware file is empty');
      throw new Error('Bundled firmware file is empty - may be corrupted');
    }
    await otaLogger.info('Bundled firmware ready', {
      sizeBytes: fileInfo.size,
      sizeKB: Math.round(fileInfo.size / 1024),
    });
    await this.uploadFirmware(asset.localUri, onProgress);
  }
  async uploadBundledFirmwareWithVerification(
    verifier: OtaPostUpdateVerifier,
    verifyOptions: OtaPostUpdateVerifyOptions,
    onProgress?: OtaProgressCallback,
    onVerifyProgress?: OtaPostUpdateProgressCallback
  ): Promise<OtaPostUpdateResult> {
    await otaLogger.init();
    await otaLogger.separator('BUNDLED FIRMWARE UPLOAD');
    await otaLogger.info('uploadBundledFirmwareWithVerification() called');
    if (FIRMWARE_MODULE === null) {
      await otaLogger.error('Firmware binary not bundled with app');
      throw new Error(
        'Firmware binary not bundled with app. ' +
        'Add firmware.bin to assets/firmware/ and rebuild.'
      );
    }
    await otaLogger.info('Loading bundled firmware asset...');
    const asset = Asset.fromModule(FIRMWARE_MODULE);
    await asset.downloadAsync();
    if (!asset.localUri) {
      await otaLogger.error('Failed to resolve local URI for bundled firmware');
      throw new Error('Failed to resolve local URI for bundled firmware');
    }
    await otaLogger.info('Asset resolved', { localUri: asset.localUri });
    const fileInfo = await FileSystem.getInfoAsync(asset.localUri);
    if (!fileInfo.exists) {
      await otaLogger.error('Bundled firmware asset not found on disk');
      throw new Error('Bundled firmware asset not found on disk');
    }
    if (!fileInfo.size || fileInfo.size === 0) {
      await otaLogger.error('Bundled firmware file is empty');
      throw new Error('Bundled firmware file is empty - may be corrupted');
    }
    await otaLogger.info('Bundled firmware ready', {
      sizeBytes: fileInfo.size,
      sizeKB: Math.round(fileInfo.size / 1024),
    });
    return this.uploadFirmwareWithVerification(
      asset.localUri,
      verifier,
      verifyOptions,
      onProgress,
      onVerifyProgress
    );
  }
  async getBundledFirmwareInfo(): Promise<{ size: number; sizeKB: number } | null> {
    if (FIRMWARE_MODULE === null) {
      return null;
    }
    try {
      const asset = Asset.fromModule(FIRMWARE_MODULE);
      await asset.downloadAsync();
      if (!asset.localUri) {
        return null;
      }
      const fileInfo = await FileSystem.getInfoAsync(asset.localUri);
      if (!fileInfo.exists || !fileInfo.size) {
        return null;
      }
      return {
        size: fileInfo.size,
        sizeKB: Math.round(fileInfo.size / 1024),
      };
    } catch {
      return null;
    }
  }
  getLogFilePath(): string {
    return otaLogger.getLogFilePath();
  }
  async readLogs(): Promise<string> {
    return otaLogger.readLogs();
  }
  async clearLogs(): Promise<void> {
    await otaLogger.clearLogs();
  }
  async logManual(message: string, data?: Record<string, unknown>): Promise<void> {
    await otaLogger.init();
    await otaLogger.info(`[MANUAL] ${message}`, data);
    await otaLogger.forceFlush();
  }
}
export const otaService = new OtaService();
export const OTA_LOG_FILE_PATH = OTA_LOG_PATH;
export async function readOtaLogs(): Promise<string> {
  return otaService.readLogs();
}
export async function clearOtaLogs(): Promise<void> {
  return otaService.clearLogs();
}
