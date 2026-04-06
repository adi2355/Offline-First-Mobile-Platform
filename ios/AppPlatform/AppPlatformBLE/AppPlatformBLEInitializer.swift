import Foundation
/
/
@objc public class AppDeviceBLEInitializer: NSObject {
    /
    /
    private static var _initialized = false
    /
    /
    /
    /
    /
    /
    /
    @objc public static func initializeBLECore() {
        print("[AppDeviceBLEInitializer] Early BLE initialization for state restoration")
        _ = AppDeviceBLECore.shared
        _initialized = true
        print("[AppDeviceBLEInitializer] CBCentralManager created with restoration ID: \(BLEConfig.restorationIdentifier)")
    }
    /
    /
    /
    @objc public static func isInitialized() -> Bool {
        return _initialized
    }
}
