package com.AppPlatformReactNativeApp.trakplusble
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.math.max
class AppDeviceBLEModule(
  reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), LifecycleEventListener, AppDeviceBLECore.Delegate {
  private val core = AppDeviceBLECore(reactContext.applicationContext)
  private val eventBufferLock = Any()
  private val eventBuffer: ArrayDeque<BufferedEvent> = ArrayDeque()
  private val maxBufferSize = 100
  private val pendingOverflows: MutableList<Map<String, Any?>> = mutableListOf()
  private val maxPendingOverflows = 10
  @Volatile
  private var listenerCount = 0
  @Volatile
  private var totalBuffered = 0
  @Volatile
  private var totalDropped = 0
  @Volatile
  private var lastConnectionStateEvent: Map<String, Any?>? = null
  @Volatile
  private var hasReplayedConnectionStateForCurrentObserverCycle = false
  init {
    reactContext.addLifecycleEventListener(this)
    core.initialize(this)
  }
  override fun getName(): String = "AppDeviceBLE"
  @ReactMethod
  fun addListener(eventName: String) {
    listenerCount += 1
    flushBufferedEvents()
    if (
      eventName == EVENT_CONNECTION_STATE &&
      !hasReplayedConnectionStateForCurrentObserverCycle
    ) {
      lastConnectionStateEvent?.let { sendEventOrBuffer(EVENT_CONNECTION_STATE, it) }
      hasReplayedConnectionStateForCurrentObserverCycle = true
    }
  }
  @ReactMethod
  fun removeListeners(count: Int) {
    listenerCount = max(0, listenerCount - count)
    if (listenerCount == 0) {
      hasReplayedConnectionStateForCurrentObserverCycle = false
    }
  }
  @ReactMethod
  fun startScan(broadScan: Boolean) {
    core.startScan(broadScan)
  }
  @ReactMethod
  fun stopScan() {
    core.stopScan()
  }
  @ReactMethod
  fun connect(deviceId: String) {
    core.connect(deviceId)
  }
  @ReactMethod
  fun disconnect() {
    core.disconnect()
  }
  @ReactMethod
  fun write(base64Data: String, promise: Promise) {
    core.write(base64Data) { accepted, errorCode, errorMessage ->
      if (accepted) {
        promise.resolve(null)
      } else {
        promise.reject(errorCode ?: "WRITE_REJECTED", errorMessage ?: "Write rejected")
      }
    }
  }
  @ReactMethod
  fun getConnectionState(promise: Promise) {
    core.getConnectionState { snapshot ->
      promise.resolve(snapshot.toWritableMap())
    }
  }
  @ReactMethod
  fun checkSystemConnections() {
    core.checkSystemConnections()
  }
  @ReactMethod
  fun setKnownPeripheralIds(ids: ReadableArray) {
    val list = mutableListOf<String>()
    for (index in 0 until ids.size()) {
      if (!ids.isNull(index)) {
        list.add(ids.getString(index))
      }
    }
    core.setKnownPeripheralIds(list)
  }
  @ReactMethod
  fun setDeviceSleepFlag() {
    core.setDeviceSleepFlag()
  }
  @ReactMethod
  fun getBufferDiagnostics(promise: Promise) {
    val diagnostics = synchronized(eventBufferLock) {
      mapOf(
        "currentBufferSize" to eventBuffer.size,
        "totalBuffered" to totalBuffered,
        "totalDropped" to totalDropped,
        "hasListeners" to hasListeners(),
        "pendingOverflowCount" to pendingOverflows.size,
      )
    }
    promise.resolve(diagnostics.toWritableMap())
  }
  override fun onHostResume() {
    core.checkSystemConnections()
  }
  override fun onHostPause() {
  }
  override fun onHostDestroy() {
    core.destroy()
  }
  override fun invalidate() {
    super.invalidate()
    reactApplicationContext.removeLifecycleEventListener(this)
    core.destroy()
  }
  override fun onConnectionStateChanged(event: ConnectionStateEvent) {
    val payload = mapOf(
      "state" to event.state.wireValue,
      "deviceId" to event.deviceId,
      "reason" to event.reason?.wireValue,
      "timestamp" to event.timestampMs.toDouble(),
      "foregroundServiceActive" to event.foregroundServiceActive,
    ).filterValues { it != null }
    lastConnectionStateEvent = payload
    sendEventOrBuffer(EVENT_CONNECTION_STATE, payload)
  }
  override fun onDataReceived(event: DataReceivedEvent) {
    val payload = mapOf(
      "data" to event.dataBase64,
      "deviceId" to event.deviceId,
      "timestamp" to event.timestampMs.toDouble(),
    )
    sendEventOrBuffer(EVENT_DATA_RECEIVED, payload)
  }
  override fun onBondingLost(deviceId: String) {
    sendEventOrBuffer(EVENT_BONDING_LOST, mapOf("deviceId" to deviceId))
  }
  override fun onBluetoothStateChanged(state: BluetoothAdapterState) {
    sendEventOrBuffer(EVENT_BLUETOOTH_STATE, mapOf("state" to state.wireValue))
  }
  override fun onDeviceDiscovered(device: DiscoveredDevice) {
    val payload = mapOf(
      "id" to device.id,
      "name" to device.name,
      "rssi" to device.rssi,
      "isConnectable" to device.isConnectable,
    )
    sendEventOrBuffer(EVENT_DEVICE_FOUND, payload)
  }
  override fun onOperationRejected(event: OperationRejectedEvent) {
    val payload = mapOf(
      "operation" to event.operation.wireValue,
      "reason" to event.reason.wireValue,
      "detail" to event.detail,
      "deviceId" to event.deviceId,
      "timestamp" to event.timestampMs.toDouble(),
    ).filterValues { it != null }
    sendEventOrBuffer(EVENT_OPERATION_REJECTED, payload)
  }
  private fun hasListeners(): Boolean = listenerCount > 0
  private fun canEmitToJs(): Boolean {
    return hasListeners() && reactApplicationContext.hasActiveReactInstance()
  }
  private fun sendEventOrBuffer(name: String, body: Map<String, Any?>) {
    if (canEmitToJs()) {
      emitEvent(name, body)
      return
    }
    val overflowSnapshot = synchronized(eventBufferLock) {
      val dropped = if (eventBuffer.size >= maxBufferSize) eventBuffer.removeFirst() else null
      eventBuffer.addLast(BufferedEvent(name, body, System.currentTimeMillis()))
      totalBuffered += 1
      if (dropped != null) {
        totalDropped += 1
      }
      dropped
    }
    if (overflowSnapshot != null) {
      val overflowPayload = mapOf(
        "droppedEventName" to overflowSnapshot.name,
        "droppedEventTimestamp" to overflowSnapshot.timestampMs.toDouble(),
        "totalDropped" to totalDropped,
        "bufferSize" to synchronized(eventBufferLock) { eventBuffer.size },
        "timestamp" to System.currentTimeMillis().toDouble(),
      )
      if (canEmitToJs()) {
        emitEvent(EVENT_BUFFER_OVERFLOW, overflowPayload)
      } else {
        synchronized(eventBufferLock) {
          pendingOverflows.add(overflowPayload)
          if (pendingOverflows.size > maxPendingOverflows) {
            pendingOverflows.removeAt(0)
          }
        }
      }
    }
  }
  private fun flushBufferedEvents() {
    if (!canEmitToJs()) {
      return
    }
    val events: List<BufferedEvent>
    val overflows: List<Map<String, Any?>>
    synchronized(eventBufferLock) {
      if (eventBuffer.isEmpty() && pendingOverflows.isEmpty()) {
        return
      }
      events = eventBuffer.toList()
      eventBuffer.clear()
      overflows = pendingOverflows.toList()
      pendingOverflows.clear()
    }
    events.forEach { buffered ->
      emitEvent(buffered.name, buffered.body)
    }
    overflows.forEach { payload ->
      emitEvent(EVENT_BUFFER_OVERFLOW, payload)
    }
  }
  private fun emitEvent(name: String, body: Map<String, Any?>) {
    val context = reactApplicationContext
    if (!context.hasActiveReactInstance()) {
      return
    }
    context.runOnUiQueueThread {
      if (!context.hasActiveReactInstance()) {
        return@runOnUiQueueThread
      }
      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, body.toWritableMap())
    }
  }
  private fun Map<String, Any?>.toWritableMap() = Arguments.makeNativeMap(this)
  private data class BufferedEvent(
    val name: String,
    val body: Map<String, Any?>,
    val timestampMs: Long,
  )
  companion object {
    private const val EVENT_CONNECTION_STATE = "onConnectionStateChange"
    private const val EVENT_DATA_RECEIVED = "onDataReceived"
    private const val EVENT_BONDING_LOST = "onBondingLost"
    private const val EVENT_BLUETOOTH_STATE = "onBluetoothStateChange"
    private const val EVENT_DEVICE_FOUND = "onDeviceFound"
    private const val EVENT_BUFFER_OVERFLOW = "onBufferOverflow"
    private const val EVENT_OPERATION_REJECTED = "onOperationRejected"
  }
}
