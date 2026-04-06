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
final class HealthNormalization {
    /
    /
    /
    /
    /
    /
    /
    /
    /
    static func mapSleepCategory(_ value: Int) -> String? {
        switch value {
        case 0: return "unknown"   
        case 1: return "unknown"   
        case 2: return "awake"     
        case 3: return "light"     
        case 4: return "deep"      
        case 5: return "rem"       
        default:
            NSLog("[HealthNormalization] Unknown sleep category value: %d", value)
            return nil
        }
    }
    /
    /
    /
    /
    static func applyMetricValueTransform(metricCode: String, value: Double) -> Double {
        if metricCode == "blood_oxygen", value >= 0.0, value <= 1.0 {
            return value * 100.0
        }
        return value
    }
    /
    private static func buildDerivedSourceRecordId(_ base: String, metricCode: String) -> String {
        return "\(base)|\(metricCode)"
    }
    /
    /
    /
    /
    /
    static func expandSleepStageDeletionIds(_ baseIds: [String]) -> [String] {
        if baseIds.isEmpty { return [] }
        let derivedCodes = [
            "time_in_bed",
            "sleep_duration",
            "sleep_awake",
            "sleep_light",
            "sleep_deep",
            "sleep_rem",
        ]
        var seen = Set<String>()
        var expanded: [String] = []
        for baseId in baseIds {
            if !seen.contains(baseId) {
                seen.insert(baseId)
                expanded.append(baseId)
            }
            for code in derivedCodes {
                let derivedId = buildDerivedSourceRecordId(baseId, metricCode: code)
                if !seen.contains(derivedId) {
                    seen.insert(derivedId)
                    expanded.append(derivedId)
                }
            }
        }
        return expanded
    }
    /
    /
    /
    /
    private static func normalizeSleepDurationSeconds(
        _ durationSeconds: Int,
        metricCode: String
    ) -> (value: Double, unit: String)? {
        switch metricCode {
        case "sleep_duration", "sleep_awake", "sleep_light", "sleep_deep", "sleep_rem", "time_in_bed":
            if durationSeconds <= 0 { return nil }
            return (value: Double(durationSeconds) / 60.0, unit: "min")
        default:
            return nil
        }
    }
    /
    /
    /
    private static func deriveSleepIntervals(
        from sample: HKCategorySample,
        baseSourceRecordId: String,
        userId: String,
        sourceId: String,
        metadata: String?,
        deviceId: String?,
        externalUuid: String?,
        timestampMs: Int64
    ) -> [NormalizedHealthSample] {
        let startTimestamp = Int64(sample.startDate.timeIntervalSince1970 * 1000)
        let endTimestamp = Int64(sample.endDate.timeIntervalSince1970 * 1000)
        guard startTimestamp > 0, endTimestamp > 0, startTimestamp <= endTimestamp else {
            return []
        }
        let durationMs = endTimestamp - startTimestamp
        let durationSeconds = durationMs > 0
            ? Int(round(Double(durationMs) / 1000.0))
            : 0
        if durationSeconds <= 0 {
            return []
        }
        func buildIntervalSample(metricCode: String) -> NormalizedHealthSample? {
            guard let normalized = normalizeSleepDurationSeconds(durationSeconds, metricCode: metricCode) else {
                return nil
            }
            return NormalizedHealthSample(
                id: UUID().uuidString.lowercased(),
                userId: userId,
                sourceId: sourceId,
                sourceRecordId: buildDerivedSourceRecordId(baseSourceRecordId, metricCode: metricCode),
                sampleType: metricCode,
                valueKind: HealthValueKind.intervalNum.rawValue,
                startTimestamp: startTimestamp,
                endTimestamp: endTimestamp,
                value: normalized.value,
                unit: normalized.unit,
                categoryCode: nil,
                durationSeconds: durationSeconds,
                deviceId: deviceId,
                externalUuid: externalUuid,
                metadata: metadata,
                timestampMs: timestampMs
            )
        }
        var derived: [NormalizedHealthSample] = []
        switch sample.value {
        case 0: 
            if let interval = buildIntervalSample(metricCode: "time_in_bed") { derived.append(interval) }
        case 1: 
            if let interval = buildIntervalSample(metricCode: "sleep_duration") { derived.append(interval) }
        case 2: 
            if let interval = buildIntervalSample(metricCode: "sleep_awake") { derived.append(interval) }
        case 3: 
            if let duration = buildIntervalSample(metricCode: "sleep_duration") { derived.append(duration) }
            if let stage = buildIntervalSample(metricCode: "sleep_light") { derived.append(stage) }
        case 4: 
            if let duration = buildIntervalSample(metricCode: "sleep_duration") { derived.append(duration) }
            if let stage = buildIntervalSample(metricCode: "sleep_deep") { derived.append(stage) }
        case 5: 
            if let duration = buildIntervalSample(metricCode: "sleep_duration") { derived.append(duration) }
            if let stage = buildIntervalSample(metricCode: "sleep_rem") { derived.append(stage) }
        default:
            break
        }
        return derived
    }
    /
    /
    /
    /
    /
    /
    /
    /
    static func normalize(
        sample: HKSample,
        config: NativeMetricConfig,
        userId: String,
        sourceId: String
    ) -> NormalizedHealthSample? {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let startTimestamp = Int64(sample.startDate.timeIntervalSince1970 * 1000)
        let endTimestamp = Int64(sample.endDate.timeIntervalSince1970 * 1000)
        guard startTimestamp > 0, endTimestamp > 0, startTimestamp <= endTimestamp else {
            NSLog("[HealthNormalization] Invalid timestamps for %@: start=%lld, end=%lld",
                  config.metricCode, startTimestamp, endTimestamp)
            return nil
        }
        assert(startTimestamp <= endTimestamp && startTimestamp > 0,
               "Timestamps passed validation but are invalid: start=\(startTimestamp) end=\(endTimestamp)")
        let sourceRecordId = sample.uuid.uuidString.lowercased()
        let durationSeconds: Int
        let durationMs = endTimestamp - startTimestamp
        if durationMs > 0 {
            durationSeconds = Int(round(Double(durationMs) / 1000.0))
        } else {
            durationSeconds = 0
        }
        let deviceId = sample.device?.localIdentifier
        let externalUuid = (sample.metadata?[HKMetadataKeyExternalUUID] as? String)
        let metadata = buildMetadataJSON(from: sample, config: config)
        let value: Double?
        let unit: String?
        let categoryCode: String?
        if config.isCategory && config.valueKind == .category {
            guard let categorySample = sample as? HKCategorySample else {
                return nil
            }
            value = nil
            unit = nil
            if config.metricCode == "sleep_stage" {
                categoryCode = mapSleepCategory(categorySample.value)
                guard categoryCode != nil else { return nil }
            } else {
                categoryCode = String(categorySample.value)
            }
        } else if config.isCategory {
            guard let categorySample = sample as? HKCategorySample else {
                return nil
            }
            let numericValue = Double(categorySample.value)
            if let minBound = config.minBound, numericValue < minBound {
                return nil
            }
            if let maxBound = config.maxBound, numericValue > maxBound {
                return nil
            }
            guard numericValue.isFinite else {
                NSLog("[HealthNormalization] Non-finite hybrid category value for %@: %f",
                      config.metricCode, numericValue)
                return nil
            }
            value = numericValue
            unit = config.canonicalUnit ?? config.queryUnit
            categoryCode = nil
        } else {
            guard let quantitySample = sample as? HKQuantitySample else {
                return nil
            }
            guard let hkUnit = config.resolveHKUnit() else {
                NSLog("[HealthNormalization] Cannot resolve unit for %@", config.metricCode)
                return nil
            }
        var rawValue = quantitySample.quantity.doubleValue(for: hkUnit)
        rawValue = applyMetricValueTransform(metricCode: config.metricCode, value: rawValue)
        if let minBound = config.minBound, rawValue < minBound {
            return nil 
        }
            if let maxBound = config.maxBound, rawValue > maxBound {
                return nil 
            }
        guard rawValue.isFinite else {
            NSLog("[HealthNormalization] Non-finite value for %@: %f", config.metricCode, rawValue)
            return nil
        }
            value = rawValue
            unit = config.canonicalUnit ?? config.queryUnit
            categoryCode = nil
        }
        let id = UUID().uuidString.lowercased()
        return NormalizedHealthSample(
            id: id,
            userId: userId,
            sourceId: sourceId,
            sourceRecordId: sourceRecordId,
            sampleType: config.metricCode,
            valueKind: config.valueKind.rawValue,
            startTimestamp: startTimestamp,
            endTimestamp: endTimestamp,
            value: value,
            unit: unit,
            categoryCode: categoryCode,
            durationSeconds: durationSeconds,
            deviceId: deviceId,
            externalUuid: externalUuid,
            metadata: metadata,
            timestampMs: now
        )
    }
    /
    /
    /
    static func normalizeBatch(
        samples: [HKSample],
        config: NativeMetricConfig,
        userId: String,
        sourceId: String
    ) -> [NormalizedHealthSample] {
        var result: [NormalizedHealthSample] = []
        for sample in samples {
            guard let normalized = normalize(sample: sample, config: config, userId: userId, sourceId: sourceId) else {
                continue
            }
            result.append(normalized)
            if config.metricCode == "sleep_stage",
               config.isCategory,
               config.valueKind == .category,
               let categorySample = sample as? HKCategorySample {
                let derived = deriveSleepIntervals(
                    from: categorySample,
                    baseSourceRecordId: normalized.sourceRecordId,
                    userId: userId,
                    sourceId: sourceId,
                    metadata: normalized.metadata,
                    deviceId: normalized.deviceId,
                    externalUuid: normalized.externalUuid,
                    timestampMs: normalized.timestampMs
                )
                if !derived.isEmpty {
                    result.append(contentsOf: derived)
                }
            }
        }
        #if DEBUG
        let sourceIds = result.map { $0.sourceRecordId }
        assert(Set(sourceIds).count == sourceIds.count,
               "normalizeBatch produced duplicate sourceRecordIds: \(sourceIds.count) total, \(Set(sourceIds).count) unique")
        #endif
        return result
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
    private static func buildMetadataJSON(from sample: HKSample, config: NativeMetricConfig) -> String? {
        var metadata: [String: Any] = [:]
        let bundleId = sample.sourceRevision.source.bundleIdentifier
        if !bundleId.isEmpty {
            metadata["sourceAppId"] = bundleId
        }
        if let version = sample.sourceRevision.version {
            metadata["sourceAppVersion"] = version
        }
        if let device = sample.device {
            if let manufacturer = device.manufacturer {
                metadata["deviceManufacturer"] = manufacturer
            }
            if let model = device.hardwareVersion ?? device.model {
                metadata["deviceModel"] = model
            }
            if let swVersion = device.softwareVersion {
                metadata["osVersion"] = swVersion
            }
        }
        let os = sample.sourceRevision.operatingSystemVersion
        if os.majorVersion > 0 {
            metadata["osVersion"] = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        }
        metadata["osName"] = "iOS"
        if config.isCategory {
            metadata["hkCategoryType"] = config.hkIdentifier
        } else {
            metadata["hkQuantityType"] = config.hkIdentifier
        }
        if let wasUserEntered = sample.metadata?[HKMetadataKeyWasUserEntered] as? Bool, wasUserEntered {
            metadata["isManualEntry"] = true
            metadata["dataSource"] = "manual"
        }
        if metadata.isEmpty {
            return nil
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: metadata, options: [])
            return String(data: data, encoding: .utf8)
        } catch {
            NSLog("[HealthNormalization] Failed to serialize metadata: %@", error.localizedDescription)
            return nil
        }
    }
    /
    /
    /
    static func isValidSourceRecordId(_ id: String) -> Bool {
        return !id.isEmpty
    }
    /
    static func areTimestampsValid(start: Int64, end: Int64) -> Bool {
        return start > 0 && end > 0 && start <= end
    }
}
