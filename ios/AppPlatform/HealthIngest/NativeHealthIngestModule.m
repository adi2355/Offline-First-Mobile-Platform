#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// =============================================================================
// ObjC Bridge for NativeHealthIngest Swift Module
//
// CRITICAL: Method signatures MUST match NativeHealthIngestModuleType
// in NativeHealthIngestionDriver.ts:67-137.
//
// Each RCT_EXTERN_METHOD maps 1:1 to a Swift @objc func in
// NativeHealthIngestModule.swift.
//
// @see NativeHealthIngestionDriver.ts for the TypeScript bridge caller
// @see services-b-analyst report for exact bridge declarations
// =============================================================================

@interface RCT_EXTERN_MODULE(NativeHealthIngest, RCTEventEmitter)

// initialize(config: NSDictionary) -> Promise<boolean>
RCT_EXTERN_METHOD(initialize:(NSDictionary *)config
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// ingestHot(userId, sourceId, metricCodes, budgetMs) -> Promise<NativeLaneResultRaw>
RCT_EXTERN_METHOD(ingestHot:(NSString *)userId
                  sourceId:(NSString *)sourceId
                  metricCodes:(NSArray *)metricCodes
                  budgetMs:(nonnull NSNumber *)budgetMs
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// ingestCold(userId, sourceId, chunkBudgetMs, maxChunks) -> Promise<NativeLaneResultRaw>
RCT_EXTERN_METHOD(ingestCold:(NSString *)userId
                  sourceId:(NSString *)sourceId
                  chunkBudgetMs:(nonnull NSNumber *)chunkBudgetMs
                  maxChunks:(nonnull NSNumber *)maxChunks
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// ingestChanges(userId, sourceId) -> Promise<NativeLaneResultRaw>
RCT_EXTERN_METHOD(ingestChanges:(NSString *)userId
                  sourceId:(NSString *)sourceId
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// cancelHot() -> void (synchronous, no resolver)
// Called by JS bridge timeout to stop orphaned native hot lane work.
RCT_EXTERN_METHOD(cancelHot)

// cancelCold() -> void (synchronous, no resolver)
RCT_EXTERN_METHOD(cancelCold)

// cancelChanges() -> void (synchronous, no resolver)
// Called by JS bridge timeout to stop orphaned native change lane work.
RCT_EXTERN_METHOD(cancelChanges)

// isHealthKitAvailable() -> Promise<boolean>
RCT_EXTERN_METHOD(isHealthKitAvailable:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// getLaneStatuses() -> Promise<{ hot: LaneStatus, cold: LaneStatus, change: LaneStatus }>
RCT_EXTERN_METHOD(getLaneStatuses:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// setBackgroundDeliveryEnabled(enabled: Bool) -> Promise<boolean>
RCT_EXTERN_METHOD(setBackgroundDeliveryEnabled:(BOOL)enabled
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// clearCredentialsAndStopDelivery() -> Promise<boolean>
// CRITICAL: Called on user logout to prevent background delivery under stale credentials.
// Clears stored userId/sourceId, stops HK observer queries, disables background delivery.
RCT_EXTERN_METHOD(clearCredentialsAndStopDelivery:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
