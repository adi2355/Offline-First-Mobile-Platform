package com.AppPlatformReactNativeApp.trakplusble
import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.ArrayDeque
import java.util.UUID
import kotlin.math.min
import kotlin.random.Random
class AppDeviceBLECore(
  private val appContext: Context
) {
  interface Delegate {
    fun onConnectionStateChanged(event: ConnectionStateEvent)
    fun onDataReceived(event: DataReceivedEvent)
    fun onBondingLost(deviceId: String)
    fun onBluetoothStateChanged(state: BluetoothAdapterState)
    fun onDeviceDiscovered(device: DiscoveredDevice)
    fun onOperationRejected(event: OperationRejectedEvent)
  }
  private val logTag = "AppDeviceBLECore"
  private val bluetoothManager =
    appContext.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val serialThread = HandlerThread("AppDeviceBLE-Serial").apply { start() }
  private val serialHandler = Handler(serialThread.looper)
  @Volatile
  private var delegate: Delegate? = null
  private var isInitialized = false
  private var receiverRegistered = false
  private var connectionState: ConnectionState = ConnectionState.DISCONNECTED
  private var bluetoothState: BluetoothAdapterState = BluetoothAdapterState.UNKNOWN
  private var connectedDevice: BluetoothDevice? = null
  private var bluetoothGatt: BluetoothGatt? = null
  private var mainCharacteristic: BluetoothGattCharacteristic? = null
  private var targetDeviceId: String? = null
  private var pendingConnectionDeviceId: String? = null
  private var knownPeripheralIds: Set<String> = emptySet()
  private var isScanning = false
  private var manualDisconnect = false
  private var shouldReconnect = false
  private var reconnectAttempt = 0
  private var deviceSignaledSleep = false
  private var readyTimestampMs: Long? = null
  @Volatile
  private var foregroundServiceActive = false
  private val writeQueue = ArrayDeque<ByteArray>()
  private var writeInFlight = false
  private var bondTimeoutRunnable: Runnable? = null
  private var connectTimeoutRunnable: Runnable? = null
  private var discoveryTimeoutRunnable: Runnable? = null
  private var subscriptionTimeoutRunnable: Runnable? = null
  private var writeTimeoutRunnable: Runnable? = null
  private var reconnectRunnable: Runnable? = null
  private var manualDisconnectFallbackRunnable: Runnable? = null
  private var mtuFallbackRunnable: Runnable? = null
  private var awaitingMtuCallback = false
  fun initialize(delegate: Delegate) {
    this.delegate = delegate
    runSerial {
      if (isInitialized) {
        return@runSerial
      }
      registerReceivers()
      updateBluetoothState(deriveBluetoothState())
      isInitialized = true
      log("Initialized")
    }
  }
  fun destroy() {
    runSerial {
      cancelAllTimers()
      cancelReconnect()
      stopScanInternal()
      closeGattInternal()
      stopForegroundService()
      if (receiverRegistered) {
        try {
          appContext.unregisterReceiver(bluetoothBroadcastReceiver)
        } catch (_: IllegalArgumentException) {
        }
        receiverRegistered = false
      }
      isInitialized = false
      delegate = null
      serialThread.quitSafely()
      log("Destroyed")
    }
  }
  fun startScan(broadScan: Boolean = false) {
    runSerial {
      ensureInitialized() ?: return@runSerial
      if (!ensureScanPermission()) {
        return@runSerial
      }
      val adapter = bluetoothManager.adapter
      if (adapter == null) {
        updateBluetoothState(BluetoothAdapterState.UNSUPPORTED)
        return@runSerial
      }
      if (!adapter.isEnabled) {
        updateBluetoothState(BluetoothAdapterState.POWERED_OFF)
        return@runSerial
      }
      if (isScanning) {
        return@runSerial
      }
      val scanner = adapter.bluetoothLeScanner
      if (scanner == null) {
        log("Cannot start scan: BLE scanner unavailable")
        return@runSerial
      }
      val filters: List<ScanFilter>? = if (broadScan) {
        null
      } else {
        listOf(
          ScanFilter.Builder()
            .setServiceUuid(ParcelUuid(UUID.fromString(BleConfig.SERVICE_UUID)))
            .build()
        )
      }
      val settings = ScanSettings.Builder()
        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
        .build()
      scanner.startScan(filters, settings, scanCallback)
      isScanning = true
      log("Scan started (broadScan=$broadScan)")
    }
  }
  fun stopScan() {
    runSerial { stopScanInternal() }
  }
  fun connect(deviceId: String) {
    runSerial {
      if (ensureInitialized() == null) {
        rejectOperation(
          operation = OperationType.CONNECT,
          reason = OperationRejectReason.NOT_INITIALIZED,
          detail = "Core not initialized",
          deviceId = deviceId
        )
        return@runSerial
      }
      if (!ensureConnectPermission()) {
        rejectOperation(
          operation = OperationType.CONNECT,
          reason = OperationRejectReason.UNAUTHORIZED,
          detail = "Missing BLUETOOTH_CONNECT permission",
          deviceId = deviceId
        )
        return@runSerial
      }
      val adapter = bluetoothManager.adapter
      if (adapter == null) {
        updateBluetoothState(BluetoothAdapterState.UNSUPPORTED)
        rejectOperation(
          operation = OperationType.CONNECT,
          reason = OperationRejectReason.UNSUPPORTED,
          detail = "Bluetooth adapter unavailable",
          deviceId = deviceId
        )
        return@runSerial
      }
      if (!adapter.isEnabled) {
        pendingConnectionDeviceId = deviceId
        updateBluetoothState(BluetoothAdapterState.POWERED_OFF)
        log("Bluetooth off, deferring connection: $deviceId")
        return@runSerial
      }
      if (connectionState != ConnectionState.DISCONNECTED) {
        if (targetDeviceId == deviceId) {
          rejectOperation(
            operation = OperationType.CONNECT,
            reason = OperationRejectReason.BUSY,
            detail = "Already connecting/connected to target device in state ${connectionState.wireValue}",
            deviceId = deviceId
          )
          log("Connect ignored: already connecting/connected to $deviceId in state ${connectionState.wireValue}")
          return@runSerial
        }
        rejectOperation(
          operation = OperationType.CONNECT,
          reason = OperationRejectReason.BUSY,
          detail = "BLE stack busy with ${connectionState.wireValue} for device ${targetDeviceId ?: "unknown"}",
          deviceId = deviceId
        )
        log("Connect ignored: busy with ${connectionState.wireValue}")
        return@runSerial
      }
      startConnectFlow(deviceId, isReconnect = false)
    }
  }
  fun disconnect() {
    runSerial {
      ensureInitialized() ?: return@runSerial
      shouldReconnect = false
      manualDisconnect = true
      cancelReconnect()
      cancelOperationTimeouts()
      clearWriteQueue()
      val gatt = bluetoothGatt
      if (gatt != null) {
        scheduleManualDisconnectFallback(gatt.device.address)
        try {
          gatt.disconnect()
        } catch (error: Exception) {
          log("disconnect() threw: ${error.message}")
          handleTerminalDisconnect(gatt.device.address, DisconnectReason.NORMAL, allowReconnect = false)
        }
      } else {
        val deviceId = connectedDevice?.address ?: targetDeviceId
        if (deviceId != null) {
          handleTerminalDisconnect(deviceId, DisconnectReason.NORMAL, allowReconnect = false)
        } else {
          resetConnectionState()
        }
      }
    }
  }
  fun write(
    base64Data: String,
    onAcceptance: ((accepted: Boolean, errorCode: String?, errorMessage: String?) -> Unit)? = null
  ) {
    runSerial {
      if (ensureInitialized() == null) {
        rejectOperation(
          operation = OperationType.WRITE,
          reason = OperationRejectReason.NOT_INITIALIZED,
          detail = "Core not initialized",
          deviceId = connectedDevice?.address ?: targetDeviceId
        )
        onAcceptance?.invoke(false, OperationRejectReason.NOT_INITIALIZED.wireValue, "Core not initialized")
        return@runSerial
      }
      if (!ensureConnectPermission()) {
        rejectOperation(
          operation = OperationType.WRITE,
          reason = OperationRejectReason.UNAUTHORIZED,
          detail = "Missing BLUETOOTH_CONNECT permission",
          deviceId = connectedDevice?.address ?: targetDeviceId
        )
        onAcceptance?.invoke(false, OperationRejectReason.UNAUTHORIZED.wireValue, "Missing BLUETOOTH_CONNECT permission")
        return@runSerial
      }
      if (connectionState != ConnectionState.READY || bluetoothGatt == null || mainCharacteristic == null) {
        val detail = "Write attempted in state ${connectionState.wireValue}"
        rejectOperation(
          operation = OperationType.WRITE,
          reason = OperationRejectReason.NOT_READY,
          detail = detail,
          deviceId = connectedDevice?.address ?: targetDeviceId
        )
        onAcceptance?.invoke(false, OperationRejectReason.NOT_READY.wireValue, detail)
        log("Write rejected: not READY")
        return@runSerial
      }
      val payload = try {
        Base64.decode(base64Data, Base64.DEFAULT)
      } catch (error: IllegalArgumentException) {
        val detail = "Invalid base64 payload: ${error.message}"
        rejectOperation(
          operation = OperationType.WRITE,
          reason = OperationRejectReason.INVALID_PAYLOAD,
          detail = detail,
          deviceId = connectedDevice?.address ?: targetDeviceId
        )
        onAcceptance?.invoke(false, OperationRejectReason.INVALID_PAYLOAD.wireValue, detail)
        log("Write rejected: invalid base64 payload (${error.message})")
        return@runSerial
      }
      if (writeQueue.size >= BleConfig.MAX_WRITE_QUEUE_SIZE) {
        val detail = "Write queue full (${BleConfig.MAX_WRITE_QUEUE_SIZE})"
        rejectOperation(
          operation = OperationType.WRITE,
          reason = OperationRejectReason.QUEUE_FULL,
          detail = detail,
          deviceId = connectedDevice?.address ?: targetDeviceId
        )
        onAcceptance?.invoke(false, OperationRejectReason.QUEUE_FULL.wireValue, detail)
        log("Write queue full (${BleConfig.MAX_WRITE_QUEUE_SIZE}), rejecting new write")
        return@runSerial
      }
      writeQueue.addLast(payload)
      onAcceptance?.invoke(true, null, null)
      drainWriteQueue()
    }
  }
  fun getConnectionState(callback: (Map<String, Any>) -> Unit) {
    runSerial {
      callback(buildConnectionStateSnapshot())
    }
  }
  private fun buildConnectionStateSnapshot(): Map<String, Any> {
    val adapterState = deriveBluetoothState()
    val state = connectionState.wireValue
    val map = mutableMapOf<String, Any>(
      "state" to state,
      "bluetoothState" to adapterState.wireValue,
      "foregroundServiceActive" to foregroundServiceActive,
    )
    val deviceId = connectedDevice?.address ?: targetDeviceId
    if (!deviceId.isNullOrEmpty()) {
      map["deviceId"] = deviceId
    }
    return map
  }
  fun checkSystemConnections() {
    runSerial {
      ensureInitialized() ?: return@runSerial
      if (!ensureConnectPermission()) {
        return@runSerial
      }
      if (connectionState != ConnectionState.DISCONNECTED) {
        return@runSerial
      }
      if (manualDisconnect) {
        log("checkSystemConnections skipped: user manually disconnected (manualDisconnect=true)")
        return@runSerial
      }
      val connected = try {
        bluetoothManager.getConnectedDevices(BluetoothProfile.GATT)
      } catch (error: SecurityException) {
        log("checkSystemConnections denied: ${error.message}")
        updateBluetoothState(BluetoothAdapterState.UNAUTHORIZED)
        return@runSerial
      }
      if (connected.isEmpty()) {
        log("No system-connected BLE devices")
        return@runSerial
      }
      val candidate =
        connected.firstOrNull { knownPeripheralIds.contains(it.address) }
          ?: connected.firstOrNull { it.address == targetDeviceId }
      if (candidate == null) {
        log(
          "System-connected BLE devices found (${connected.size}) but none match known IDs/target. " +
            "Skipping adoption to avoid claiming unrelated peripherals."
        )
        return@runSerial
      }
      log("Adopting system-connected device: ${candidate.address}")
      startConnectFlow(candidate.address, isReconnect = false)
    }
  }
  fun setKnownPeripheralIds(ids: List<String>) {
    runSerial {
      knownPeripheralIds = ids.toSet()
      log("Known IDs updated: ${knownPeripheralIds.size}")
    }
  }
  fun setDeviceSleepFlag() {
    runSerial {
      deviceSignaledSleep = true
      log("Device sleep hint set")
    }
  }
  private fun startConnectFlow(deviceId: String, isReconnect: Boolean) {
    stopScanInternal()
    val adapter = bluetoothManager.adapter ?: run {
      updateBluetoothState(BluetoothAdapterState.UNSUPPORTED)
      return
    }
    if (!adapter.isEnabled) {
      pendingConnectionDeviceId = deviceId
      updateBluetoothState(BluetoothAdapterState.POWERED_OFF)
      log("Bluetooth off, deferring connect flow for $deviceId")
      return
    }
    val device = try {
      adapter.getRemoteDevice(deviceId)
    } catch (_: IllegalArgumentException) {
      null
    }
    if (device == null) {
      log("Invalid device ID for connect: $deviceId")
      emitConnectionState(ConnectionState.DISCONNECTED, deviceId, DisconnectReason.CONNECTION_FAILED)
      return
    }
    cancelReconnect()
    cancelOperationTimeouts()
    clearWriteQueue()
    closeGattInternal()
    targetDeviceId = deviceId
    connectedDevice = device
    manualDisconnect = false
    shouldReconnect = true
    if (!isReconnect) {
      reconnectAttempt = 0
    }
    val serviceStarted = AppDeviceBleForegroundService.start(appContext)
    foregroundServiceActive = serviceStarted
    if (!serviceStarted) {
      log("WARNING: Foreground service failed to start — background BLE reliability degraded")
    }
    transitionState(ConnectionState.CONNECTING, deviceId)
    when (device.bondState) {
      BluetoothDevice.BOND_BONDED -> {
        openGattConnection(device)
      }
      BluetoothDevice.BOND_BONDING -> {
        scheduleBondTimeout(device.address)
      }
      else -> {
        scheduleBondTimeout(device.address)
        val created = try {
          device.createBond()
        } catch (error: SecurityException) {
          log("createBond security failure: ${error.message}")
          false
        }
        if (!created) {
          handleTerminalDisconnect(device.address, DisconnectReason.BONDING_LOST, allowReconnect = false)
          delegate?.onBondingLost(device.address)
        }
      }
    }
  }
  @SuppressLint("MissingPermission")
  private fun openGattConnection(device: BluetoothDevice) {
    if (!ensureConnectPermission()) {
      return
    }
    cancelBondTimeout()
    startConnectTimeout(device.address)
    bluetoothGatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    } else {
      device.connectGatt(appContext, false, gattCallback)
    }
    if (bluetoothGatt == null) {
      handleTerminalDisconnect(device.address, DisconnectReason.CONNECTION_FAILED, allowReconnect = true)
    }
  }
  private fun transitionToReady(deviceId: String) {
    cancelOperationTimeouts()
    readyTimestampMs = System.currentTimeMillis()
    deviceSignaledSleep = false
    reconnectAttempt = 0
    transitionState(ConnectionState.READY, deviceId)
    drainWriteQueue()
  }
  private fun drainWriteQueue() {
    if (writeInFlight) {
      return
    }
    if (connectionState != ConnectionState.READY) {
      return
    }
    val gatt = bluetoothGatt ?: return
    val characteristic = mainCharacteristic ?: return
    while (writeQueue.isNotEmpty()) {
      val payload = writeQueue.removeFirst()
      val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        gatt.writeCharacteristic(
          characteristic,
          payload,
          BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        ) == BluetoothStatusCodes.SUCCESS
      } else {
        @Suppress("DEPRECATION")
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        @Suppress("DEPRECATION")
        characteristic.value = payload
        @Suppress("DEPRECATION")
        gatt.writeCharacteristic(characteristic)
      }
      if (!started) {
        log("Failed to submit write-without-response")
        handleTerminalDisconnect(
          gatt.device.address,
          DisconnectReason.CONNECTION_FAILED,
          allowReconnect = true
        )
        return
      }
    }
  }
  private fun handleGattDisconnected(status: Int, deviceId: String) {
    cancelOperationTimeouts()
    clearWriteQueue()
    val reason = classifyDisconnectReason(status)
    val isBondingIssue =
      reason == DisconnectReason.BONDING_LOST || reason == DisconnectReason.ENCRYPTION_FAILED
    if (isBondingIssue) {
      delegate?.onBondingLost(deviceId)
    }
    handleTerminalDisconnect(deviceId, reason, allowReconnect = shouldAttemptReconnect(reason))
  }
  private fun handleTerminalDisconnect(
    deviceId: String,
    reason: DisconnectReason,
    allowReconnect: Boolean,
  ) {
    closeGattInternal()
    resetConnectionState()
    emitConnectionState(ConnectionState.DISCONNECTED, deviceId, reason)
    if (allowReconnect) {
      scheduleReconnect(deviceId)
    } else {
      shouldReconnect = false
      stopForegroundService()
    }
  }
  private fun shouldAttemptReconnect(reason: DisconnectReason): Boolean {
    if (!shouldReconnect) {
      return false
    }
    if (manualDisconnect) {
      return false
    }
    return when (reason) {
      DisconnectReason.NORMAL,
      DisconnectReason.BONDING_LOST,
      DisconnectReason.ENCRYPTION_FAILED,
      DisconnectReason.SERVICE_NOT_FOUND,
      DisconnectReason.CHARACTERISTIC_NOT_FOUND -> false
      else -> true
    }
  }
  private fun scheduleReconnect(deviceId: String) {
    cancelReconnect()
    val attempt = reconnectAttempt
    val delayMs = if (attempt < BleConfig.MAX_RECONNECTION_ATTEMPTS) {
      val expDelay = BleConfig.RECONNECT_BASE_DELAY_MS * (1L shl attempt)
      val jitter = Random.nextLong(0L, 350L)
      min(expDelay + jitter, BleConfig.DORMANT_RECONNECTION_INTERVAL_MS)
    } else {
      BleConfig.DORMANT_RECONNECTION_INTERVAL_MS
    }
    reconnectAttempt += 1
    reconnectRunnable = Runnable {
      reconnectRunnable = null
      if (!shouldReconnect || manualDisconnect) {
        return@Runnable
      }
      if (connectionState != ConnectionState.DISCONNECTED) {
        return@Runnable
      }
      log("Reconnect attempt #$reconnectAttempt to $deviceId")
      startConnectFlow(deviceId, isReconnect = true)
    }
    serialHandler.postDelayed(reconnectRunnable!!, delayMs)
    log("Scheduled reconnect in ${delayMs}ms")
  }
  private fun cancelReconnect() {
    reconnectRunnable?.let { serialHandler.removeCallbacks(it) }
    reconnectRunnable = null
  }
  private fun classifyDisconnectReason(status: Int): DisconnectReason {
    if (manualDisconnect) {
      return DisconnectReason.NORMAL
    }
    if (status == BluetoothGatt.GATT_SUCCESS) {
      return DisconnectReason.NORMAL
    }
    if (status == GATT_STATUS_CONNECTION_TIMEOUT) {
      return DisconnectReason.TIMEOUT
    }
    if (isConnectionSecurityStatus(status)) {
      return DisconnectReason.BONDING_LOST
    }
    if (status == GATT_STATUS_CONNECTION_FAILED || status == GATT_STATUS_GENERIC_FAILURE) {
      return DisconnectReason.CONNECTION_FAILED
    }
    val readyAt = readyTimestampMs
    if (readyAt != null) {
      val ageMs = System.currentTimeMillis() - readyAt
      if (ageMs >= BleConfig.STABLE_CONNECTION_THRESHOLD_MS) {
        return DisconnectReason.DEVICE_SLEEP
      }
    }
    if (deviceSignaledSleep) {
      return DisconnectReason.DEVICE_SLEEP
    }
    return DisconnectReason.UNKNOWN
  }
  private fun disconnectWithFault(reason: DisconnectReason, logMessage: String) {
    val deviceId = connectedDevice?.address ?: targetDeviceId
    if (deviceId.isNullOrEmpty()) {
      log("disconnectWithFault ignored without active device: ${reason.wireValue}")
      return
    }
    log("GATT fault: $logMessage (${reason.wireValue})")
    shouldReconnect = shouldAttemptReconnect(reason)
    closeGattInternal()
    resetConnectionState()
    emitConnectionState(ConnectionState.DISCONNECTED, deviceId, reason)
    if (shouldReconnect) {
      scheduleReconnect(deviceId)
    } else {
      stopForegroundService()
    }
  }
  private fun resetConnectionState() {
    readyTimestampMs = null
    deviceSignaledSleep = false
    connectionState = ConnectionState.DISCONNECTED
    connectedDevice = null
    mainCharacteristic = null
    writeInFlight = false
    awaitingMtuCallback = false
  }
  private fun emitConnectionState(
    state: ConnectionState,
    deviceId: String,
    reason: DisconnectReason? = null,
  ) {
    delegate?.onConnectionStateChanged(
      ConnectionStateEvent(
        state = state,
        deviceId = deviceId,
        reason = reason,
        foregroundServiceActive = foregroundServiceActive,
      )
    )
  }
  private fun stopForegroundService() {
    AppDeviceBleForegroundService.stop(appContext)
    foregroundServiceActive = false
  }
  private fun transitionState(state: ConnectionState, deviceId: String) {
    if (connectionState == state && state != ConnectionState.DISCONNECTED) {
      return
    }
    connectionState = state
    emitConnectionState(state, deviceId)
  }
  private fun emitData(deviceId: String, payload: ByteArray) {
    val base64 = Base64.encodeToString(payload, Base64.NO_WRAP)
    delegate?.onDataReceived(DataReceivedEvent(base64, deviceId))
  }
  private fun rejectOperation(
    operation: OperationType,
    reason: OperationRejectReason,
    detail: String,
    deviceId: String? = null,
  ) {
    log("Operation rejected: ${operation.wireValue} (${reason.wireValue}) - $detail")
    delegate?.onOperationRejected(
      OperationRejectedEvent(
        operation = operation,
        reason = reason,
        detail = detail,
        deviceId = deviceId
      )
    )
  }
  private fun updateBluetoothState(state: BluetoothAdapterState) {
    if (bluetoothState == state) {
      return
    }
    bluetoothState = state
    delegate?.onBluetoothStateChanged(state)
  }
  private fun deriveBluetoothState(): BluetoothAdapterState {
    val adapter = bluetoothManager.adapter ?: return BluetoothAdapterState.UNSUPPORTED
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
      ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.BLUETOOTH_CONNECT
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      return BluetoothAdapterState.UNAUTHORIZED
    }
    return when (adapter.state) {
      BluetoothAdapter.STATE_ON -> BluetoothAdapterState.POWERED_ON
      BluetoothAdapter.STATE_OFF -> BluetoothAdapterState.POWERED_OFF
      BluetoothAdapter.STATE_TURNING_ON,
      BluetoothAdapter.STATE_TURNING_OFF -> BluetoothAdapterState.RESETTING
      else -> BluetoothAdapterState.UNKNOWN
    }
  }
  private fun scheduleBondTimeout(deviceId: String) {
    cancelBondTimeout()
    bondTimeoutRunnable = Runnable {
      bondTimeoutRunnable = null
      if (connectionState == ConnectionState.CONNECTING && connectedDevice?.address == deviceId) {
        log("Bond timeout for $deviceId")
        handleTerminalDisconnect(deviceId, DisconnectReason.BONDING_LOST, allowReconnect = false)
        delegate?.onBondingLost(deviceId)
      }
    }
    serialHandler.postDelayed(bondTimeoutRunnable!!, BleConfig.BOND_TIMEOUT_MS)
  }
  private fun cancelBondTimeout() {
    bondTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
    bondTimeoutRunnable = null
  }
  private fun startConnectTimeout(deviceId: String) {
    connectTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
    connectTimeoutRunnable = Runnable {
      connectTimeoutRunnable = null
      if (connectionState == ConnectionState.CONNECTING && connectedDevice?.address == deviceId) {
        log("Connect timeout for $deviceId")
        handleTerminalDisconnect(deviceId, DisconnectReason.TIMEOUT, allowReconnect = true)
      }
    }
    serialHandler.postDelayed(connectTimeoutRunnable!!, BleConfig.CONNECTION_TIMEOUT_MS)
  }
  private fun startDiscoveryTimeout(deviceId: String) {
    discoveryTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
    discoveryTimeoutRunnable = Runnable {
      discoveryTimeoutRunnable = null
      if (connectionState == ConnectionState.DISCOVERING && connectedDevice?.address == deviceId) {
        disconnectWithFault(
          DisconnectReason.DISCOVERY_TIMEOUT,
          "Service/characteristic discovery timeout"
        )
      }
    }
    serialHandler.postDelayed(discoveryTimeoutRunnable!!, BleConfig.DISCOVERY_TIMEOUT_MS)
  }
  private fun startSubscriptionTimeout(deviceId: String) {
    subscriptionTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
    subscriptionTimeoutRunnable = Runnable {
      subscriptionTimeoutRunnable = null
      if (connectionState == ConnectionState.SUBSCRIBING && connectedDevice?.address == deviceId) {
        disconnectWithFault(
          DisconnectReason.SUBSCRIPTION_TIMEOUT,
          "Notification subscription timeout"
        )
      }
    }
    serialHandler.postDelayed(subscriptionTimeoutRunnable!!, BleConfig.SUBSCRIPTION_TIMEOUT_MS)
  }
  private fun scheduleWriteTimeout(deviceId: String) {
    writeTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
    writeTimeoutRunnable = Runnable {
      writeTimeoutRunnable = null
      if (writeInFlight && connectedDevice?.address == deviceId) {
        writeInFlight = false
        disconnectWithFault(DisconnectReason.TIMEOUT, "Characteristic write timeout")
      }
    }
    serialHandler.postDelayed(writeTimeoutRunnable!!, BleConfig.WRITE_TIMEOUT_MS)
  }
  private fun scheduleManualDisconnectFallback(deviceId: String) {
    manualDisconnectFallbackRunnable?.let { serialHandler.removeCallbacks(it) }
    manualDisconnectFallbackRunnable = Runnable {
      manualDisconnectFallbackRunnable = null
      if (connectionState != ConnectionState.DISCONNECTED) {
        log("Manual disconnect fallback fired for $deviceId")
        handleTerminalDisconnect(deviceId, DisconnectReason.NORMAL, allowReconnect = false)
      }
    }
    serialHandler.postDelayed(manualDisconnectFallbackRunnable!!, 2_500L)
  }
  private fun cancelOperationTimeouts() {
    connectTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
    discoveryTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
    subscriptionTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
    writeTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
    manualDisconnectFallbackRunnable?.let { serialHandler.removeCallbacks(it) }
    mtuFallbackRunnable?.let { serialHandler.removeCallbacks(it) }
    connectTimeoutRunnable = null
    discoveryTimeoutRunnable = null
    subscriptionTimeoutRunnable = null
    writeTimeoutRunnable = null
    manualDisconnectFallbackRunnable = null
    mtuFallbackRunnable = null
  }
  private fun cancelAllTimers() {
    cancelBondTimeout()
    cancelOperationTimeouts()
  }
  private fun clearWriteQueue() {
    writeQueue.clear()
    writeInFlight = false
  }
  private fun stopScanInternal() {
    if (!isScanning) {
      return
    }
    val adapter = bluetoothManager.adapter
    val scanner = adapter?.bluetoothLeScanner
    if (scanner != null && ensureScanPermission()) {
      scanner.stopScan(scanCallback)
    }
    isScanning = false
  }
  private fun closeGattInternal() {
    val gatt = bluetoothGatt
    if (gatt != null) {
      try {
        gatt.close()
      } catch (_: Exception) {
      }
    }
    bluetoothGatt = null
  }
  private fun registerReceivers() {
    if (receiverRegistered) {
      return
    }
    val filter = IntentFilter().apply {
      addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
      addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
    }
    appContext.registerReceiver(bluetoothBroadcastReceiver, filter)
    receiverRegistered = true
  }
  private fun ensureInitialized(): Unit? {
    if (!isInitialized) {
      log("Ignored operation before initialize()")
      return null
    }
    return Unit
  }
  private fun ensureConnectPermission(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      return true
    }
    if (ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.BLUETOOTH_CONNECT
      ) == PackageManager.PERMISSION_GRANTED
    ) {
      return true
    }
    updateBluetoothState(BluetoothAdapterState.UNAUTHORIZED)
    log("Missing BLUETOOTH_CONNECT permission")
    return false
  }
  private fun ensureScanPermission(): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (ContextCompat.checkSelfPermission(
          appContext,
          Manifest.permission.BLUETOOTH_SCAN
        ) == PackageManager.PERMISSION_GRANTED
      ) {
        return true
      }
      updateBluetoothState(BluetoothAdapterState.UNAUTHORIZED)
      log("Missing BLUETOOTH_SCAN permission")
      return false
    }
    val hasFineLocation =
      ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_FINE_LOCATION
      ) == PackageManager.PERMISSION_GRANTED
    val hasCoarseLocation =
      ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_COARSE_LOCATION
      ) == PackageManager.PERMISSION_GRANTED
    return hasFineLocation || hasCoarseLocation
  }
  private fun runSerial(block: () -> Unit) {
    if (Thread.currentThread() == serialThread) {
      block()
      return
    }
    serialHandler.post(block)
  }
  private fun log(message: String) {
    Log.d(logTag, message)
  }
  private val bluetoothBroadcastReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val action = intent?.action ?: return
      when (action) {
        BluetoothAdapter.ACTION_STATE_CHANGED -> {
          val newState = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
          runSerial {
            val mapped = when (newState) {
              BluetoothAdapter.STATE_ON -> BluetoothAdapterState.POWERED_ON
              BluetoothAdapter.STATE_OFF -> BluetoothAdapterState.POWERED_OFF
              BluetoothAdapter.STATE_TURNING_ON,
              BluetoothAdapter.STATE_TURNING_OFF -> BluetoothAdapterState.RESETTING
              else -> BluetoothAdapterState.UNKNOWN
            }
            updateBluetoothState(mapped)
            if (mapped == BluetoothAdapterState.POWERED_ON) {
              pendingConnectionDeviceId?.let { pending ->
                pendingConnectionDeviceId = null
                connect(pending)
              }
            }
          }
        }
        BluetoothDevice.ACTION_BOND_STATE_CHANGED -> {
          val device =
            intent.getParcelableExtraCompat<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE) ?: return
          val newState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
          val previousState =
            intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.ERROR)
          runSerial {
            if (connectedDevice?.address != device.address && targetDeviceId != device.address) {
              return@runSerial
            }
            if (newState == BluetoothDevice.BOND_BONDED) {
              cancelBondTimeout()
              if (connectionState == ConnectionState.CONNECTING) {
                openGattConnection(device)
              }
              return@runSerial
            }
            if (newState == BluetoothDevice.BOND_NONE &&
              (previousState == BluetoothDevice.BOND_BONDING || previousState == BluetoothDevice.BOND_BONDED)
            ) {
              cancelBondTimeout()
              log("Bond lost: previousState=$previousState, deviceId=${device.address}")
              delegate?.onBondingLost(device.address)
              handleTerminalDisconnect(
                device.address,
                DisconnectReason.BONDING_LOST,
                allowReconnect = false
              )
            }
          }
        }
      }
    }
  }
  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult?) {
      if (result == null) return
      val device = result.device ?: return
      val address = device.address
      val name = try {
        device.name
      } catch (_: SecurityException) {
        null
      } ?: result.scanRecord?.deviceName
      val rssi = result.rssi
      val connectable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        result.isConnectable
      } else {
        true
      }
      runSerial {
        delegate?.onDeviceDiscovered(
          DiscoveredDevice(
            id = address,
            name = name,
            rssi = rssi,
            isConnectable = connectable
          )
        )
      }
    }
    override fun onScanFailed(errorCode: Int) {
      runSerial {
        log("Scan failed with code $errorCode")
        isScanning = false
      }
    }
  }
  private val gattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      runSerial {
        if (gatt !== bluetoothGatt) {
          log("Ignoring callback from stale GATT instance")
          try {
            gatt.close()
          } catch (_: Exception) {
          }
          return@runSerial
        }
        val deviceId = gatt.device.address
        when (newState) {
          BluetoothProfile.STATE_CONNECTED -> {
            if (status != BluetoothGatt.GATT_SUCCESS) {
              handleGattDisconnected(status, deviceId)
              return@runSerial
            }
            cancelBondTimeout()
            connectTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
            connectTimeoutRunnable = null
            connectedDevice = gatt.device
            transitionState(ConnectionState.CONNECTED, deviceId)
            awaitingMtuCallback = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
              awaitingMtuCallback = gatt.requestMtu(BleConfig.REQUESTED_MTU)
            }
            if (awaitingMtuCallback) {
              mtuFallbackRunnable?.let { serialHandler.removeCallbacks(it) }
              mtuFallbackRunnable = Runnable {
                mtuFallbackRunnable = null
                if (connectionState == ConnectionState.CONNECTED) {
                  beginServiceDiscovery(gatt, deviceId)
                }
              }
              serialHandler.postDelayed(mtuFallbackRunnable!!, 1_000L)
            } else {
              beginServiceDiscovery(gatt, deviceId)
            }
          }
          BluetoothProfile.STATE_DISCONNECTED -> {
            manualDisconnectFallbackRunnable?.let { serialHandler.removeCallbacks(it) }
            manualDisconnectFallbackRunnable = null
            handleGattDisconnected(status, deviceId)
          }
        }
      }
    }
    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      runSerial {
        if (gatt !== bluetoothGatt) {
          return@runSerial
        }
        mtuFallbackRunnable?.let { serialHandler.removeCallbacks(it) }
        mtuFallbackRunnable = null
        awaitingMtuCallback = false
        if (connectionState == ConnectionState.CONNECTED) {
          beginServiceDiscovery(gatt, gatt.device.address)
        }
      }
    }
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      runSerial {
        if (gatt !== bluetoothGatt) {
          return@runSerial
        }
        discoveryTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
        discoveryTimeoutRunnable = null
        if (status != BluetoothGatt.GATT_SUCCESS) {
          disconnectWithFault(
            DisconnectReason.SERVICE_DISCOVERY_FAILED,
            "discoverServices failed with status=$status"
          )
          return@runSerial
        }
        val serviceUuid = UUID.fromString(BleConfig.SERVICE_UUID)
        val characteristicUuid = UUID.fromString(BleConfig.MAIN_CHARACTERISTIC_UUID)
        val cccdUuid = UUID.fromString(BleConfig.CLIENT_CHARACTERISTIC_CONFIG_UUID)
        val service = gatt.getService(serviceUuid)
        if (service == null) {
          disconnectWithFault(
            DisconnectReason.SERVICE_NOT_FOUND,
            "Target service not found"
          )
          return@runSerial
        }
        val characteristic = service.getCharacteristic(characteristicUuid)
        if (characteristic == null) {
          disconnectWithFault(
            DisconnectReason.CHARACTERISTIC_NOT_FOUND,
            "Target characteristic not found"
          )
          return@runSerial
        }
        mainCharacteristic = characteristic
        transitionState(ConnectionState.SUBSCRIBING, gatt.device.address)
        startSubscriptionTimeout(gatt.device.address)
        val notifySet = gatt.setCharacteristicNotification(characteristic, true)
        if (!notifySet) {
          disconnectWithFault(
            DisconnectReason.SUBSCRIPTION_FAILED,
            "setCharacteristicNotification(false) returned"
          )
          return@runSerial
        }
        val descriptor = characteristic.getDescriptor(cccdUuid)
        if (descriptor == null) {
          disconnectWithFault(
            DisconnectReason.SUBSCRIPTION_FAILED,
            "CCCD descriptor missing"
          )
          return@runSerial
        }
        @Suppress("DEPRECATION")
        descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        val writeStarted = gatt.writeDescriptor(descriptor)
        if (!writeStarted) {
          disconnectWithFault(
            DisconnectReason.SUBSCRIPTION_FAILED,
            "writeDescriptor failed to start"
          )
        }
      }
    }
    override fun onDescriptorWrite(
      gatt: BluetoothGatt,
      descriptor: BluetoothGattDescriptor,
      status: Int
    ) {
      runSerial {
        if (gatt !== bluetoothGatt) {
          return@runSerial
        }
        val cccdUuid = UUID.fromString(BleConfig.CLIENT_CHARACTERISTIC_CONFIG_UUID)
        if (descriptor.uuid != cccdUuid) {
          return@runSerial
        }
        subscriptionTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
        subscriptionTimeoutRunnable = null
        if (status == BluetoothGatt.GATT_SUCCESS) {
          transitionToReady(gatt.device.address)
          return@runSerial
        }
        if (isOperationSecurityStatus(status)) {
          delegate?.onBondingLost(gatt.device.address)
          disconnectWithFault(
            DisconnectReason.BONDING_LOST,
            "Descriptor write failed due to authentication/encryption status=$status"
          )
        } else {
          disconnectWithFault(
            DisconnectReason.SUBSCRIPTION_FAILED,
            "Descriptor write failed status=$status"
          )
        }
      }
    }
    @Deprecated("Deprecated in Java")
    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic
    ) {
      runSerial {
        if (gatt !== bluetoothGatt) {
          return@runSerial
        }
        val payload = characteristic.value ?: return@runSerial
        emitData(gatt.device.address, payload)
      }
    }
    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray
    ) {
      runSerial {
        if (gatt !== bluetoothGatt) {
          return@runSerial
        }
        emitData(gatt.device.address, value)
      }
    }
    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int
    ) {
      runSerial {
        if (gatt !== bluetoothGatt) {
          return@runSerial
        }
        writeTimeoutRunnable?.let { serialHandler.removeCallbacks(it) }
        writeTimeoutRunnable = null
        writeInFlight = false
        if (status == BluetoothGatt.GATT_SUCCESS) {
          return@runSerial
        }
        if (isOperationSecurityStatus(status)) {
          delegate?.onBondingLost(gatt.device.address)
          disconnectWithFault(
            DisconnectReason.BONDING_LOST,
            "Write failed with security status=$status"
          )
        } else {
          disconnectWithFault(
            DisconnectReason.CONNECTION_FAILED,
            "Characteristic write failed status=$status"
          )
        }
      }
    }
  }
  @SuppressLint("MissingPermission")
  private fun beginServiceDiscovery(gatt: BluetoothGatt, deviceId: String) {
    if (connectionState == ConnectionState.DISCONNECTED) {
      return
    }
    transitionState(ConnectionState.DISCOVERING, deviceId)
    startDiscoveryTimeout(deviceId)
    val started = gatt.discoverServices()
    if (!started) {
      disconnectWithFault(
        DisconnectReason.SERVICE_DISCOVERY_FAILED,
        "discoverServices returned false"
      )
    }
  }
  private fun isConnectionSecurityStatus(status: Int): Boolean {
    return status == GATT_STATUS_INSUFFICIENT_AUTHENTICATION ||
      status == GATT_STATUS_INSUFFICIENT_ENCRYPTION
  }
  private fun isOperationSecurityStatus(status: Int): Boolean {
    return status == GATT_STATUS_INSUFFICIENT_AUTHENTICATION ||
      status == GATT_STATUS_INSUFFICIENT_ENCRYPTION ||
      status == GATT_STATUS_INSUFFICIENT_AUTHORIZATION
  }
  companion object {
    private const val GATT_STATUS_CONNECTION_TIMEOUT = 8
    private const val GATT_STATUS_CONNECTION_FAILED = 133
    private const val GATT_STATUS_GENERIC_FAILURE = 257
    private const val GATT_STATUS_INSUFFICIENT_AUTHENTICATION = 5
    private const val GATT_STATUS_INSUFFICIENT_AUTHORIZATION = 8
    private const val GATT_STATUS_INSUFFICIENT_ENCRYPTION = 15
  }
}
private object BluetoothStatusCodes {
  const val SUCCESS = 0
}
private inline fun <reified T> Intent.getParcelableExtraCompat(key: String): T? {
  return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    getParcelableExtra(key, T::class.java)
  } else {
    @Suppress("DEPRECATION")
    getParcelableExtra(key) as? T
  }
}
