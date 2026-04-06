import Foundation
import CoreBluetooth
/
/
/
/
/
/
/
/
/
/
/
final class AppDeviceBLECore: NSObject {
    /
    static let shared = AppDeviceBLECore()
    /
    weak var delegate: AppDeviceBLECoreDelegate?
    /
    private(set) var connectionState: ConnectionState = .disconnected {
        didSet {
            guard oldValue != connectionState else { return }
            log("State transition: \(oldValue.rawValue) → \(connectionState.rawValue)")
        }
    }
    /
    private(set) var connectedPeripheral: CBPeripheral?
    /
    private(set) var bluetoothState: BluetoothAdapterState = .unknown
    /
    private var centralManager: CBCentralManager!
    /
    private var mainCharacteristic: CBCharacteristic?
    /
    private var connectionTimeoutTimer: Timer?
    /
    private var discoveryTimeoutTimer: Timer?
    /
    private var subscriptionTimeoutTimer: Timer?
    /
    private var isRestoringState = false
    /
    /
    /
    private var deviceSignaledSleep = false
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    private var isManualDisconnect = false
    /
    /
    private var readyTimestamp: Date?
    /
    private let stableConnectionThresholdSeconds: TimeInterval = 55.0
    /
    private var pendingConnectionDeviceId: String?
    /
    private var knownPeripheralIds: Set<String> = []
    /
    private var isScanning = false
    /
    /
    private static var initializationTimestamp: Date?
    private static var initializationSource: String = "unknown"
    /
    private override init() {
        super.init()
        AppDeviceBLECore.initializationTimestamp = Date()
        let callStack = Thread.callStackSymbols
        let isEarlyInit = callStack.contains { $0.contains("AppDelegate") || $0.contains("AppDeviceBLEInitializer") }
        AppDeviceBLECore.initializationSource = isEarlyInit ? "AppDelegate (early)" : "ReactNative (lazy)"
        log("=== AppDeviceBLECore INITIALIZATION ===")
        log("Initialization source: \(AppDeviceBLECore.initializationSource)")
        log("Timestamp: \(AppDeviceBLECore.initializationTimestamp!)")
        log("App state: \(UIApplication.shared.applicationState.debugDescription)")
        centralManager = CBCentralManager(
            delegate: self,
            queue: nil,  
            options: [
                CBCentralManagerOptionRestoreIdentifierKey: BLEConfig.restorationIdentifier,
                CBCentralManagerOptionShowPowerAlertKey: true
            ]
        )
        log("CBCentralManager initialized with restoration ID: \(BLEConfig.restorationIdentifier)")
        log("=== END INITIALIZATION ===")
    }
    /
    /
    static func getInitializationDiagnostics() -> [String: Any] {
        return [
            "timestamp": initializationTimestamp?.description ?? "not initialized",
            "source": initializationSource,
            "timeSinceInit": initializationTimestamp.map { Date().timeIntervalSince($0) } ?? -1
        ]
    }
    /
    func startScan(broadScan: Bool = false) {
        guard centralManager.state == .poweredOn else {
            log("Cannot scan: Bluetooth not powered on")
            return
        }
        guard !isScanning else {
            log("Already scanning")
            return
        }
        log("Starting scan for App Device devices (broadScan=\(broadScan))...")
        isScanning = true
        let serviceUUIDs: [CBUUID]? = broadScan ? nil : [AppDeviceUUIDs.service]
        centralManager.scanForPeripherals(
            withServices: serviceUUIDs,
            options: [
                CBCentralManagerScanOptionAllowDuplicatesKey: false
            ]
        )
    }
    /
    func stopScan() {
        guard isScanning else { return }
        log("Stopping scan")
        isScanning = false
        centralManager.stopScan()
    }
    /
    /
    /
    func connect(_ uuidString: String) {
        log("Connect requested for: \(uuidString)")
        guard centralManager.state == .poweredOn else {
            switch centralManager.state {
            case .unsupported:
                log("Bluetooth unsupported, rejecting connect")
                delegate?.operationRejected(OperationRejectedEvent(
                    operation: .connect,
                    reason: .unsupported,
                    detail: "Bluetooth hardware not available",
                    deviceId: uuidString
                ))
                return
            case .unauthorized:
                log("Bluetooth unauthorized, rejecting connect")
                delegate?.operationRejected(OperationRejectedEvent(
                    operation: .connect,
                    reason: .unauthorized,
                    detail: "Bluetooth permission not granted",
                    deviceId: uuidString
                ))
                return
            default:
                let btState = BluetoothAdapterState(from: centralManager.state)
                log("Bluetooth not ready (\(btState.rawValue)), deferring connection")
                pendingConnectionDeviceId = uuidString
                return
            }
        }
        guard connectionState == .disconnected else {
            log("Cannot connect: Already in state \(connectionState.rawValue)")
            delegate?.operationRejected(OperationRejectedEvent(
                operation: .connect,
                reason: .busy,
                detail: "Already in state \(connectionState.rawValue)",
                deviceId: connectedPeripheral?.identifier.uuidString
            ))
            return
        }
        guard let uuid = UUID(uuidString: uuidString) else {
            log("Invalid UUID format: \(uuidString)")
            delegate?.operationRejected(OperationRejectedEvent(
                operation: .connect,
                reason: .invalidPayload,
                detail: "Invalid UUID format: \(uuidString)"
            ))
            return
        }
        let systemConnected = centralManager.retrieveConnectedPeripherals(
            withServices: [AppDeviceUUIDs.service]
        )
        if let peripheral = systemConnected.first(where: { $0.identifier == uuid }) {
            log("Device already connected at system level, adopting connection")
            adoptSystemConnection(peripheral)
            return
        }
        let known = centralManager.retrievePeripherals(withIdentifiers: [uuid])
        guard let peripheral = known.first else {
            log("Device not found in known peripherals. Need to scan first.")
            delegate?.operationRejected(OperationRejectedEvent(
                operation: .connect,
                reason: .notReady,
                detail: "Device not found in known peripherals. Scan first.",
                deviceId: uuidString
            ))
            return
        }
        performConnect(peripheral)
    }
    /
    /
    /
    /
    /
    /
    /
    /
    /
    func disconnect() {
        guard let peripheral = connectedPeripheral else {
            log("Disconnect called but no device connected")
            return
        }
        log("Disconnecting from: \(peripheral.identifier)")
        isManualDisconnect = true
        cancelAllTimers()
        centralManager.cancelPeripheralConnection(peripheral)
    }
    /
    /
    /
    /
    @discardableResult
    func write(_ data: Data) -> Bool {
        guard let characteristic = mainCharacteristic,
              let peripheral = connectedPeripheral,
              connectionState == .ready else {
            log("Cannot write: Not in READY state")
            delegate?.operationRejected(OperationRejectedEvent(
                operation: .write,
                reason: .notReady,
                detail: "Write attempted in state \(connectionState.rawValue)",
                deviceId: connectedPeripheral?.identifier.uuidString
            ))
            return false
        }
        peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
        return true
    }
    /
    func getConnectionState() -> [String: Any] {
        var result: [String: Any] = [
            "state": connectionState.rawValue,
            "bluetoothState": bluetoothState.rawValue
        ]
        if let peripheral = connectedPeripheral {
            result["deviceId"] = peripheral.identifier.uuidString
        }
        return result
    }
    /
    /
    func checkSystemConnections() {
        guard centralManager.state == .poweredOn else {
            log("Cannot check system connections: Bluetooth not powered on")
            return
        }
        reconcileSystemConnections()
    }
    /
    /
    func setKnownPeripheralIds(_ ids: [String]) {
        knownPeripheralIds = Set(ids)
        log("Set \(ids.count) known peripheral IDs")
    }
    /
    /
    /
    /
    /
    func setDeviceSleepFlag() {
        log("Device signaled sleep (hint)")
        deviceSignaledSleep = true
    }
    /
    private func performConnect(_ peripheral: CBPeripheral) {
        log("Connecting to: \(peripheral.identifier)")
        isManualDisconnect = false  
        connectedPeripheral = peripheral
        peripheral.delegate = self
        connectionState = .connecting
        emitConnectionState(.connecting, peripheral.identifier.uuidString)
        startConnectionTimeout()
        centralManager.connect(peripheral, options: nil)
    }
    /
    /
    /
    /
    /
    private func adoptSystemConnection(_ peripheral: CBPeripheral) {
        log("Adopting system connection: \(peripheral.identifier)")
        isManualDisconnect = false  
        connectedPeripheral = peripheral
        peripheral.delegate = self
        connectionState = .connected
        emitConnectionState(.connected, peripheral.identifier.uuidString)
        discoverServices(for: peripheral)
    }
    /
    /
    /
    /
    /
    /
    /
    private func reconcileSystemConnections() {
        log("Checking for system-connected devices...")
        let connected = centralManager.retrieveConnectedPeripherals(
            withServices: [AppDeviceUUIDs.service]
        )
        guard !connected.isEmpty else {
            log("No system-connected devices found")
            return
        }
        log("Found \(connected.count) system-connected device(s)")
        guard connectionState == .disconnected else {
            log("Already connected/connecting, not adopting system connection")
            return
        }
        guard !isManualDisconnect else {
            log("Skipping adoption: user manually disconnected (isManualDisconnect=true)")
            return
        }
        let device: CBPeripheral
        if let known = connected.first(where: { knownPeripheralIds.contains($0.identifier.uuidString) }) {
            device = known
        } else if let pendingId = pendingConnectionDeviceId,
                  let pending = connected.first(where: { $0.identifier.uuidString == pendingId }) {
            device = pending
        } else {
            log("System-connected device(s) found (\(connected.count)) but none match " +
                "known IDs (\(knownPeripheralIds.count) known) or pending target. " +
                "Skipping adoption to avoid claiming unrelated peripherals.")
            return
        }
        adoptSystemConnection(device)
    }
    /
    private func discoverServices(for peripheral: CBPeripheral) {
        log("Discovering services...")
        connectionState = .discovering
        emitConnectionState(.discovering, peripheral.identifier.uuidString)
        startDiscoveryTimeout()
        peripheral.discoverServices([AppDeviceUUIDs.service])
    }
    /
    private func validateSubscription(for peripheral: CBPeripheral) {
        guard let service = peripheral.services?.first(where: { $0.uuid == AppDeviceUUIDs.service }) else {
            log("Service not found in cached services, need to discover")
            discoverServices(for: peripheral)
            return
        }
        if let char = service.characteristics?.first(where: { $0.uuid == AppDeviceUUIDs.mainCharacteristic }) {
            mainCharacteristic = char
            if char.isNotifying {
                log("Already subscribed, transitioning to READY")
                transitionToReady()
            } else {
                log("Enabling notifications...")
                connectionState = .subscribing
                emitConnectionState(.subscribing, peripheral.identifier.uuidString)
                startSubscriptionTimeout()
                peripheral.setNotifyValue(true, for: char)
            }
        } else {
            log("Characteristics not discovered, discovering...")
            peripheral.discoverCharacteristics(
                [AppDeviceUUIDs.mainCharacteristic],
                for: service
            )
        }
    }
    /
    private func transitionToReady() {
        cancelAllTimers()
        connectionState = .ready
        readyTimestamp = Date()  
        deviceSignaledSleep = false  
        guard let peripheral = connectedPeripheral else { return }
        log("Connection READY: \(peripheral.identifier)")
        emitConnectionState(.ready, peripheral.identifier.uuidString)
    }
    /
    /
    /
    private func handleDisconnection(peripheral: CBPeripheral, error: Error?) {
        guard connectionState != .disconnected else {
            log("EC-DEDUP-001: Ignoring duplicate disconnect for \(peripheral.identifier) (already disconnected)")
            return
        }
        log("Handling disconnection for: \(peripheral.identifier)")
        cancelAllTimers()
        let deviceId = peripheral.identifier.uuidString
        let reason = classifyDisconnectReason(error: error)
        log("Disconnect reason: \(reason.rawValue)")
        if reason == .bondingLost || reason == .encryptionFailed {
            log("BONDING ERROR DETECTED - emitting bondingLost")
            delegate?.bondingLost(deviceId: deviceId)
        }
        connectedPeripheral = nil
        mainCharacteristic = nil
        connectionState = .disconnected
        deviceSignaledSleep = false
        readyTimestamp = nil
        emitConnectionState(.disconnected, deviceId, reason: reason)
    }
    /
    /
    /
    /
    /
    /
    /
    private func classifyDisconnectReason(error: Error?) -> DisconnectReason {
        if isManualDisconnect {
            log("EC-MANUAL-001: Manual disconnect flagged → reason .normal")
            return .normal
        }
        if deviceSignaledSleep {
            if let error = error {
                log("EC-SLEEP-BOND-FIX-001: Device signaled sleep but CBError present (\(error.localizedDescription)). Treating as deviceSleep (false positive from abrupt power-off).")
            } else {
                log("EC-SLEEP-BOND-FIX-001: Device signaled sleep → reason .deviceSleep")
            }
            return .deviceSleep
        }
        if let error = error {
            let classified = classifyDisconnectError(error)
            if classified != .unknown {
                return classified
            }
        }
        if let readyTime = readyTimestamp {
            let connectionDuration = Date().timeIntervalSince(readyTime)
            if connectionDuration >= stableConnectionThresholdSeconds {
                log("Stable connection (\(Int(connectionDuration))s) + no error → inferring device sleep")
                return .deviceSleep
            }
        }
        if error != nil {
            return .unknown
        }
        return .normal
    }
    /
    private func classifyDisconnectError(_ error: Error) -> DisconnectReason {
        let nsError = error as NSError
        if nsError.domain == CBErrorDomain {
            switch nsError.code {
            case 6:  
                log("CBError 6: Peer removed pairing information")
                return .bondingLost
            case 9:  
                log("CBError 9: Encryption timed out")
                return .encryptionFailed
            case 10: 
                log("CBError 10: Connection failed")
                return .connectionFailed
            case 7:  
                log("CBError 7: Connection timeout")
                return .timeout
            default:
                log("Unclassified CBError code: \(nsError.code)")
                return .unknown
            }
        }
        if nsError.domain == CBATTErrorDomain {
            switch nsError.code {
            case 5:  
                log("CBATTError 5: Insufficient authentication")
                return .encryptionFailed
            case 15: 
                log("CBATTError 15: Insufficient encryption")
                return .encryptionFailed
            default:
                log("Unclassified CBATTError code: \(nsError.code)")
                return .unknown
            }
        }
        return .unknown
    }
    private func startConnectionTimeout() {
        cancelConnectionTimeout()
        connectionTimeoutTimer = Timer.scheduledTimer(
            withTimeInterval: BLEConfig.connectionTimeoutSeconds,
            repeats: false
        ) { [weak self] _ in
            self?.handleConnectionTimeout()
        }
    }
    private func cancelConnectionTimeout() {
        connectionTimeoutTimer?.invalidate()
        connectionTimeoutTimer = nil
    }
    /
    /
    /
    private func handleConnectionTimeout() {
        guard connectionState == .connecting else { return }
        log("Connection timeout!")
        let deviceId = connectedPeripheral?.identifier.uuidString
        if let peripheral = connectedPeripheral {
            centralManager.cancelPeripheralConnection(peripheral)
        }
        connectedPeripheral = nil
        connectionState = .disconnected
        if let id = deviceId {
            emitConnectionState(.disconnected, id, reason: .timeout)
        } else {
            log("WARNING: No deviceId available for timeout event")
        }
    }
    private func startDiscoveryTimeout() {
        cancelDiscoveryTimeout()
        discoveryTimeoutTimer = Timer.scheduledTimer(
            withTimeInterval: BLEConfig.discoveryTimeoutSeconds,
            repeats: false
        ) { [weak self] _ in
            self?.handleDiscoveryTimeout()
        }
    }
    private func cancelDiscoveryTimeout() {
        discoveryTimeoutTimer?.invalidate()
        discoveryTimeoutTimer = nil
    }
    /
    /
    /
    private func handleDiscoveryTimeout() {
        guard connectionState == .discovering else { return }
        log("Discovery timeout!")
        disconnectWithFault(.discoveryTimeout,
                           logMessage: "Service/characteristic discovery timed out")
    }
    private func startSubscriptionTimeout() {
        cancelSubscriptionTimeout()
        subscriptionTimeoutTimer = Timer.scheduledTimer(
            withTimeInterval: BLEConfig.subscriptionTimeoutSeconds,
            repeats: false
        ) { [weak self] _ in
            self?.handleSubscriptionTimeout()
        }
    }
    private func cancelSubscriptionTimeout() {
        subscriptionTimeoutTimer?.invalidate()
        subscriptionTimeoutTimer = nil
    }
    /
    /
    /
    private func handleSubscriptionTimeout() {
        guard connectionState == .subscribing else { return }
        log("Subscription timeout!")
        disconnectWithFault(.subscriptionTimeout,
                           logMessage: "setNotifyValue timed out - device may be unresponsive")
    }
    private func cancelAllTimers() {
        cancelConnectionTimeout()
        cancelDiscoveryTimeout()
        cancelSubscriptionTimeout()
    }
    private func emitConnectionState(_ state: ConnectionState, _ deviceId: String, reason: DisconnectReason? = nil) {
        let event = ConnectionStateEvent(state: state, deviceId: deviceId, reason: reason)
        delegate?.connectionStateChanged(event)
    }
    /
    /
    /
    /
    /
    /
    private func disconnectWithFault(_ reason: DisconnectReason, logMessage: String? = nil) {
        guard let peripheral = connectedPeripheral else {
            log("disconnectWithFault called but no device connected (reason: \(reason.rawValue))")
            return
        }
        let deviceId = peripheral.identifier.uuidString
        if let message = logMessage {
            log("GATT FAULT: \(message)")
        }
        log("Disconnecting with fault reason: \(reason.rawValue)")
        cancelAllTimers()
        connectedPeripheral = nil
        mainCharacteristic = nil
        connectionState = .disconnected
        deviceSignaledSleep = false
        readyTimestamp = nil
        centralManager.cancelPeripheralConnection(peripheral)
        emitConnectionState(.disconnected, deviceId, reason: reason)
    }
    private func log(_ message: String) {
        print("[AppDeviceBLECore] \(message)")
    }
}
extension AppDeviceBLECore: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = BluetoothAdapterState(from: central.state)
        bluetoothState = state
        log("Bluetooth state changed: \(state.rawValue)")
        delegate?.bluetoothStateChanged(state)
        if central.state == .poweredOn {
            reconcileSystemConnections()
            if let pendingId = pendingConnectionDeviceId {
                pendingConnectionDeviceId = nil
                connect(pendingId)
            }
        }
    }
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        log("=== iOS STATE RESTORATION CALLBACK ===")
        log("Initialization source was: \(AppDeviceBLECore.initializationSource)")
        log("Time since init: \(AppDeviceBLECore.initializationTimestamp.map { Date().timeIntervalSince($0) } ?? -1)s")
        log("App state: \(UIApplication.shared.applicationState.debugDescription)")
        isRestoringState = true
        if let scanServices = dict[CBCentralManagerRestoredStateScanServicesKey] as? [CBUUID] {
            log("Restored scan services: \(scanServices.map { $0.uuidString })")
        }
        if let scanOptions = dict[CBCentralManagerRestoredStateScanOptionsKey] as? [String: Any] {
            log("Restored scan options: \(scanOptions)")
        }
        if let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] {
            log("Restored \(peripherals.count) peripheral(s)")
            for peripheral in peripherals {
                log("--- Restoring peripheral ---")
                log("  ID: \(peripheral.identifier)")
                log("  Name: \(peripheral.name ?? "unknown")")
                log("  State: \(peripheral.state.rawValue)")
                log("  Services cached: \(peripheral.services?.count ?? 0)")
                if peripheral.state != .connected {
                    log("  WARNING: Peripheral state is not connected (\(peripheral.state.rawValue))")
                    log("  Will attempt to reconnect...")
                    connectedPeripheral = nil
                    peripheral.delegate = self
                    centralManager.connect(peripheral, options: nil)
                    connectionState = .connecting
                    emitConnectionState(.connecting, peripheral.identifier.uuidString)
                    continue
                }
                connectedPeripheral = peripheral
                peripheral.delegate = self
                connectionState = .connected
                emitConnectionState(.connected, peripheral.identifier.uuidString)
                log("  Driving GATT pipeline (discover → subscribe)...")
                discoverServices(for: peripheral)
            }
        } else {
            log("No peripherals to restore")
        }
        isRestoringState = false
        log("=== END STATE RESTORATION ===")
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let device = DiscoveredDevice(
            id: peripheral.identifier.uuidString,
            name: peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String,
            rssi: RSSI.intValue,
            isConnectable: advertisementData[CBAdvertisementDataIsConnectable] as? Bool ?? true
        )
        delegate?.deviceDiscovered(device)
    }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        log("Connected to: \(peripheral.identifier)")
        cancelConnectionTimeout()
        connectedPeripheral = peripheral
        peripheral.delegate = self
        connectionState = .connected
        emitConnectionState(.connected, peripheral.identifier.uuidString)
        discoverServices(for: peripheral)
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        log("Failed to connect: \(error?.localizedDescription ?? "Unknown error")")
        cancelAllTimers()
        let deviceId = peripheral.identifier.uuidString
        connectedPeripheral = nil
        connectionState = .disconnected
        emitConnectionState(.disconnected, deviceId, reason: .connectionFailed)
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        handleDisconnection(peripheral: peripheral, error: error)
    }
}
extension AppDeviceBLECore: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        cancelDiscoveryTimeout()
        if let error = error {
            disconnectWithFault(.serviceDiscoveryFailed,
                               logMessage: "Service discovery failed: \(error.localizedDescription)")
            return
        }
        guard let service = peripheral.services?.first(where: { $0.uuid == AppDeviceUUIDs.service }) else {
            disconnectWithFault(.serviceNotFound,
                               logMessage: "App Device service not found in discovered services")
            return
        }
        log("Discovered App Device service, discovering characteristics...")
        peripheral.discoverCharacteristics(
            [AppDeviceUUIDs.mainCharacteristic],
            for: service
        )
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error = error {
            disconnectWithFault(.characteristicDiscoveryFailed,
                               logMessage: "Characteristic discovery failed: \(error.localizedDescription)")
            return
        }
        guard let char = service.characteristics?.first(where: { $0.uuid == AppDeviceUUIDs.mainCharacteristic }) else {
            disconnectWithFault(.characteristicNotFound,
                               logMessage: "Main characteristic not found in service")
            return
        }
        log("Discovered main characteristic, subscribing...")
        mainCharacteristic = char
        connectionState = .subscribing
        emitConnectionState(.subscribing, peripheral.identifier.uuidString)
        startSubscriptionTimeout()
        peripheral.setNotifyValue(true, for: char)
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        cancelSubscriptionTimeout()
        if let error = error {
            log("Subscription failed: \(error.localizedDescription)")
            let nsError = error as NSError
            if nsError.domain == CBATTErrorDomain &&
               (nsError.code == 5 || nsError.code == 15) {
                log("Subscription failed due to security - bonding issue detected")
                delegate?.bondingLost(deviceId: peripheral.identifier.uuidString)
                disconnectWithFault(.bondingLost,
                                   logMessage: "Subscription failed due to insufficient authentication/encryption")
            } else {
                disconnectWithFault(.subscriptionFailed,
                                   logMessage: "Subscription failed: \(error.localizedDescription)")
            }
            return
        }
        if characteristic.isNotifying {
            log("Subscription enabled!")
            transitionToReady()
        } else {
            log("Subscription disabled unexpectedly!")
            disconnectWithFault(.subscriptionLost,
                               logMessage: "Notifications were unexpectedly disabled")
        }
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error {
            log("Data receive error: \(error.localizedDescription)")
            return
        }
        guard let data = characteristic.value else {
            log("Received empty data")
            return
        }
        let event = DataReceivedEvent(data: data, deviceId: peripheral.identifier.uuidString)
        delegate?.dataReceived(event)
    }
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error {
            log("Write failed: \(error.localizedDescription)")
            let nsError = error as NSError
            if nsError.domain == CBATTErrorDomain &&
               (nsError.code == 5 || nsError.code == 15) {
                log("Write failed due to security - bonding issue")
                delegate?.bondingLost(deviceId: peripheral.identifier.uuidString)
            }
        }
    }
}
/
extension UIApplication.State {
    var debugDescription: String {
        switch self {
        case .active:
            return "active (foreground)"
        case .inactive:
            return "inactive (transitioning)"
        case .background:
            return "background"
        @unknown default:
            return "unknown (\(rawValue))"
        }
    }
}
