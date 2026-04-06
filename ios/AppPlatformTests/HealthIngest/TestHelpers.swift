import Foundation
import HealthKit
import SQLite3
@testable import AppPlatform
/
/
/
/
/
/
/
/
@discardableResult
func createTestSchema(db: OpaquePointer) -> Int32 {
    var result = execTestSQL(db, """
        CREATE TABLE IF NOT EXISTS health_samples (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_record_id TEXT NOT NULL,
            sample_type TEXT NOT NULL,
            value_kind TEXT NOT NULL,
            start_timestamp INTEGER NOT NULL,
            end_timestamp INTEGER NOT NULL,
            duration_seconds INTEGER,
            device_id TEXT,
            external_uuid TEXT,
            value REAL,
            unit TEXT,
            category_code TEXT,
            metadata TEXT,
            upload_status TEXT DEFAULT 'pending' NOT NULL,
            staged_batch_id TEXT,
            upload_request_id TEXT,
            uploaded_at INTEGER,
            upload_error TEXT,
            upload_attempt_count INTEGER DEFAULT 0 NOT NULL,
            next_upload_attempt_at INTEGER,
            state_updated_at_ms INTEGER,
            is_deleted INTEGER DEFAULT 0 NOT NULL,
            deleted_at_ms INTEGER,
            created_at INTEGER DEFAULT (strftime('%s','now')*1000)
        )
        """)
    guard result == SQLITE_OK else { return result }
    result = execTestSQL(db, """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_health_samples_source
        ON health_samples (user_id, source_id, source_record_id, start_timestamp)
        """)
    guard result == SQLITE_OK else { return result }
    result = execTestSQL(db, """
        CREATE INDEX IF NOT EXISTS idx_health_samples_upload
        ON health_samples (user_id, upload_status, is_deleted)
        """)
    guard result == SQLITE_OK else { return result }
    result = execTestSQL(db, """
        CREATE TABLE IF NOT EXISTS health_ingest_cursors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            sample_type TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'change_anchor',
            anchor_data TEXT,
            cursor_version INTEGER NOT NULL DEFAULT 1,
            last_ingest_timestamp INTEGER,
            total_samples_ingested INTEGER DEFAULT 0,
            cold_backfill_end_ts INTEGER,
            cold_backfill_start_ts INTEGER,
            last_sync_at INTEGER,
            created_at INTEGER DEFAULT (strftime('%s','now')*1000),
            updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
        )
        """)
    guard result == SQLITE_OK else { return result }
    result = execTestSQL(db, """
        CREATE INDEX IF NOT EXISTS idx_health_ingest_cursors_lookup
        ON health_ingest_cursors (user_id, source_id, sample_type, scope)
        """)
    guard result == SQLITE_OK else { return result }
    result = execTestSQL(db, """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_health_ingest_cursor
        ON health_ingest_cursors (user_id, source_id, sample_type, scope)
        """)
    guard result == SQLITE_OK else { return result }
    result = execTestSQL(db, """
        CREATE TABLE IF NOT EXISTS health_sample_deletion_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_record_id TEXT NOT NULL,
            start_timestamp_ms INTEGER,
            deleted_at_ms INTEGER NOT NULL,
            upload_status TEXT DEFAULT 'pending',
            uploaded_at INTEGER,
            upload_error TEXT,
            upload_attempt_count INTEGER NOT NULL DEFAULT 0,
            next_upload_attempt_at INTEGER,
            state_updated_at_ms INTEGER,
            staged_batch_id TEXT,
            upload_request_id TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now')*1000)
        )
        """)
    guard result == SQLITE_OK else { return result }
    result = execTestSQL(db, """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_deletion_queue_sample
        ON health_sample_deletion_queue (user_id, source_id, source_record_id, start_timestamp_ms)
        """)
    guard result == SQLITE_OK else { return result }
    result = execTestSQL(db, """
        CREATE INDEX IF NOT EXISTS idx_deletion_queue_pending
        ON health_sample_deletion_queue (user_id, upload_status)
        """)
    guard result == SQLITE_OK else { return result }
    return SQLITE_OK
}
/
/
/
func openTestDatabase() -> (OpaquePointer?, String?) {
    var db: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
    let result = sqlite3_open_v2(":memory:", &db, flags, nil)
    guard result == SQLITE_OK, let db = db else {
        return (nil, "Failed to open in-memory database: code \(result)")
    }
    _ = execTestSQL(db, "PRAGMA busy_timeout = 5000")
    _ = execTestSQL(db, "PRAGMA journal_mode = WAL")
    _ = execTestSQL(db, "PRAGMA foreign_keys = ON")
    let schemaResult = createTestSchema(db: db)
    guard schemaResult == SQLITE_OK else {
        sqlite3_close_v2(db)
        return (nil, "Schema creation failed: code \(schemaResult)")
    }
    return (db, nil)
}
/
/
/
func openTempFileDatabase() -> (OpaquePointer?, String, String?) {
    let tempDir = NSTemporaryDirectory()
    let dbPath = (tempDir as NSString).appendingPathComponent("test_\(UUID().uuidString).db")
    var db: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
    let result = sqlite3_open_v2(dbPath, &db, flags, nil)
    guard result == SQLITE_OK, let db = db else {
        return (nil, dbPath, "Failed to open temp database: code \(result)")
    }
    _ = execTestSQL(db, "PRAGMA busy_timeout = 5000")
    _ = execTestSQL(db, "PRAGMA journal_mode = WAL")
    _ = execTestSQL(db, "PRAGMA foreign_keys = ON")
    let schemaResult = createTestSchema(db: db)
    guard schemaResult == SQLITE_OK else {
        sqlite3_close_v2(db)
        return (nil, dbPath, "Schema creation failed: code \(schemaResult)")
    }
    return (db, dbPath, nil)
}
/
@discardableResult
func execTestSQL(_ db: OpaquePointer, _ sql: String) -> Int32 {
    return sqlite3_exec(db, sql, nil, nil, nil)
}
/
func countRows(db: OpaquePointer, table: String, where whereClause: String? = nil) -> Int {
    let sql = whereClause != nil
        ? "SELECT COUNT(*) FROM \(table) WHERE \(whereClause!)"
        : "SELECT COUNT(*) FROM \(table)"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
    return Int(sqlite3_column_int(stmt, 0))
}
/
/
/
/
func makeQuantitySample(
    type: HKQuantityTypeIdentifier = .heartRate,
    value: Double = 72.0,
    unit: HKUnit = HKUnit(from: "count/min"),
    start: Date = Date(timeIntervalSince1970: 1700000000),
    end: Date = Date(timeIntervalSince1970: 1700000060)
) -> HKQuantitySample {
    let quantityType = HKQuantityType.quantityType(forIdentifier: type)!
    let quantity = HKQuantity(unit: unit, doubleValue: value)
    return HKQuantitySample(type: quantityType, quantity: quantity, start: start, end: end)
}
/
func makeCategorySample(
    type: HKCategoryTypeIdentifier = .sleepAnalysis,
    value: Int = 3,
    start: Date = Date(timeIntervalSince1970: 1700000000),
    end: Date = Date(timeIntervalSince1970: 1700003600)
) -> HKCategorySample {
    let categoryType = HKCategoryType.categoryType(forIdentifier: type)!
    return HKCategorySample(type: categoryType, value: value, start: start, end: end)
}
func makeHeartRateConfig() -> NativeMetricConfig {
    return NativeMetricConfig(
        metricCode: "heart_rate",
        hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
        queryUnit: "count/min",
        valueKind: .scalarNum,
        isCategory: false,
        minBound: 20.0,
        maxBound: 300.0,
        canonicalUnit: "bpm"
    )
}
func makeStepsConfig() -> NativeMetricConfig {
    return NativeMetricConfig(
        metricCode: "steps",
        hkIdentifier: "HKQuantityTypeIdentifierStepCount",
        queryUnit: "count",
        valueKind: .cumulativeNum,
        isCategory: false,
        minBound: 0.0,
        maxBound: 200000.0,
        canonicalUnit: "count"
    )
}
func makeSleepStageConfig() -> NativeMetricConfig {
    return NativeMetricConfig(
        metricCode: "sleep_stage",
        hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
        queryUnit: nil,
        valueKind: .category,
        isCategory: true,
        minBound: nil,
        maxBound: nil,
        canonicalUnit: nil
    )
}
func makeStandHoursConfig() -> NativeMetricConfig {
    return NativeMetricConfig(
        metricCode: "stand_hours",
        hkIdentifier: "HKCategoryTypeIdentifierAppleStandHour",
        queryUnit: nil,
        valueKind: .cumulativeNum,
        isCategory: true,
        minBound: 0.0,
        maxBound: 1.0,
        canonicalUnit: "count"
    )
}
func makeBloodOxygenConfig() -> NativeMetricConfig {
    return NativeMetricConfig(
        metricCode: "blood_oxygen",
        hkIdentifier: "HKQuantityTypeIdentifierOxygenSaturation",
        queryUnit: "%",
        valueKind: .scalarNum,
        isCategory: false,
        minBound: 50.0,
        maxBound: 100.0,
        canonicalUnit: "%"
    )
}
/
/
/
/
func makeLaneConstantsDict(
    hotBudgetMs: Int = 2000,
    recentDataQueryLimit: Int = 60000,
    hotLookbackDays: Int = 14,
    hotOverlapMs: Int = 300_000,
    hotUiWindowMs: Int = 86_400_000,
    hotCatchupChunkWindowMs: Int = 21_600_000,
    hotCatchupMaxChunksPerRun: Int = 4,
    hotCatchupQueryLimit: Int = 5_000,
    hotTwoPassEnabled: Bool = false,
    coldChunkBudgetMs: Int = 500,
    coldMaxChunks: Int = 10,
    coldBackfillDays: Int = 90,
    coldGraceWindowDays: Int = 0,
    coldChunkWindowMs: Int = 604_800_000,
    coldQueryLimitPerChunk: Int = 5_000,
    maxSamplesPerChunk: Int = 200,
    busyTimeoutMs: Int = 5000
) -> NSDictionary {
    return [
        "hotBudgetMs": NSNumber(value: hotBudgetMs),
        "recentDataQueryLimit": NSNumber(value: recentDataQueryLimit),
        "hotLookbackDays": NSNumber(value: hotLookbackDays),
        "hotOverlapMs": NSNumber(value: hotOverlapMs),
        "hotUiWindowMs": NSNumber(value: hotUiWindowMs),
        "hotCatchupChunkWindowMs": NSNumber(value: hotCatchupChunkWindowMs),
        "hotCatchupMaxChunksPerRun": NSNumber(value: hotCatchupMaxChunksPerRun),
        "hotCatchupQueryLimit": NSNumber(value: hotCatchupQueryLimit),
        "hotTwoPassEnabled": hotTwoPassEnabled,
        "coldChunkBudgetMs": NSNumber(value: coldChunkBudgetMs),
        "coldMaxChunks": NSNumber(value: coldMaxChunks),
        "coldBackfillDays": NSNumber(value: coldBackfillDays),
        "coldGraceWindowDays": NSNumber(value: coldGraceWindowDays),
        "coldChunkWindowMs": NSNumber(value: coldChunkWindowMs),
        "coldQueryLimitPerChunk": NSNumber(value: coldQueryLimitPerChunk),
        "maxSamplesPerChunk": NSNumber(value: maxSamplesPerChunk),
        "busyTimeoutMs": NSNumber(value: busyTimeoutMs),
    ]
}
/
func makeNormalizedSample(
    id: String = UUID().uuidString.lowercased(),
    userId: String = "test-user",
    sourceId: String = "test-source",
    sourceRecordId: String = UUID().uuidString.lowercased(),
    sampleType: String = "heart_rate",
    valueKind: String = "SCALAR_NUM",
    startTimestamp: Int64 = 1700000000000,
    endTimestamp: Int64 = 1700000060000,
    value: Double? = 72.0,
    unit: String? = "bpm",
    categoryCode: String? = nil,
    durationSeconds: Int? = 60,
    deviceId: String? = nil,
    externalUuid: String? = nil,
    metadata: String? = nil,
    timestampMs: Int64 = 1700000000000
) -> NormalizedHealthSample {
    return NormalizedHealthSample(
        id: id,
        userId: userId,
        sourceId: sourceId,
        sourceRecordId: sourceRecordId,
        sampleType: sampleType,
        valueKind: valueKind,
        startTimestamp: startTimestamp,
        endTimestamp: endTimestamp,
        value: value,
        unit: unit,
        categoryCode: categoryCode,
        durationSeconds: durationSeconds,
        deviceId: deviceId,
        externalUuid: externalUuid,
        metadata: metadata,
        timestampMs: timestampMs
    )
}
