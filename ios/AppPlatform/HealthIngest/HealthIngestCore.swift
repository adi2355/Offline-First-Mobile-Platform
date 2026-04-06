import Foundation
import HealthKit
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
final class HealthIngestCore {
    private let sqlite: HealthIngestSQLite
    private let queries: HealthKitQueries
    private let healthStore: HKHealthStore
    private var metricCatalog: [String: NativeMetricConfig] = [:]
    private var laneConstants: LaneConstants?
    /
    let hotCancellationFlag = AtomicBool(false)
    /
    let coldCancellationFlag = AtomicBool(false)
    /
    /
    /
    /
    /
    /
    /
    /
    private var coldResumeIndex: Int = 0
    /
    let changeCancellationFlag = AtomicBool(false)
    private var activeHotQuery: HKQuery?
    private var activeColdQuery: HKQuery?
    private var activeChangeQuery: HKQuery?
    private let queryLock = NSLock()
    /
    private let hotQueue: OperationQueue
    private let coldQueue: OperationQueue
    private let changeQueue: OperationQueue
    /
    private var hotStatus = NativeLaneStatus()
    private var coldStatus = NativeLaneStatus()
    private var changeStatus = NativeLaneStatus()
    private let statusLock = NSLock()
    /
    var onColdProgress: ((ColdProgressEvent) -> Void)?
    /
    var onError: ((NativeErrorCode, String, String?) -> Void)?
    private var isInitialized = false
    init() {
        self.sqlite = HealthIngestSQLite()
        self.healthStore = HKHealthStore()
        self.queries = HealthKitQueries(healthStore: healthStore, metricCatalog: [:])
        hotQueue = OperationQueue()
        hotQueue.name = "com.appplatform.healthingest.hot"
        hotQueue.maxConcurrentOperationCount = 1
        hotQueue.qualityOfService = .userInitiated
        coldQueue = OperationQueue()
        coldQueue.name = "com.appplatform.healthingest.cold"
        coldQueue.maxConcurrentOperationCount = 1
        coldQueue.qualityOfService = .utility
        changeQueue = OperationQueue()
        changeQueue.name = "com.appplatform.healthingest.change"
        changeQueue.maxConcurrentOperationCount = 1
        changeQueue.qualityOfService = .default
    }
    /
    /
    /
    /
    /
    /
    func initialize(config: NSDictionary) -> NativeErrorCode? {
        guard !isInitialized else {
            return nil
        }
        guard let dbPath = config["dbPath"] as? String, !dbPath.isEmpty else {
            return .notInitialized
        }
        guard dbPath.contains("SQLite") else {
            NSLog("[HealthIngestCore] dbPath does not contain SQLite directory: %@", dbPath)
            return .sqliteOpenFailed
        }
        guard let constantsDict = config["laneConstants"] as? NSDictionary,
              let constants = LaneConstants.fromDictionary(constantsDict) else {
            NSLog("[HealthIngestCore] Failed to parse laneConstants")
            return .notInitialized
        }
        self.laneConstants = constants
        guard let metricsArray = config["metrics"] as? [NSDictionary] else {
            NSLog("[HealthIngestCore] Failed to parse metrics array")
            return .notInitialized
        }
        var catalog: [String: NativeMetricConfig] = [:]
        for metricDict in metricsArray {
            guard let metricConfig = NativeMetricConfig.fromDictionary(metricDict) else {
                NSLog("[HealthIngestCore] Failed to parse metric config: %@", metricDict)
                continue
            }
            guard metricConfig.resolveHKSampleType() != nil else {
                NSLog("[HealthIngestCore] Invalid HK identifier: %@", metricConfig.hkIdentifier)
                continue
            }
            catalog[metricConfig.metricCode] = metricConfig
        }
        if catalog.isEmpty {
            NSLog("[HealthIngestCore] No valid metrics in catalog")
            return .invalidMetricCode
        }
        self.metricCatalog = catalog
        if let error = sqlite.open(dbPath: dbPath, busyTimeoutMs: constants.busyTimeoutMs) {
            return error
        }
        isInitialized = true
        NSLog("[HealthIngestCore] Initialized with %d metrics", catalog.count)
        return nil
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
    func executeHotLane(
        userId: String,
        sourceId: String,
        metricCodes: [String],
        budgetMs: Int,
        completion: @escaping (NativeLaneResult) -> Void
    ) {
        precondition(isInitialized, "executeHotLane called before initialize()")
        guard isInitialized else {
            completion(.error(.notInitialized, message: "Module not initialized"))
            return
        }
        cancelColdLane()
        updateLaneStatus(\.hotStatus) { $0.running = true }
        hotQueue.addOperation { [weak self] in
            guard let self = self else { return }
            let startTime = DispatchTime.now()
            var result = NativeLaneResult.empty()
            let budget = budgetMs > 0 ? budgetMs : (self.laneConstants?.hotBudgetMs ?? 2000)
            let hotLookbackDays = self.laneConstants?.hotLookbackDays ?? 14
            let maxHotWindowMs = Int64(hotLookbackDays) * 24 * 60 * 60 * 1000
            let overlapMs = Int64(self.laneConstants?.hotOverlapMs ?? 300_000) 
            let nowDate = Date()
            let nowMs = Int64(nowDate.timeIntervalSince1970 * 1000)
            self.hotCancellationFlag.value = false
            let twoPassEnabled = self.laneConstants?.hotTwoPassEnabled ?? false
            let hotUiWindowMs = Int64(self.laneConstants?.hotUiWindowMs ?? 86_400_000)
            let hotCatchupChunkWindowMs = Int64(self.laneConstants?.hotCatchupChunkWindowMs ?? 21_600_000)
            let hotCatchupMaxChunksPerRun = self.laneConstants?.hotCatchupMaxChunksPerRun ?? 4
            let hotCatchupQueryLimit = self.laneConstants?.hotCatchupQueryLimit ?? 5_000
            for metricCode in metricCodes {
                if self.hotCancellationFlag.value {
                    result.partial = true
                    result.errors.append(IngestError(
                        code: .hotCancelled,
                        message: "Hot lane cancelled by bridge timeout",
                        metricCode: nil
                    ))
                    break
                }
                let elapsedMs = self.elapsedMs(since: startTime)
                if elapsedMs >= budget {
                    result.partial = true
                    result.errors.append(IngestError(
                        code: .budgetExceeded,
                        message: "Hot lane budget exceeded at \(elapsedMs)ms",
                        metricCode: metricCode
                    ))
                    break
                }
                guard let config = self.metricCatalog[metricCode] else {
                    result.errors.append(IngestError(
                        code: .invalidMetricCode,
                        message: "Unknown metric code: \(metricCode)",
                        metricCode: metricCode
                    ))
                    continue
                }
                let cursor = self.sqlite.readCursor(
                    userId: userId,
                    sourceId: sourceId,
                    sampleType: metricCode,
                    scope: .hotAnchor
                )
                if twoPassEnabled, let watermarkMs = cursor?.lastIngestTimestamp,
                   let gap = computeHotTwoPassGap(
                       watermarkMs: watermarkMs,
                       nowMs: nowMs,
                       overlapMs: overlapMs,
                       maxHotWindowMs: maxHotWindowMs,
                       hotUiWindowMs: hotUiWindowMs
                   ) {
                        var passAInserted = 0
                        var passASkipped = 0
                        var passBInserted = 0
                        var passBSkipped = 0
                        var metricNewestTs: Int64? = nil
                        var metricOldestTs: Int64? = nil
                        var twoPassHadFatalError = false
                        let passAStartDate = Date(timeIntervalSince1970: TimeInterval(gap.gapEnd) / 1000.0)
                        let semaphoreA = DispatchSemaphore(value: 0)
                        var passASamples: [HKSample] = []
                        var passAQueryError: Error?
                        let queryQueriesA = HealthKitQueries(
                            healthStore: self.healthStore,
                            metricCatalog: self.metricCatalog
                        )
                        let hkQueryA = queryQueriesA.queryRecentSamples(
                            metricCode: metricCode,
                            startDate: passAStartDate,
                            endDate: nowDate,
                            limit: max(1, self.laneConstants?.recentDataQueryLimit ?? 60000)
                        ) { queryResult in
                            switch queryResult {
                            case .success(let samples):
                                passASamples = samples
                            case .failure(let error):
                                passAQueryError = error
                            }
                            semaphoreA.signal()
                        }
                        self.storeActiveQuery(hkQueryA, lane: .hot)
                        let waitResultA = semaphoreA.wait(timeout: .now() + .seconds(QUERY_TIMEOUT_SECONDS))
                        self.clearActiveQuery(lane: .hot)
                        if waitResultA == .timedOut {
                            if let hkQueryA = hkQueryA { self.healthStore.stop(hkQueryA) }
                            result.errors.append(IngestError(
                                code: .queryTimeout,
                                message: "Hot Pass A timed out after \(QUERY_TIMEOUT_SECONDS)s for \(metricCode)",
                                metricCode: metricCode
                            ))
                            NSLog("[HealthIngestCore] HOT Pass A TIMED OUT for %@", metricCode)
                            twoPassHadFatalError = true
                        }
                        if let error = passAQueryError, !twoPassHadFatalError {
                            result.errors.append(IngestError(
                                code: .healthkitQueryFailed,
                                message: "Hot Pass A: \(error.localizedDescription)",
                                metricCode: metricCode
                            ))
                            twoPassHadFatalError = true
                        }
                        if !twoPassHadFatalError && !passASamples.isEmpty {
                            let normalizedA = HealthNormalization.normalizeBatch(
                                samples: passASamples,
                                config: config,
                                userId: userId,
                                sourceId: sourceId
                            )
                            if !normalizedA.isEmpty {
                                let (inserted, skipped, dbError) = self.sqlite.insertSamplesOnly(
                                    samples: normalizedA
                                )
                                if let dbError = dbError {
                                    result.errors.append(IngestError(
                                        code: dbError,
                                        message: "Hot Pass A SQLite error for \(metricCode)",
                                        metricCode: metricCode
                                    ))
                                    twoPassHadFatalError = true
                                } else {
                                    passAInserted = inserted
                                    passASkipped = skipped
                                    let timestamps = normalizedA.map { $0.startTimestamp }
                                    metricNewestTs = timestamps.max()
                                    metricOldestTs = timestamps.min()
                                }
                            }
                        }
                        NSLog("[HealthIngestCore] HOT Pass A for %@: queried=%d, inserted=%d, skipped=%d, error=%@",
                              metricCode, passASamples.count, passAInserted, passASkipped, String(describing: twoPassHadFatalError))
                        if !twoPassHadFatalError {
                            let catchupChunks = computeCatchupChunks(
                                gapStart: gap.gapStart,
                                gapEnd: gap.gapEnd,
                                chunkMs: hotCatchupChunkWindowMs,
                                maxChunks: hotCatchupMaxChunksPerRun
                            )
                            var chunksProcessed = 0
                            var currentPassBCursor = cursor
                            for chunk in catchupChunks {
                                if self.hotCancellationFlag.value {
                                    result.partial = true
                                    result.errors.append(IngestError(
                                        code: .hotCancelled,
                                        message: "Hot Pass B cancelled at chunk \(chunksProcessed + 1) for \(metricCode)",
                                        metricCode: metricCode
                                    ))
                                    break
                                }
                                let elapsedBMs = self.elapsedMs(since: startTime)
                                if elapsedBMs >= budget {
                                    result.partial = true
                                    result.errors.append(IngestError(
                                        code: .budgetExceeded,
                                        message: "Hot Pass B budget exceeded at \(elapsedBMs)ms for \(metricCode)",
                                        metricCode: metricCode
                                    ))
                                    break
                                }
                                let chunkStartMs = chunk.start
                                let chunkEndMs = chunk.end
                                let chunkStartDate = Date(timeIntervalSince1970: TimeInterval(chunkStartMs) / 1000.0)
                                let chunkEndDate = Date(timeIntervalSince1970: TimeInterval(chunkEndMs) / 1000.0)
                                let semaphoreB = DispatchSemaphore(value: 0)
                                var chunkSamples: [HKSample] = []
                                var chunkQueryError: Error?
                                let queryQueriesB = HealthKitQueries(
                                    healthStore: self.healthStore,
                                    metricCatalog: self.metricCatalog
                                )
                                let hkQueryB = queryQueriesB.queryColdChunk(
                                    metricCode: metricCode,
                                    chunkStartDate: chunkStartDate,
                                    chunkEndDate: chunkEndDate,
                                    limit: hotCatchupQueryLimit
                                ) { queryResult in
                                    switch queryResult {
                                    case .success(let samples):
                                        chunkSamples = samples
                                    case .failure(let error):
                                        chunkQueryError = error
                                    }
                                    semaphoreB.signal()
                                }
                                self.storeActiveQuery(hkQueryB, lane: .hot)
                                let waitResultB = semaphoreB.wait(timeout: .now() + .seconds(QUERY_TIMEOUT_SECONDS))
                                self.clearActiveQuery(lane: .hot)
                                if waitResultB == .timedOut {
                                    if let hkQueryB = hkQueryB { self.healthStore.stop(hkQueryB) }
                                    result.errors.append(IngestError(
                                        code: .queryTimeout,
                                        message: "Hot Pass B timed out for \(metricCode) chunk \(chunksProcessed + 1)",
                                        metricCode: metricCode
                                    ))
                                    NSLog("[HealthIngestCore] HOT Pass B TIMED OUT for %@ chunk %d",
                                          metricCode, chunksProcessed + 1)
                                    break
                                }
                                if let error = chunkQueryError {
                                    result.errors.append(IngestError(
                                        code: .healthkitQueryFailed,
                                        message: "Hot Pass B: \(error.localizedDescription)",
                                        metricCode: metricCode
                                    ))
                                    break
                                }
                                let normalizedB: [NormalizedHealthSample]
                                if !chunkSamples.isEmpty {
                                    normalizedB = HealthNormalization.normalizeBatch(
                                        samples: chunkSamples,
                                        config: config,
                                        userId: userId,
                                        sourceId: sourceId
                                    )
                                } else {
                                    normalizedB = []
                                }
                                let queryLimitHitB = chunkSamples.count >= hotCatchupQueryLimit
                                let watermarkAdvanceTo: Int64
                                if queryLimitHitB && !normalizedB.isEmpty {
                                    let maxSampleTs = normalizedB.map { $0.startTimestamp }.max() ?? chunkStartMs
                                    watermarkAdvanceTo = maxSampleTs
                                    NSLog("[HealthIngestCore] HOT Pass B: query limit hit for %@ chunk %d " +
                                          "(count=%d, limit=%d), watermark→%lld (not chunkEnd=%lld)",
                                          metricCode, chunksProcessed + 1,
                                          chunkSamples.count, hotCatchupQueryLimit,
                                          watermarkAdvanceTo, chunkEndMs)
                                } else {
                                    watermarkAdvanceTo = chunkEndMs
                                }
                                let expectedVersion = currentPassBCursor?.cursorVersion ?? 0
                                let newVersion = expectedVersion + 1
                                let (inserted, skipped, dbError) = self.sqlite.atomicInsertAndUpdateCursor(
                                    samples: normalizedB,
                                    cursor: currentPassBCursor,
                                    newAnchorData: nil,
                                    newVersion: newVersion,
                                    scope: .hotAnchor,
                                    lastIngestTimestampOverrideMs: watermarkAdvanceTo,
                                    explicitUserId: userId,
                                    explicitSourceId: sourceId,
                                    explicitSampleType: metricCode
                                )
                                if let dbError = dbError {
                                    result.errors.append(IngestError(
                                        code: dbError,
                                        message: "Hot Pass B SQLite error for \(metricCode) chunk \(chunksProcessed + 1)",
                                        metricCode: metricCode
                                    ))
                                    break
                                }
                                passBInserted += inserted
                                passBSkipped += skipped
                                chunksProcessed += 1
                                let chunkTimestamps = normalizedB.map { $0.startTimestamp }
                                if let chunkNewest = chunkTimestamps.max() {
                                    metricNewestTs = max(metricNewestTs ?? Int64.min, chunkNewest)
                                }
                                if let chunkOldest = chunkTimestamps.min() {
                                    metricOldestTs = min(metricOldestTs ?? Int64.max, chunkOldest)
                                }
                                currentPassBCursor = self.sqlite.readCursor(
                                    userId: userId,
                                    sourceId: sourceId,
                                    sampleType: metricCode,
                                    scope: .hotAnchor
                                )
                                if queryLimitHitB {
                                    NSLog("[HealthIngestCore] HOT Pass B: breaking chunk loop after limit hit for %@ " +
                                          "(processed=%d, total=%d, watermark→%lld)",
                                          metricCode, chunksProcessed, catchupChunks.count, watermarkAdvanceTo)
                                    break
                                }
                            }
                            let gapFullyCovered = chunksProcessed == catchupChunks.count
                            if gapFullyCovered {
                                let expectedVersion = currentPassBCursor?.cursorVersion ?? 0
                                let newVersion = expectedVersion + 1
                                let (_, _, finalError) = self.sqlite.atomicInsertAndUpdateCursor(
                                    samples: [],
                                    cursor: currentPassBCursor,
                                    newAnchorData: nil,
                                    newVersion: newVersion,
                                    scope: .hotAnchor,
                                    lastIngestTimestampOverrideMs: nowMs,
                                    explicitUserId: userId,
                                    explicitSourceId: sourceId,
                                    explicitSampleType: metricCode
                                )
                                if let error = finalError {
                                    NSLog("[HealthIngestCore] Hot two-pass: final watermark advance failed for %@: %@",
                                          metricCode, error.rawValue)
                                } else {
                                    NSLog("[HealthIngestCore] Hot two-pass: gap fully covered for %@, watermark advanced to now",
                                          metricCode)
                                }
                            }
                            NSLog("[HealthIngestCore] HOT Pass B for %@: chunks=%d/%d, inserted=%d, skipped=%d, gapCovered=%@",
                                  metricCode, chunksProcessed, catchupChunks.count, passBInserted, passBSkipped,
                                  String(gapFullyCovered))
                        }
                        result.samplesInserted += passAInserted + passBInserted
                        result.samplesSkipped += passASkipped + passBSkipped
                        if !twoPassHadFatalError {
                            result.metricsProcessed.append(metricCode)
                        }
                        result.metricDiagnostics.append(MetricDiagnostic(
                            metricCode: metricCode,
                            newestSampleTimestampMs: metricNewestTs,
                            oldestSampleTimestampMs: metricOldestTs,
                            samplesInserted: passAInserted + passBInserted,
                            samplesSkipped: passASkipped + passBSkipped
                        ))
                        continue
                }
                let startMs: Int64
                if let watermark = cursor?.lastIngestTimestamp {
                    startMs = max(watermark - overlapMs, nowMs - maxHotWindowMs)
                } else {
                    startMs = nowMs - maxHotWindowMs
                }
                let perMetricStartDate = Date(timeIntervalSince1970: TimeInterval(startMs) / 1000.0)
                let semaphore = DispatchSemaphore(value: 0)
                var queriedSamples: [HKSample] = []
                var queryError: Error?
                let queryQueries = HealthKitQueries(
                    healthStore: self.healthStore,
                    metricCatalog: self.metricCatalog
                )
                let hkQuery = queryQueries.queryRecentSamples(
                    metricCode: metricCode,
                    startDate: perMetricStartDate,
                    endDate: nowDate,
                    limit: max(1, self.laneConstants?.recentDataQueryLimit ?? 60000)
                ) { queryResult in
                    switch queryResult {
                    case .success(let samples):
                        queriedSamples = samples
                    case .failure(let error):
                        queryError = error
                    }
                    semaphore.signal()
                }
                self.storeActiveQuery(hkQuery, lane: .hot)
                let waitResult = semaphore.wait(timeout: .now() + .seconds(QUERY_TIMEOUT_SECONDS))
                self.clearActiveQuery(lane: .hot)
                if waitResult == .timedOut {
                    if let hkQuery = hkQuery {
                        self.healthStore.stop(hkQuery)
                    }
                    result.errors.append(IngestError(
                        code: .queryTimeout,
                        message: "Hot lane query timed out after \(QUERY_TIMEOUT_SECONDS)s for \(metricCode)",
                        metricCode: metricCode
                    ))
                    NSLog("[HealthIngestCore] HOT query TIMED OUT after %ds for %@", QUERY_TIMEOUT_SECONDS, metricCode)
                    continue
                }
                if let error = queryError {
                    result.errors.append(IngestError(
                        code: .healthkitQueryFailed,
                        message: error.localizedDescription,
                        metricCode: metricCode
                    ))
                    continue
                }
                if queriedSamples.isEmpty {
                    let expectedVersion = cursor?.cursorVersion ?? 0
                    let newVersion = expectedVersion + 1
                    let (_, _, advanceError) = self.sqlite.atomicInsertAndUpdateCursor(
                        samples: [],
                        cursor: cursor,
                        newAnchorData: nil,
                        newVersion: newVersion,
                        scope: .hotAnchor,
                        explicitUserId: userId,
                        explicitSourceId: sourceId,
                        explicitSampleType: metricCode
                    )
                    if let error = advanceError {
                        NSLog("[HealthIngestCore] Hot lane: watermark advance failed for %@ (empty results): %@",
                              metricCode, error.rawValue)
                    }
                    result.metricsProcessed.append(metricCode)
                    result.metricDiagnostics.append(MetricDiagnostic(
                        metricCode: metricCode,
                        newestSampleTimestampMs: nil,
                        oldestSampleTimestampMs: nil,
                        samplesInserted: 0,
                        samplesSkipped: 0
                    ))
                    continue
                }
                let normalized = HealthNormalization.normalizeBatch(
                    samples: queriedSamples,
                    config: config,
                    userId: userId,
                    sourceId: sourceId
                )
                if normalized.isEmpty {
                    let expectedVersion = cursor?.cursorVersion ?? 0
                    let newVersion = expectedVersion + 1
                    let (_, _, advanceError) = self.sqlite.atomicInsertAndUpdateCursor(
                        samples: [],
                        cursor: cursor,
                        newAnchorData: nil,
                        newVersion: newVersion,
                        scope: .hotAnchor,
                        explicitUserId: userId,
                        explicitSourceId: sourceId,
                        explicitSampleType: metricCode
                    )
                    if let error = advanceError {
                        NSLog("[HealthIngestCore] Hot lane: watermark advance failed for %@ (normalized empty): %@",
                              metricCode, error.rawValue)
                    }
                    result.metricsProcessed.append(metricCode)
                    result.metricDiagnostics.append(MetricDiagnostic(
                        metricCode: metricCode,
                        newestSampleTimestampMs: nil,
                        oldestSampleTimestampMs: nil,
                        samplesInserted: 0,
                        samplesSkipped: 0
                    ))
                    continue
                }
                let expectedVersion = cursor?.cursorVersion ?? 0
                let newVersion = expectedVersion + 1
                let (inserted, skipped, dbError) = self.sqlite.atomicInsertAndUpdateCursor(
                    samples: normalized,
                    cursor: cursor,
                    newAnchorData: nil, 
                    newVersion: newVersion,
                    scope: .hotAnchor
                )
                if let dbError = dbError {
                    result.errors.append(IngestError(
                        code: dbError,
                        message: "SQLite error for \(metricCode)",
                        metricCode: metricCode
                    ))
                    continue
                }
                let timestamps = normalized.map { $0.startTimestamp }
                let newestTs = timestamps.max()
                let oldestTs = timestamps.min()
                result.samplesInserted += inserted
                result.samplesSkipped += skipped
                result.metricsProcessed.append(metricCode)
                result.metricDiagnostics.append(MetricDiagnostic(
                    metricCode: metricCode,
                    newestSampleTimestampMs: newestTs,
                    oldestSampleTimestampMs: oldestTs,
                    samplesInserted: inserted,
                    samplesSkipped: skipped
                ))
            }
            result.durationMs = Int(self.elapsedMs(since: startTime))
            result.success = result.errors.filter { $0.code != .budgetExceeded && $0.code != .hotCancelled }.isEmpty
            assert(!result.success || result.errors.filter({
                $0.code != .budgetExceeded && $0.code != .hotCancelled
            }).isEmpty, "success=true but non-benign errors present in hot lane")
            self.updateLaneStatus(\.hotStatus) { status in
                status.running = false
                if result.success {
                    status.lastCompletedAt = Int64(Date().timeIntervalSince1970 * 1000)
                    status.consecutiveFailures = 0
                    status.lastErrorCode = nil
                } else {
                    status.lastFailedAt = Int64(Date().timeIntervalSince1970 * 1000)
                    status.consecutiveFailures += 1
                    status.lastErrorCode = result.errors.first?.code
                }
            }
            completion(result)
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
    func executeColdLane(
        userId: String,
        sourceId: String,
        chunkBudgetMs: Int,
        maxChunks: Int,
        completion: @escaping (NativeLaneResult) -> Void
    ) {
        guard isInitialized else {
            completion(.error(.notInitialized, message: "Module not initialized"))
            return
        }
        coldCancellationFlag.value = false
        updateLaneStatus(\.coldStatus) { $0.running = true; $0.paused = false }
        coldQueue.addOperation { [weak self] in
            guard let self = self else { return }
            let startTime = DispatchTime.now()
            var result = NativeLaneResult.empty()
            let backfillDays = self.laneConstants?.coldBackfillDays ?? 90
            let graceWindowDays = self.laneConstants?.coldGraceWindowDays ?? 0
            let effectiveBackfillDays = backfillDays + graceWindowDays
            let chunkLimit = self.laneConstants?.coldQueryLimitPerChunk ?? 5_000
            var chunksProcessed = 0
            let effectiveMaxChunks = maxChunks > 0
                ? maxChunks
                : (self.laneConstants?.coldMaxChunks ?? 10)
            let totalLaneBudgetMs: Int
            if chunkBudgetMs > 0 {
                totalLaneBudgetMs = chunkBudgetMs * effectiveMaxChunks
            } else {
                totalLaneBudgetMs = 0 
            }
            var totalInserted = 0
            var oldestTimestampReached: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
            var coldCursorsAdvanced = 0
            let effectiveBackfillMs = Int64(effectiveBackfillDays) * 86_400_000
            let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
            let maxInnerIterations = 50
            var budgetExhausted = false
            let sortedMetrics = self.metricCatalog.sorted(by: { $0.key < $1.key })
            let effectiveStartIndex: Int
            if sortedMetrics.count > 0 {
                effectiveStartIndex = self.coldResumeIndex % sortedMetrics.count
            } else {
                effectiveStartIndex = 0
            }
            let rotatedMetrics: [(key: String, value: NativeMetricConfig)]
            if effectiveStartIndex > 0 {
                rotatedMetrics = Array(sortedMetrics[effectiveStartIndex...]) + Array(sortedMetrics[..<effectiveStartIndex])
            } else {
                rotatedMetrics = sortedMetrics
            }
            var remainingChunkBudget = effectiveMaxChunks
            var remainingMetricCount = rotatedMetrics.count
            var perMetricChunksUsed: [String: Int] = [:]
            var lastChunkedRotatedIndex: Int = -1
            for (ri, entry) in rotatedMetrics.enumerated() {
                let (metricCode, config) = entry
                remainingMetricCount -= 1
                if self.coldCancellationFlag.value {
                    result.partial = true
                    result.errors.append(IngestError(
                        code: .coldCancelled,
                        message: "Cold lane cancelled by hot preemption",
                        metricCode: nil
                    ))
                    break
                }
                if totalLaneBudgetMs > 0 && self.elapsedMs(since: startTime) >= totalLaneBudgetMs {
                    result.partial = true
                    result.errors.append(IngestError(
                        code: .budgetExceeded,
                        message: "Cold lane total budget exceeded at \(self.elapsedMs(since: startTime))ms (budget: \(totalLaneBudgetMs)ms = \(chunkBudgetMs)ms × \(effectiveMaxChunks) chunks)",
                        metricCode: metricCode
                    ))
                    budgetExhausted = true
                    break
                }
                var currentCursor = self.sqlite.readCursor(
                    userId: userId,
                    sourceId: sourceId,
                    sampleType: metricCode,
                    scope: .coldTime
                )
                var coldBackfillStartTs: Int64
                if let cursor = currentCursor,
                   let existingStartTs = cursor.coldBackfillStartTs {
                    let endTs = cursor.coldBackfillEndTs ?? nowMs
                    if existingStartTs < endTs - 86_400_000 {
                        coldBackfillStartTs = existingStartTs + effectiveBackfillMs
                        NSLog("[HealthIngestCore] Cold cursor migration for %@: old startTs=%lld → new startTs=%lld (ref semantic)",
                              metricCode, existingStartTs, coldBackfillStartTs)
                    } else {
                        coldBackfillStartTs = existingStartTs
                    }
                } else {
                    coldBackfillStartTs = nowMs
                }
                let coldBoundaryMs = coldBackfillStartTs - effectiveBackfillMs
                var chunkEndMs = currentCursor?.coldBackfillEndTs ?? nowMs
                if chunkEndMs <= coldBoundaryMs {
                    result.metricsProcessed.append(metricCode)
                    result.metricDiagnostics.append(MetricDiagnostic(
                        metricCode: metricCode,
                        newestSampleTimestampMs: nil,
                        oldestSampleTimestampMs: nil,
                        samplesInserted: 0,
                        samplesSkipped: 0
                    ))
                    continue
                }
                var metricNewestTs: Int64? = nil
                var metricOldestTs: Int64? = nil
                var metricInserted = 0
                var metricSkipped = 0
                let chunkDurationMs: Int64 = Int64(self.laneConstants?.coldChunkWindowMs ?? 604_800_000)
                var chunkStartMs = max(chunkEndMs - chunkDurationMs, coldBoundaryMs)
                let windowStartMs = chunkStartMs
                var innerIteration = 0
                var metricHadError = false
                while innerIteration < maxInnerIterations {
                    innerIteration += 1
                    if self.coldCancellationFlag.value {
                        result.partial = true
                        result.errors.append(IngestError(
                            code: .coldCancelled,
                            message: "Cold lane cancelled by hot preemption during pagination",
                            metricCode: metricCode
                        ))
                        budgetExhausted = true 
                        break
                    }
                    if totalLaneBudgetMs > 0 && self.elapsedMs(since: startTime) >= totalLaneBudgetMs {
                        result.partial = true
                        result.errors.append(IngestError(
                            code: .budgetExceeded,
                            message: "Cold lane total budget exceeded during pagination at \(self.elapsedMs(since: startTime))ms (budget: \(totalLaneBudgetMs)ms)",
                            metricCode: metricCode
                        ))
                        budgetExhausted = true
                        break
                    }
                    let chunkStartDate = Date(timeIntervalSince1970: TimeInterval(chunkStartMs) / 1000.0)
                    let chunkEndDate = Date(timeIntervalSince1970: TimeInterval(chunkEndMs) / 1000.0)
                    let semaphore = DispatchSemaphore(value: 0)
                    var queriedSamples: [HKSample] = []
                    var queryError: Error?
                    let queryQueries = HealthKitQueries(
                        healthStore: self.healthStore,
                        metricCatalog: self.metricCatalog
                    )
                    let hkQuery = queryQueries.queryColdChunk(
                        metricCode: metricCode,
                        chunkStartDate: chunkStartDate,
                        chunkEndDate: chunkEndDate,
                        limit: chunkLimit
                    ) { queryResult in
                        switch queryResult {
                        case .success(let samples):
                            queriedSamples = samples
                        case .failure(let error):
                            queryError = error
                        }
                        semaphore.signal()
                    }
                    self.storeActiveQuery(hkQuery, lane: .cold)
                    let waitResult = semaphore.wait(timeout: .now() + .seconds(QUERY_TIMEOUT_SECONDS))
                    self.clearActiveQuery(lane: .cold)
                    if waitResult == .timedOut {
                        if let hkQuery = hkQuery {
                            self.healthStore.stop(hkQuery)
                        }
                        result.partial = true
                        result.errors.append(IngestError(
                            code: .queryTimeout,
                            message: "Cold lane query timed out after \(QUERY_TIMEOUT_SECONDS)s for \(metricCode)",
                            metricCode: metricCode
                        ))
                        NSLog("[HealthIngestCore] COLD query TIMED OUT after %ds for %@", QUERY_TIMEOUT_SECONDS, metricCode)
                        budgetExhausted = true
                        break
                    }
                    if let error = queryError {
                        result.errors.append(IngestError(
                            code: .healthkitQueryFailed,
                            message: error.localizedDescription,
                            metricCode: metricCode
                        ))
                        metricHadError = true
                        break
                    }
                    if queriedSamples.isEmpty {
                        let expectedVersion = currentCursor?.cursorVersion ?? 0
                        let newVersion = expectedVersion + 1
                        let (_, _, advanceError) = self.sqlite.atomicInsertAndUpdateCursor(
                            samples: [],
                            cursor: currentCursor,
                            newAnchorData: nil,
                            newVersion: newVersion,
                            scope: .coldTime,
                            coldBackfillEndTs: windowStartMs,
                            coldBackfillStartTs: coldBackfillStartTs,
                            explicitUserId: userId,
                            explicitSourceId: sourceId,
                            explicitSampleType: metricCode
                        )
                        if let error = advanceError {
                            result.errors.append(IngestError(
                                code: error,
                                message: "Failed to advance cold cursor past empty window for \(metricCode)",
                                metricCode: metricCode
                            ))
                            metricHadError = true
                        } else {
                            coldCursorsAdvanced += 1
                            NSLog("[HealthIngestCore] Cold lane: advanced cursor past empty window for %@ (windowStartMs=%lld, coldCursorsAdvanced=%d)",
                                  metricCode, windowStartMs, coldCursorsAdvanced)
                            currentCursor = self.sqlite.readCursor(
                                userId: userId,
                                sourceId: sourceId,
                                sampleType: metricCode,
                                scope: .coldTime
                            )
                        }
                        break
                    }
                    let normalized = HealthNormalization.normalizeBatch(
                        samples: queriedSamples,
                        config: config,
                        userId: userId,
                        sourceId: sourceId
                    )
                    let expectedVersion = currentCursor?.cursorVersion ?? 0
                    let newVersion = expectedVersion + 1
                    var isFinalPage = queriedSamples.count < chunkLimit
                    if !isFinalPage, let lastSample = queriedSamples.last {
                        let lastStartMs = Int64(lastSample.startDate.timeIntervalSince1970 * 1000)
                        let nextChunkStartMs = (lastStartMs == chunkStartMs)
                            ? lastStartMs + 1  
                            : lastStartMs       
                        if nextChunkStartMs >= chunkEndMs {
                            isFinalPage = true 
                        }
                    }
                    let coldBackfillEndTsForInsert: Int64? = isFinalPage ? windowStartMs : nil
                    let (inserted, skipped, dbError) = self.sqlite.atomicInsertAndUpdateCursor(
                        samples: normalized,
                        cursor: currentCursor,
                        newAnchorData: nil,
                        newVersion: newVersion,
                        scope: .coldTime,
                        coldBackfillEndTs: coldBackfillEndTsForInsert, 
                        coldBackfillStartTs: coldBackfillStartTs
                    )
                    if let dbError = dbError {
                        result.errors.append(IngestError(
                            code: dbError,
                            message: "SQLite error for \(metricCode)",
                            metricCode: metricCode
                        ))
                        metricHadError = true
                        break
                    }
                    if coldBackfillEndTsForInsert != nil {
                        coldCursorsAdvanced += 1
                    }
                    totalInserted += inserted
                    result.samplesInserted += inserted
                    result.samplesSkipped += skipped
                    chunksProcessed += 1
                    perMetricChunksUsed[metricCode, default: 0] += 1
                    lastChunkedRotatedIndex = ri
                    metricInserted += inserted
                    metricSkipped += skipped
                    let pageTimestamps = normalized.map { $0.startTimestamp }
                    if let pageNewest = pageTimestamps.max() {
                        metricNewestTs = max(metricNewestTs ?? Int64.min, pageNewest)
                    }
                    if let pageOldest = pageTimestamps.min() {
                        metricOldestTs = min(metricOldestTs ?? Int64.max, pageOldest)
                    }
                    if windowStartMs < oldestTimestampReached {
                        oldestTimestampReached = windowStartMs
                    }
                    self.onColdProgress?(ColdProgressEvent(
                        chunksProcessed: chunksProcessed,
                        estimatedTotalChunks: self.metricCatalog.count * maxInnerIterations, 
                        totalSamplesInserted: totalInserted,
                        oldestTimestampReached: oldestTimestampReached,
                        isRunning: true
                    ))
                    if chunksProcessed >= effectiveMaxChunks {
                        result.partial = true
                        budgetExhausted = true
                        break
                    }
                    if queriedSamples.count < chunkLimit {
                        break
                    }
                    if let lastSample = queriedSamples.last {
                        let lastStartMs = Int64(lastSample.startDate.timeIntervalSince1970 * 1000)
                        let boundaryExhausted = (lastStartMs == chunkStartMs)
                        let newChunkStartMs = boundaryExhausted
                            ? lastStartMs + 1  
                            : lastStartMs       
                        if newChunkStartMs >= chunkEndMs {
                            break
                        }
                        chunkStartMs = newChunkStartMs
                    } else {
                        break
                    }
                    currentCursor = self.sqlite.readCursor(
                        userId: userId,
                        sourceId: sourceId,
                        sampleType: metricCode,
                        scope: .coldTime
                    )
                }
                if !metricHadError {
                    result.metricsProcessed.append(metricCode)
                }
                let chunksUsedByMetric = perMetricChunksUsed[metricCode] ?? 0
                remainingChunkBudget -= chunksUsedByMetric
                result.metricDiagnostics.append(MetricDiagnostic(
                    metricCode: metricCode,
                    newestSampleTimestampMs: metricNewestTs,
                    oldestSampleTimestampMs: metricOldestTs,
                    samplesInserted: metricInserted,
                    samplesSkipped: metricSkipped
                ))
                if budgetExhausted {
                    break
                }
            }
            if lastChunkedRotatedIndex >= 0 && !sortedMetrics.isEmpty {
                let originalIndex = (effectiveStartIndex + lastChunkedRotatedIndex + 1) % sortedMetrics.count
                self.coldResumeIndex = originalIndex
            }
            result.durationMs = Int(self.elapsedMs(since: startTime))
            result.coldCursorsAdvanced = coldCursorsAdvanced
            result.success = result.errors.filter { $0.code != .coldCancelled && $0.code != .budgetExceeded }.isEmpty
            assert(!result.success || result.errors.filter({
                $0.code != .coldCancelled && $0.code != .budgetExceeded
            }).isEmpty, "success=true but non-benign errors present in cold lane")
            self.onColdProgress?(ColdProgressEvent(
                chunksProcessed: chunksProcessed,
                estimatedTotalChunks: self.metricCatalog.count,
                totalSamplesInserted: totalInserted,
                oldestTimestampReached: oldestTimestampReached,
                isRunning: false
            ))
            self.updateLaneStatus(\.coldStatus) { status in
                status.running = false
                status.paused = false
                if result.success {
                    status.lastCompletedAt = Int64(Date().timeIntervalSince1970 * 1000)
                    status.consecutiveFailures = 0
                } else {
                    status.lastFailedAt = Int64(Date().timeIntervalSince1970 * 1000)
                    status.consecutiveFailures += 1
                    status.lastErrorCode = result.errors.first?.code
                }
            }
            completion(result)
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
    func executeChangeLane(
        userId: String,
        sourceId: String,
        completion: @escaping (NativeLaneResult) -> Void
    ) {
        guard isInitialized else {
            completion(.error(.notInitialized, message: "Module not initialized"))
            return
        }
        updateLaneStatus(\.changeStatus) { $0.running = true }
        changeCancellationFlag.value = false
        changeQueue.addOperation { [weak self] in
            guard let self = self else { return }
            let startTime = DispatchTime.now()
            var result = NativeLaneResult.empty()
            let maxChangeIterations = 20
            let changeLimit = self.laneConstants?.maxSamplesPerChunk ?? 200
            var changeCancelled = false
            for (metricCode, config) in self.metricCatalog {
                if self.changeCancellationFlag.value {
                    result.partial = true
                    result.errors.append(IngestError(
                        code: .changeCancelled,
                        message: "Change lane cancelled",
                        metricCode: nil
                    ))
                    changeCancelled = true
                    break
                }
                var currentCursor = self.sqlite.readCursor(
                    userId: userId,
                    sourceId: sourceId,
                    sampleType: metricCode,
                    scope: .changeAnchor
                )
                var currentAnchorData = currentCursor?.anchorData
                var metricNewestTs: Int64? = nil
                var metricOldestTs: Int64? = nil
                var metricInserted = 0
                var metricSkipped = 0
                var changeIteration = 0
                var metricHadError = false
                while changeIteration < maxChangeIterations {
                    changeIteration += 1
                    if self.changeCancellationFlag.value {
                        result.partial = true
                        result.errors.append(IngestError(
                            code: .changeCancelled,
                            message: "Change lane cancelled during iteration \(changeIteration) for \(metricCode)",
                            metricCode: metricCode
                        ))
                        changeCancelled = true
                        break
                    }
                    let semaphore = DispatchSemaphore(value: 0)
                    var changeResult: ChangeQueryResult?
                    var queryError: Error?
                    let queryQueries = HealthKitQueries(
                        healthStore: self.healthStore,
                        metricCatalog: self.metricCatalog
                    )
                    let hkQuery = queryQueries.queryChanges(
                        metricCode: metricCode,
                        anchorData: currentAnchorData,
                        limit: changeLimit
                    ) { queryResult in
                        switch queryResult {
                        case .success(let result):
                            changeResult = result
                        case .failure(let error):
                            queryError = error
                        }
                        semaphore.signal()
                    }
                    self.storeActiveQuery(hkQuery, lane: .change)
                    let waitResult = semaphore.wait(timeout: .now() + .seconds(QUERY_TIMEOUT_SECONDS))
                    self.clearActiveQuery(lane: .change)
                    if waitResult == .timedOut {
                        if let hkQuery = hkQuery {
                            self.healthStore.stop(hkQuery)
                        }
                        result.errors.append(IngestError(
                            code: .queryTimeout,
                            message: "Change lane query timed out after \(QUERY_TIMEOUT_SECONDS)s for \(metricCode)",
                            metricCode: metricCode
                        ))
                        NSLog("[HealthIngestCore] CHANGE query TIMED OUT after %ds for %@", QUERY_TIMEOUT_SECONDS, metricCode)
                        metricHadError = true
                        break
                    }
                    if let error = queryError {
                        result.errors.append(IngestError(
                            code: .healthkitQueryFailed,
                            message: error.localizedDescription,
                            metricCode: metricCode
                        ))
                        metricHadError = true
                        break
                    }
                    guard let changes = changeResult else { break }
                    if !changes.deletedUUIDs.isEmpty {
                        let deletionIds: [String]
                        if metricCode == "sleep_stage" {
                            deletionIds = HealthNormalization.expandSleepStageDeletionIds(changes.deletedUUIDs)
                        } else {
                            deletionIds = changes.deletedUUIDs
                        }
                        let foundTimestamps = self.sqlite.lookupStartTimestamps(
                            userId: userId,
                            sourceId: sourceId,
                            sourceRecordIds: deletionIds
                        )
                        let startTimestamps: [Int64?] = deletionIds.map { uuid in
                            foundTimestamps[uuid] 
                        }
                        let preciseModeCount = startTimestamps.compactMap { $0 }.count
                        let losslessModeCount = startTimestamps.count - preciseModeCount
                        if losslessModeCount > 0 {
                            NSLog("[HealthIngestCore] Change lane deletions: %d precise, %d lossless (for %@)",
                                  preciseModeCount, losslessModeCount, metricCode)
                        }
                        let (deletedCount, deleteError) = self.sqlite.softDeleteAndEnqueue(
                            userId: userId,
                            sourceId: sourceId,
                            sourceRecordIds: deletionIds,
                            startTimestamps: startTimestamps
                        )
                        if let deleteError = deleteError {
                            result.errors.append(IngestError(
                                code: deleteError,
                                message: "Soft delete failed for \(metricCode); anchor NOT advanced to prevent deletion loss",
                                metricCode: metricCode
                            ))
                            NSLog("[HealthIngestCore] Change lane deletion FAILED for %@: anchor NOT advanced (fail-fast). Next run will retry.", metricCode)
                            metricHadError = true
                            break
                        }
                        NSLog("[HealthIngestCore] Change lane: %d deletions processed for %@ (anchor not yet advanced)",
                              deletedCount, metricCode)
                    }
                    var anchorPersistedSuccessfully = false
                    if !changes.addedSamples.isEmpty {
                        let normalized = HealthNormalization.normalizeBatch(
                            samples: changes.addedSamples,
                            config: config,
                            userId: userId,
                            sourceId: sourceId
                        )
                        if !normalized.isEmpty {
                            let expectedVersion = currentCursor?.cursorVersion ?? 0
                            let newVersion = expectedVersion + 1
                            let (inserted, skipped, dbError) = self.sqlite.atomicInsertAndUpdateCursor(
                                samples: normalized,
                                cursor: currentCursor,
                                newAnchorData: changes.serializedAnchor,
                                newVersion: newVersion,
                                scope: .changeAnchor
                            )
                            if let dbError = dbError {
                                result.errors.append(IngestError(
                                    code: dbError,
                                    message: "SQLite error for \(metricCode)",
                                    metricCode: metricCode
                                ))
                                metricHadError = true
                                break
                            }
                            result.samplesInserted += inserted
                            result.samplesSkipped += skipped
                            anchorPersistedSuccessfully = true
                            metricInserted += inserted
                            metricSkipped += skipped
                            let addTimestamps = normalized.map { $0.startTimestamp }
                            if let pageNewest = addTimestamps.max() {
                                metricNewestTs = max(metricNewestTs ?? Int64.min, pageNewest)
                            }
                            if let pageOldest = addTimestamps.min() {
                                metricOldestTs = min(metricOldestTs ?? Int64.max, pageOldest)
                            }
                        } else if let newAnchor = changes.serializedAnchor {
                            let expectedVersion = currentCursor?.cursorVersion ?? 0
                            let newVersion = expectedVersion + 1
                            let (_, _, anchorError) = self.sqlite.atomicInsertAndUpdateCursor(
                                samples: [],
                                cursor: currentCursor,
                                newAnchorData: newAnchor,
                                newVersion: newVersion,
                                scope: .changeAnchor,
                                explicitUserId: userId,
                                explicitSourceId: sourceId,
                                explicitSampleType: metricCode
                            )
                            if let anchorError = anchorError {
                                result.errors.append(IngestError(
                                    code: anchorError,
                                    message: "Anchor-only update failed for \(metricCode) (additions filtered by normalization)",
                                    metricCode: metricCode
                                ))
                                NSLog("[HealthIngestCore] Change lane: anchor-only update FAILED for %@ (additions filtered). Next run will retry.", metricCode)
                                metricHadError = true
                                break
                            }
                            anchorPersistedSuccessfully = true
                        }
                    } else if let newAnchor = changes.serializedAnchor {
                        let expectedVersion = currentCursor?.cursorVersion ?? 0
                        let newVersion = expectedVersion + 1
                        let (_, _, anchorError) = self.sqlite.atomicInsertAndUpdateCursor(
                            samples: [],
                            cursor: currentCursor,
                            newAnchorData: newAnchor,
                            newVersion: newVersion,
                            scope: .changeAnchor,
                            explicitUserId: userId,
                            explicitSourceId: sourceId,
                            explicitSampleType: metricCode
                        )
                        if let anchorError = anchorError {
                            result.errors.append(IngestError(
                                code: anchorError,
                                message: "Anchor-only update failed for \(metricCode) (no additions)",
                                metricCode: metricCode
                            ))
                            NSLog("[HealthIngestCore] Change lane: anchor-only update FAILED for %@ (no additions). Next run will retry.", metricCode)
                            metricHadError = true
                            break
                        }
                        anchorPersistedSuccessfully = true
                    }
                    if anchorPersistedSuccessfully, let newAnchor = changes.serializedAnchor {
                        currentAnchorData = newAnchor
                    } else if !anchorPersistedSuccessfully {
                    } else {
                        NSLog("[HealthIngestCore] Change lane: serializedAnchor is nil for %@, retaining previous anchor", metricCode)
                    }
                    if !changes.hasMore {
                        break
                    }
                    currentCursor = self.sqlite.readCursor(
                        userId: userId,
                        sourceId: sourceId,
                        sampleType: metricCode,
                        scope: .changeAnchor
                    )
                    NSLog("[HealthIngestCore] Change lane continuing for %@ (iteration %d, hasMore=true)",
                          metricCode, changeIteration)
                }
                if !metricHadError {
                    result.metricsProcessed.append(metricCode)
                }
                result.metricDiagnostics.append(MetricDiagnostic(
                    metricCode: metricCode,
                    newestSampleTimestampMs: metricNewestTs,
                    oldestSampleTimestampMs: metricOldestTs,
                    samplesInserted: metricInserted,
                    samplesSkipped: metricSkipped
                ))
                if changeCancelled {
                    break
                }
            }
            result.durationMs = Int(self.elapsedMs(since: startTime))
            result.success = result.errors.filter { $0.code != .changeCancelled && $0.code != .queryTimeout }.isEmpty
            assert(!result.success || result.errors.filter({
                $0.code != .changeCancelled && $0.code != .queryTimeout
            }).isEmpty, "success=true but non-benign errors present in change lane")
            self.updateLaneStatus(\.changeStatus) { status in
                status.running = false
                if result.success {
                    status.lastCompletedAt = Int64(Date().timeIntervalSince1970 * 1000)
                    status.consecutiveFailures = 0
                } else {
                    status.lastFailedAt = Int64(Date().timeIntervalSince1970 * 1000)
                    status.consecutiveFailures += 1
                    status.lastErrorCode = result.errors.first?.code
                }
            }
            completion(result)
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
    func cancelHotLane() {
        hotCancellationFlag.value = true
        stopAndClearActiveQuery(lane: .hot)
    }
    /
    /
    /
    /
    func cancelColdLane() {
        coldCancellationFlag.value = true
        stopAndClearActiveQuery(lane: .cold)
        updateLaneStatus(\.coldStatus) { $0.paused = true }
    }
    /
    /
    /
    /
    /
    /
    func cancelChangeLane() {
        changeCancellationFlag.value = true
        stopAndClearActiveQuery(lane: .change)
    }
    /
    func getLaneStatuses() -> NSDictionary {
        statusLock.lock()
        let result: NSDictionary = [
            "hot": hotStatus.toDictionary(),
            "cold": coldStatus.toDictionary(),
            "change": changeStatus.toDictionary(),
        ]
        statusLock.unlock()
        return result
    }
    /
    /
    /
    /
    func dispose() {
        cancelHotLane()
        cancelColdLane()
        cancelChangeLane()
        hotQueue.cancelAllOperations()
        coldQueue.cancelAllOperations()
        changeQueue.cancelAllOperations()
        sqlite.close()
        isInitialized = false
    }
    /
    private enum QueryLane {
        case hot, cold, change
    }
    /
    private func storeActiveQuery(_ query: HKQuery?, lane: QueryLane) {
        queryLock.lock()
        defer { queryLock.unlock() }
        switch lane {
        case .hot: activeHotQuery = query
        case .cold: activeColdQuery = query
        case .change: activeChangeQuery = query
        }
    }
    /
    private func clearActiveQuery(lane: QueryLane) {
        queryLock.lock()
        defer { queryLock.unlock() }
        switch lane {
        case .hot: activeHotQuery = nil
        case .cold: activeColdQuery = nil
        case .change: activeChangeQuery = nil
        }
    }
    /
    /
    /
    /
    /
    /
    private func stopAndClearActiveQuery(lane: QueryLane) {
        queryLock.lock()
        let query: HKQuery?
        switch lane {
        case .hot: query = activeHotQuery; activeHotQuery = nil
        case .cold: query = activeColdQuery; activeColdQuery = nil
        case .change: query = activeChangeQuery; activeChangeQuery = nil
        }
        queryLock.unlock()
        if let query = query {
            healthStore.stop(query)
        }
    }
    /
    private func elapsedMs(since startTime: DispatchTime) -> Int {
        let elapsed = DispatchTime.now().uptimeNanoseconds - startTime.uptimeNanoseconds
        return Int(elapsed / 1_000_000)
    }
    /
    private func updateLaneStatus(
        _ keyPath: ReferenceWritableKeyPath<HealthIngestCore, NativeLaneStatus>,
        update: (inout NativeLaneStatus) -> Void
    ) {
        statusLock.lock()
        update(&self[keyPath: keyPath])
        statusLock.unlock()
    }
}
