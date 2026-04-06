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
final class HealthKitQueries {
    private let healthStore: HKHealthStore
    private let metricCatalog: [String: NativeMetricConfig]
    init(healthStore: HKHealthStore, metricCatalog: [String: NativeMetricConfig]) {
        self.healthStore = healthStore
        self.metricCatalog = metricCatalog
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
    @discardableResult
    func queryRecentSamples(
        metricCode: String,
        startDate: Date,
        endDate: Date,
        limit: Int,
        completion: @escaping (Result<[HKSample], Error>) -> Void
    ) -> HKQuery? {
        guard let config = metricCatalog[metricCode] else {
            completion(.failure(HealthKitQueryError.invalidMetricCode(metricCode)))
            return nil
        }
        guard let sampleType = config.resolveHKSampleType() else {
            completion(.failure(HealthKitQueryError.invalidSampleType(config.hkIdentifier)))
            return nil
        }
        let predicate = HKQuery.predicateForSamples(
            withStart: startDate,
            end: endDate,
            options: .strictStartDate
        )
        let sortDescriptor = NSSortDescriptor(
            key: HKSampleSortIdentifierStartDate,
            ascending: false
        )
        let query = HKSampleQuery(
            sampleType: sampleType,
            predicate: predicate,
            limit: limit,
            sortDescriptors: [sortDescriptor]
        ) { _, samples, error in
            if let error = error {
                completion(.failure(error))
            } else {
                completion(.success(samples ?? []))
            }
        }
        healthStore.execute(query)
        return query
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
    @discardableResult
    func queryColdChunk(
        metricCode: String,
        chunkStartDate: Date,
        chunkEndDate: Date,
        limit: Int,
        completion: @escaping (Result<[HKSample], Error>) -> Void
    ) -> HKQuery? {
        guard let config = metricCatalog[metricCode] else {
            completion(.failure(HealthKitQueryError.invalidMetricCode(metricCode)))
            return nil
        }
        guard let sampleType = config.resolveHKSampleType() else {
            completion(.failure(HealthKitQueryError.invalidSampleType(config.hkIdentifier)))
            return nil
        }
        let predicate = HKQuery.predicateForSamples(
            withStart: chunkStartDate,
            end: chunkEndDate,
            options: .strictStartDate
        )
        let sortDescriptor = NSSortDescriptor(
            key: HKSampleSortIdentifierStartDate,
            ascending: true
        )
        let query = HKSampleQuery(
            sampleType: sampleType,
            predicate: predicate,
            limit: limit,
            sortDescriptors: [sortDescriptor]
        ) { _, samples, error in
            if let error = error {
                completion(.failure(error))
            } else {
                completion(.success(samples ?? []))
            }
        }
        healthStore.execute(query)
        return query
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
    @discardableResult
    func queryChanges(
        metricCode: String,
        anchorData: String?,
        limit: Int,
        completion: @escaping (Result<ChangeQueryResult, Error>) -> Void
    ) -> HKQuery? {
        guard let config = metricCatalog[metricCode] else {
            completion(.failure(HealthKitQueryError.invalidMetricCode(metricCode)))
            return nil
        }
        guard let sampleType = config.resolveHKSampleType() else {
            completion(.failure(HealthKitQueryError.invalidSampleType(config.hkIdentifier)))
            return nil
        }
        let anchor: HKQueryAnchor?
        if let anchorData = anchorData {
            anchor = Self.deserializeAnchor(anchorData)
        } else {
            anchor = nil 
        }
        let query = HKAnchoredObjectQuery(
            type: sampleType,
            predicate: nil,
            anchor: anchor,
            limit: limit
        ) { [weak self] _, addedSamples, deletedObjects, newAnchor, error in
            guard self != nil else { return }
            if let error = error {
                completion(.failure(error))
                return
            }
            let serializedAnchor: String?
            if let newAnchor = newAnchor {
                serializedAnchor = Self.serializeAnchor(newAnchor)
            } else {
                serializedAnchor = nil
            }
            let deletedUUIDs = (deletedObjects ?? []).map { $0.uuid.uuidString.lowercased() }
            let result = ChangeQueryResult(
                addedSamples: addedSamples ?? [],
                deletedUUIDs: deletedUUIDs,
                serializedAnchor: serializedAnchor,
                hasMore: (addedSamples?.count ?? 0) >= limit || (deletedObjects?.count ?? 0) >= limit
            )
            completion(.success(result))
        }
        healthStore.execute(query)
        return query
    }
    /
    /
    /
    static func serializeAnchor(_ anchor: HKQueryAnchor) -> String? {
        do {
            let data = try NSKeyedArchiver.archivedData(
                withRootObject: anchor,
                requiringSecureCoding: true
            )
            return data.base64EncodedString()
        } catch {
            NSLog("[HealthKitQueries] Failed to serialize anchor: %@", error.localizedDescription)
            return nil
        }
    }
    /
    static func deserializeAnchor(_ base64String: String) -> HKQueryAnchor? {
        guard let data = Data(base64Encoded: base64String) else {
            NSLog("[HealthKitQueries] Failed to decode anchor base64")
            return nil
        }
        do {
            let anchor = try NSKeyedUnarchiver.unarchivedObject(
                ofClass: HKQueryAnchor.self,
                from: data
            )
            return anchor
        } catch {
            NSLog("[HealthKitQueries] Failed to deserialize anchor: %@", error.localizedDescription)
            return nil
        }
    }
    /
    func isAvailable() -> Bool {
        return HKHealthStore.isHealthDataAvailable()
    }
    /
    func checkAuthorizationStatus() -> [String: HKAuthorizationStatus] {
        var statuses: [String: HKAuthorizationStatus] = [:]
        for (metricCode, config) in metricCatalog {
            if let sampleType = config.resolveHKSampleType() {
                statuses[metricCode] = healthStore.authorizationStatus(for: sampleType)
            }
        }
        return statuses
    }
}
/
struct ChangeQueryResult {
    /
    let addedSamples: [HKSample]
    /
    let deletedUUIDs: [String]
    /
    let serializedAnchor: String?
    /
    let hasMore: Bool
}
/
enum HealthKitQueryError: Error, LocalizedError {
    case invalidMetricCode(String)
    case invalidSampleType(String)
    case unauthorized
    case unavailable
    var errorDescription: String? {
        switch self {
        case .invalidMetricCode(let code):
            return "Invalid metric code: \(code)"
        case .invalidSampleType(let identifier):
            return "Could not resolve HKSampleType for: \(identifier)"
        case .unauthorized:
            return "HealthKit authorization not granted"
        case .unavailable:
            return "HealthKit is not available on this device"
        }
    }
}
