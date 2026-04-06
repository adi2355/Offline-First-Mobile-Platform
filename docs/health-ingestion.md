# Health Ingestion: Native-Orchestrated Data Pipeline

## Overview

The Health Ingestion subsystem serves as the application's primary mechanism for reliably acquiring user health data, predominantly from Apple HealthKit. It features a robust iOS-native ingestion runtime, architected around a lane-based prioritization model, which processes and persists normalized samples into a local SQLite operational store. This native core is orchestrated by an intelligent TypeScript driver and engine layer, managing the data lifecycle from raw ingestion through to cloud synchronization and the generation of local read-model projections for UI consumption.

This document outlines the architecture, key data flows, and correctness guarantees of this critical app-side subsystem.

<br>

## Scope and Boundaries

This document comprehensively details the architecture and behavior of the **app-side health ingestion subsystem**. It covers:

- Lifecycle entry points and background registration mechanisms within iOS
- Design and operation of the iOS-native (Swift/Obj-C) ingestion runtime
- Lane-based architecture (Hot, Cold, Change) for processing diverse data needs
- Data normalization and sample shaping processes
- Atomic local persistence strategies, including cursor management and deletion queues
- JavaScript orchestration layer that manages ingestion flow and policy
- Handoff points to downstream health synchronization, cloud upload, and local projection refresh

**Out of scope:**

- General application architecture — see [**architecture.md**](architecture.md)
- End-to-end entity sync, except where it interfaces with health data — see [**offline-sync.md**](offline-sync.md)
- Internal architecture or processing logic of the backend's health services
- Specific implementations of UI components that consume health data

> For broader data flow context, refer to [**data-flow.md**](data-flow.md). Architectural decisions are captured in [**decisions/**](decisions/).

---

## Why This Subsystem Exists

The Health Ingestion subsystem is a first-class app component designed to address the unique complexities and demands of integrating with mobile health platforms:

- **High Data Volume & Diversity** — Health data spans instantaneous metrics (heart rate), cumulative metrics (steps), and categories (sleep stages), arriving at high frequencies.
- **Operating System Constraints** — Mobile OSes (especially iOS) impose strict, unpredictable limits on background execution, memory, and network activity.
- **Diverse Application Needs** — The app requires immediate UX freshness for real-time display, comprehensive historical backfill for analytics, and reliable delta handling for edits and deletions.
- **Atomic and Resumable Persistence** — Data must be durably stored in a crash-safe manner, with cursors ensuring the system can resume precisely without data loss or duplication.
- **Local-First Ownership** — Local storage acts as the operational source of truth, enabling offline functionality and fast UI rendering prior to cloud sync.

---

## Subsystem at a Glance

<div align="center">
  <img src="../media/diagrams/healthglance.svg" alt="Health Ingestion Subsystem Overview" width="100%" />
</div>

<br>

---

## Lifecycle Entry and Background Registration

> **Note:** This section describes iOS-specific HealthKit integration.

Apple's HealthKit framework mandates early registration of `HKObserverQuery` instances to ensure background delivery of health data changes. This critical, native-level setup is performed during app launch.

**`AppDelegate.mm`** — The `application:didFinishLaunchingWithOptions:` method initializes the `HealthKitObserver` singleton and invokes its `registerDefaultObservers` method. This explicitly ensures `HKObserverQuery` instances are active *before* the application finishes launching, adhering to iOS requirements.

**`HealthKitObserver.swift`** — This Swift singleton is dedicated to managing HealthKit observation. It registers `HKObserverQuery` instances for predefined health metrics (e.g., heart rate, steps, sleep analysis) and calls `healthStore.enableBackgroundDelivery(for:frequency:completion:)` to instruct iOS to wake the app. Its `onBackgroundUpdate` callback triggers the Change Lane in the native ingestion runtime upon receiving a background update notification.

> **Guarantee:** Observer queries are registered before app launch completes. Background delivery is explicitly enabled per metric.

---

## Native Ingestion Runtime

The core processing of HealthKit data is performed by a dedicated native Swift runtime, optimized for platform-specific APIs and precise resource control.

| Component | Source | Responsibility |
| :--- | :--- | :--- |
| **Native Orchestrator** | `HealthIngestCore.swift` | Manages three distinct `OperationQueue`s (Hot, Cold, Change), each with specific `QualityOfService`. Coordinates the fetch, normalize, and persist cycle. Maintains cancellation flags (`AtomicBool`) and tracks active `HKQuery` objects. |
| **HealthKit API Wrapper** | `HealthKitQueries.swift` | Specialized, asynchronous query methods (`queryRecentSamples`, `queryColdChunk`, `queryChanges`). Handles serialization/deserialization of `HKQueryAnchor` objects. |
| **Data Transformation** | `HealthNormalization.swift` | Ensures raw HealthKit data is consistently formatted and validated. Applies `NativeMetricConfig` definitions for unit/timestamp canonicalization, metadata sanitization, `valueKind` mapping, and derived sleep samples. Enforces strict data invariants. |
| **Atomic Persistence** | `HealthIngestSQLite.swift` | Direct SQLite C API interaction. Uses `BEGIN IMMEDIATE` transactions and `sqlite3_changes()` for Compare-And-Swap (CAS) cursor updates, ensuring atomic and crash-safe database operations. |
| **JS Bridge** | `NativeHealthIngestModule.swift` | Exposes a typed API to JavaScript, allowing `HealthIngestionEngine` to invoke native ingestion functionality and receive events via `RCTEventEmitter`. |
| **Shared DTOs** | `HealthIngestTypes.swift` | Defines DTOs, `NativeErrorCode`, and configuration structures, ensuring type consistency across native modules. |

---

## Lane Architecture: Hot, Cold, and Change

The native ingestion runtime employs a lane-based architecture to prioritize diverse health data needs, optimizing resource usage under constrained mobile environments.

<div align="center">
  <img src="../media/diagrams/LaneArchitecture.svg" alt="Health Ingestion Lane Architecture" width="100%" />
</div>

<br>

### Hot Lane

- **Purpose:** UX-critical, immediate display of recent health data.
- **QoS:** `.userInitiated`
- **Data Window:** Sliding window (e.g., last 14 days + 5-minute overlap), fetches in descending order. Uses a two-pass mechanism for fast UI paint and background catch-up.
- **Behavior:** Preempts Cold Lane, adheres to a strict `hotBudgetMs`, and advances the per-metric `lastIngestTimestamp` cursor even on empty results.

### Cold Lane

- **Purpose:** Comprehensive historical backfill (e.g., 90 days) without impacting foreground UX.
- **QoS:** `.utility`
- **Data Window:** Processes data in fixed-size chunks (e.g., 7-day windows), moving backward in time, fetching in ascending order.
- **Behavior:** Preemptible by Hot Lane, budget-aware (`coldChunkBudgetMs * maxChunks`). Advances `coldBackfillEndTs` cursor with inner pagination and `coldResumeIndex` for cross-invocation fairness. Cursor advancement itself signals progress.

### Change Lane

- **Purpose:** Event-driven processing of HealthKit additions, updates, and deletions.
- **QoS:** `.default`
- **Data Window:** Utilizes `HKAnchoredObjectQuery` for efficient incremental changes.
- **Behavior:** Primarily triggered by `HealthKitObserver` for background delivery. Performs local soft-deletes on `health_samples` and atomically enqueues deletions into `health_sample_deletion_queue`. Adheres to strict background execution time budgets (e.g., 15 seconds) via explicit cancellation (`cancelChangeLane()`).

> **Guarantee:** Zero data loss under background termination. Atomic cursor advancement prevents skipped or duplicated ingestion windows.

---

## Query Execution and Time Budgets

The native ingestion runtime manages interactions with HealthKit through disciplined query execution, time budgeting, and explicit cancellation.

- **Active `HKQuery` Tracking** — `HealthIngestCore.swift` maintains `queryLock`-protected references to active `HKQuery` objects, enabling their explicit termination.
- **Timeout-Based Query Waits** — `HealthIngestCore` employs `DispatchSemaphore.wait(timeout:)` with a `QUERY_TIMEOUT_SECONDS` (e.g., 30 seconds) to prevent indefinite hangs.
- **Explicit Cancellation** — Upon timeout or external signal, `healthStore.stop(query)` is called, immediately abandoning the query and freeing HealthKit resources.
- **Background Budget Adherence** — `NativeHealthIngestModule.swift` enforces strict time budgets for background Change Lane execution. `cancelChangeLane()` is invoked if the budget is exceeded, ensuring prompt `completionHandler()` invocation.

---

## Normalization and Sample Shaping

Raw HealthKit data undergoes extensive transformation, validation, and standardization before local persistence.

| Component | Responsibility |
| :--- | :--- |
| **`HealthNormalization.swift`** | Unit/timestamp canonicalization, metadata sanitization (against `WhitelistedMetadataSchema` from `health.contract.ts`), `valueKind` mapping (e.g., `SCALAR_NUM`, `CATEGORY`), and generation of derived sleep samples. Enforces strict invariants (e.g., `startAt <= endAt`, value bounds) at the trust boundary. |
| **`HealthIngestTypes.swift`** | Defines `NativeMetricConfig` (metric definitions) and `NormalizedHealthSample` (the DTO ready for SQLite insertion). |
| **`health.contract.ts`** | Canonical Zod schemas (`HealthSampleSchema`) for validating payloads at trust boundaries, ensuring strict data integrity. |

---

## Atomic Local Persistence and Cursor Management

The local SQLite database (`DeviceEvents.db`) is the app's operational source of truth for ingested health data, secured by atomic transactions and robust cursor management.

| Component | Responsibility |
| :--- | :--- |
| **`HealthIngestSQLite.swift`** | Uses `BEGIN IMMEDIATE` transactions and `sqlite3_changes()` for CAS cursor updates, guaranteeing all-or-nothing data changes. Uses per-row prepared statements to avoid SQLite variable limits. |
| **`HealthSampleRepository.ts`** | The `atomicInsertAndUpdateCursorAtomic()` method orchestrates a single SQLite transaction encompassing both sample insertion(s) and `HealthIngestCursor` updates. Closes the "crash gap" — samples are stored *only if* the cursor advances. Supports an `onBeforeCommit` callback for atomic integration with downstream logic. |
| **`HealthCursorRepository.ts`** | Manages opaque `HKQueryAnchor`s for incremental fetching via the `health_ingest_cursors` table, utilizing `CursorScope` (Hot, Cold, Change) to isolate lane progress. |
| **`HealthDeletionQueueRepository.ts`** | Tracks locally soft-deleted samples (via `HealthSampleRepository.markSamplesDeletedBySourceRecordIds()`) in the `health_sample_deletion_queue` for reliable propagation to the backend. |

> **Guarantee:** Samples are persisted only if the cursor advances in the same atomic transaction. If the OS kills the process mid-transaction, SQLite's journal-based rollback ensures neither samples nor cursors are left in a partial state.

---

## JS Driver and Engine Orchestration

A JavaScript layer orchestrates the overall ingestion process, defining policy and managing the lifecycle atop the native runtime.

| Component | Responsibility |
| :--- | :--- |
| **`NativeHealthIngestionDriver.ts`** | TypeScript proxy for `NativeHealthIngestModule.swift`. Exposes APIs and routes native events via `RCTEventEmitter`. |
| **`HealthIngestionEngine.ts`** | Central JavaScript orchestrator. Triggers native lanes, applies policy (rate limiting, exponential backoff for native calls), schedules retries, and interprets native errors. Implements fairness strategies for the Cold Lane. |
| **`HealthSyncCoordinationState.ts`** | Manages shared, static coordination state and canonical timing constants (`SESSION_IDLE_TIMEOUT_MS`, `QUERY_TIMEOUT_SECONDS`) for consistency across native and JS layers. |

---

## Handoff to Health Sync, Upload, and Projection Refresh

Locally persisted health samples are processed by downstream services for cloud synchronization and the generation of user-facing read models.

| Service | Responsibility |
| :--- | :--- |
| **`HealthSyncService.ts`** | Manages the overall health data lifecycle, coordinating native ingestion, `HealthUploadEngine` for sample uploads, and `HealthProjectionRefreshService` for local read model hydration. |
| **`HealthUploadEngine.ts`** | Dedicated engine for reliably pushing `HealthSample` records and `HealthSampleDeletionQueue` entries to the backend, using `payload-hash.ts` for request-level idempotency. |
| **`HealthProjectionRefreshService.ts`** | Orchestrates fetching and updating local read models (e.g., `HealthRollupDayDto`, `SleepNightSummaryDto`) from the backend, driven by dirty keys (`LocalRollupDirtyKeyRepository.ts`). |
| **`HealthProjectionHydrationClient.ts`** | Fetches refreshed projection DTOs from the backend and upserts them into local read model repositories. |

---

## Data Ownership and Local Read Models

The data ownership model prioritizes local-first operation and efficient UI reactivity by distinguishing raw ingested data from optimized read models.

| Store | Repository | Purpose |
| :--- | :--- | :--- |
| **Raw Samples** | `HealthSampleRepository.ts` | Primary local operational source of truth for raw, ingested health data |
| **Ingestion Cursors** | `HealthCursorRepository.ts` | Tracks incremental ingestion progress per lane |
| **Deletion Queue** | `HealthDeletionQueueRepository.ts` | Manages pending deletions for reliable server propagation |
| **Daily Rollups** | `LocalHealthRollupRepository.ts` | Pre-aggregated daily health metrics for UI display |
| **Sleep Summaries** | `LocalSleepNightSummaryRepository.ts` | Per-night sleep aggregations |
| **Session Impact** | `LocalSessionImpactRepository.ts` | Health impact analysis per consumption session |
| **Product Impact** | `LocalProductImpactRepository.ts` | Aggregated product-level health impact |
| **Health Insights** | `LocalHealthInsightRepository.ts` | Derived insight data for UI consumption |

UI components primarily consume data from local read model repositories, not raw samples.

---

## Platform Considerations

The current Health Ingestion subsystem's deepest implementation is specific to iOS and HealthKit.

- **Native Runtime** — The entire `packages/app/ios/AppPlatform/HealthIngest` directory is in Swift/Obj-C, reflecting deep platform integration.
- **Lifecycle Requirements** — `AppDelegate.mm` and `HealthKitObserver.swift` manage iOS-specific lifecycle requirements for `HKObserverQuery` registration and background delivery.
- **Entitlements** — The reliance on HealthKit entitlements (`com.apple.developer.healthkit`) is iOS-specific.
- **Android Parity** — While a conceptual health service exists for Android, a comparably deep native ingestion runtime for Health Connect is not currently evident in the provided codebase.

---

## Reliability and Failure Containment

The subsystem is engineered for resilience in unpredictable mobile environments.

| Mechanism | Implementation |
| :--- | :--- |
| **Time Budgets & Cancellation** | `HealthIngestCore.swift` uses strict time budgets, `DispatchSemaphore` timeouts, and `AtomicBool` flags for query management and resource conservation |
| **Atomic Persistence** | `HealthIngestSQLite.swift` and `HealthSampleRepository.ts` guarantee all-or-nothing transactions for sample writes and cursor updates |
| **Idempotency & Deduplication** | `ON CONFLICT DO UPDATE` semantics and `payload-hash.ts` ensure safe re-processing without duplicates |
| **Bounded Retries & Backoff** | `HealthUploadEngine.ts` implements exponential backoff for failed uploads; `HealthSampleRepository.ts` handles crash recovery for stuck samples |
| **Sparse Data Progress** | Cold Lane advances cursors even for empty windows, ensuring forward progress for infrequent metrics |
| **Freshness & Staleness Detection** | `FreshnessMeta` (`freshness-types.ts`) provides explicit metadata for derived data, informing UI about data recency |
| **Trust Boundary Validation** | Strict Zod schemas (`health.contract.ts`) and native invariant checks (`HealthNormalization.swift`) enforce data integrity at every trust boundary |

---

## Verification Surface

| Layer | Scope |
| :--- | :--- |
| **Native Unit Tests** | Lane behavior, `HealthKitQuery` processing, `HealthNormalization` accuracy, `HealthIngestSQLite` atomicity |
| **TypeScript Unit/Integration** | Driver communication, `HealthIngestionEngine` logic, `HealthSyncService` coordination, `HealthUploadEngine` mechanisms, repository invariants |
| **End-to-End Pipeline** | Complete data flow from simulated HealthKit events to local read models |
| **Schema & Contract Validation** | Zod schemas and invariant checks in `health.contract.ts` and `payload-hash.ts` ensure data shape and integrity |
| **Golden Tests** | Deterministic output verification of critical pure functions |

---

## Related Documents

| Document | Focus Area |
| :--- | :--- |
| [**System Architecture**](architecture.md) | Layered system model, service boundaries, and lifecycle orchestration |
| [**Data Flow Map**](data-flow.md) | End-to-end data movement across layers, pipelines, and external boundaries |
| [**Offline Entity Sync**](offline-sync.md) | Transactional outbox, cursor-based pull, and conflict resolution |
| [**Failure Modes**](failure-modes.md) | Reliability domains, containment mechanisms, and recovery strategies |
| [**Native BLE Subsystem**](nativeBLE.md) | CoreBluetooth runtime, state restoration, and bridge design |
| [**Architectural Decisions**](decisions/) | ADRs covering key design choices |
