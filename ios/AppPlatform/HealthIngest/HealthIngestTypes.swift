import Foundation
import HealthKit
/
/
/
/
/
/
enum NativeErrorCode: String {
    /
    case healthkitUnavailable = "HEALTHKIT_UNAVAILABLE"
    /
    case healthkitUnauthorized = "HEALTHKIT_UNAUTHORIZED"
    /
    case healthkitQueryFailed = "HEALTHKIT_QUERY_FAILED"
    /
    case sqliteOpenFailed = "SQLITE_OPEN_FAILED"
    /
    case sqliteWriteFailed = "SQLITE_WRITE_FAILED"
    /
    case sqliteBusy = "SQLITE_BUSY"
    /
    case budgetExceeded = "BUDGET_EXCEEDED"
    /
    case hotCancelled = "HOT_CANCELLED"
    /
    case coldCancelled = "COLD_CANCELLED"
    /
    case nativeBridgeError = "NATIVE_BRIDGE_ERROR"
    /
    case notInitialized = "NOT_INITIALIZED"
    /
    case invalidMetricCode = "INVALID_METRIC_CODE"
    /
    case changeCancelled = "CHANGE_CANCELLED"
    /
    case queryTimeout = "QUERY_TIMEOUT"
}
/
/
/
/
/
/
/
enum CursorScope: String {
    /
    case hotAnchor = "hot_anchor"
    /
    case coldTime = "cold_time"
    /
    case changeAnchor = "change_anchor"
}
/
/
/
/
enum HealthValueKind: String {
    /
    case scalarNum = "SCALAR_NUM"
    /
    case cumulativeNum = "CUMULATIVE_NUM"
    /
    case intervalNum = "INTERVAL_NUM"
    /
    case category = "CATEGORY"
}
/
/
/
/
/
/
/
struct NativeMetricConfig {
    /
    let metricCode: String
    /
    let hkIdentifier: String
    /
    let queryUnit: String?
    /
    let valueKind: HealthValueKind
    /
    let isCategory: Bool
    /
    let minBound: Double?
    /
    let maxBound: Double?
    /
    let canonicalUnit: String?
    /
    /
    /
    func resolveHKSampleType() -> HKSampleType? {
        if isCategory {
            return HKObjectType.categoryType(forIdentifier: HKCategoryTypeIdentifier(rawValue: hkIdentifier))
        } else {
            return HKObjectType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: hkIdentifier))
        }
    }
    /
    func resolveHKUnit() -> HKUnit? {
        guard let unitString = queryUnit else { return nil }
        return HKUnit(from: unitString)
    }
    /
    /
    /
    /
    /
    /
    /
    /
    static func fromDictionary(_ dict: NSDictionary) -> NativeMetricConfig? {
        guard
            let metricCode = dict["metricCode"] as? String,
            let hkIdentifier = dict["hkIdentifier"] as? String,
            let valueKindStr = dict["valueKind"] as? String,
            let valueKind = HealthValueKind(rawValue: valueKindStr),
            let isCategory = dict["isCategory"] as? Bool
        else {
            return nil
        }
        return NativeMetricConfig(
            metricCode: metricCode,
            hkIdentifier: hkIdentifier,
            queryUnit: dict["queryUnit"] as? String,
            valueKind: valueKind,
            isCategory: isCategory,
            minBound: (dict["minBound"] as? NSNumber)?.doubleValue,
            maxBound: (dict["maxBound"] as? NSNumber)?.doubleValue,
            canonicalUnit: dict["canonicalUnit"] as? String
        )
    }
}
/
/
/
/
/
/
struct LaneConstants {
    /
    let hotBudgetMs: Int
    /
    let recentDataQueryLimit: Int
    /
    /
    /
    /
    /
    /
    /
    let hotLookbackDays: Int
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
    let hotOverlapMs: Int
    /
    /
    /
    /
    /
    /
    let hotUiWindowMs: Int
    /
    /
    /
    /
    /
    /
    let hotCatchupChunkWindowMs: Int
    /
    /
    /
    /
    /
    /
    let hotCatchupMaxChunksPerRun: Int
    /
    /
    /
    let hotCatchupQueryLimit: Int
    /
    /
    /
    /
    /
    /
    /
    /
    /
    let hotTwoPassEnabled: Bool
    /
    let coldChunkBudgetMs: Int
    /
    /
    let coldMaxChunks: Int
    /
    let coldBackfillDays: Int
    /
    /
    /
    /
    /
    /
    /
    /
    /
    let coldGraceWindowDays: Int
    /
    /
    /
    /
    /
    /
    /
    /
    let coldChunkWindowMs: Int
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
    let coldQueryLimitPerChunk: Int
    /
    let maxSamplesPerChunk: Int
    /
    let busyTimeoutMs: Int
    /
    /
    /
    /
    /
    /
    /
    static func fromDictionary(_ dict: NSDictionary) -> LaneConstants? {
        guard
            let hotBudgetMs = (dict["hotBudgetMs"] as? NSNumber)?.intValue,
            let coldChunkBudgetMs = (dict["coldChunkBudgetMs"] as? NSNumber)?.intValue,
            let coldBackfillDays = (dict["coldBackfillDays"] as? NSNumber)?.intValue,
            let maxSamplesPerChunk = (dict["maxSamplesPerChunk"] as? NSNumber)?.intValue,
            let busyTimeoutMs = (dict["busyTimeoutMs"] as? NSNumber)?.intValue
        else {
            return nil
        }
        let coldMaxChunks = (dict["coldMaxChunks"] as? NSNumber)?.intValue ?? 10
        let recentDataQueryLimit = (dict["recentDataQueryLimit"] as? NSNumber)?.intValue ?? 60000
        let hotLookbackDays = (dict["hotLookbackDays"] as? NSNumber)?.intValue ?? 14
        let hotOverlapMs = (dict["hotOverlapMs"] as? NSNumber)?.intValue ?? 300_000
        let hotUiWindowMs = (dict["hotUiWindowMs"] as? NSNumber)?.intValue ?? 86_400_000
        let hotCatchupChunkWindowMs = (dict["hotCatchupChunkWindowMs"] as? NSNumber)?.intValue ?? 21_600_000
        let hotCatchupMaxChunksPerRun = (dict["hotCatchupMaxChunksPerRun"] as? NSNumber)?.intValue ?? 4
        let hotCatchupQueryLimit = (dict["hotCatchupQueryLimit"] as? NSNumber)?.intValue ?? 5_000
        let hotTwoPassEnabled = (dict["hotTwoPassEnabled"] as? Bool) ?? false
        let coldGraceWindowDays = (dict["coldGraceWindowDays"] as? NSNumber)?.intValue ?? 0
        let coldChunkWindowMs = (dict["coldChunkWindowMs"] as? NSNumber)?.intValue ?? 604_800_000
        let coldQueryLimitPerChunk = (dict["coldQueryLimitPerChunk"] as? NSNumber)?.intValue ?? 5_000
        return LaneConstants(
            hotBudgetMs: hotBudgetMs,
            recentDataQueryLimit: recentDataQueryLimit > 0 ? recentDataQueryLimit : 60000,
            hotLookbackDays: hotLookbackDays > 0 ? hotLookbackDays : 14,
            hotOverlapMs: hotOverlapMs > 0 ? hotOverlapMs : 300_000,
            hotUiWindowMs: hotUiWindowMs > 0 ? hotUiWindowMs : 86_400_000,
            hotCatchupChunkWindowMs: hotCatchupChunkWindowMs > 0 ? hotCatchupChunkWindowMs : 21_600_000,
            hotCatchupMaxChunksPerRun: hotCatchupMaxChunksPerRun > 0 ? hotCatchupMaxChunksPerRun : 4,
            hotCatchupQueryLimit: hotCatchupQueryLimit > 0 ? hotCatchupQueryLimit : 5_000,
            hotTwoPassEnabled: hotTwoPassEnabled,
            coldChunkBudgetMs: coldChunkBudgetMs,
            coldMaxChunks: coldMaxChunks,
            coldBackfillDays: coldBackfillDays,
            coldGraceWindowDays: coldGraceWindowDays >= 0 ? coldGraceWindowDays : 0,
            coldChunkWindowMs: coldChunkWindowMs > 0 ? coldChunkWindowMs : 604_800_000,
            coldQueryLimitPerChunk: coldQueryLimitPerChunk > 0 ? coldQueryLimitPerChunk : 5_000,
            maxSamplesPerChunk: maxSamplesPerChunk,
            busyTimeoutMs: busyTimeoutMs
        )
    }
}
/
/
/
struct IngestError {
    /
    let code: NativeErrorCode
    /
    let message: String
    /
    let metricCode: String?
    /
    /
    /
    /
    func toDictionary() -> NSDictionary {
        let dict = NSMutableDictionary()
        dict["code"] = code.rawValue
        dict["message"] = message
        if let metricCode = metricCode {
            dict["metricCode"] = metricCode
        }
        return dict
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
struct MetricDiagnostic {
    /
    let metricCode: String
    /
    /
    let newestSampleTimestampMs: Int64?
    /
    /
    let oldestSampleTimestampMs: Int64?
    /
    let samplesInserted: Int
    /
    let samplesSkipped: Int
    /
    func toDictionary() -> NSDictionary {
        let dict = NSMutableDictionary()
        dict["metricCode"] = metricCode
        dict["newestSampleTimestampMs"] = newestSampleTimestampMs.map { NSNumber(value: $0) } ?? NSNull()
        dict["oldestSampleTimestampMs"] = oldestSampleTimestampMs.map { NSNumber(value: $0) } ?? NSNull()
        dict["samplesInserted"] = samplesInserted
        dict["samplesSkipped"] = samplesSkipped
        return dict
    }
}
/
/
/
/
/
/
/
struct NativeLaneResult {
    /
    var success: Bool
    /
    var samplesInserted: Int
    /
    var samplesSkipped: Int
    /
    var durationMs: Int
    /
    var metricsProcessed: [String]
    /
    var errors: [IngestError]
    /
    var partial: Bool
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
    var coldCursorsAdvanced: Int
    /
    /
    /
    /
    /
    /
    var metricDiagnostics: [MetricDiagnostic]
    /
    static func empty() -> NativeLaneResult {
        return NativeLaneResult(
            success: true,
            samplesInserted: 0,
            samplesSkipped: 0,
            durationMs: 0,
            metricsProcessed: [],
            errors: [],
            partial: false,
            coldCursorsAdvanced: 0,
            metricDiagnostics: []
        )
    }
    /
    static func error(_ code: NativeErrorCode, message: String, metricCode: String? = nil) -> NativeLaneResult {
        return NativeLaneResult(
            success: false,
            samplesInserted: 0,
            samplesSkipped: 0,
            durationMs: 0,
            metricsProcessed: [],
            errors: [IngestError(code: code, message: message, metricCode: metricCode)],
            partial: false,
            coldCursorsAdvanced: 0,
            metricDiagnostics: []
        )
    }
    /
    /
    /
    /
    /
    /
    func toDictionary() -> NSDictionary {
        return [
            "success": success,
            "samplesInserted": samplesInserted,
            "samplesSkipped": samplesSkipped,
            "durationMs": durationMs,
            "metricsProcessed": metricsProcessed,
            "errors": errors.map { $0.toDictionary() },
            "partial": partial,
            "coldCursorsAdvanced": coldCursorsAdvanced,
            "metricDiagnostics": metricDiagnostics.map { $0.toDictionary() },
        ] as NSDictionary
    }
}
/
/
/
/
/
/
/
struct ColdProgressEvent {
    /
    let chunksProcessed: Int
    /
    let estimatedTotalChunks: Int
    /
    let totalSamplesInserted: Int
    /
    let oldestTimestampReached: Int64
    /
    let isRunning: Bool
    /
    func toDictionary() -> [String: Any] {
        return [
            "chunksProcessed": chunksProcessed,
            "estimatedTotalChunks": estimatedTotalChunks,
            "totalSamplesInserted": totalSamplesInserted,
            "oldestTimestampReached": NSNumber(value: oldestTimestampReached),
            "isRunning": isRunning,
        ]
    }
}
/
/
/
struct NativeLaneStatus {
    var running: Bool = false
    var lastCompletedAt: Int64? = nil
    var lastFailedAt: Int64? = nil
    var lastErrorCode: NativeErrorCode? = nil
    var consecutiveFailures: Int = 0
    var paused: Bool = false
    /
    func toDictionary() -> NSDictionary {
        let dict = NSMutableDictionary()
        dict["running"] = running
        dict["lastCompletedAt"] = lastCompletedAt.map { NSNumber(value: $0) } ?? NSNull()
        dict["lastFailedAt"] = lastFailedAt.map { NSNumber(value: $0) } ?? NSNull()
        dict["lastErrorCode"] = lastErrorCode?.rawValue ?? NSNull()
        dict["consecutiveFailures"] = consecutiveFailures
        dict["paused"] = paused
        return dict
    }
}
/
/
/
/
/
/
struct NormalizedHealthSample {
    /
    let id: String
    /
    let userId: String
    /
    let sourceId: String
    /
    let sourceRecordId: String
    /
    let sampleType: String
    /
    let valueKind: String
    /
    let startTimestamp: Int64
    /
    let endTimestamp: Int64
    /
    let value: Double?
    /
    let unit: String?
    /
    let categoryCode: String?
    /
    let durationSeconds: Int?
    /
    let deviceId: String?
    /
    let externalUuid: String?
    /
    let metadata: String?
    /
    let timestampMs: Int64
}
/
/
/
/
/
/
/
final class AtomicBool {
    private var _value: Bool
    private var _lock = os_unfair_lock()
    init(_ value: Bool) {
        self._value = value
    }
    var value: Bool {
        get {
            os_unfair_lock_lock(&_lock)
            let v = _value
            os_unfair_lock_unlock(&_lock)
            return v
        }
        set {
            os_unfair_lock_lock(&_lock)
            _value = newValue
            os_unfair_lock_unlock(&_lock)
        }
    }
}
/
struct CursorData {
    let id: Int64
    let userId: String
    let sourceId: String
    let sampleType: String
    let scope: CursorScope
    let anchorData: String?
    let cursorVersion: Int64
    let lastIngestTimestamp: Int64?
    let totalSamplesIngested: Int64
    let coldBackfillEndTs: Int64?
    let coldBackfillStartTs: Int64?
    let lastSyncAt: Int64?
}
/
/
/
/
/
/
struct HotTwoPassGap {
    /
    let gapStart: Int64
    /
    let gapEnd: Int64
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
func computeHotTwoPassGap(
    watermarkMs: Int64,
    nowMs: Int64,
    overlapMs: Int64,
    maxHotWindowMs: Int64,
    hotUiWindowMs: Int64
) -> HotTwoPassGap? {
    let gapStart = max(watermarkMs - overlapMs, nowMs - maxHotWindowMs)
    let gapEnd = nowMs - hotUiWindowMs
    guard gapEnd > gapStart else { return nil }
    return HotTwoPassGap(gapStart: gapStart, gapEnd: gapEnd)
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
func computeCatchupChunks(
    gapStart: Int64,
    gapEnd: Int64,
    chunkMs: Int64,
    maxChunks: Int
) -> [(start: Int64, end: Int64)] {
    guard gapEnd > gapStart, chunkMs > 0, maxChunks > 0 else { return [] }
    var chunks: [(start: Int64, end: Int64)] = []
    var current = gapStart
    while current < gapEnd && chunks.count < maxChunks {
        let end = min(current + chunkMs, gapEnd)
        chunks.append((start: current, end: end))
        current = end
    }
    return chunks
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
let QUERY_TIMEOUT_SECONDS: Int = 30
/
/
/
/
/
/
let UNKNOWN_START_TIMESTAMP_SENTINEL: Int64 = -1
/
/
/
/
/
let MAX_ROWS_PER_CHUNK: Int = 30
