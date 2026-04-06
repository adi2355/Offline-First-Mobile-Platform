//
//  KeychainWipeModule.m
//  AppPlatform
//
//  Objective-C bridge for KeychainWipeModule.swift.
//  Exposes the Keychain wipe method to React Native's JavaScript bridge.
//
//  Created for AppPlatform to fix TestFlight crash-on-reinstall issues.
//

#import <React/RCTBridgeModule.h>

/// Objective-C interface for KeychainWipe React Native module.
/// Exposes Swift methods to JavaScript.
@interface RCT_EXTERN_MODULE(KeychainWipe, NSObject)

/// Wipe all Keychain items for this app.
/// Returns a promise that resolves with { success: true } or rejects with error.
RCT_EXTERN_METHOD(wipeKeychain:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
