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
/
/
@objc(KeychainWipe)
class KeychainWipeModule: NSObject {
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
    @objc public static func wipeAllKeychainItems() -> Bool {
        NSLog("[FactoryReset][KeychainWipe] Starting Keychain wipe...")
        let passwordClasses: [CFString] = [
            kSecClassGenericPassword,
            kSecClassInternetPassword
        ]
        let otherClasses: [CFString] = [
            kSecClassCertificate,
            kSecClassKey,
            kSecClassIdentity
        ]
        var allSucceeded = true
        var deletedCount = 0
        var errorCount = 0
        for secClass in passwordClasses {
            let query: [String: Any] = [
                kSecClass as String: secClass,
                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny
            ]
            let status = SecItemDelete(query as CFDictionary)
            switch status {
            case errSecSuccess:
                NSLog("[FactoryReset][KeychainWipe] Deleted password items of class: %@", secClass as String)
                deletedCount += 1
            case errSecItemNotFound:
                NSLog("[FactoryReset][KeychainWipe] No password items found for class: %@", secClass as String)
            default:
                NSLog("[FactoryReset][KeychainWipe] ERROR: Failed to delete password class %@, status: %d",
                      secClass as String, Int(status))
                allSucceeded = false
                errorCount += 1
            }
        }
        for secClass in otherClasses {
            let query: [String: Any] = [
                kSecClass as String: secClass
            ]
            let status = SecItemDelete(query as CFDictionary)
            switch status {
            case errSecSuccess:
                NSLog("[FactoryReset][KeychainWipe] Deleted items of class: %@", secClass as String)
                deletedCount += 1
            case errSecItemNotFound:
                NSLog("[FactoryReset][KeychainWipe] No items found for class: %@", secClass as String)
            default:
                NSLog("[FactoryReset][KeychainWipe] ERROR: Failed to delete class %@, status: %d",
                      secClass as String, Int(status))
                allSucceeded = false
                errorCount += 1
            }
        }
        NSLog("[FactoryReset][KeychainWipe] Wipe complete. Deleted: %d classes, Errors: %d",
              deletedCount, errorCount)
        return allSucceeded
    }
    /
    /
    /
    @objc
    func wipeKeychain(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        NSLog("[FactoryReset][KeychainWipe] wipeKeychain() called from JavaScript")
        let success = KeychainWipeModule.wipeAllKeychainItems()
        if success {
            resolve(["success": true])
        } else {
            reject(
                "KEYCHAIN_WIPE_PARTIAL_FAILURE",
                "Some Keychain items could not be deleted. Check logs for details.",
                nil
            )
        }
    }
    /
    /
    @objc static func requiresMainQueueSetup() -> Bool {
        return false
    }
}
