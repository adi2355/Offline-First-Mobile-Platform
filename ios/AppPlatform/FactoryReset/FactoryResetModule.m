//
//  FactoryResetModule.m
//  AppPlatform
//
//  Objective-C bridge for FactoryResetModule.swift.
//  Exposes factory reset methods to React Native's JavaScript bridge.
//
//  Created for AppPlatform to fix TestFlight crash-on-reinstall issues.
//

#import <React/RCTBridgeModule.h>

/// Objective-C interface for FactoryReset React Native module.
/// Exposes Swift methods to JavaScript.
@interface RCT_EXTERN_MODULE(FactoryReset, NSObject)

/// Wipe SQLite database and all sidecar files.
/// Wipes the entire Documents/SQLite directory for a complete reset.
/// Returns a promise that resolves with { success: true } or rejects with error.
RCT_EXTERN_METHOD(wipeSQLite:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

/// Wipe AsyncStorage directory.
/// Returns a promise that resolves with { success: true } or rejects with error.
RCT_EXTERN_METHOD(wipeAsyncStorageRN:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

/// Wipe all local storage (SQLite + AsyncStorage).
/// This is the JS-callable equivalent of the native reinstall reset.
/// Returns a promise that resolves with { success: true } or rejects with error.
RCT_EXTERN_METHOD(wipeAll:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
