import XCTest
import HealthKit
@testable import AppPlatform
final class MapSleepCategoryTests: XCTestCase {
    func testInBed_ReturnsUnknown() {
        XCTAssertEqual(HealthNormalization.mapSleepCategory(0), "unknown")
    }
    func testAsleepUnspecified_ReturnsUnknown() {
        XCTAssertEqual(HealthNormalization.mapSleepCategory(1), "unknown")
    }
    func testAwake_ReturnsAwake() {
        XCTAssertEqual(HealthNormalization.mapSleepCategory(2), "awake")
    }
    func testAsleepCore_ReturnsLight() {
        XCTAssertEqual(HealthNormalization.mapSleepCategory(3), "light")
    }
    func testAsleepDeep_ReturnsDeep() {
        XCTAssertEqual(HealthNormalization.mapSleepCategory(4), "deep")
    }
    func testAsleepREM_ReturnsRem() {
        XCTAssertEqual(HealthNormalization.mapSleepCategory(5), "rem")
    }
    func testFutureValue6_ReturnsNil() {
        XCTAssertNil(HealthNormalization.mapSleepCategory(6))
    }
    func testNegativeValue_ReturnsNil() {
        XCTAssertNil(HealthNormalization.mapSleepCategory(-1))
    }
    func testIntMax_ReturnsNil() {
        XCTAssertNil(HealthNormalization.mapSleepCategory(Int.max))
    }
}
final class ApplyMetricValueTransformTests: XCTestCase {
    func testBloodOxygen_FractionalToPercentage() {
        let result = HealthNormalization.applyMetricValueTransform(metricCode: "blood_oxygen", value: 0.95)
        XCTAssertEqual(result, 95.0, accuracy: 0.001)
    }
    func testBloodOxygen_ZeroBoundary() {
        let result = HealthNormalization.applyMetricValueTransform(metricCode: "blood_oxygen", value: 0.0)
        XCTAssertEqual(result, 0.0, accuracy: 0.001)
    }
    func testBloodOxygen_OneBoundary() {
        let result = HealthNormalization.applyMetricValueTransform(metricCode: "blood_oxygen", value: 1.0)
        XCTAssertEqual(result, 100.0, accuracy: 0.001)
    }
    func testBloodOxygen_AlreadyPercentage_NoTransform() {
        let result = HealthNormalization.applyMetricValueTransform(metricCode: "blood_oxygen", value: 95.0)
        XCTAssertEqual(result, 95.0, accuracy: 0.001)
    }
    func testHeartRate_Passthrough() {
        let result = HealthNormalization.applyMetricValueTransform(metricCode: "heart_rate", value: 72.0)
        XCTAssertEqual(result, 72.0, accuracy: 0.001)
    }
    func testNonBloodOxygen_Passthrough() {
        let result = HealthNormalization.applyMetricValueTransform(metricCode: "steps", value: 5000.0)
        XCTAssertEqual(result, 5000.0, accuracy: 0.001)
    }
}
final class ExpandSleepStageDeletionIdsTests: XCTestCase {
    func testSingleId_Produces7Ids() {
        let result = HealthNormalization.expandSleepStageDeletionIds(["abc-123"])
        XCTAssertEqual(result.count, 7)
        XCTAssertEqual(result[0], "abc-123")
        XCTAssertTrue(result.contains("abc-123|time_in_bed"))
        XCTAssertTrue(result.contains("abc-123|sleep_duration"))
        XCTAssertTrue(result.contains("abc-123|sleep_awake"))
        XCTAssertTrue(result.contains("abc-123|sleep_light"))
        XCTAssertTrue(result.contains("abc-123|sleep_deep"))
        XCTAssertTrue(result.contains("abc-123|sleep_rem"))
    }
    func testMultipleIds_CorrectExpansion() {
        let result = HealthNormalization.expandSleepStageDeletionIds(["id-1", "id-2"])
        XCTAssertEqual(result.count, 14)
        XCTAssertTrue(result.contains("id-1"))
        XCTAssertTrue(result.contains("id-2"))
        XCTAssertTrue(result.contains("id-1|sleep_deep"))
        XCTAssertTrue(result.contains("id-2|sleep_rem"))
    }
    func testEmptyArray_ReturnsEmpty() {
        let result = HealthNormalization.expandSleepStageDeletionIds([])
        XCTAssertTrue(result.isEmpty)
    }
    func testDuplicateBaseIds_Deduplicated() {
        let result = HealthNormalization.expandSleepStageDeletionIds(["dup", "dup"])
        XCTAssertEqual(result.count, 7)
    }
    func testDerivedIdFormat() {
        let result = HealthNormalization.expandSleepStageDeletionIds(["base-uuid"])
        let derivedIds = result.filter { $0.contains("|") }
        XCTAssertEqual(derivedIds.count, 6)
        for id in derivedIds {
            let parts = id.split(separator: "|")
            XCTAssertEqual(parts.count, 2)
            XCTAssertEqual(parts[0], "base-uuid")
        }
    }
}
final class NormalizeTrueCategoryTests: XCTestCase {
    func testSleepStageCore_ReturnsLight() {
        let sample = makeCategorySample(type: .sleepAnalysis, value: 3,
                                        start: Date(timeIntervalSince1970: 1700000000),
                                        end: Date(timeIntervalSince1970: 1700003600))
        let config = makeSleepStageConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.categoryCode, "light")
        XCTAssertNil(result?.value)
        XCTAssertNil(result?.unit)
        XCTAssertEqual(result?.valueKind, "CATEGORY")
        XCTAssertEqual(result?.sampleType, "sleep_stage")
    }
    func testSleepStageInBed_ReturnsUnknown() {
        let sample = makeCategorySample(type: .sleepAnalysis, value: 0)
        let config = makeSleepStageConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.categoryCode, "unknown")
    }
    func testNonSleepCategory_UsesStringValue() {
        let config = NativeMetricConfig(
            metricCode: "mindful_minutes",
            hkIdentifier: "HKCategoryTypeIdentifierMindfulSession",
            queryUnit: nil,
            valueKind: .category,
            isCategory: true,
            minBound: nil,
            maxBound: nil,
            canonicalUnit: nil
        )
        let sample = makeCategorySample(type: .mindfulSession, value: 0)
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.categoryCode, "0")
    }
    func testQuantitySampleAsCategoryConfig_ReturnsNil() {
        let sample = makeQuantitySample()
        let config = makeSleepStageConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNil(result, "Quantity sample should be skipped for true category config")
    }
    func testInvalidSleepValue_HandledByMapSleepCategory() {
        XCTAssertNil(HealthNormalization.mapSleepCategory(99),
                     "mapSleepCategory should return nil for unknown category value")
    }
}
final class NormalizeHybridCategoryTests: XCTestCase {
    func testStandHours_Value1_ReturnsNumeric() {
        let sample = makeCategorySample(type: .appleStandHour, value: 1)
        let config = makeStandHoursConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.value, 1.0)
        XCTAssertEqual(result?.unit, "count")
        XCTAssertNil(result?.categoryCode)
        XCTAssertEqual(result?.valueKind, "CUMULATIVE_NUM")
    }
    func testStandHours_BoundsEnforcedByHealthKit() {
        let sample = makeCategorySample(type: .appleStandHour, value: 0)
        let config = makeStandHoursConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.value, 0.0)
        XCTAssertEqual(result?.unit, "count")
    }
    func testQuantitySampleAsHybridConfig_ReturnsNil() {
        let sample = makeQuantitySample()
        let config = makeStandHoursConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNil(result, "Quantity sample should be skipped for hybrid category config")
    }
}
final class NormalizeQuantityTests: XCTestCase {
    func testHeartRate_CorrectNormalization() {
        let sample = makeQuantitySample(type: .heartRate, value: 72.0,
                                        unit: HKUnit(from: "count/min"))
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result!.value!, 72.0, accuracy: 0.001)
        XCTAssertEqual(result?.unit, "bpm")
        XCTAssertNil(result?.categoryCode)
        XCTAssertEqual(result?.valueKind, "SCALAR_NUM")
        XCTAssertEqual(result?.sampleType, "heart_rate")
        XCTAssertEqual(result?.userId, "u1")
        XCTAssertEqual(result?.sourceId, "s1")
    }
    func testSteps_CumulativeValueKind() {
        let sample = makeQuantitySample(type: .stepCount, value: 5000.0,
                                        unit: HKUnit.count())
        let config = makeStepsConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.valueKind, "CUMULATIVE_NUM")
    }
    func testBelowMinBound_ReturnsNil() {
        let sample = makeQuantitySample(type: .heartRate, value: 5.0,
                                        unit: HKUnit(from: "count/min"))
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNil(result, "Below minBound (20) should skip")
    }
    func testAboveMaxBound_ReturnsNil() {
        let sample = makeQuantitySample(type: .heartRate, value: 500.0,
                                        unit: HKUnit(from: "count/min"))
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNil(result, "Above maxBound (300) should skip")
    }
    func testNaN_ReturnsNil() {
        let sample = makeQuantitySample(type: .heartRate, value: Double.nan,
                                        unit: HKUnit(from: "count/min"))
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNil(result, "NaN value should skip")
    }
    func testInfinity_ReturnsNil() {
        let sample = makeQuantitySample(type: .heartRate, value: Double.infinity,
                                        unit: HKUnit(from: "count/min"))
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNil(result, "Infinity value should skip")
    }
    func testBloodOxygen_TransformApplied() {
        let sample = makeQuantitySample(type: .oxygenSaturation, value: 0.95,
                                        unit: HKUnit.percent())
        let config = makeBloodOxygenConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result!.value!, 95.0, accuracy: 0.001)
    }
}
final class NormalizeSharedFieldsTests: XCTestCase {
    func testTimestamps_DateToMilliseconds() {
        let start = Date(timeIntervalSince1970: 1700000000.0)
        let end = Date(timeIntervalSince1970: 1700000060.0)
        let sample = makeQuantitySample(type: .heartRate, value: 72.0,
                                        unit: HKUnit(from: "count/min"),
                                        start: start, end: end)
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.startTimestamp, 1700000000000)
        XCTAssertEqual(result?.endTimestamp, 1700000060000)
    }
    func testDuration_60Seconds() {
        let start = Date(timeIntervalSince1970: 1700000000.0)
        let end = Date(timeIntervalSince1970: 1700000060.0)
        let sample = makeQuantitySample(type: .heartRate, value: 72.0,
                                        unit: HKUnit(from: "count/min"),
                                        start: start, end: end)
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertEqual(result?.durationSeconds, 60)
    }
    func testDuration_ZeroDuration() {
        let ts = Date(timeIntervalSince1970: 1700000000.0)
        let sample = makeQuantitySample(type: .heartRate, value: 72.0,
                                        unit: HKUnit(from: "count/min"),
                                        start: ts, end: ts)
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.durationSeconds, 0)
    }
    func testSourceRecordId_UUIDLowercased() {
        let sample = makeQuantitySample()
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.sourceRecordId, sample.uuid.uuidString.lowercased())
    }
    func testMetadata_IncludesHkQuantityType() {
        let sample = makeQuantitySample()
        let config = makeHeartRateConfig()
        let result = HealthNormalization.normalize(sample: sample, config: config,
                                                    userId: "u1", sourceId: "s1")
        XCTAssertNotNil(result?.metadata)
        if let metadataStr = result?.metadata,
           let data = metadataStr.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            XCTAssertEqual(json["hkQuantityType"] as? String, "HKQuantityTypeIdentifierHeartRate")
        } else {
            XCTFail("Metadata should be valid JSON with hkQuantityType")
        }
    }
}
final class NormalizeBatchTests: XCTestCase {
    func testSleepStageBatch_ProducesBasePlusDerived() {
        let sample = makeCategorySample(type: .sleepAnalysis, value: 3,
                                        start: Date(timeIntervalSince1970: 1700000000),
                                        end: Date(timeIntervalSince1970: 1700003600))
        let config = makeSleepStageConfig()
        let result = HealthNormalization.normalizeBatch(samples: [sample], config: config,
                                                         userId: "u1", sourceId: "s1")
        XCTAssertEqual(result.count, 3, "asleepCore should produce base + sleep_duration + sleep_light")
        let base = result[0]
        XCTAssertEqual(base.sampleType, "sleep_stage")
        XCTAssertEqual(base.categoryCode, "light")
        let derivedTypes = Set(result.dropFirst().map { $0.sampleType })
        XCTAssertTrue(derivedTypes.contains("sleep_duration"))
        XCTAssertTrue(derivedTypes.contains("sleep_light"))
    }
    func testAsleepDeep_ProducesDurationAndDeep() {
        let sample = makeCategorySample(type: .sleepAnalysis, value: 4,
                                        start: Date(timeIntervalSince1970: 1700000000),
                                        end: Date(timeIntervalSince1970: 1700003600))
        let config = makeSleepStageConfig()
        let result = HealthNormalization.normalizeBatch(samples: [sample], config: config,
                                                         userId: "u1", sourceId: "s1")
        XCTAssertEqual(result.count, 3)
        let derivedTypes = Set(result.dropFirst().map { $0.sampleType })
        XCTAssertTrue(derivedTypes.contains("sleep_duration"))
        XCTAssertTrue(derivedTypes.contains("sleep_deep"))
    }
    func testInBed_ProducesTimeInBed() {
        let sample = makeCategorySample(type: .sleepAnalysis, value: 0,
                                        start: Date(timeIntervalSince1970: 1700000000),
                                        end: Date(timeIntervalSince1970: 1700003600))
        let config = makeSleepStageConfig()
        let result = HealthNormalization.normalizeBatch(samples: [sample], config: config,
                                                         userId: "u1", sourceId: "s1")
        XCTAssertEqual(result.count, 2, "inBed should produce base + time_in_bed")
        XCTAssertEqual(result[1].sampleType, "time_in_bed")
    }
    func testDerivedSample_SourceRecordIdFormat() {
        let sample = makeCategorySample(type: .sleepAnalysis, value: 3,
                                        start: Date(timeIntervalSince1970: 1700000000),
                                        end: Date(timeIntervalSince1970: 1700003600))
        let config = makeSleepStageConfig()
        let result = HealthNormalization.normalizeBatch(samples: [sample], config: config,
                                                         userId: "u1", sourceId: "s1")
        let baseSrcId = result[0].sourceRecordId
        for derived in result.dropFirst() {
            XCTAssertTrue(derived.sourceRecordId.hasPrefix(baseSrcId + "|"),
                          "Derived sourceRecordId should be baseUuid|metricCode")
        }
    }
    func testDerivedSample_UnitAndValueKind() {
        let sample = makeCategorySample(type: .sleepAnalysis, value: 3,
                                        start: Date(timeIntervalSince1970: 1700000000),
                                        end: Date(timeIntervalSince1970: 1700003600))
        let config = makeSleepStageConfig()
        let result = HealthNormalization.normalizeBatch(samples: [sample], config: config,
                                                         userId: "u1", sourceId: "s1")
        for derived in result.dropFirst() {
            XCTAssertEqual(derived.unit, "min", "Derived sleep samples should have unit 'min'")
            XCTAssertEqual(derived.valueKind, "INTERVAL_NUM", "Derived sleep samples should be INTERVAL_NUM")
        }
    }
}
final class ValidationHelperTests: XCTestCase {
    func testIsValidSourceRecordId_Empty_ReturnsFalse() {
        XCTAssertFalse(HealthNormalization.isValidSourceRecordId(""))
    }
    func testIsValidSourceRecordId_NonEmpty_ReturnsTrue() {
        XCTAssertTrue(HealthNormalization.isValidSourceRecordId("abc"))
    }
    func testAreTimestampsValid_ZeroStart_ReturnsFalse() {
        XCTAssertFalse(HealthNormalization.areTimestampsValid(start: 0, end: 100))
    }
    func testAreTimestampsValid_StartAfterEnd_ReturnsFalse() {
        XCTAssertFalse(HealthNormalization.areTimestampsValid(start: 200, end: 100))
    }
    func testAreTimestampsValid_ValidRange_ReturnsTrue() {
        XCTAssertTrue(HealthNormalization.areTimestampsValid(start: 100, end: 200))
    }
    func testAreTimestampsValid_EqualStartEnd_ReturnsTrue() {
        XCTAssertTrue(HealthNormalization.areTimestampsValid(start: 100, end: 100))
    }
}
