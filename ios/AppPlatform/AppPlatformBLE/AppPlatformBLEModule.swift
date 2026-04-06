import Foundation
import React
/
struct DroppedEventInfo {
    let eventName: String
    let timestamp: Date
}
/
/
/
/
private final class EventBuffer {
    /
    struct BufferedEvent {
        let name: String
        let body: [String: Any]?
        let timestamp: Date
    }
    /
    private let maxSize: Int
    /
    private var buffer: [BufferedEvent] = []
    /
    private let lock = NSLock()
    /
    private(set) var totalBuffered: Int = 0
    private(set) var totalDropped: Int = 0
    /
    var onOverflow: ((DroppedEventInfo) -> Void)?
    init(maxSize: Int = 100) {
        self.maxSize = maxSize
    }
    /
    /
    /
    /
    func add(name: String, body: [String: Any]?) {
        lock.lock()
        var droppedEvent: BufferedEvent? = nil
        if buffer.count >= maxSize {
            droppedEvent = buffer.removeFirst()
            totalDropped += 1
            print("[EventBuffer] Buffer full, dropped oldest event '\(droppedEvent?.name ?? "unknown")'. Total dropped: \(totalDropped)")
        }
        buffer.append(BufferedEvent(name: name, body: body, timestamp: Date()))
        totalBuffered += 1
        lock.unlock()
        if let dropped = droppedEvent, let callback = onOverflow {
            callback(DroppedEventInfo(eventName: dropped.name, timestamp: dropped.timestamp))
        }
    }
    /
    /
    func flush() -> [BufferedEvent] {
        lock.lock()
        defer { lock.unlock() }
        let events = buffer
        buffer.removeAll()
        return events
    }
    /
    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return buffer.count
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
/
/
/
/
/
/
@objc(AppDeviceBLE)
class AppDeviceBLEModule: RCTEventEmitter {
    /
    private let core = AppDeviceBLECore.shared
    /
    private var hasListeners = false
    /
    /
    private let eventBuffer = EventBuffer(maxSize: 100)
    /
    private var lastConnectionState: ConnectionStateEvent?
    private var pendingOverflows: [[String: Any]] = []
    private let overflowLock = NSLock()
    private let maxPendingOverflows = 10
    override init() {
        super.init()
        core.delegate = self
        eventBuffer.onOverflow = { [weak self] droppedInfo in
            guard let self = self else { return }
            self.log("BUFFER OVERFLOW: Dropped event '\(droppedInfo.eventName)' from \(droppedInfo.timestamp)")
            let overflowPayload: [String: Any] = [
                "droppedEventName": droppedInfo.eventName,
                "droppedEventTimestamp": droppedInfo.timestamp.timeIntervalSince1970 * 1000,
                "totalDropped": self.eventBuffer.totalDropped,
                "bufferSize": self.eventBuffer.count,
                "timestamp": Date().timeIntervalSince1970 * 1000
            ]
            if self.hasListeners {
                self.sendEvent(withName: "onBufferOverflow", body: overflowPayload)
            } else {
                self.overflowLock.lock()
                self.pendingOverflows.append(overflowPayload)
                if self.pendingOverflows.count > self.maxPendingOverflows {
                    self.pendingOverflows.removeFirst()
                }
                self.overflowLock.unlock()
            }
        }
        log("AppDeviceBLEModule initialized with event buffering enabled")
    }
    /
    override static func requiresMainQueueSetup() -> Bool {
        return true
    }
    /
    override func supportedEvents() -> [String]! {
        return [
            "onConnectionStateChange",
            "onDataReceived",
            "onBondingLost",
            "onBluetoothStateChange",
            "onDeviceFound",
            "onBufferOverflow",
            "onOperationRejected"
        ]
    }
    /
    /
    override func startObserving() {
        hasListeners = true
        log("JS started observing events")
        flushBufferedEvents()
        if let lastState = lastConnectionState {
            log("Sending cached connection state to new listener: \(lastState.state.rawValue)")
            sendEvent(withName: "onConnectionStateChange", body: lastState.toDictionary())
        }
    }
    /
    override func stopObserving() {
        hasListeners = false
        log("JS stopped observing events")
    }
    /
    /
    /
    /
    /
    /
    private func flushBufferedEvents() {
        let bufferedEvents = eventBuffer.flush()
        overflowLock.lock()
        let overflows = pendingOverflows
        pendingOverflows.removeAll()
        overflowLock.unlock()
        if bufferedEvents.isEmpty && overflows.isEmpty {
            log("No buffered events or overflow notifications to flush")
            return
        }
        log("Flushing \(bufferedEvents.count) buffered events and \(overflows.count) overflow notifications to JS")
        for event in bufferedEvents {
            let ageMs = Int(Date().timeIntervalSince(event.timestamp) * 1000)
            log("Flushing buffered event '\(event.name)' (age: \(ageMs)ms)")
            sendEvent(withName: event.name, body: event.body)
        }
        for payload in overflows {
            log("Flushing deferred overflow notification")
            sendEvent(withName: "onBufferOverflow", body: payload)
        }
        log("Buffer flush complete. Stats: totalBuffered=\(eventBuffer.totalBuffered), totalDropped=\(eventBuffer.totalDropped)")
    }
    /
    /
    private func sendEventOrBuffer(name: String, body: [String: Any]?) {
        if hasListeners {
            sendEvent(withName: name, body: body)
        } else {
            log("Buffering event '\(name)' (no JS listeners yet)")
            eventBuffer.add(name: name, body: body)
        }
    }
    /
    /
    @objc
    func startScan(_ broadScan: Bool) {
        log("startScan called from JS (broadScan=\(broadScan))")
        DispatchQueue.main.async {
            self.core.startScan(broadScan: broadScan)
        }
    }
    /
    @objc
    func stopScan() {
        log("stopScan called from JS")
        DispatchQueue.main.async {
            self.core.stopScan()
        }
    }
    /
    /
    /
    @objc
    func connect(_ uuid: String) {
        log("connect called from JS: \(uuid)")
        DispatchQueue.main.async {
            self.core.connect(uuid)
        }
    }
    /
    @objc
    func disconnect() {
        log("disconnect called from JS")
        DispatchQueue.main.async {
            self.core.disconnect()
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
    @objc
    func write(_ base64Data: String,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let data = Data(base64Encoded: base64Data) else {
            log("write: Invalid base64 data")
            sendEventOrBuffer(name: "onOperationRejected", body: OperationRejectedEvent(
                operation: .write,
                reason: .invalidPayload,
                detail: "Invalid base64 payload",
                deviceId: core.connectedPeripheral?.identifier.uuidString
            ).toDictionary())
            reject("INVALID_PAYLOAD", "Invalid base64 payload", nil)
            return
        }
        DispatchQueue.main.async {
            let accepted = self.core.write(data)
            if accepted {
                resolve(nil)
            } else {
                reject("WRITE_REJECTED", "Write rejected - not in READY state", nil)
            }
        }
    }
    /
    /
    /
    /
    /
    @objc
    func getConnectionState(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            let state = self.core.getConnectionState()
            resolve(state)
        }
    }
    /
    /
    @objc
    func checkSystemConnections() {
        log("checkSystemConnections called from JS")
        DispatchQueue.main.async {
            self.core.checkSystemConnections()
        }
    }
    /
    /
    /
    @objc
    func setKnownPeripheralIds(_ ids: [String]) {
        log("setKnownPeripheralIds called from JS: \(ids.count) IDs")
        DispatchQueue.main.async {
            self.core.setKnownPeripheralIds(ids)
        }
    }
    /
    @objc
    func setDeviceSleepFlag() {
        log("setDeviceSleepFlag called from JS")
        DispatchQueue.main.async {
            self.core.setDeviceSleepFlag()
        }
    }
    /
    @objc
    func getBufferDiagnostics(_ resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
        overflowLock.lock()
        let pendingCount = pendingOverflows.count
        overflowLock.unlock()
        resolve([
            "currentBufferSize": eventBuffer.count,
            "totalBuffered": eventBuffer.totalBuffered,
            "totalDropped": eventBuffer.totalDropped,
            "hasListeners": hasListeners,
            "pendingOverflowCount": pendingCount
        ])
    }
    private func log(_ message: String) {
        print("[AppDeviceBLEModule] \(message)")
    }
}
extension AppDeviceBLEModule: AppDeviceBLECoreDelegate {
    func connectionStateChanged(_ event: ConnectionStateEvent) {
        log("Connection state changed: \(event.state.rawValue)")
        lastConnectionState = event
        sendEventOrBuffer(name: "onConnectionStateChange", body: event.toDictionary())
    }
    func dataReceived(_ event: DataReceivedEvent) {
        sendEventOrBuffer(name: "onDataReceived", body: event.toDictionary())
    }
    func bondingLost(deviceId: String) {
        log("Bonding lost for device: \(deviceId)")
        sendEventOrBuffer(name: "onBondingLost", body: ["deviceId": deviceId])
    }
    func bluetoothStateChanged(_ state: BluetoothAdapterState) {
        log("Bluetooth state changed: \(state.rawValue)")
        sendEventOrBuffer(name: "onBluetoothStateChange", body: ["state": state.rawValue])
    }
    func deviceDiscovered(_ device: DiscoveredDevice) {
        log("Device discovered: \(device.id)")
        sendEventOrBuffer(name: "onDeviceFound", body: [
            "id": device.id,
            "name": device.name ?? NSNull(),
            "rssi": device.rssi,
            "isConnectable": device.isConnectable
        ])
    }
    func operationRejected(_ event: OperationRejectedEvent) {
        log("Operation rejected: \(event.operation.rawValue) (\(event.reason.rawValue))")
        sendEventOrBuffer(name: "onOperationRejected", body: event.toDictionary())
    }
}
