import Foundation
import CoreBluetooth
/
/
enum AppDeviceUUIDs {
    /
    static let service = CBUUID(string: "4fafc201-1fb5-459e-8fcc-c5c9c331914b")
    /
    static let mainCharacteristic = CBUUID(string: "beb5483e-36e1-4688-b7f5-ea07361b26a8")
    /
    static let otaCharacteristic = CBUUID(string: "beb5483e-36e1-4688-b7f5-ea07361b26a9")
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
enum ConnectionState: String, Codable {
    /
    case disconnected = "DISCONNECTED"
    /
    /
    case connecting = "CONNECTING"
    /
    /
    case connected = "CONNECTED"
    /
    /
    case discovering = "DISCOVERING"
    /
    /
    case subscribing = "SUBSCRIBING"
    /
    /
    case ready = "READY"
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
enum DisconnectReason: String, Codable {
    /
    case normal = "normal"
    /
    /
    case bondingLost = "bondingLost"
    /
    /
    case encryptionFailed = "encryptionFailed"
    /
    /
    case connectionFailed = "connectionFailed"
    /
    case timeout = "timeout"
    /
    case unknown = "unknown"
    /
    case deviceSleep = "deviceSleep"
    /
    case serviceDiscoveryFailed = "serviceDiscoveryFailed"
    /
    /
    case serviceNotFound = "serviceNotFound"
    /
    case characteristicDiscoveryFailed = "characteristicDiscoveryFailed"
    /
    /
    case characteristicNotFound = "characteristicNotFound"
    /
    /
    case subscriptionFailed = "subscriptionFailed"
    /
    /
    case subscriptionLost = "subscriptionLost"
    /
    case discoveryTimeout = "discoveryTimeout"
    /
    case subscriptionTimeout = "subscriptionTimeout"
}
/
enum BluetoothAdapterState: String, Codable {
    case unknown = "unknown"
    case resetting = "resetting"
    case unsupported = "unsupported"
    case unauthorized = "unauthorized"
    case poweredOff = "poweredOff"
    case poweredOn = "poweredOn"
    init(from cbState: CBManagerState) {
        switch cbState {
        case .unknown: self = .unknown
        case .resetting: self = .resetting
        case .unsupported: self = .unsupported
        case .unauthorized: self = .unauthorized
        case .poweredOff: self = .poweredOff
        case .poweredOn: self = .poweredOn
        @unknown default: self = .unknown
        }
    }
}
/
struct DiscoveredDevice: Codable {
    let id: String
    let name: String?
    let rssi: Int
    let isConnectable: Bool
}
/
struct ConnectionStateEvent: Codable {
    let state: ConnectionState
    let deviceId: String
    let reason: DisconnectReason?
    let timestamp: TimeInterval
    init(state: ConnectionState, deviceId: String, reason: DisconnectReason? = nil) {
        self.state = state
        self.deviceId = deviceId
        self.reason = reason
        self.timestamp = Date().timeIntervalSince1970 * 1000 
    }
    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "state": state.rawValue,
            "deviceId": deviceId,
            "timestamp": timestamp
        ]
        if let reason = reason {
            dict["reason"] = reason.rawValue
        }
        return dict
    }
}
/
struct DataReceivedEvent: Codable {
    let data: String  
    let deviceId: String
    let timestamp: TimeInterval
    init(data: Data, deviceId: String) {
        self.data = data.base64EncodedString()
        self.deviceId = deviceId
        self.timestamp = Date().timeIntervalSince1970 * 1000
    }
    func toDictionary() -> [String: Any] {
        return [
            "data": data,
            "deviceId": deviceId,
            "timestamp": timestamp
        ]
    }
}
/
/
protocol AppDeviceBLECoreDelegate: AnyObject {
    /
    func connectionStateChanged(_ event: ConnectionStateEvent)
    /
    func dataReceived(_ event: DataReceivedEvent)
    /
    func bondingLost(deviceId: String)
    /
    func bluetoothStateChanged(_ state: BluetoothAdapterState)
    /
    func deviceDiscovered(_ device: DiscoveredDevice)
    /
    /
    func operationRejected(_ event: OperationRejectedEvent)
}
/
/
enum OperationType: String, Codable {
    case connect = "connect"
    case write = "write"
}
/
/
enum OperationRejectReason: String, Codable {
    case notInitialized = "notInitialized"
    case unauthorized = "unauthorized"
    case unsupported = "unsupported"
    case busy = "busy"
    case notReady = "notReady"
    case invalidPayload = "invalidPayload"
    case queueFull = "queueFull"
}
/
/
/
/
/
struct OperationRejectedEvent {
    let operation: OperationType
    let reason: OperationRejectReason
    let detail: String?
    let deviceId: String?
    let timestampMs: TimeInterval
    init(
        operation: OperationType,
        reason: OperationRejectReason,
        detail: String? = nil,
        deviceId: String? = nil
    ) {
        self.operation = operation
        self.reason = reason
        self.detail = detail
        self.deviceId = deviceId
        self.timestampMs = Date().timeIntervalSince1970 * 1000
    }
    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "operation": operation.rawValue,
            "reason": reason.rawValue,
            "timestamp": timestampMs
        ]
        if let detail = detail {
            dict["detail"] = detail
        }
        if let deviceId = deviceId {
            dict["deviceId"] = deviceId
        }
        return dict
    }
}
/
enum BLEConfig {
    /
    static let requestedMTU: Int = 512
    /
    static let connectionTimeoutSeconds: TimeInterval = 30
    /
    static let discoveryTimeoutSeconds: TimeInterval = 10
    /
    static let subscriptionTimeoutSeconds: TimeInterval = 5
    /
    static let restorationIdentifier = "AppDeviceBLE_Restore"
    /
    static let maxReconnectionAttempts = 5
    /
    static let dormantReconnectionIntervalSeconds: TimeInterval = 60
}
