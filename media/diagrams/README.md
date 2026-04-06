# Diagrams

Architecture and system diagrams for the offline-first mobile platform.

| Diagram | Depicts | Used In |
| :--- | :--- | :--- |
| `apparchitecture.svg` | Full application architecture: native runtime, bridge, services, persistence, sync | [README](../../README.md), [architecture.md](../../docs/architecture.md) |
| `OfflinesyncArch.svg` | Offline sync architecture: outbox, engines, coordination, external boundaries | [README](../../README.md), [architecture.md](../../docs/architecture.md), [offline-sync.md](../../docs/offline-sync.md) |
| `PushPAth.svg` | Push path flow: local mutation through backend submission | [offline-sync.md](../../docs/offline-sync.md) |
| `pushconflict.svg` | Push conflict resolution decision tree | [offline-sync.md](../../docs/offline-sync.md) |
| `OfflineSyncPullIntegrity.svg` | Pull path and integrity validation flow | [offline-sync.md](../../docs/offline-sync.md) |
| `LaneArchitecture.svg` | Health ingestion lane architecture: HOT, COLD, CHANGE queues | [README](../../README.md), [architecture.md](../../docs/architecture.md) |
| `healthglance.svg` | Health ingestion pipeline end-to-end overview | [health-ingestion.md](../../docs/health-ingestion.md) |
| `nativeble.svg` | Native BLE subsystem architecture layers | [architecture.md](../../docs/architecture.md), [nativeBLE.md](../../docs/nativeBLE.md) |
