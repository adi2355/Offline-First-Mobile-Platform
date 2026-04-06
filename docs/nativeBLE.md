# Native iOS / Android BLE Subsystem

## Overview

The BLE subsystem in the AppPlatform app is a native-integrated, resilient device communication layer. It features a deeply embedded iOS-native CoreBluetooth runtime, a robust React Native bridge for cross-platform eventing, and a sophisticated TypeScript orchestration layer that intelligently selects between native transport and a `react-native-ble-plx` fallback. This architecture is designed for high reliability, especially under demanding mobile OS lifecycle constraints.

> **Scope:** This document covers the iOS native BLE runtime, the React Native bridge module, the TypeScript integration and orchestration layer, the dual-transport selection strategy, the custom binary application protocol, and mechanisms for background operation and reconnection. For related subsystems, see [Related Documents](#related-documents) at the end.

---

## Why Native BLE Exists in This System

The decision for a deeply integrated native BLE runtime on iOS is driven by two critical mobile operating system realities:

### CoreBluetooth State Restoration Requirements

React Native's native modules are typically initialized lazily. However, iOS's CoreBluetooth provides state restoration, requiring `CBCentralManager` to be created *early* in the app lifecycle (with `CBCentralManagerOptionRestoreIdentifierKey`) for `centralManager:willRestoreState:` to be delivered. A purely JS-driven, lazy initialization would miss this critical window, leading to lost connection state and an unreliable user experience.

> **Goal:** Meet strict OS timing constraints without coupling platform correctness to bridge availability.

<details>
<summary><strong>AppDeviceBLEInitializer.swift — Initialization Comment</strong></summary>
<br>

```swift
// iOS State Restoration for CoreBluetooth requires CBCentralManager to be
// created with the same restoration identifier BEFORE iOS tries to restore state.
// React Native creates native module instances LAZILY...
// ...CBCentralManager doesn't exist → willRestoreState callback is missed
// SOLUTION: This initializer is called from AppDelegate's didFinishLaunchingWithOptions
```

</details>

### Background Operation and Resilient Reconnection

Mobile OSes impose strict limitations on background app execution. A native, early-initialized BLE runtime ensures persistent connection management and reliable event delivery, allowing the OS to manage BLE connections and handle reconnections without constant, unreliable JavaScript intervention.

> **Goal:** A native, early-initialized runtime ensures BLE connections survive app termination and background transitions without JavaScript availability.

---

## Architecture

The BLE subsystem is structured in distinct, interacting layers, designed for modularity and platform resilience:

<div align="center">
  <img src="../media/diagrams/nativeble.svg" alt="Native BLE Subsystem Architecture" width="100%" />
</div>

<br>

**Layered Design:**

| Layer | Component | Responsibility |
| :--- | :--- | :--- |
| **Native Transport** | `AppDeviceBLECore.swift` | Singleton `CBCentralManager` owner. State restoration, GATT discovery, MTU negotiation, explicit disconnect classification (`bondingLost`, `encryptionFailed`, `deviceSleep`). |
| **Bridge** | `AppDeviceBLEModule.swift` | `RCTEventEmitter` with `EventBuffer` for buffered delivery when JS listeners are absent. Overflow reporting via `onBufferOverflow`. |
| **JS Integration** | `AppDeviceBLE.ts` / `useAppDeviceBLEIntegration.ts` | Type-safe wrapper and React hook forwarding native events to `BluetoothHandler`. |
| **Protocol** | `AppDeviceProtocolService.ts` | Custom binary frames with CRC16 checksums, sequence numbers, ACK/NACK, and event deduplication by `eventId`. |
| **Orchestration** | `BluetoothService.ts` / `BLERestorationService.ts` | High-level scanning, connection, reconnection with backoff, dormant mode, and device lifecycle management via `OutboxRepository`. |

**Event Flow:** `AppDeviceBLECore` → `AppDeviceBLEModule` (RCTEventEmitter) → `useAppDeviceBLEIntegration` hook → `BluetoothHandler` → `BluetoothService` and `AppDeviceProtocolService`.

> **Guarantee:** BLE connections survive app termination. Native events are buffered until the JS bridge is ready. No events are silently dropped.

---

## iOS Lifecycle and Early Initialization

The foundation of robust iOS BLE is the precise timing of its initialization:

*   **`AppDelegate.mm` Integration** — Calls `[AppDeviceBLEInitializer initializeBLECore]` *before* the React Native bridge or any other major framework.
*   **`AppDeviceBLEInitializer.swift`** — Ensures the `AppDeviceBLECore` singleton is instantiated, configuring `CBCentralManager` with `CBCentralManagerOptionRestoreIdentifierKey`.
*   **Restoration Readiness** — Guarantees the `centralManager:willRestoreState:` callback is enabled from the earliest app launch, vital for background operations and connection persistence.

---

## iOS Native BLE Runtime

The core of the native BLE implementation on iOS resides within `AppDeviceBLECore.swift`, acting as the authoritative layer:

*   **Singleton Ownership** — `AppDeviceBLECore` is a shared singleton, owning and managing the single `CBCentralManager` instance.
*   **CoreBluetooth Delegation** — Implements `CBCentralManagerDelegate` and `CBPeripheralDelegate` for all BLE events.
*   **Restoration Identifier** — Configured with `CBCentralManagerOptionRestoreIdentifierKey` and implements `centralManager:willRestoreState:` to re-adopt system-connected peripherals.
*   **Explicit State Machine** — Maintains a clear `ConnectionState` machine (`DISCONNECTED` to `READY`) with defined transitions, timeouts, and disconnect reason classification.
*   **Resilience Mechanisms** — Includes logic to `classifyDisconnectReason` (e.g., inspecting `CBError.code` for GATT faults), `cancelAllTimers`, and `reconcileSystemConnections()` for robust connection management.

> **Guarantee:** Native singleton initialization before the React Native bridge ensures `willRestoreState` is never missed.

---

## React Native Bridge Design

The `AppDeviceBLEModule.swift` bridge is designed for reliability and robust event delivery:

*   **`RCTEventEmitter`** — Exposes native Swift events to JavaScript.
*   **Exposed Operations** — Provides synchronous (e.g., `startScan`, `disconnect`) and asynchronous (e.g., `write`, `getConnectionState`) methods.
*   **Buffered Event Delivery (`EventBuffer`)** — Stores native events (`onConnectionStateChange`, `onDataReceived`) when JavaScript listeners are absent (e.g., during startup or background).
*   **Overflow Reporting (`onBufferOverflow`)** — If the `EventBuffer` overflows, it drops the oldest event and explicitly emits an `onBufferOverflow` event, signaling potential data loss to JavaScript for higher-level recovery.
*   **Listener Lifecycle** — `startObserving()` flushes buffered events, `stopObserving()` pauses buffering.
*   **Fail-Fast Operations** — Emits `onOperationRejected` events for synchronous rejections (e.g., `connect` while Bluetooth is not ready), allowing immediate JS reaction.

> **Guarantee:** No native BLE events are silently dropped. Events are either delivered or reported as overflow.

---

## TypeScript Native Integration

The JavaScript layer integrates with the native module via `src/native/AppDeviceBLE.ts` and `src/native/useAppDeviceBLEIntegration.ts`:

*   **`AppDeviceBLENative.ts` Wrapper** — A thin, type-safe TypeScript wrapper around the `NativeModules.AppDeviceBLE` object.
*   **`useAppDeviceBLEIntegration.ts` Hook** — The primary integration point:
    *   **Synchronous Subscriptions** — Registers native event listeners *synchronously* early in the JS lifecycle to prevent missing events.
    *   **Asynchronous Reconciliation** — Performs tasks like `syncKnownDevices` (to share stored device IDs with native) and `AppDeviceBLENative.checkSystemConnections()` (to reconcile OS-level active connections).
    *   **State Mirroring** — Translates native `ConnectionStateEvent`s into `BluetoothHandler`'s state updates, ensuring JS mirrors the native runtime.
    *   **Protocol Data Routing** — Routes `onDataReceived` events directly to `AppDeviceProtocolService.onDataReceived()` for binary protocol processing.

---

## BLE Orchestration Above the Transport

Above the raw BLE transport, TypeScript services (`src/services/ble/`) orchestrate higher-level device communication:

*   **`BluetoothHandler` (`BluetoothContext.tsx`)** — The central JS singleton. Manages dual-transport selection, `ConnectionState`, reconnection logic, and dispatches data to other protocol services.
*   **`BluetoothService`** — Provides application-level device management APIs (discovery, persistence).
*   **`BLERestorationService`** — Handles application-level device/session state restoration.
*   **`EventSyncService` (`src/services/ble/EventSyncService.ts`)** — Manages event-level synchronization (e.g., `lastEventId`, `timeSyncAnchor`, handshake flow), processing hit events asynchronously.
*   **`DeviceSettingsService` (`src/services/ble/DeviceSettingsService.ts`)** — Manages device settings (e.g., `sensitivity`) with optimistic updates, debounce, and factory reset detection.
*   **OTA Integration** — Services like `OtaPostUpdateVerifier` integrate with `BluetoothHandler` for post-firmware-update connection and verification.

---

## Transport Selection and Platform Differences

The architecture uses a dynamic transport selection strategy:

*   **`shouldUseNativeTransport()` (`src/services/ble/transport/index.ts`)** — Determines whether the `AppDeviceBLE` native module (iOS) is available.
*   **iOS Native Path** — When available, `BluetoothHandler` delegates core BLE operations to the Swift-based native module for deep CoreBluetooth integration.
*   **`react-native-ble-plx` Fallback Path** — For Android and as a general fallback, `BluetoothHandler` directly manages `BleManager` from `react-native-ble-plx`.

<details>
<summary><strong>Transport Comparison: iOS Native vs. Android / Fallback</strong></summary>
<br>

| Feature | iOS Native Path (`AppDeviceBLECore.swift`) | Android / Fallback (`react-native-ble-plx`) |
| :--- | :--- | :--- |
| **Core Bluetooth Ownership** | `AppDeviceBLECore` singleton owns `CBCentralManager` | `BluetoothHandler` owns `BleManager` |
| **State Restoration** | Explicit `CBCentralManagerOptionRestoreIdentifierKey` & `willRestoreState` | `BleManager`'s `restoreStateIdentifier` & `restoreStateFunction` |
| **Native Bridge Depth** | Deep, custom Swift module (`AppDeviceBLEModule`) | Thin JS wrapper around `BleManager`'s JS API |
| **Primary Transport** | Yes (leveraged for iOS-specific resilience) | Yes (primary transport for Android) |
| **Event Buffering** | `AppDeviceBLEModule` has `EventBuffer` with overflow handling | Not directly in `BleManager` (handled by higher JS layers) |
| **Reconnection Logic** | Native timers, `isManualDisconnect`, `reconcileSystemConnections` | JS timers, `isDormantReconnectionMode`, `circuitBreaker` |
| **Sleep Disconnect** | Explicit Swift override of false bonding errors | JS heuristic + flags (`isSleepDisconnect`) |
| **Proof Strength** | Very Strong (explicit Swift code, AppDelegate integration) | Moderate (relies on `ble-plx` abstraction, JS orchestration) |

</details>

---

## Binary Protocol Boundary

The BLE communication adheres to a custom binary application protocol, defining the communication contract with the APP DEVICE device firmware:

*   **Transport vs. Protocol Separation** — The protocol layer (`AppDeviceProtocolService.ts`, `protocol/`) is distinct from the raw BLE transport.
*   **Framed Binary Messages** — Messages conform to a structured frame (SOF, type, version, sequence, length, CRC16) for robust parsing.
*   **CRC16 for Integrity** — `crc16.ts` implements CRC16-CCITT-FALSE for end-to-end data integrity.
*   **ACK/NACK for Reliable Delivery** — `AppDeviceProtocolService` manages ACK/NACK and retransmission logic. Critical `v2.4.0` fixes ensure ACKs are asynchronously awaited before heavy JS processing to prevent firmware timeouts.
*   **Message Types (`MessageType` enum)** — `protocol/types.ts` defines distinct values for application-level commands (`MSG_HELLO`, `MSG_TIME_SYNC`, `MSG_SET_CONFIG`, `MSG_ENTER_OTA_MODE`, `MSG_CLEAR_BONDS`) and data (`MSG_HIT_EVENT`, `MSG_BATTERY_STATUS`).
*   **Device Contract Boundary** — This binary protocol defines the strict, versioned contract between the mobile app and the APP DEVICE device firmware.

> **Guarantee:** Every frame is integrity-checked (CRC16) and delivery-confirmed (ACK/NACK). No corrupted or lost frames propagate to the application layer.

---

## Background Behavior and Operational Constraints

The BLE subsystem is engineered for resilience under mobile OS constraints:

*   **State Restoration and Process Relaunch** — Early initialization of `AppDeviceBLECore` on iOS ensures correct handling of `CBCentralManager` state restoration, vital for background operation.
*   **Background Event Windows** — The `AppDeviceBLEModule`'s `EventBuffer` ensures native events are safely delivered to JavaScript even when the JS runtime is suspended.
*   **Background-Safe Storage** — `SecureStorageService.ts` explicitly uses `SecureStore.AFTER_FIRST_UNLOCK` accessibility for private Keychain items on iOS. This bypasses "User interaction is not allowed" errors during background BLE operations, enabling services like `DeviceService` to retrieve user context reliably.
*   **Listener Timing Sensitivity** — `useAppDeviceBLEIntegration.ts` establishes synchronous, early subscriptions to native events, minimizing missed events.
*   **OS Background Keep-Alive** — `BluetoothHandler`'s `AppState` listener and active `MSG_HEARTBEAT` signals maintain BLE activity in the background, signaling to the OS that the connection is active and reducing termination risk.

---

## Reliability Posture

*   **Restoration Correctness** — Early native initialization and `CBCentralManager`'s restoration capabilities on iOS prevent silent connection loss.
*   **Buffered Event Durability** — The `EventBuffer` ensures native events are eventually delivered or explicitly reported as `onBufferOverflow`.
*   **Overflow Visibility** — `onBufferOverflow` events alert JavaScript to potential data loss, enabling higher-level recovery strategies.
*   **Reconnection and Bonding-Loss Handling** — `DisconnectReason` classification, exponential backoff, dormant reconnection, and `EC-SLEEP-BOND-FIX-001` (`AppDeviceBLECore.swift`) provide robust handling of disconnections and avoid false bonding errors.
*   **ACK Timing and Security** — Critical `v2.4.0` fixes in `AppDeviceProtocolService` ensure ACKs are sent before heavy JS processing, preventing firmware timeouts. `EC-HEARTBEAT-SUICIDE-001` in `BluetoothContext.tsx` protects against security-related health check failures.
*   **Fault Containment** — Fail-fast on critical errors (e.g., invalid protocol frames) prevents state corruption, while non-critical failures are managed with retry logic.

---

## Verification and Current Limits

The architecture is strongly grounded in the codebase, with explicit proof points:

*   **Proven iOS-Native Depth** — `AppDeviceBLEInitializer.swift`, `AppDeviceBLECore.swift`, and their integration in `AppDelegate.mm` confirm deep iOS-native CoreBluetooth integration.
*   **Proven RN Bridge Reliability** — The `EventBuffer` and `onBufferOverflow` mechanisms in `AppDeviceBLEModule.swift` are clear code-level proofs of intentional bridge durability.
*   **JS Orchestration and Protocol** — `BluetoothHandler`, `EventSyncService`, and `AppDeviceProtocolService` demonstrate a sophisticated JavaScript layer for orchestration and custom binary protocol handling.
*   **Android Scope Caveats** — The codebase primarily showcases iOS-native implementations. While Android is supported via `react-native-ble-plx` (as indicated by `shouldUseNativeTransport()`), the provided snippets do not demonstrate an equivalent depth of custom-native Android runtime. The Android experience relies more heavily on `react-native-ble-plx`'s abstraction and the shared TypeScript orchestration layer. This document reflects this divergence honestly; the Android story may evolve with future native work.

---

## Related Documents

| Document | Focus Area |
| :--- | :--- |
| [**System Architecture**](architecture.md) | High-level system overview and service boundaries. |
| [**Data Flow Map**](data-flow.md) | Detailed data paths within the application. |
| [**Health Ingestion Pipeline**](health-ingestion.md) | HealthKit / Health Connect integration and data ingestion. |
| [**Failure Modes**](failure-modes.md) | System failure modes and recovery strategies. |
