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
/
/
/
@objc(FactoryReset)
public class FactoryResetModule: NSObject {
    /
    private static let databaseName = "DeviceEvents.db"
    /
    private static let asyncStorageDirectory = "RCTAsyncLocalStorage"
    /
    private static let asyncStorageDirectoryAlt = "RCTAsyncLocalStorage_V1"
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
    @objc public static func wipeSQLiteDatabase() -> Bool {
        NSLog("[FactoryReset][SQLite] Starting SQLite database wipe...")
        let filesToDelete = [
            databaseName,
            "\(databaseName)-wal",
            "\(databaseName)-shm",
            "\(databaseName)-journal"
        ]
        var allSucceeded = true
        var deletedCount = 0
        if let appSupportPath = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first {
            let sqlitePath = appSupportPath.appendingPathComponent("SQLite")
            for fileName in filesToDelete {
                let filePath = sqlitePath.appendingPathComponent(fileName)
                if FileManager.default.fileExists(atPath: filePath.path) {
                    do {
                        try FileManager.default.removeItem(at: filePath)
                        NSLog("[FactoryReset][SQLite] Deleted from App Support: %@", fileName)
                        deletedCount += 1
                    } catch {
                        NSLog("[FactoryReset][SQLite] ERROR: Failed to delete from App Support %@: %@",
                              fileName, error.localizedDescription)
                        allSucceeded = false
                    }
                }
            }
        } else {
            NSLog("[FactoryReset][SQLite] WARNING: Could not get Application Support directory (continuing to Documents)")
        }
        if let documentsPath = FileManager.default.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first {
            for fileName in filesToDelete {
                let filePath = documentsPath.appendingPathComponent(fileName)
                if FileManager.default.fileExists(atPath: filePath.path) {
                    do {
                        try FileManager.default.removeItem(at: filePath)
                        NSLog("[FactoryReset][SQLite] Deleted from Documents: %@", fileName)
                        deletedCount += 1
                    } catch {
                        NSLog("[FactoryReset][SQLite] ERROR: Failed to delete from Documents %@: %@",
                              fileName, error.localizedDescription)
                        allSucceeded = false
                    }
                }
            }
            let documentsSqlitePath = documentsPath.appendingPathComponent("SQLite")
            for fileName in filesToDelete {
                let filePath = documentsSqlitePath.appendingPathComponent(fileName)
                if FileManager.default.fileExists(atPath: filePath.path) {
                    do {
                        try FileManager.default.removeItem(at: filePath)
                        NSLog("[FactoryReset][SQLite] Deleted from Documents/SQLite: %@", fileName)
                        deletedCount += 1
                    } catch {
                        NSLog("[FactoryReset][SQLite] ERROR: Failed to delete from Documents/SQLite %@: %@",
                              fileName, error.localizedDescription)
                        allSucceeded = false
                    }
                }
            }
            if FileManager.default.fileExists(atPath: documentsSqlitePath.path) {
                do {
                    let contents = try FileManager.default.contentsOfDirectory(atPath: documentsSqlitePath.path)
                    for item in contents {
                        let itemPath = documentsSqlitePath.appendingPathComponent(item)
                        do {
                            try FileManager.default.removeItem(at: itemPath)
                            NSLog("[FactoryReset][SQLite] Deleted from Documents/SQLite directory: %@", item)
                            deletedCount += 1
                        } catch {
                            NSLog("[FactoryReset][SQLite] ERROR: Failed to delete %@ from Documents/SQLite: %@",
                                  item, error.localizedDescription)
                            allSucceeded = false
                        }
                    }
                } catch {
                    NSLog("[FactoryReset][SQLite] ERROR: Failed to enumerate Documents/SQLite: %@",
                          error.localizedDescription)
                    allSucceeded = false
                }
            }
        } else {
            NSLog("[FactoryReset][SQLite] ERROR: Could not resolve Documents directory - wipe failed")
            allSucceeded = false
        }
        NSLog("[FactoryReset][SQLite] Wipe complete. Deleted: %d files, Success: %d",
              deletedCount, allSucceeded ? 1 : 0)
        return allSucceeded
    }
    /
    /
    /
    /
    /
    /
    @objc public static func wipeAsyncStorage() -> Bool {
        NSLog("[FactoryReset][AsyncStorage] Starting AsyncStorage wipe...")
        guard let documentsPath = FileManager.default.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first else {
            NSLog("[FactoryReset][AsyncStorage] ERROR: Could not get Documents directory")
            return false
        }
        var allSucceeded = true
        var deletedCount = 0
        let directories = [asyncStorageDirectory, asyncStorageDirectoryAlt]
        for dirName in directories {
            let dirPath = documentsPath.appendingPathComponent(dirName)
            if FileManager.default.fileExists(atPath: dirPath.path) {
                do {
                    try FileManager.default.removeItem(at: dirPath)
                    NSLog("[FactoryReset][AsyncStorage] Deleted directory: %@", dirName)
                    deletedCount += 1
                } catch {
                    NSLog("[FactoryReset][AsyncStorage] ERROR: Failed to delete %@: %@",
                          dirName, error.localizedDescription)
                    allSucceeded = false
                }
            } else {
                NSLog("[FactoryReset][AsyncStorage] Directory not found (OK): %@", dirName)
            }
        }
        if let appSupportPath = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first {
            for dirName in directories {
                let dirPath = appSupportPath.appendingPathComponent(dirName)
                if FileManager.default.fileExists(atPath: dirPath.path) {
                    do {
                        try FileManager.default.removeItem(at: dirPath)
                        NSLog("[FactoryReset][AsyncStorage] Deleted from App Support: %@", dirName)
                        deletedCount += 1
                    } catch {
                        NSLog("[FactoryReset][AsyncStorage] ERROR: Failed to delete from App Support %@: %@",
                              dirName, error.localizedDescription)
                        allSucceeded = false
                    }
                }
            }
        }
        NSLog("[FactoryReset][AsyncStorage] Wipe complete. Deleted: %d directories, Success: %d",
              deletedCount, allSucceeded ? 1 : 0)
        return allSucceeded
    }
    /
    /
    /
    /
    /
    @objc public static func wipeAllLocalStorage() -> Bool {
        let dbSuccess = wipeSQLiteDatabase()
        let asyncSuccess = wipeAsyncStorage()
        NSLog("[FactoryReset] All local storage wipe complete. DB: %d, AsyncStorage: %d",
              dbSuccess ? 1 : 0, asyncSuccess ? 1 : 0)
        return dbSuccess && asyncSuccess
    }
    /
    @objc static func requiresMainQueueSetup() -> Bool {
        return false
    }
    /
    /
    /
    /
    /
    /
    /
    /
    @objc func wipeSQLite(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        NSLog("[FactoryReset][RN] wipeSQLite called from JavaScript")
        let success = FactoryResetModule.wipeSQLiteDatabase()
        if success {
            resolve(["success": true])
        } else {
            reject(
                "SQLITE_WIPE_FAILED",
                "Failed to completely wipe SQLite database and sidecars",
                nil
            )
        }
    }
    /
    /
    /
    /
    /
    /
    /
    @objc func wipeAsyncStorageRN(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        NSLog("[FactoryReset][RN] wipeAsyncStorage called from JavaScript")
        let success = FactoryResetModule.wipeAsyncStorage()
        if success {
            resolve(["success": true])
        } else {
            reject(
                "ASYNC_STORAGE_WIPE_FAILED",
                "Failed to completely wipe AsyncStorage directory",
                nil
            )
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
    @objc func wipeAll(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        NSLog("[FactoryReset][RN] wipeAll called from JavaScript")
        let success = FactoryResetModule.wipeAllLocalStorage()
        if success {
            resolve(["success": true])
        } else {
            reject(
                "FACTORY_RESET_FAILED",
                "Failed to completely wipe local storage (SQLite and/or AsyncStorage)",
                nil
            )
        }
    }
}
