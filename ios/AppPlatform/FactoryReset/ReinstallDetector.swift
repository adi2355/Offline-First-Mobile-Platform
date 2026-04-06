import Foundation
import Security
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
@objc public class ReinstallDetector: NSObject {
    /
    private static let keychainService = "com.appplatform.appplatform.install"
    /
    private static let keychainAccount = "install_marker"
    /
    private static let sentinelFileName = ".appplatform_install_sentinel"
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
    @objc public static func checkForReinstall() -> Bool {
        NSLog("[FactoryReset][ReinstallDetector] Checking for reinstall...")
        let keychainMarkerExists = getKeychainMarker() != nil
        let sentinelFileExists = checkSentinelFileExists()
        NSLog("[FactoryReset][ReinstallDetector] keychainMarker=%d, sentinelFile=%d",
              keychainMarkerExists ? 1 : 0,
              sentinelFileExists ? 1 : 0)
        if keychainMarkerExists && !sentinelFileExists {
            NSLog("[FactoryReset][ReinstallDetector] REINSTALL DETECTED - Keychain persisted but sentinel missing")
            return true
        }
        if !keychainMarkerExists && !sentinelFileExists {
            NSLog("[FactoryReset][ReinstallDetector] Fresh install detected - no previous data")
            return false
        }
        NSLog("[FactoryReset][ReinstallDetector] Normal launch - both markers present")
        return false
    }
    /
    /
    /
    /
    /
    @objc public static func getSentinelPath() -> String {
        let documentsPath = NSSearchPathForDirectoriesInDomains(
            .documentDirectory,
            .userDomainMask,
            true
        ).first ?? ""
        return (documentsPath as NSString).appendingPathComponent(sentinelFileName)
    }
    /
    /
    /
    /
    /
    @objc @discardableResult
    public static func createSentinelFile() -> Bool {
        let path = getSentinelPath()
        let timestamp = String(Date().timeIntervalSince1970)
        do {
            try timestamp.write(toFile: path, atomically: true, encoding: .utf8)
            NSLog("[FactoryReset][ReinstallDetector] Sentinel file created at: %@", path)
            return true
        } catch {
            NSLog("[FactoryReset][ReinstallDetector] ERROR: Failed to create sentinel file: %@",
                  error.localizedDescription)
            return false
        }
    }
    /
    /
    /
    /
    /
    /
    @objc public static func hasKeychainMarker() -> Bool {
        return getKeychainMarker() != nil
    }
    /
    /
    /
    /
    /
    @objc @discardableResult
    public static func setKeychainMarker() -> Bool {
        let timestamp = String(Date().timeIntervalSince1970)
        guard let data = timestamp.data(using: .utf8) else {
            NSLog("[FactoryReset][ReinstallDetector] ERROR: Failed to encode marker data")
            return false
        }
        deleteKeychainMarker()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecSuccess {
            NSLog("[FactoryReset][ReinstallDetector] Keychain marker set successfully")
            return true
        } else {
            NSLog("[FactoryReset][ReinstallDetector] ERROR: Failed to set Keychain marker, status: %d",
                  Int(status))
            return false
        }
    }
    /
    private static func checkSentinelFileExists() -> Bool {
        let path = getSentinelPath()
        return FileManager.default.fileExists(atPath: path)
    }
    /
    private static func getKeychainMarker() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data {
            return String(data: data, encoding: .utf8)
        }
        if status != errSecItemNotFound {
            NSLog("[FactoryReset][ReinstallDetector] Keychain read status: %d", Int(status))
        }
        return nil
    }
    /
    @discardableResult
    private static func deleteKeychainMarker() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
