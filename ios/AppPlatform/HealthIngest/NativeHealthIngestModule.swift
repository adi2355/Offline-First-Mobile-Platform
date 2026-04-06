import Foundation
import React
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
@objc(NativeHealthIngest)
final class NativeHealthIngestModule: RCTEventEmitter {
    private let core = HealthIngestCore()
    private var hasListeners = false
    /
    /
    /
    private let credentialLock = NSLock()
    private var storedUserId: String?
    private var storedSourceId: String?
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
    private var sessionGeneration: Int = 0
    /
    /
    /
    override func supportedEvents() -> [String]! {
        return [
            "NativeHealthIngest_ColdProgress",
            "NativeHealthIngest_Error",
        ]
    }
    override func startObserving() {
        hasListeners = true
    }
    override func stopObserving() {
        hasListeners = false
    }
    /
    override static func requiresMainQueueSetup() -> Bool {
        return false
    }
    /
    /
    /
    /
    private func storeCredentials(userId: String, sourceId: String) {
        credentialLock.lock()
        defer { credentialLock.unlock() }
        storedUserId = userId
        storedSourceId = sourceId
        sessionGeneration += 1
    }
    /
    private func readCredentials() -> (userId: String, sourceId: String)? {
        credentialLock.lock()
        defer { credentialLock.unlock() }
        guard let userId = storedUserId, let sourceId = storedSourceId else {
            return nil
        }
        return (userId, sourceId)
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
    func initialize(
        _ config: NSDictionary,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        credentialLock.lock()
        sessionGeneration += 1
        credentialLock.unlock()
        core.onColdProgress = { [weak self] event in
            guard let self = self, self.hasListeners else { return }
            self.sendEvent(withName: "NativeHealthIngest_ColdProgress", body: event.toDictionary())
        }
        core.onError = { [weak self] code, message, metricCode in
            guard let self = self, self.hasListeners else { return }
            var body: [String: Any] = [
                "code": code.rawValue,
                "message": message,
            ]
            if let metricCode = metricCode {
                body["metricCode"] = metricCode
            }
            self.sendEvent(withName: "NativeHealthIngest_Error", body: body)
        }
        HealthKitObserver.shared.onBackgroundUpdate = { [weak self] sampleType, completionHandler in
            guard let self = self else {
                NSLog("[NativeHealthIngestModule] Background update but module deallocated")
                completionHandler()
                return
            }
            guard let credentials = self.readCredentials() else {
                NSLog("[NativeHealthIngestModule] Background update for %@ but no stored credentials (user not logged in yet). Skipping.", sampleType)
                completionHandler()
                return
            }
            NSLog("[NativeHealthIngestModule] Background delivery for %@, triggering change lane", sampleType)
            let completionCalled = AtomicBool(false)
            let backgroundBudgetSeconds: TimeInterval = 15.0
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + backgroundBudgetSeconds) {
                if !completionCalled.value {
                    completionCalled.value = true
                    self.core.cancelChangeLane()
                    NSLog("[NativeHealthIngestModule] Background change lane TIMED OUT after %.0fs for %@. Change lane cancelled. Calling completion.",
                          backgroundBudgetSeconds, sampleType)
                    completionHandler()
                }
            }
            self.core.executeChangeLane(
                userId: credentials.userId,
                sourceId: credentials.sourceId
            ) { result in
                if !completionCalled.value {
                    completionCalled.value = true
                    NSLog("[NativeHealthIngestModule] Background change lane complete: inserted=%d, success=%@, durationMs=%d",
                          result.samplesInserted, result.success ? "true" : "false", result.durationMs)
                    completionHandler()
                } else {
                    NSLog("[NativeHealthIngestModule] Background change lane callback after timeout (cancelled): inserted=%d, durationMs=%d",
                          result.samplesInserted, result.durationMs)
                }
            }
        }
        if let error = core.initialize(config: config) {
            reject(error.rawValue, "Initialization failed: \(error.rawValue)", nil)
        } else {
            resolve(true)
        }
    }
    /
    /
    /
    /
    /
    /
    @objc
    func ingestHot(
        _ userId: NSString,
        sourceId: NSString,
        metricCodes: NSArray,
        budgetMs: NSNumber,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        let userIdStr = userId as String
        let sourceIdStr = sourceId as String
        let codes = (metricCodes as? [String]) ?? []
        let budget = budgetMs.intValue
        storeCredentials(userId: userIdStr, sourceId: sourceIdStr)
        core.executeHotLane(
            userId: userIdStr,
            sourceId: sourceIdStr,
            metricCodes: codes,
            budgetMs: budget
        ) { result in
            DispatchQueue.main.async {
                resolve(result.toDictionary())
            }
        }
    }
    /
    /
    /
    /
    /
    /
    @objc
    func ingestCold(
        _ userId: NSString,
        sourceId: NSString,
        chunkBudgetMs: NSNumber,
        maxChunks: NSNumber,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        let userIdStr = userId as String
        let sourceIdStr = sourceId as String
        let budget = chunkBudgetMs.intValue
        let chunks = maxChunks.intValue
        storeCredentials(userId: userIdStr, sourceId: sourceIdStr)
        core.executeColdLane(
            userId: userIdStr,
            sourceId: sourceIdStr,
            chunkBudgetMs: budget,
            maxChunks: chunks
        ) { result in
            DispatchQueue.main.async {
                resolve(result.toDictionary())
            }
        }
    }
    /
    /
    /
    /
    /
    /
    @objc
    func ingestChanges(
        _ userId: NSString,
        sourceId: NSString,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        let userIdStr = userId as String
        let sourceIdStr = sourceId as String
        storeCredentials(userId: userIdStr, sourceId: sourceIdStr)
        core.executeChangeLane(
            userId: userIdStr,
            sourceId: sourceIdStr
        ) { result in
            DispatchQueue.main.async {
                resolve(result.toDictionary())
            }
        }
    }
    /
    /
    /
    /
    /
    /
    @objc
    func cancelHot() {
        core.cancelHotLane()
    }
    /
    /
    /
    /
    /
    @objc
    func cancelCold() {
        core.cancelColdLane()
    }
    /
    /
    /
    /
    /
    /
    @objc
    func cancelChanges() {
        core.cancelChangeLane()
    }
    /
    /
    /
    @objc
    func isHealthKitAvailable(
        _ resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        resolve(HealthKitQueries(healthStore: .init(), metricCatalog: [:]).isAvailable())
    }
    /
    /
    /
    @objc
    func getLaneStatuses(
        _ resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        resolve(core.getLaneStatuses())
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
    @objc
    func setBackgroundDeliveryEnabled(
        _ enabled: Bool,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        UserDefaults.standard.set(enabled, forKey: "healthBackgroundDeliveryEnabled")
        if enabled {
            HealthKitObserver.shared.registerDefaultObservers()
            NSLog("[NativeHealthIngestModule] Background delivery ENABLED: UserDefaults set + observers registered")
        } else {
            HealthKitObserver.shared.stopObservers()
            NSLog("[NativeHealthIngestModule] Background delivery DISABLED: UserDefaults set + observers stopped")
        }
        resolve(enabled)
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
    @objc
    func clearCredentialsAndStopDelivery(
        _ resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        credentialLock.lock()
        let generationAtDispatch = sessionGeneration
        let hadCredentials = storedUserId != nil
        credentialLock.unlock()
        credentialLock.lock()
        if sessionGeneration != generationAtDispatch {
            credentialLock.unlock()
            NSLog("[NativeHealthIngestModule] clearCredentialsAndStopDelivery SKIPPED: generation advanced %d → %d (new session started)",
                  generationAtDispatch, sessionGeneration)
            resolve(true)
            return
        }
        storedUserId = nil
        storedSourceId = nil
        credentialLock.unlock()
        HealthKitObserver.shared.stopObservers()
        UserDefaults.standard.set(false, forKey: "healthBackgroundDeliveryEnabled")
        HealthKitObserver.shared.onBackgroundUpdate = nil
        credentialLock.lock()
        let shouldDispose = sessionGeneration == generationAtDispatch
        credentialLock.unlock()
        if shouldDispose {
            core.dispose()
        } else {
            NSLog("[NativeHealthIngestModule] Skipping core.dispose(): generation advanced %d → %d during cleanup",
                  generationAtDispatch, sessionGeneration)
        }
        NSLog("[NativeHealthIngestModule] Credentials cleared, observers stopped, background delivery disabled (hadCredentials: %@, generation: %d)",
              hadCredentials ? "true" : "false", generationAtDispatch)
        resolve(true)
    }
}
