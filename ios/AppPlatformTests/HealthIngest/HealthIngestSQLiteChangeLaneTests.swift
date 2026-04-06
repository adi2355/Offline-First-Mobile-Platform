import XCTest
import SQLite3
@testable import AppPlatform
final class LookupStartTimestampsTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_lookup_\(UUID().uuidString).db")
        var db: OpaquePointer?
        sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        if let db = db {
            execTestSQL(db, "PRAGMA journal_mode = WAL")
            createTestSchema(db: db)
            sqlite3_close_v2(db)
        }
        sqlite = HealthIngestSQLite()
        let error = sqlite.open(dbPath: dbPath, busyTimeoutMs: 5000)
        precondition(error == nil, "setUp: open failed: \(error!)")
    }
    override func tearDown() {
        sqlite.close()
        try? FileManager.default.removeItem(atPath: dbPath)
        try? FileManager.default.removeItem(atPath: dbPath + "-wal")
        try? FileManager.default.removeItem(atPath: dbPath + "-shm")
        super.tearDown()
    }
    func testExistingRecords_ReturnsTimestamps() {
        let samples = [
            makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "rec-A",
                                  startTimestamp: 1700000000001),
            makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "rec-B",
                                  startTimestamp: 1700000000002),
            makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "rec-C",
                                  startTimestamp: 1700000000003),
        ]
        let (_, _, insertError) = sqlite.atomicInsertAndUpdateCursor(
            samples: samples, cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(insertError)
        let result = sqlite.lookupStartTimestamps(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: ["rec-A", "rec-B", "rec-C"]
        )
        XCTAssertEqual(result.count, 3)
        XCTAssertEqual(result["rec-A"], 1700000000001)
        XCTAssertEqual(result["rec-B"], 1700000000002)
        XCTAssertEqual(result["rec-C"], 1700000000003)
    }
    func testMissingRecords_OmittedFromResult() {
        let result = sqlite.lookupStartTimestamps(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: ["nonexistent-1", "nonexistent-2"]
        )
        XCTAssertTrue(result.isEmpty, "Non-existent IDs should not appear in result")
    }
    func testSoftDeletedRecords_StillReturned() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "soft-del",
                                           startTimestamp: 1700000000999)
        let (_, _, insertError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(insertError)
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            execTestSQL(rawDb, "UPDATE health_samples SET is_deleted = 1 WHERE source_record_id = 'soft-del'")
            sqlite3_close_v2(rawDb)
        }
        let result = sqlite.lookupStartTimestamps(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: ["soft-del"]
        )
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result["soft-del"], 1700000000999,
                       "Soft-deleted samples should still have resolvable timestamps")
    }
    func testEmptyInput_ReturnsEmpty() {
        let result = sqlite.lookupStartTimestamps(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: []
        )
        XCTAssertTrue(result.isEmpty)
    }
    func testMixedKnownAndUnknown_PartialResult() {
        let samples = [
            makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "known-1",
                                  startTimestamp: 1700000001000),
            makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "known-2",
                                  startTimestamp: 1700000002000),
            makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "known-3",
                                  startTimestamp: 1700000003000),
        ]
        let (_, _, insertError) = sqlite.atomicInsertAndUpdateCursor(
            samples: samples, cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(insertError)
        let result = sqlite.lookupStartTimestamps(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: ["known-1", "known-2", "known-3", "unknown-1", "unknown-2"]
        )
        XCTAssertEqual(result.count, 3, "Only known records should appear in result")
        XCTAssertEqual(result["known-1"], 1700000001000)
        XCTAssertEqual(result["known-2"], 1700000002000)
        XCTAssertEqual(result["known-3"], 1700000003000)
        XCTAssertNil(result["unknown-1"])
        XCTAssertNil(result["unknown-2"])
    }
}
final class ChangeLaneScopeIsolationTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_scope_\(UUID().uuidString).db")
        var db: OpaquePointer?
        sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        if let db = db {
            execTestSQL(db, "PRAGMA journal_mode = WAL")
            createTestSchema(db: db)
            sqlite3_close_v2(db)
        }
        sqlite = HealthIngestSQLite()
        let error = sqlite.open(dbPath: dbPath, busyTimeoutMs: 5000)
        precondition(error == nil, "setUp: open failed: \(error!)")
    }
    override func tearDown() {
        sqlite.close()
        try? FileManager.default.removeItem(atPath: dbPath)
        try? FileManager.default.removeItem(atPath: dbPath + "-wal")
        try? FileManager.default.removeItem(atPath: dbPath + "-shm")
        super.tearDown()
    }
    func testChangeAnchor_DoesNotAffectHotCursor() {
        let hotSample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                              sourceRecordId: "hot-rec", sampleType: "heart_rate")
        let (_, _, hotError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [hotSample], cursor: nil, newAnchorData: "hot-anchor",
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(hotError)
        let hotCursorBefore = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                                  sampleType: "heart_rate", scope: .hotAnchor)!
        let (_, _, changeError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [],
            cursor: nil,
            newAnchorData: "change-anchor-data",
            newVersion: 1,
            scope: .changeAnchor,
            explicitUserId: "u1",
            explicitSourceId: "s1",
            explicitSampleType: "heart_rate"
        )
        XCTAssertNil(changeError)
        let hotCursorAfter = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                                 sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(hotCursorAfter.cursorVersion, hotCursorBefore.cursorVersion)
        XCTAssertEqual(hotCursorAfter.totalSamplesIngested, hotCursorBefore.totalSamplesIngested)
        XCTAssertEqual(hotCursorAfter.lastIngestTimestamp, hotCursorBefore.lastIngestTimestamp)
    }
    func testHotAnchor_DoesNotAffectChangeCursor() {
        let (_, _, changeError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [],
            cursor: nil,
            newAnchorData: "change-v1",
            newVersion: 1,
            scope: .changeAnchor,
            explicitUserId: "u1",
            explicitSourceId: "s1",
            explicitSampleType: "heart_rate"
        )
        XCTAssertNil(changeError)
        let changeCursorBefore = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                                     sampleType: "heart_rate", scope: .changeAnchor)!
        let hotSample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                              sourceRecordId: "hot-rec", sampleType: "heart_rate")
        let (_, _, hotError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [hotSample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(hotError)
        let changeCursorAfter = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                                    sampleType: "heart_rate", scope: .changeAnchor)!
        XCTAssertEqual(changeCursorAfter.cursorVersion, changeCursorBefore.cursorVersion)
        XCTAssertEqual(changeCursorAfter.anchorData, changeCursorBefore.anchorData)
    }
    func testAllThreeScopes_IndependentCursors() {
        let userId = "u1"
        let sourceId = "s1"
        let metricCode = "heart_rate"
        let hotSample = makeNormalizedSample(userId: userId, sourceId: sourceId,
                                              sourceRecordId: "hot-s", sampleType: metricCode)
        let (_, _, hotError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [hotSample], cursor: nil, newAnchorData: "hot-data",
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(hotError)
        let coldSample = makeNormalizedSample(userId: userId, sourceId: sourceId,
                                               sourceRecordId: "cold-s", sampleType: metricCode)
        let (_, _, coldError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [coldSample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .coldTime,
            coldBackfillEndTs: 1700000000000, coldBackfillStartTs: 1690000000000
        )
        XCTAssertNil(coldError)
        let (_, _, changeError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [],
            cursor: nil,
            newAnchorData: "change-data",
            newVersion: 1,
            scope: .changeAnchor,
            explicitUserId: userId, explicitSourceId: sourceId,
            explicitSampleType: metricCode
        )
        XCTAssertNil(changeError)
        let hotCursor = sqlite.readCursor(userId: userId, sourceId: sourceId,
                                            sampleType: metricCode, scope: .hotAnchor)!
        let coldCursor = sqlite.readCursor(userId: userId, sourceId: sourceId,
                                             sampleType: metricCode, scope: .coldTime)!
        let changeCursor = sqlite.readCursor(userId: userId, sourceId: sourceId,
                                               sampleType: metricCode, scope: .changeAnchor)!
        XCTAssertEqual(hotCursor.scope, .hotAnchor)
        XCTAssertEqual(coldCursor.scope, .coldTime)
        XCTAssertEqual(changeCursor.scope, .changeAnchor)
        XCTAssertEqual(hotCursor.cursorVersion, 1)
        XCTAssertEqual(coldCursor.cursorVersion, 1)
        XCTAssertEqual(changeCursor.cursorVersion, 1)
        XCTAssertNotNil(coldCursor.coldBackfillEndTs)
        XCTAssertNil(hotCursor.coldBackfillEndTs)
        XCTAssertNil(changeCursor.coldBackfillEndTs)
        XCTAssertEqual(hotCursor.anchorData, "hot-data")
        XCTAssertNil(coldCursor.anchorData)
        XCTAssertEqual(changeCursor.anchorData, "change-data")
    }
}
final class DeletionOrderingTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_deletion_\(UUID().uuidString).db")
        var db: OpaquePointer?
        sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        if let db = db {
            execTestSQL(db, "PRAGMA journal_mode = WAL")
            createTestSchema(db: db)
            sqlite3_close_v2(db)
        }
        sqlite = HealthIngestSQLite()
        let error = sqlite.open(dbPath: dbPath, busyTimeoutMs: 5000)
        precondition(error == nil, "setUp: open failed: \(error!)")
    }
    override func tearDown() {
        sqlite.close()
        try? FileManager.default.removeItem(atPath: dbPath)
        try? FileManager.default.removeItem(atPath: dbPath + "-wal")
        try? FileManager.default.removeItem(atPath: dbPath + "-shm")
        super.tearDown()
    }
    func testSoftDelete_ThenReinsert_SkippedByDeleteGuard() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "guard-test",
                                           startTimestamp: 1700000000000)
        let (_, _, insertError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(insertError)
        let (deleted, deleteError) = sqlite.softDeleteAndEnqueue(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: ["guard-test"],
            startTimestamps: [1700000000000]
        )
        XCTAssertNil(deleteError)
        XCTAssertEqual(deleted, 1)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        let sameKey = makeNormalizedSample(id: UUID().uuidString.lowercased(),
                                            userId: "u1", sourceId: "s1",
                                            sourceRecordId: "guard-test",
                                            startTimestamp: 1700000000000,
                                            value: 99.0)
        let (reinserted, skipped, _) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sameKey], cursor: cursor, newAnchorData: nil,
            newVersion: 2, scope: .hotAnchor
        )
        XCTAssertEqual(reinserted, 0, "Re-insert of soft-deleted row should be skipped")
        XCTAssertEqual(skipped, 1)
    }
    func testSoftDelete_EnqueuesAllToQueue() {
        let count = 5
        let samples = (1...count).map { i in
            makeNormalizedSample(userId: "u1", sourceId: "s1",
                                  sourceRecordId: "enq-\(i)",
                                  startTimestamp: Int64(1700000000000 + i))
        }
        let (_, _, insertError) = sqlite.atomicInsertAndUpdateCursor(
            samples: samples, cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(insertError)
        let ids = (1...count).map { "enq-\($0)" }
        let timestamps: [Int64?] = (1...count).map { Int64(1700000000000 + $0) }
        let (deleted, deleteError) = sqlite.softDeleteAndEnqueue(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: ids,
            startTimestamps: timestamps
        )
        XCTAssertNil(deleteError)
        XCTAssertEqual(deleted, count)
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            let queued = countRows(db: rawDb, table: "health_sample_deletion_queue")
            XCTAssertEqual(queued, count, "All deleted samples should be enqueued")
            sqlite3_close_v2(rawDb)
        }
    }
    func testSoftDelete_SentinelTimestamp_WhenNotFound() {
        let (_, deleteError) = sqlite.softDeleteAndEnqueue(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: ["phantom-1"],
            startTimestamps: [nil]  
        )
        XCTAssertNil(deleteError)
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            let queued = countRows(db: rawDb, table: "health_sample_deletion_queue")
            XCTAssertEqual(queued, 1)
            var stmt: OpaquePointer?
            let sql = "SELECT start_timestamp_ms FROM health_sample_deletion_queue WHERE source_record_id = 'phantom-1'"
            if sqlite3_prepare_v2(rawDb, sql, -1, &stmt, nil) == SQLITE_OK {
                if sqlite3_step(stmt) == SQLITE_ROW {
                    let ts = sqlite3_column_int64(stmt, 0)
                    XCTAssertEqual(ts, UNKNOWN_START_TIMESTAMP_SENTINEL,
                                   "Unknown start_timestamp should use sentinel value (-1)")
                }
                sqlite3_finalize(stmt)
            }
            sqlite3_close_v2(rawDb)
        }
    }
}
