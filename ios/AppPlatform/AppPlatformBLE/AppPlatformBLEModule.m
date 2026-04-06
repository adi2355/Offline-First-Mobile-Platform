//
//  AppDeviceBLEModule.m
//  AppDeviceBLE
//
//  Objective-C bridge for AppDeviceBLEModule.swift.
//  This file exposes Swift methods to React Native's bridge.
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

/// Objective-C interface for AppDeviceBLE React Native module.
/// Methods defined here are exposed to JavaScript.
@interface RCT_EXTERN_MODULE(AppDeviceBLE, RCTEventEmitter)

// MARK: - Scanning

/// Start scanning for App Device devices.
/// @param broadScan If YES, scan without UUID filter (foreground only on iOS).
RCT_EXTERN_METHOD(startScan:(BOOL)broadScan)

/// Stop scanning for devices.
RCT_EXTERN_METHOD(stopScan)

// MARK: - Connection

/// Connect to a device by UUID.
/// @param uuid The peripheral's UUID as a string.
RCT_EXTERN_METHOD(connect:(NSString *)uuid)

/// Disconnect from the current device.
RCT_EXTERN_METHOD(disconnect)

// MARK: - Data Transfer

/// Write data to the connected device.
/// Returns a promise that resolves if the write was accepted, rejects if rejected.
/// Cross-platform parity: matches Android's Promise-based write semantics.
/// @param base64Data Base64-encoded data string.
RCT_EXTERN_METHOD(write:(NSString *)base64Data
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// MARK: - State Query

/// Get the current connection state.
/// Returns a promise that resolves with the current state.
RCT_EXTERN_METHOD(getConnectionState:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// MARK: - System Integration

/// Check for system-connected devices.
/// Call this on app foreground or startup.
RCT_EXTERN_METHOD(checkSystemConnections)

/// Set known peripheral IDs from app storage.
/// @param ids Array of peripheral UUID strings.
RCT_EXTERN_METHOD(setKnownPeripheralIds:(NSArray<NSString *> *)ids)

/// Signal that the device has sent MSG_SLEEP.
RCT_EXTERN_METHOD(setDeviceSleepFlag)

// MARK: - Diagnostics

/// Get buffer diagnostics for debugging.
RCT_EXTERN_METHOD(getBufferDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
