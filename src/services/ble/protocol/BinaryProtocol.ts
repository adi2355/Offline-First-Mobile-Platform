import { calculateCRC16, appendCRC16 } from './crc16';
import {
  MessageType,
  ErrorCode,
  PROTOCOL_SOF,
  PROTOCOL_VERSION,
  PROTOCOL_HEADER_SIZE,
  PROTOCOL_CRC_SIZE,
  PROTOCOL_MIN_FRAME_SIZE,
  PROTOCOL_MAX_PAYLOAD_SIZE,
  ProtocolFrame,
  ParseResult,
  MessageOptions,
  HitEvent,
  HIT_EVENT_SIZE,
  BatteryStatusPayload,
  BATTERY_STATUS_SIZE,
  HelloAckPayload,
  HELLO_ACK_SIZE,
  TimeSyncPayload,
  TIME_SYNC_SIZE,
  CalibrationResultPayload,
  CALIBRATION_RESULT_SIZE,
  SyncRequestPayload,
  SYNC_REQUEST_SIZE,
  AckPayload,
  ACK_PAYLOAD_SIZE,
  NackPayload,
  NACK_PAYLOAD_SIZE,
  ConfigDataPayload,
  CONFIG_DATA_SIZE,
  SetConfigPayload,
  SET_CONFIG_SIZE,
  ConfigId,
  DeviceStatusPayload,
  DEVICE_STATUS_SIZE,
  WifiState,
  WifiReason,
} from './types';
let sequenceCounter = 0;
export function getNextSequenceNumber(): number {
  const seq = sequenceCounter;
  sequenceCounter = (sequenceCounter + 1) & 0xffff;
  return seq;
}
export function resetSequenceCounter(): void {
  sequenceCounter = 0;
}
export function buildFrame(options: MessageOptions): Uint8Array {
  const { type, payload, sequenceNumber } = options;
  const payloadData = payload ?? new Uint8Array(0);
  if (payloadData.length > PROTOCOL_MAX_PAYLOAD_SIZE) {
    throw new Error(
      `Payload size ${payloadData.length} exceeds maximum ${PROTOCOL_MAX_PAYLOAD_SIZE}`
    );
  }
  const seqNum = sequenceNumber ?? getNextSequenceNumber();
  const frameSize = PROTOCOL_HEADER_SIZE + payloadData.length + PROTOCOL_CRC_SIZE;
  const frame = new Uint8Array(frameSize);
  let offset = 0;
  frame[offset++] = PROTOCOL_SOF; 
  frame[offset++] = type; 
  frame[offset++] = PROTOCOL_VERSION; 
  frame[offset++] = (seqNum >> 8) & 0xff; 
  frame[offset++] = seqNum & 0xff; 
  frame[offset++] = (payloadData.length >> 8) & 0xff; 
  frame[offset++] = payloadData.length & 0xff; 
  if (payloadData.length > 0) {
    frame.set(payloadData, offset);
  }
  const crc = calculateCRC16(frame, 0, PROTOCOL_HEADER_SIZE + payloadData.length);
  frame[frameSize - 2] = (crc >> 8) & 0xff; 
  frame[frameSize - 1] = crc & 0xff; 
  return frame;
}
export function buildSimpleMessage(
  type: MessageType,
  sequenceNumber?: number
): Uint8Array {
  return buildFrame({ type, sequenceNumber });
}
export function buildHelloMessage(lastEventId: number = 0): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = PROTOCOL_VERSION;
  payload[1] = (lastEventId >> 24) & 0xff;
  payload[2] = (lastEventId >> 16) & 0xff;
  payload[3] = (lastEventId >> 8) & 0xff;
  payload[4] = lastEventId & 0xff;
  return buildFrame({
    type: MessageType.MSG_HELLO,
    payload,
  });
}
export function buildAckMessage(ackSequence: number): Uint8Array {
  const payload = new Uint8Array(ACK_PAYLOAD_SIZE);
  payload[0] = (ackSequence >> 8) & 0xff;
  payload[1] = ackSequence & 0xff;
  return buildFrame({
    type: MessageType.MSG_ACK,
    payload,
  });
}
export function buildNackMessage(
  nackSequence: number,
  errorCode: ErrorCode
): Uint8Array {
  const payload = new Uint8Array(NACK_PAYLOAD_SIZE);
  payload[0] = (nackSequence >> 8) & 0xff;
  payload[1] = nackSequence & 0xff;
  payload[2] = errorCode;
  return buildFrame({
    type: MessageType.MSG_NACK,
    payload,
  });
}
export function buildTimeSyncMessage(
  epochSeconds: number,
  timezoneOffsetMinutes: number = 0
): Uint8Array {
  const payload = new Uint8Array(TIME_SYNC_SIZE);
  payload[0] = epochSeconds & 0xff;
  payload[1] = (epochSeconds >> 8) & 0xff;
  payload[2] = (epochSeconds >> 16) & 0xff;
  payload[3] = (epochSeconds >> 24) & 0xff;
  const tzOffset = timezoneOffsetMinutes & 0xffff;
  payload[4] = tzOffset & 0xff;
  payload[5] = (tzOffset >> 8) & 0xff;
  return buildFrame({
    type: MessageType.MSG_TIME_SYNC,
    payload,
  });
}
export function buildSyncRequestMessage(lastKnownEventId: number): Uint8Array {
  const payload = new Uint8Array(SYNC_REQUEST_SIZE);
  payload[0] = (lastKnownEventId >> 24) & 0xff;
  payload[1] = (lastKnownEventId >> 16) & 0xff;
  payload[2] = (lastKnownEventId >> 8) & 0xff;
  payload[3] = lastKnownEventId & 0xff;
  return buildFrame({
    type: MessageType.MSG_SYNC_REQUEST,
    payload,
  });
}
export function buildSetConfigMessage(configId: ConfigId, value: number): Uint8Array {
  const payload = new Uint8Array(SET_CONFIG_SIZE);
  payload[0] = configId;
  payload[1] = value & 0xff;
  payload[2] = 0; 
  payload[3] = 0; 
  return buildFrame({
    type: MessageType.MSG_SET_CONFIG,
    payload,
  });
}
export function buildSetSensitivityMessage(sensitivity: number): Uint8Array {
  const clampedValue = Math.max(0, Math.min(100, sensitivity));
  return buildSetConfigMessage(ConfigId.SENSITIVITY, clampedValue);
}
export function buildGetConfigMessage(): Uint8Array {
  return buildFrame({
    type: MessageType.MSG_GET_CONFIG,
  });
}
export function buildClearBondsMessage(): Uint8Array {
  return buildFrame({
    type: MessageType.MSG_CLEAR_BONDS,
  });
}
export function buildPairingModeMessage(): Uint8Array {
  return buildFrame({
    type: MessageType.MSG_PAIRING_MODE,
  });
}
export const WIFI_MAX_SSID_LEN = 32;
export const WIFI_MAX_PASS_LEN = 64;
export function buildEnterOtaModeMessage(): Uint8Array {
  return buildFrame({
    type: MessageType.MSG_ENTER_OTA_MODE,
  });
}
export function buildSetWifiConfigMessage(ssid: string, password: string): Uint8Array {
  if (!ssid || ssid.length === 0) {
    throw new Error('Wi-Fi SSID cannot be empty');
  }
  const ssidBytes = new TextEncoder().encode(ssid);
  if (ssidBytes.length > WIFI_MAX_SSID_LEN) {
    throw new Error(`Wi-Fi SSID too long: ${ssidBytes.length} bytes exceeds max ${WIFI_MAX_SSID_LEN}`);
  }
  const passwordBytes = password ? new TextEncoder().encode(password) : new Uint8Array(0);
  if (passwordBytes.length > WIFI_MAX_PASS_LEN) {
    throw new Error(`Wi-Fi password too long: ${passwordBytes.length} bytes exceeds max ${WIFI_MAX_PASS_LEN}`);
  }
  const payloadSize = 1 + ssidBytes.length + 1 + passwordBytes.length;
  const payload = new Uint8Array(payloadSize);
  let offset = 0;
  payload[offset++] = ssidBytes.length;
  payload.set(ssidBytes, offset);
  offset += ssidBytes.length;
  payload[offset++] = passwordBytes.length;
  if (passwordBytes.length > 0) {
    payload.set(passwordBytes, offset);
  }
  console.log(`[BinaryProtocol] Building MSG_SET_WIFI: SSID="${ssid}" (${ssidBytes.length}B), pass=[${passwordBytes.length}B]`);
  return buildFrame({
    type: MessageType.MSG_SET_WIFI,
    payload,
  });
}
export function parseFrame(data: Uint8Array): ParseResult {
  if (data.length < PROTOCOL_MIN_FRAME_SIZE) {
    return {
      frame: null,
      error: `Frame too short: ${data.length} < ${PROTOCOL_MIN_FRAME_SIZE}`,
      bytesConsumed: 0,
    };
  }
  const sofIndex = data.indexOf(PROTOCOL_SOF);
  if (sofIndex === -1) {
    return {
      frame: null,
      error: 'No SOF marker found',
      bytesConsumed: data.length, 
    };
  }
  const frameStart = sofIndex;
  const remainingLength = data.length - frameStart;
  if (remainingLength < PROTOCOL_MIN_FRAME_SIZE) {
    return {
      frame: null,
      error: 'Incomplete frame after SOF',
      bytesConsumed: frameStart, 
    };
  }
  const type = data[frameStart + 1]! as MessageType;
  const version = data[frameStart + 2]!;
  const sequenceNumber = (data[frameStart + 3]! << 8) | data[frameStart + 4]!;
  const payloadLength = (data[frameStart + 5]! << 8) | data[frameStart + 6]!;
  if (version !== PROTOCOL_VERSION) {
    return {
      frame: null,
      error: `Unsupported protocol version: ${version}`,
      bytesConsumed: frameStart + 1, 
    };
  }
  if (payloadLength > PROTOCOL_MAX_PAYLOAD_SIZE) {
    return {
      frame: null,
      error: `Payload too large: ${payloadLength} > ${PROTOCOL_MAX_PAYLOAD_SIZE}`,
      bytesConsumed: frameStart + 1,
    };
  }
  const totalFrameSize = PROTOCOL_HEADER_SIZE + payloadLength + PROTOCOL_CRC_SIZE;
  if (remainingLength < totalFrameSize) {
    return {
      frame: null,
      error: `Incomplete frame: have ${remainingLength}, need ${totalFrameSize}`,
      bytesConsumed: frameStart, 
    };
  }
  const payloadStart = frameStart + PROTOCOL_HEADER_SIZE;
  const payload = data.slice(payloadStart, payloadStart + payloadLength);
  const crcOffset = payloadStart + payloadLength;
  const receivedCrc = (data[crcOffset]! << 8) | data[crcOffset + 1]!;
  const calculatedCrc = calculateCRC16(
    data,
    frameStart,
    PROTOCOL_HEADER_SIZE + payloadLength
  );
  const crcValid = receivedCrc === calculatedCrc;
  const frame: ProtocolFrame = {
    type,
    version,
    sequenceNumber,
    payload,
    receivedCrc,
    calculatedCrc,
    crcValid,
  };
  return {
    frame,
    error: crcValid ? null : `CRC mismatch: received 0x${receivedCrc.toString(16)}, calculated 0x${calculatedCrc.toString(16)}`,
    bytesConsumed: frameStart + totalFrameSize,
  };
}
export function parseHitEvent(payload: Uint8Array): HitEvent | null {
  if (payload.length < HIT_EVENT_SIZE) {
    console.error(`[BinaryProtocol] HitEvent payload too short: ${payload.length} < ${HIT_EVENT_SIZE}`);
    return null;
  }
  const eventId =
    payload[0]! |
    (payload[1]! << 8) |
    (payload[2]! << 16) |
    ((payload[3]! << 24) >>> 0); 
  const timestampMs =
    payload[4]! |
    (payload[5]! << 8) |
    (payload[6]! << 16) |
    ((payload[7]! << 24) >>> 0);
  const bootCount =
    payload[8]! |
    (payload[9]! << 8) |
    (payload[10]! << 16) |
    ((payload[11]! << 24) >>> 0);
  const durationMs = payload[12]! | (payload[13]! << 8);
  const timestamp =
    payload[14]! |
    (payload[15]! << 8) |
    (payload[16]! << 16) |
    ((payload[17]! << 24) >>> 0);
  const flags = payload[18]!;
  const reserved = [
    payload[19]!,
    payload[20]!,
    payload[21]!,
    payload[22]!,
    payload[23]!,
  ];
  return {
    eventId,
    timestampMs,
    bootCount,
    durationMs,
    timestamp,
    flags,
    reserved,
  };
}
export function parseBatteryStatus(
  payload: Uint8Array
): BatteryStatusPayload | null {
  if (payload.length < BATTERY_STATUS_SIZE) {
    console.error(`[BinaryProtocol] BatteryStatus payload too short: ${payload.length} < ${BATTERY_STATUS_SIZE}`);
    return null;
  }
  return {
    percentage: payload[0]!,
    isCharging: payload[1]!,
    voltageMilliVolts: payload[2]! | (payload[3]! << 8),
  };
}
export function parseHelloAck(payload: Uint8Array): HelloAckPayload | null {
  const MIN_LEGACY_SIZE = 28;  
  if (payload.length < MIN_LEGACY_SIZE) {
    console.error(`[BinaryProtocol] HelloAck payload too short: ${payload.length} < ${MIN_LEGACY_SIZE}`);
    return null;
  }
  const firmwareMajor = payload[0]!;
  const firmwareMinor = payload[1]!;
  const firmwarePatch = payload[2]!;
  const buildType = payload[3]!;
  const buildNumber =
    payload[4]! |
    (payload[5]! << 8) |
    (payload[6]! << 16) |
    ((payload[7]! << 24) >>> 0);
  const batteryPercent = payload[8]!;
  const isCharging = payload[9]!;
  const lastEventId =
    payload[10]! |
    (payload[11]! << 8) |
    (payload[12]! << 16) |
    ((payload[13]! << 24) >>> 0);
  const currentMillis =
    payload[14]! |
    (payload[15]! << 8) |
    (payload[16]! << 16) |
    ((payload[17]! << 24) >>> 0);
  const bondedDevices = payload[18]!;
  const sensitivity = payload[19]!; 
  const configCrc32 =
    payload[20]! |
    (payload[21]! << 8) |
    (payload[22]! << 16) |
    ((payload[23]! << 24) >>> 0);
  const configSignature =
    payload[24]! |
    (payload[25]! << 8) |
    (payload[26]! << 16) |
    ((payload[27]! << 24) >>> 0);
  let hardwareId = '';
  if (payload.length >= HELLO_ACK_SIZE) {
    const macBytes = [
      payload[28]!,
      payload[29]!,
      payload[30]!,
      payload[31]!,
      payload[32]!,
      payload[33]!,
    ];
    const isValidMac = !macBytes.every(b => b === 0) && !macBytes.every(b => b === 0xFF);
    if (isValidMac) {
      hardwareId = macBytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
      console.log(`[BinaryProtocol] EC-DEVICE-ID-001: Hardware ID (MAC): ${hardwareId}`);
    } else {
      console.warn('[BinaryProtocol] EC-DEVICE-ID-001: Invalid MAC address in hardwareId field');
    }
  } else {
    console.warn('[BinaryProtocol] EC-DEVICE-ID-001: Old firmware detected (no hardwareId support)');
  }
  return {
    firmwareMajor,
    firmwareMinor,
    firmwarePatch,
    buildType,
    buildNumber,
    batteryPercent,
    isCharging,
    lastEventId,
    currentMillis,
    bondedDevices,
    sensitivity,
    configCrc32,
    configSignature,
    hardwareId,  
  };
}
export function parseCalibrationResult(
  payload: Uint8Array
): CalibrationResultPayload | null {
  if (payload.length < CALIBRATION_RESULT_SIZE) {
    console.error(`[BinaryProtocol] CalibrationResult payload too short: ${payload.length} < ${CALIBRATION_RESULT_SIZE}`);
    return null;
  }
  return {
    wakeThreshold: (payload[0]! << 8) | payload[1]!,
    hitThreshold: (payload[2]! << 8) | payload[3]!,
    ambientLevel: (payload[4]! << 8) | payload[5]!,
    status: payload[6]!,
    reserved: payload[7]!,
  };
}
export function parseAckPayload(payload: Uint8Array): AckPayload | null {
  if (payload.length < ACK_PAYLOAD_SIZE) {
    console.error(`[BinaryProtocol] Ack payload too short: ${payload.length} < ${ACK_PAYLOAD_SIZE}`);
    return null;
  }
  return {
    ackSequence: (payload[0]! << 8) | payload[1]!,
  };
}
export function parseNackPayload(payload: Uint8Array): NackPayload | null {
  if (payload.length < NACK_PAYLOAD_SIZE) {
    console.error(`[BinaryProtocol] Nack payload too short: ${payload.length} < ${NACK_PAYLOAD_SIZE}`);
    return null;
  }
  return {
    nackSequence: (payload[0]! << 8) | payload[1]!,
    errorCode: payload[2]! as ErrorCode,
  };
}
export function parseConfigData(payload: Uint8Array): ConfigDataPayload | null {
  if (payload.length < CONFIG_DATA_SIZE) {
    console.error(`[BinaryProtocol] ConfigData payload too short: ${payload.length} < ${CONFIG_DATA_SIZE}`);
    return null;
  }
  return {
    sensitivity: payload[0]!,
    ledBrightness: payload[1]!,
    reserved: [payload[2]!, payload[3]!],
  };
}
export function parseDeviceStatus(payload: Uint8Array): DeviceStatusPayload | null {
  if (payload.length < DEVICE_STATUS_SIZE) {
    console.error(`[BinaryProtocol] DeviceStatus payload too short: ${payload.length} < ${DEVICE_STATUS_SIZE}`);
    return null;
  }
  const state = payload[0]! as WifiState;
  const reason = payload[1]! as WifiReason;
  const rssiByte = payload[2]!;
  const rssi = (rssiByte & 0x80) ? -(256 - rssiByte) : rssiByte;
  const ip =
    payload[3]! |
    (payload[4]! << 8) |
    (payload[5]! << 16) |
    ((payload[6]! << 24) >>> 0);  
  console.log(`[BinaryProtocol] DeviceStatus: state=${state}, reason=${reason}, rssi=${rssi}, ip=${ip}`);
  return {
    state,
    reason,
    rssi,
    ip,
  };
}
export function getMessageTypeName(type: MessageType): string {
  return MessageType[type] ?? `UNKNOWN_0x${type.toString(16).padStart(2, '0')}`;
}
export function getErrorCodeName(code: ErrorCode): string {
  return ErrorCode[code] ?? `UNKNOWN_ERROR_0x${code.toString(16).padStart(2, '0')}`;
}
export function toHexString(data: Uint8Array): string {
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
export function uint8ArrayToBase64(data: Uint8Array): string {
  let binaryString = '';
  for (let i = 0; i < data.length; i++) {
    binaryString += String.fromCharCode(data[i]!);
  }
  return btoa(binaryString);
}
