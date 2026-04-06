package com.AppPlatformReactNativeApp.trakplusble
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
enum class ConnectionState(val wireValue: String) {
  DISCONNECTED("DISCONNECTED"),
  CONNECTING("CONNECTING"),
  CONNECTED("CONNECTED"),
  DISCOVERING("DISCOVERING"),
  SUBSCRIBING("SUBSCRIBING"),
  READY("READY");
}
enum class DisconnectReason(val wireValue: String) {
  NORMAL("normal"),
  BONDING_LOST("bondingLost"),
  ENCRYPTION_FAILED("encryptionFailed"),
  CONNECTION_FAILED("connectionFailed"),
  TIMEOUT("timeout"),
  UNKNOWN("unknown"),
  DEVICE_SLEEP("deviceSleep"),
  SERVICE_DISCOVERY_FAILED("serviceDiscoveryFailed"),
  SERVICE_NOT_FOUND("serviceNotFound"),
  CHARACTERISTIC_DISCOVERY_FAILED("characteristicDiscoveryFailed"),
  CHARACTERISTIC_NOT_FOUND("characteristicNotFound"),
  SUBSCRIPTION_FAILED("subscriptionFailed"),
  SUBSCRIPTION_LOST("subscriptionLost"),
  DISCOVERY_TIMEOUT("discoveryTimeout"),
  SUBSCRIPTION_TIMEOUT("subscriptionTimeout");
}
enum class BluetoothAdapterState(val wireValue: String) {
  UNKNOWN("unknown"),
  RESETTING("resetting"),
  UNSUPPORTED("unsupported"),
  UNAUTHORIZED("unauthorized"),
  POWERED_OFF("poweredOff"),
  POWERED_ON("poweredOn");
}
enum class OperationType(val wireValue: String) {
  CONNECT("connect"),
  WRITE("write");
}
enum class OperationRejectReason(val wireValue: String) {
  NOT_INITIALIZED("notInitialized"),
  UNAUTHORIZED("unauthorized"),
  UNSUPPORTED("unsupported"),
  BUSY("busy"),
  NOT_READY("notReady"),
  INVALID_PAYLOAD("invalidPayload"),
  QUEUE_FULL("queueFull");
}
data class OperationRejectedEvent(
  val operation: OperationType,
  val reason: OperationRejectReason,
  val detail: String? = null,
  val deviceId: String? = null,
  val timestampMs: Long = System.currentTimeMillis(),
)
data class ConnectionStateEvent(
  val state: ConnectionState,
  val deviceId: String,
  val reason: DisconnectReason? = null,
  val timestampMs: Long = System.currentTimeMillis(),
  val foregroundServiceActive: Boolean = false,
) {
  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("state", state.wireValue)
    map.putString("deviceId", deviceId)
    if (reason != null) {
      map.putString("reason", reason.wireValue)
    }
    map.putDouble("timestamp", timestampMs.toDouble())
    map.putBoolean("foregroundServiceActive", foregroundServiceActive)
    return map
  }
}
data class DataReceivedEvent(
  val dataBase64: String,
  val deviceId: String,
  val timestampMs: Long = System.currentTimeMillis(),
) {
  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("data", dataBase64)
    map.putString("deviceId", deviceId)
    map.putDouble("timestamp", timestampMs.toDouble())
    return map
  }
}
data class DiscoveredDevice(
  val id: String,
  val name: String?,
  val rssi: Int,
  val isConnectable: Boolean,
) {
  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("id", id)
    map.putString("name", name)
    map.putInt("rssi", rssi)
    map.putBoolean("isConnectable", isConnectable)
    return map
  }
}
object BleConfig {
  const val CONNECTION_TIMEOUT_MS = 30_000L
  const val DISCOVERY_TIMEOUT_MS = 10_000L
  const val SUBSCRIPTION_TIMEOUT_MS = 5_000L
  const val WRITE_TIMEOUT_MS = 5_000L
  const val BOND_TIMEOUT_MS = 20_000L
  const val MAX_RECONNECTION_ATTEMPTS = 5
  const val DORMANT_RECONNECTION_INTERVAL_MS = 60_000L
  const val RECONNECT_BASE_DELAY_MS = 1_000L
  const val MAX_WRITE_QUEUE_SIZE = 128
  const val STABLE_CONNECTION_THRESHOLD_MS = 55_000L
  const val REQUESTED_MTU = 247
  const val SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
  const val MAIN_CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8"
  const val CLIENT_CHARACTERISTIC_CONFIG_UUID = "00002902-0000-1000-8000-00805f9b34fb"
}
