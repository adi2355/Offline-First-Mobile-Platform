import Foundation
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
@objc public class FactoryResetGuard: NSObject {
    /
    private static let maxAttempts = 3
    /
    private static let attemptCountKey = "appplatform_factory_reset_attempts"
    /
    private static let lastBuildKey = "appplatform_factory_reset_last_build"
    /
    private static let lastResetTimestampKey = "appplatform_factory_reset_timestamp"
    /
    /
    /
    /
    /
    /
    /
    /
    /
    @objc public static func shouldAllowReset() -> Bool {
        let currentBuild = getCurrentBuildNumber()
        let lastBuild = UserDefaults.standard.string(forKey: lastBuildKey)
        let attempts = UserDefaults.standard.integer(forKey: attemptCountKey)
        NSLog("[FactoryReset][Guard] Checking reset permission. currentBuild=%@, lastBuild=%@, attempts=%d, max=%d",
              currentBuild, lastBuild ?? "nil", attempts, maxAttempts)
        if lastBuild != currentBuild {
            NSLog("[FactoryReset][Guard] New build detected, resetting counter. Allowing reset.")
            UserDefaults.standard.set(0, forKey: attemptCountKey)
            UserDefaults.standard.set(currentBuild, forKey: lastBuildKey)
            UserDefaults.standard.synchronize()
            return true
        }
        if attempts >= maxAttempts {
            NSLog("[FactoryReset][Guard] BLOCKED: Max attempts (%d) reached for build %@",
                  maxAttempts, currentBuild)
            return false
        }
        NSLog("[FactoryReset][Guard] Reset allowed. Attempt %d of %d", attempts + 1, maxAttempts)
        return true
    }
    /
    /
    /
    /
    @objc public static func incrementAttempt() {
        let currentBuild = getCurrentBuildNumber()
        let attempts = UserDefaults.standard.integer(forKey: attemptCountKey)
        let newCount = attempts + 1
        UserDefaults.standard.set(newCount, forKey: attemptCountKey)
        UserDefaults.standard.set(currentBuild, forKey: lastBuildKey)
        UserDefaults.standard.synchronize() 
        NSLog("[FactoryReset][Guard] Attempt counter incremented to %d for build %@",
              newCount, currentBuild)
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
    @objc public static func markResetComplete() {
        NSLog("[FactoryReset][Guard] Marking reset complete...")
        let sentinelCreated = ReinstallDetector.createSentinelFile()
        NSLog("[FactoryReset][Guard] Sentinel file created: %d", sentinelCreated ? 1 : 0)
        let markerSet = ReinstallDetector.setKeychainMarker()
        NSLog("[FactoryReset][Guard] Keychain marker set: %d", markerSet ? 1 : 0)
        UserDefaults.standard.set(0, forKey: attemptCountKey)
        let timestamp = Date().timeIntervalSince1970
        UserDefaults.standard.set(timestamp, forKey: lastResetTimestampKey)
        UserDefaults.standard.synchronize()
        NSLog("[FactoryReset][Guard] Reset marked complete at %f", timestamp)
    }
    /
    /
    /
    /
    /
    @objc public static func getDiagnostics() -> [String: Any] {
        let currentBuild = getCurrentBuildNumber()
        let lastBuild = UserDefaults.standard.string(forKey: lastBuildKey) ?? "never"
        let attempts = UserDefaults.standard.integer(forKey: attemptCountKey)
        let lastResetTimestamp = UserDefaults.standard.double(forKey: lastResetTimestampKey)
        let sentinelExists = FileManager.default.fileExists(
            atPath: ReinstallDetector.getSentinelPath()
        )
        return [
            "currentBuild": currentBuild,
            "lastResetBuild": lastBuild,
            "attemptCount": attempts,
            "maxAttempts": maxAttempts,
            "lastResetTimestamp": lastResetTimestamp,
            "sentinelExists": sentinelExists
        ]
    }
    /
    private static func getCurrentBuildNumber() -> String {
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    }
}
