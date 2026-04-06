import XCTest
import HealthKit
@testable import AppPlatform
final class NativeMetricConfigParsingTests: XCTestCase {
    func testValidCompleteDict_ParsesCorrectly() {
        let dict: NSDictionary = [
            "metricCode": "heart_rate",
            "hkIdentifier": "HKQuantityTypeIdentifierHeartRate",
            "queryUnit": "count/min",
            "valueKind": "SCALAR_NUM",
            "isCategory": false,
            "minBound": NSNumber(value: 20.0),
            "maxBound": NSNumber(value: 300.0),
            "canonicalUnit": "bpm",
        ]
        let config = NativeMetricConfig.fromDictionary(dict)
        XCTAssertNotNil(config)
        XCTAssertEqual(config?.metricCode, "heart_rate")
        XCTAssertEqual(config?.hkIdentifier, "HKQuantityTypeIdentifierHeartRate")
        XCTAssertEqual(config?.queryUnit, "count/min")
        XCTAssertEqual(config?.valueKind, .scalarNum)
        XCTAssertEqual(config?.isCategory, false)
        XCTAssertEqual(config?.minBound, 20.0)
        XCTAssertEqual(config?.maxBound, 300.0)
        XCTAssertEqual(config?.canonicalUnit, "bpm")
    }
    func testMissingMetricCode_ReturnsNil() {
        let dict: NSDictionary = [
            "hkIdentifier": "HKQuantityTypeIdentifierHeartRate",
            "valueKind": "SCALAR_NUM",
            "isCategory": false,
        ]
        XCTAssertNil(NativeMetricConfig.fromDictionary(dict))
    }
    func testMissingHkIdentifier_ReturnsNil() {
        let dict: NSDictionary = [
            "metricCode": "heart_rate",
            "valueKind": "SCALAR_NUM",
            "isCategory": false,
        ]
        XCTAssertNil(NativeMetricConfig.fromDictionary(dict))
    }
    func testMissingValueKind_ReturnsNil() {
        let dict: NSDictionary = [
            "metricCode": "heart_rate",
            "hkIdentifier": "HKQuantityTypeIdentifierHeartRate",
            "isCategory": false,
        ]
        XCTAssertNil(NativeMetricConfig.fromDictionary(dict))
    }
    func testInvalidValueKindString_ReturnsNil() {
        let dict: NSDictionary = [
            "metricCode": "heart_rate",
            "hkIdentifier": "HKQuantityTypeIdentifierHeartRate",
            "valueKind": "INVALID_KIND",
            "isCategory": false,
        ]
        XCTAssertNil(NativeMetricConfig.fromDictionary(dict))
    }
    func testMissingIsCategory_ReturnsNil() {
        let dict: NSDictionary = [
            "metricCode": "heart_rate",
            "hkIdentifier": "HKQuantityTypeIdentifierHeartRate",
            "valueKind": "SCALAR_NUM",
        ]
        XCTAssertNil(NativeMetricConfig.fromDictionary(dict))
    }
    func testOptionalFieldsNil_UsesDefaults() {
        let dict: NSDictionary = [
            "metricCode": "sleep_stage",
            "hkIdentifier": "HKCategoryTypeIdentifierSleepAnalysis",
            "valueKind": "CATEGORY",
            "isCategory": true,
        ]
        let config = NativeMetricConfig.fromDictionary(dict)
        XCTAssertNotNil(config)
        XCTAssertNil(config?.queryUnit)
        XCTAssertNil(config?.minBound)
        XCTAssertNil(config?.maxBound)
        XCTAssertNil(config?.canonicalUnit)
    }
    func testNSNumberDouble_ParsesViaDotDoubleValue() {
        let dict: NSDictionary = [
            "metricCode": "heart_rate",
            "hkIdentifier": "HKQuantityTypeIdentifierHeartRate",
            "valueKind": "SCALAR_NUM",
            "isCategory": false,
            "minBound": NSNumber(value: 20.5),
            "maxBound": NSNumber(value: 300.7),
        ]
        let config = NativeMetricConfig.fromDictionary(dict)
        XCTAssertNotNil(config)
        XCTAssertEqual(config!.minBound!, 20.5, accuracy: 0.001)
        XCTAssertEqual(config!.maxBound!, 300.7, accuracy: 0.001)
    }
}
final class LaneConstantsParsingTests: XCTestCase {
    func testValidCompleteDict_ParsesCorrectly() {
        let dict = makeLaneConstantsDict()
        let constants = LaneConstants.fromDictionary(dict)
        XCTAssertNotNil(constants)
        XCTAssertEqual(constants?.hotBudgetMs, 2000)
        XCTAssertEqual(constants?.recentDataQueryLimit, 60000)
        XCTAssertEqual(constants?.coldChunkBudgetMs, 500)
        XCTAssertEqual(constants?.coldMaxChunks, 10)
        XCTAssertEqual(constants?.coldBackfillDays, 90)
        XCTAssertEqual(constants?.coldChunkWindowMs, 604_800_000)
        XCTAssertEqual(constants?.coldQueryLimitPerChunk, 5_000)
        XCTAssertEqual(constants?.maxSamplesPerChunk, 200)
        XCTAssertEqual(constants?.busyTimeoutMs, 5000)
    }
    func testMissingRequiredField_ReturnsNil() {
        let dict: NSDictionary = [
            "coldChunkBudgetMs": NSNumber(value: 500),
            "coldBackfillDays": NSNumber(value: 90),
            "maxSamplesPerChunk": NSNumber(value: 200),
            "busyTimeoutMs": NSNumber(value: 5000),
        ]
        XCTAssertNil(LaneConstants.fromDictionary(dict))
    }
    func testNSNumberDouble_ParsesViaIntValue() {
        let dict: NSDictionary = [
            "hotBudgetMs": NSNumber(value: Double(2000)),
            "coldChunkBudgetMs": NSNumber(value: Double(500)),
            "coldBackfillDays": NSNumber(value: Double(90)),
            "maxSamplesPerChunk": NSNumber(value: Double(200)),
            "busyTimeoutMs": NSNumber(value: Double(5000)),
        ]
        let constants = LaneConstants.fromDictionary(dict)
        XCTAssertNotNil(constants)
        XCTAssertEqual(constants?.hotBudgetMs, 2000)
    }
    func testColdMaxChunksMissing_DefaultsTo10() {
        let dict: NSDictionary = [
            "hotBudgetMs": NSNumber(value: 2000),
            "coldChunkBudgetMs": NSNumber(value: 500),
            "coldBackfillDays": NSNumber(value: 90),
            "maxSamplesPerChunk": NSNumber(value: 200),
            "busyTimeoutMs": NSNumber(value: 5000),
        ]
        let constants = LaneConstants.fromDictionary(dict)
        XCTAssertNotNil(constants)
        XCTAssertEqual(constants?.coldMaxChunks, 10)
    }
    func testRecentDataQueryLimitZero_DefaultsTo60000() {
        let dict = makeLaneConstantsDict(recentDataQueryLimit: 0)
        let constants = LaneConstants.fromDictionary(dict)
        XCTAssertNotNil(constants)
        XCTAssertEqual(constants?.recentDataQueryLimit, 60000)
    }
    func testRecentDataQueryLimitNegative_DefaultsTo60000() {
        let dict = makeLaneConstantsDict(recentDataQueryLimit: -100)
        let constants = LaneConstants.fromDictionary(dict)
        XCTAssertNotNil(constants)
        XCTAssertEqual(constants?.recentDataQueryLimit, 60000)
    }
    /
    /
    /
    /
    /
    /
    /
    /
    func testColdChunkWindowMsMissing_DefaultsTo7Days() {
        let dict: NSDictionary = [
            "hotBudgetMs": NSNumber(value: 2000),
            "coldChunkBudgetMs": NSNumber(value: 500),
            "coldBackfillDays": NSNumber(value: 90),
            "maxSamplesPerChunk": NSNumber(value: 200),
            "busyTimeoutMs": NSNumber(value: 5000),
        ]
        let constants = LaneConstants.fromDictionary(dict)
        XCTAssertNotNil(constants)
        XCTAssertEqual(constants?.coldChunkWindowMs, 604_800_000)
    }
    /
    /
    func testColdQueryLimitPerChunkMissing_DefaultsTo5000() {
        let dict: NSDictionary = [
            "hotBudgetMs": NSNumber(value: 2000),
            "coldChunkBudgetMs": NSNumber(value: 500),
            "coldBackfillDays": NSNumber(value: 90),
            "maxSamplesPerChunk": NSNumber(value: 200),
            "busyTimeoutMs": NSNumber(value: 5000),
        ]
        let constants = LaneConstants.fromDictionary(dict)
        XCTAssertNotNil(constants)
        XCTAssertEqual(constants?.coldQueryLimitPerChunk, 5_000)
    }
    /
    /
    func testColdChunkWindowMsZero_DefaultsTo7Days() {
        let dict = makeLaneConstantsDict(coldChunkWindowMs: 0)
        let constants = LaneConstants.fromDictionary(dict)
        XCTAssertNotNil(constants)
        XCTAssertEqual(constants?.coldChunkWindowMs, 604_800_000)
    }
    func testColdQueryLimitPerChunkZero_DefaultsTo5000() {
        let dict = makeLaneConstantsDict(coldQueryLimitPerChunk: 0)
        let constants = LaneConstants.fromDictionary(dict)
        XCTAssertNotNil(constants)
        XCTAssertEqual(constants?.coldQueryLimitPerChunk, 5_000)
    }
}
final class NativeLaneResultSerializationTests: XCTestCase {
    func testEmptyResult_CorrectDictShape() {
        let result = NativeLaneResult.empty()
        let dict = result.toDictionary()
        XCTAssertEqual(dict["success"] as? Bool, true)
        XCTAssertEqual(dict["samplesInserted"] as? Int, 0)
        XCTAssertEqual(dict["samplesSkipped"] as? Int, 0)
        XCTAssertEqual(dict["durationMs"] as? Int, 0)
        XCTAssertEqual((dict["metricsProcessed"] as? [String])?.count, 0)
        XCTAssertEqual((dict["errors"] as? [NSDictionary])?.count, 0)
        XCTAssertEqual(dict["partial"] as? Bool, false)
    }
    func testErrorResult_CorrectSerialization() {
        let result = NativeLaneResult.error(.notInitialized, message: "Not init")
        let dict = result.toDictionary()
        XCTAssertEqual(dict["success"] as? Bool, false)
        let errors = dict["errors"] as? [NSDictionary]
        XCTAssertEqual(errors?.count, 1)
        XCTAssertEqual(errors?[0]["code"] as? String, "NOT_INITIALIZED")
        XCTAssertEqual(errors?[0]["message"] as? String, "Not init")
    }
    func testFullResult_AllFieldsPresent() {
        let result = NativeLaneResult(
            success: true,
            samplesInserted: 42,
            samplesSkipped: 3,
            durationMs: 500,
            metricsProcessed: ["heart_rate", "steps"],
            errors: [IngestError(code: .budgetExceeded, message: "Budget", metricCode: "steps")],
            partial: true,
            coldCursorsAdvanced: 0,
            metricDiagnostics: [
                MetricDiagnostic(
                    metricCode: "heart_rate",
                    newestSampleTimestampMs: 1700000000000,
                    oldestSampleTimestampMs: 1699999000000,
                    samplesInserted: 30,
                    samplesSkipped: 1
                ),
                MetricDiagnostic(
                    metricCode: "steps",
                    newestSampleTimestampMs: 1700000000000,
                    oldestSampleTimestampMs: 1699998000000,
                    samplesInserted: 12,
                    samplesSkipped: 2
                )
            ]
        )
        let dict = result.toDictionary()
        XCTAssertEqual(dict["samplesInserted"] as? Int, 42)
        XCTAssertEqual(dict["samplesSkipped"] as? Int, 3)
        XCTAssertEqual(dict["durationMs"] as? Int, 500)
        XCTAssertEqual(dict["partial"] as? Bool, true)
        XCTAssertEqual((dict["metricsProcessed"] as? [String])?.count, 2)
        let diagnostics = dict["metricDiagnostics"] as? [NSDictionary]
        XCTAssertEqual(diagnostics?.count, 2)
        let diag0 = diagnostics?[0] as NSDictionary?
        let diag1 = diagnostics?[1] as NSDictionary?
        XCTAssertEqual(diag0?["metricCode"] as? String, "heart_rate")
        XCTAssertEqual(diag0?["samplesInserted"] as? Int, 30)
        XCTAssertEqual(diag1?["metricCode"] as? String, "steps")
        XCTAssertEqual(diag1?["samplesSkipped"] as? Int, 2)
    }
}
final class IngestErrorSerializationTests: XCTestCase {
    func testWithMetricCode_IncludesKey() {
        let error = IngestError(code: .healthkitQueryFailed, message: "Query failed", metricCode: "heart_rate")
        let dict = error.toDictionary()
        XCTAssertEqual(dict["code"] as? String, "HEALTHKIT_QUERY_FAILED")
        XCTAssertEqual(dict["message"] as? String, "Query failed")
        XCTAssertEqual(dict["metricCode"] as? String, "heart_rate")
    }
    func testWithoutMetricCode_NoKey() {
        let error = IngestError(code: .notInitialized, message: "Not init", metricCode: nil)
        let dict = error.toDictionary()
        XCTAssertEqual(dict["code"] as? String, "NOT_INITIALIZED")
        XCTAssertNil(dict["metricCode"])
    }
}
final class ColdProgressEventSerializationTests: XCTestCase {
    func testAllFieldsSerialized() {
        let event = ColdProgressEvent(
            chunksProcessed: 5,
            estimatedTotalChunks: 20,
            totalSamplesInserted: 1000,
            oldestTimestampReached: Int64(1_600_000_000_000),
            isRunning: true
        )
        let dict = event.toDictionary()
        XCTAssertEqual(dict["chunksProcessed"] as? Int, 5)
        XCTAssertEqual(dict["estimatedTotalChunks"] as? Int, 20)
        XCTAssertEqual(dict["totalSamplesInserted"] as? Int, 1000)
        XCTAssertEqual(dict["isRunning"] as? Bool, true)
        let oldest = dict["oldestTimestampReached"] as? NSNumber
        XCTAssertNotNil(oldest)
        XCTAssertEqual(oldest?.int64Value, Int64(1_600_000_000_000))
    }
}
final class NativeLaneStatusSerializationTests: XCTestCase {
    func testDefaultStatus_NilFieldsAsNSNull() {
        let status = NativeLaneStatus()
        let dict = status.toDictionary()
        XCTAssertEqual(dict["running"] as? Bool, false)
        XCTAssertEqual(dict["consecutiveFailures"] as? Int, 0)
        XCTAssertEqual(dict["paused"] as? Bool, false)
        XCTAssertTrue(dict["lastCompletedAt"] is NSNull)
        XCTAssertTrue(dict["lastFailedAt"] is NSNull)
        XCTAssertTrue(dict["lastErrorCode"] is NSNull)
    }
    func testPopulatedStatus_AllFieldsPresent() {
        var status = NativeLaneStatus()
        status.running = true
        status.lastCompletedAt = 1700000000000
        status.lastFailedAt = 1700000001000
        status.lastErrorCode = .sqliteBusy
        status.consecutiveFailures = 3
        status.paused = true
        let dict = status.toDictionary()
        XCTAssertEqual(dict["running"] as? Bool, true)
        XCTAssertEqual((dict["lastCompletedAt"] as? NSNumber)?.int64Value, 1700000000000)
        XCTAssertEqual((dict["lastFailedAt"] as? NSNumber)?.int64Value, 1700000001000)
        XCTAssertEqual(dict["lastErrorCode"] as? String, "SQLITE_BUSY")
        XCTAssertEqual(dict["consecutiveFailures"] as? Int, 3)
        XCTAssertEqual(dict["paused"] as? Bool, true)
    }
}
final class NativeErrorCodeRawValueTests: XCTestCase {
    func testAllErrorCodes_MatchTypeScriptStrings() {
        XCTAssertEqual(NativeErrorCode.healthkitUnavailable.rawValue, "HEALTHKIT_UNAVAILABLE")
        XCTAssertEqual(NativeErrorCode.healthkitUnauthorized.rawValue, "HEALTHKIT_UNAUTHORIZED")
        XCTAssertEqual(NativeErrorCode.healthkitQueryFailed.rawValue, "HEALTHKIT_QUERY_FAILED")
        XCTAssertEqual(NativeErrorCode.sqliteOpenFailed.rawValue, "SQLITE_OPEN_FAILED")
        XCTAssertEqual(NativeErrorCode.sqliteWriteFailed.rawValue, "SQLITE_WRITE_FAILED")
        XCTAssertEqual(NativeErrorCode.sqliteBusy.rawValue, "SQLITE_BUSY")
        XCTAssertEqual(NativeErrorCode.budgetExceeded.rawValue, "BUDGET_EXCEEDED")
        XCTAssertEqual(NativeErrorCode.coldCancelled.rawValue, "COLD_CANCELLED")
        XCTAssertEqual(NativeErrorCode.nativeBridgeError.rawValue, "NATIVE_BRIDGE_ERROR")
        XCTAssertEqual(NativeErrorCode.notInitialized.rawValue, "NOT_INITIALIZED")
        XCTAssertEqual(NativeErrorCode.invalidMetricCode.rawValue, "INVALID_METRIC_CODE")
        XCTAssertEqual(NativeErrorCode.changeCancelled.rawValue, "CHANGE_CANCELLED")
        XCTAssertEqual(NativeErrorCode.queryTimeout.rawValue, "QUERY_TIMEOUT")
    }
}
final class EnumRawValueTests: XCTestCase {
    func testCursorScopeRawValues() {
        XCTAssertEqual(CursorScope.hotAnchor.rawValue, "hot_anchor")
        XCTAssertEqual(CursorScope.coldTime.rawValue, "cold_time")
        XCTAssertEqual(CursorScope.changeAnchor.rawValue, "change_anchor")
    }
    func testHealthValueKindRawValues() {
        XCTAssertEqual(HealthValueKind.scalarNum.rawValue, "SCALAR_NUM")
        XCTAssertEqual(HealthValueKind.cumulativeNum.rawValue, "CUMULATIVE_NUM")
        XCTAssertEqual(HealthValueKind.intervalNum.rawValue, "INTERVAL_NUM")
        XCTAssertEqual(HealthValueKind.category.rawValue, "CATEGORY")
    }
}
