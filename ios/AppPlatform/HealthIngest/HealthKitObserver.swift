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
@objc
final class HealthKitObserver: NSObject {
    @objc static let shared = HealthKitObserver()
    private let healthStore = HKHealthStore()
    private var registeredQueries: [HKObserverQuery] = []
    private var isRegistered = false
    /
    /
    var onBackgroundUpdate: ((_ sampleType: String, _ completionHandler: @escaping () -> Void) -> Void)?
    /
    /
    /
    /
    /
    /
    @objc
    func registerObservers(sampleTypes: [HKSampleType]) {
        guard !isRegistered else {
            NSLog("[HealthKitObserver] Already registered, skipping")
            return
        }
        guard HKHealthStore.isHealthDataAvailable() else {
            NSLog("[HealthKitObserver] HealthKit not available, skipping observer registration")
            return
        }
        for sampleType in sampleTypes {
            let query = HKObserverQuery(sampleType: sampleType, predicate: nil) {
                [weak self] query, completionHandler, error in
                guard let self = self else {
                    completionHandler()
                    return
                }
                if let error = error {
                    NSLog("[HealthKitObserver] Observer query error for %@: %@",
                          sampleType.identifier, error.localizedDescription)
                    completionHandler()
                    return
                }
                NSLog("[HealthKitObserver] Background delivery for %@", sampleType.identifier)
                if let handler = self.onBackgroundUpdate {
                    handler(sampleType.identifier) {
                        completionHandler()
                    }
                } else {
                    completionHandler()
                }
            }
            healthStore.execute(query)
            registeredQueries.append(query)
            healthStore.enableBackgroundDelivery(
                for: sampleType,
                frequency: .immediate
            ) { success, error in
                if let error = error {
                    NSLog("[HealthKitObserver] Failed to enable background delivery for %@: %@",
                          sampleType.identifier, error.localizedDescription)
                } else if success {
                    NSLog("[HealthKitObserver] Background delivery enabled for %@", sampleType.identifier)
                }
            }
        }
        isRegistered = true
        NSLog("[HealthKitObserver] Registered %d observer queries", sampleTypes.count)
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
    /
    @objc
    func registerDefaultObservers() {
        let isEnabled = UserDefaults.standard.object(forKey: "healthBackgroundDeliveryEnabled") as? Bool ?? false
        if !isEnabled {
            NSLog("[HealthKitObserver] Background delivery not enabled (UserDefaults unset or false), skipping observer registration")
            return
        }
        var sampleTypes: [HKSampleType] = []
        let vitalIdentifiers: [HKQuantityTypeIdentifier] = [
            .heartRate,
            .heartRateVariabilitySDNN,
            .restingHeartRate,
            .oxygenSaturation,
            .respiratoryRate,
            .bodyTemperature,
        ]
        let activityIdentifiers: [HKQuantityTypeIdentifier] = [
            .stepCount,
            .distanceWalkingRunning,
            .activeEnergyBurned,
            .basalEnergyBurned,
            .flightsClimbed,
            .appleExerciseTime,
        ]
        for identifier in vitalIdentifiers + activityIdentifiers {
            if let type = HKObjectType.quantityType(forIdentifier: identifier) {
                sampleTypes.append(type)
            }
        }
        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            sampleTypes.append(sleepType)
        }
        registerObservers(sampleTypes: sampleTypes)
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
    func stopObservers() {
        for query in registeredQueries {
            healthStore.stop(query)
        }
        registeredQueries.removeAll()
        isRegistered = false
        disableAllBackgroundDelivery()
        NSLog("[HealthKitObserver] Stopped all observer queries and disabled background delivery")
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
    private func disableAllBackgroundDelivery() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        healthStore.disableAllBackgroundDelivery { success, error in
            if let error = error {
                NSLog("[HealthKitObserver] Failed to disable all background delivery: %@",
                      error.localizedDescription)
            } else if success {
                NSLog("[HealthKitObserver] All background delivery disabled via HKHealthStore")
            }
        }
    }
}
