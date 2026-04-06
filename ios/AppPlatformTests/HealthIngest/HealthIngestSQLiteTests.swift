import XCTest
import SQLite3
@testable import AppPlatform
final class HealthIngestSQLiteOpenCloseTests: XCTestCase {
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_open_\(UUID().uuidString).db")
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        sqlite3_open_v2(dbPath, &db, flags, nil)
        if let db = db {
            execTestSQL(db, "PRAGMA journal_mode = WAL")
            createTestSchema(db: db)
            sqlite3_close_v2(db)
        }
    }
    override func tearDown() {
        try? FileManager.default.removeItem(atPath: dbPath)
        try? FileManager.default.removeItem(atPath: dbPath + "-wal")
        try? FileManager.default.removeItem(atPath: dbPath + "-shm")
        super.tearDown()
    }
    func testValidPath_OpensSuccessfully() {
        let sqlite = HealthIngestSQLite()
        let error = sqlite.open(dbPath: dbPath, busyTimeoutMs: 5000)
        XCTAssertNil(error, "Valid path should open without error")
        sqlite.close()
    }
    func testInvalidPath_ReturnsSqliteOpenFailed() {
        let sqlite = HealthIngestSQLite()
        let error = sqlite.open(dbPath: "/nonexistent/path/db.sqlite", busyTimeoutMs: 5000)
        XCTAssertEqual(error, .sqliteOpenFailed)
    }
    func testDoubleOpen_Idempotent() {
        let sqlite = HealthIngestSQLite()
        let error1 = sqlite.open(dbPath: dbPath, busyTimeoutMs: 5000)
        XCTAssertNil(error1)
        let error2 = sqlite.open(dbPath: dbPath, busyTimeoutMs: 5000)
        XCTAssertNil(error2, "Second open should be a no-op (idempotent)")
        sqlite.close()
    }
    func testSchemaMissingScopeColumn_ReturnsNotInitialized() {
        let badPath = (NSTemporaryDirectory() as NSString).appendingPathComponent("test_bad_\(UUID().uuidString).db")
        var db: OpaquePointer?
        sqlite3_open_v2(badPath, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        if let db = db {
            execTestSQL(db, "PRAGMA journal_mode = WAL")
            createTestSchema(db: db)
            execTestSQL(db, "DROP TABLE health_ingest_cursors")
            execTestSQL(db, """
                CREATE TABLE health_ingest_cursors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    sample_type TEXT NOT NULL,
                    anchor_data TEXT,
                    cursor_version INTEGER NOT NULL DEFAULT 1
                )
                """)
            sqlite3_close_v2(db)
        }
        let sqlite = HealthIngestSQLite()
        let error = sqlite.open(dbPath: badPath, busyTimeoutMs: 5000)
        XCTAssertEqual(error, .notInitialized, "Missing scope column should return .notInitialized")
        try? FileManager.default.removeItem(atPath: badPath)
        try? FileManager.default.removeItem(atPath: badPath + "-wal")
        try? FileManager.default.removeItem(atPath: badPath + "-shm")
    }
}
final class HealthIngestSQLiteReadCursorTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_cursor_\(UUID().uuidString).db")
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
    func testNoCursorExists_ReturnsNil() {
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                        sampleType: "heart_rate", scope: .hotAnchor)
        XCTAssertNil(cursor)
    }
    func testAfterInsert_ReturnsCorrectCursor() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "rec-1", sampleType: "heart_rate")
        let (inserted, skipped, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample],
            cursor: nil,
            newAnchorData: nil,
            newVersion: 1,
            scope: .hotAnchor
        )
        XCTAssertNil(error)
        XCTAssertEqual(inserted, 1)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                        sampleType: "heart_rate", scope: .hotAnchor)
        XCTAssertNotNil(cursor)
        XCTAssertEqual(cursor?.cursorVersion, 1)
        XCTAssertEqual(cursor?.userId, "u1")
        XCTAssertEqual(cursor?.sourceId, "s1")
        XCTAssertEqual(cursor?.sampleType, "heart_rate")
        XCTAssertEqual(cursor?.scope, .hotAnchor)
        XCTAssertEqual(cursor?.totalSamplesIngested, 1)
    }
    func testWrongScope_ReturnsNil() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "rec-1", sampleType: "heart_rate")
        let (_, _, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(error)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                        sampleType: "heart_rate", scope: .coldTime)
        XCTAssertNil(cursor, "Different scope should isolate cursor")
    }
}
final class HealthIngestSQLiteCreateCursorTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_create_\(UUID().uuidString).db")
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
    func testFirstInsert_CreatesCursor() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1")
        let (inserted, skipped, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: "anchor-data",
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(error)
        XCTAssertEqual(inserted, 1)
        XCTAssertEqual(skipped, 0)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                        sampleType: "heart_rate", scope: .hotAnchor)
        XCTAssertNotNil(cursor)
        XCTAssertEqual(cursor?.cursorVersion, 1)
    }
    func testEmptySamples_ExplicitIdentifiers_CreatesCursorVersion1() {
        let (inserted, skipped, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [],
            cursor: nil,
            newAnchorData: "anchor-for-empty",
            newVersion: 1,
            scope: .changeAnchor,
            explicitUserId: "u1",
            explicitSourceId: "s1",
            explicitSampleType: "heart_rate"
        )
        XCTAssertNil(error)
        XCTAssertEqual(inserted, 0)
        XCTAssertEqual(skipped, 0)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                        sampleType: "heart_rate", scope: .changeAnchor)
        XCTAssertNotNil(cursor)
        XCTAssertEqual(cursor?.cursorVersion, 1)
    }
    func testEmptySamples_NoIdentifiers_Fails() {
        let (_, _, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [],
            cursor: nil,
            newAnchorData: nil,
            newVersion: 1,
            scope: .changeAnchor
        )
        XCTAssertEqual(error, .sqliteWriteFailed,
                        "Empty samples + no explicit identifiers should fail fast")
    }
    func testCursorCreatedWithCorrectScope() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1")
        let (_, _, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .coldTime
        )
        XCTAssertNil(error)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                        sampleType: "heart_rate", scope: .coldTime)
        XCTAssertNotNil(cursor)
        XCTAssertEqual(cursor?.scope, .coldTime)
    }
}
final class HealthIngestSQLiteCASUpdateTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_cas_\(UUID().uuidString).db")
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
    func testCorrectVersion_UpdatesCursor() {
        let sample1 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        let (_, _, createError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample1], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(createError)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)
        XCTAssertNotNil(cursor)
        XCTAssertEqual(cursor?.cursorVersion, 1)
        let sample2 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r2")
        let (inserted, _, updateError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample2], cursor: cursor, newAnchorData: "anchor-v2",
            newVersion: 2, scope: .hotAnchor
        )
        XCTAssertNil(updateError)
        XCTAssertEqual(inserted, 1)
        let updated = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                          sampleType: "heart_rate", scope: .hotAnchor)
        XCTAssertEqual(updated?.cursorVersion, 2)
    }
    func testWrongVersion_CASConflict_Rollback() {
        let sample1 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        let (_, _, createError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample1], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(createError)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        let staleCursor = CursorData(
            id: cursor.id, userId: cursor.userId, sourceId: cursor.sourceId,
            sampleType: cursor.sampleType, scope: cursor.scope,
            anchorData: cursor.anchorData,
            cursorVersion: 999, 
            lastIngestTimestamp: cursor.lastIngestTimestamp,
            totalSamplesIngested: cursor.totalSamplesIngested,
            coldBackfillEndTs: cursor.coldBackfillEndTs,
            coldBackfillStartTs: cursor.coldBackfillStartTs,
            lastSyncAt: cursor.lastSyncAt
        )
        let sample2 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r2")
        let (_, _, casError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample2], cursor: staleCursor, newAnchorData: nil,
            newVersion: 1000, scope: .hotAnchor
        )
        XCTAssertNotNil(casError, "Wrong cursor version should cause CAS failure")
        XCTAssertEqual(casError, .sqliteWriteFailed)
        let unchanged = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                            sampleType: "heart_rate", scope: .hotAnchor)
        XCTAssertEqual(unchanged?.cursorVersion, 1, "Cursor should remain at version 1 after CAS failure")
    }
    func testVersionIncrementsExactlyBy1() {
        let sample1 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        sqlite.atomicInsertAndUpdateCursor(
            samples: [sample1], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        for version in 2...5 {
            let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                             sampleType: "heart_rate", scope: .hotAnchor)!
            XCTAssertEqual(cursor.cursorVersion, Int64(version - 1))
            let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                               sourceRecordId: "r\(version)")
            let (_, _, error) = sqlite.atomicInsertAndUpdateCursor(
                samples: [sample], cursor: cursor, newAnchorData: nil,
                newVersion: Int64(version), scope: .hotAnchor
            )
            XCTAssertNil(error)
        }
        let final = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                        sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(final.cursorVersion, 5)
    }
    func testTotalSamplesIngested_Accumulates() {
        let sample1 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        sqlite.atomicInsertAndUpdateCursor(
            samples: [sample1], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        var cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(cursor.totalSamplesIngested, 1)
        let sample2 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r2")
        let sample3 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r3")
        sqlite.atomicInsertAndUpdateCursor(
            samples: [sample2, sample3], cursor: cursor, newAnchorData: nil,
            newVersion: 2, scope: .hotAnchor
        )
        cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                     sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(cursor.totalSamplesIngested, 3, "1 + 2 = 3 accumulated")
    }
    func testColdLane_NilBackfillEndTs_PreservesExisting() {
        let sample1 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        let (_, _, createError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample1], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .coldTime,
            coldBackfillEndTs: 1700000000000,
            coldBackfillStartTs: 1690000000000
        )
        XCTAssertNil(createError)
        let cursor1 = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                          sampleType: "heart_rate", scope: .coldTime)!
        XCTAssertEqual(cursor1.coldBackfillEndTs, 1700000000000)
        let sample2 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r2")
        let (_, _, updateError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample2], cursor: cursor1, newAnchorData: nil,
            newVersion: 2, scope: .coldTime,
            coldBackfillEndTs: nil, 
            coldBackfillStartTs: 1690000000000
        )
        XCTAssertNil(updateError)
        let cursor2 = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                          sampleType: "heart_rate", scope: .coldTime)!
        XCTAssertEqual(cursor2.coldBackfillEndTs, 1700000000000,
                        "nil coldBackfillEndTs should COALESCE to preserve existing value")
    }
}
final class HealthIngestSQLiteUpsertDedupTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_dedup_\(UUID().uuidString).db")
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
    func testSameSourceRecord_Updates_NotDuplicates() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "dup-id",
                                           startTimestamp: 1700000000000,
                                           value: 72.0)
        let (inserted1, _, error1) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(error1)
        XCTAssertEqual(inserted1, 1)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        let sampleUpdated = makeNormalizedSample(id: UUID().uuidString.lowercased(),
                                                  userId: "u1", sourceId: "s1",
                                                  sourceRecordId: "dup-id",
                                                  startTimestamp: 1700000000000,
                                                  value: 80.0)
        let (inserted2, skipped2, error2) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sampleUpdated], cursor: cursor, newAnchorData: nil,
            newVersion: 2, scope: .hotAnchor
        )
        XCTAssertNil(error2)
        XCTAssertEqual(inserted2, 1, "ON CONFLICT DO UPDATE should count as a change")
        XCTAssertEqual(skipped2, 0)
    }
    func testDeletedRow_OnConflict_Skipped() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "del-id",
                                           startTimestamp: 1700000000000)
        let (_, _, error1) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(error1)
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            execTestSQL(rawDb, "UPDATE health_samples SET is_deleted = 1 WHERE source_record_id = 'del-id'")
            sqlite3_close_v2(rawDb)
        }
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        let sampleAgain = makeNormalizedSample(id: UUID().uuidString.lowercased(),
                                                userId: "u1", sourceId: "s1",
                                                sourceRecordId: "del-id",
                                                startTimestamp: 1700000000000)
        let (inserted, skipped, error2) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sampleAgain], cursor: cursor, newAnchorData: nil,
            newVersion: 2, scope: .hotAnchor
        )
        XCTAssertNil(error2)
        XCTAssertEqual(inserted, 0, "Deleted row should be skipped on conflict")
        XCTAssertEqual(skipped, 1)
    }
    func testInsertedVsSkipped_CountsCorrect() {
        let samples = (1...3).map { i in
            makeNormalizedSample(userId: "u1", sourceId: "s1",
                                  sourceRecordId: "rec-\(i)", startTimestamp: Int64(1700000000000 + i))
        }
        let (inserted1, skipped1, _) = sqlite.atomicInsertAndUpdateCursor(
            samples: samples, cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertEqual(inserted1, 3)
        XCTAssertEqual(skipped1, 0)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        let mixedSamples = [
            makeNormalizedSample(userId: "u1", sourceId: "s1",
                                  sourceRecordId: "rec-1", startTimestamp: 1700000000001), 
            makeNormalizedSample(userId: "u1", sourceId: "s1",
                                  sourceRecordId: "rec-2", startTimestamp: 1700000000002), 
            makeNormalizedSample(userId: "u1", sourceId: "s1",
                                  sourceRecordId: "rec-4", startTimestamp: 1700000000004), 
            makeNormalizedSample(userId: "u1", sourceId: "s1",
                                  sourceRecordId: "rec-5", startTimestamp: 1700000000005), 
        ]
        let (inserted2, skipped2, _) = sqlite.atomicInsertAndUpdateCursor(
            samples: mixedSamples, cursor: cursor, newAnchorData: nil,
            newVersion: 2, scope: .hotAnchor
        )
        XCTAssertEqual(inserted2 + skipped2, 4, "Total should equal sample count")
    }
}
final class HealthIngestSQLiteSoftDeleteTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_delete_\(UUID().uuidString).db")
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
    func testExistingSamples_SoftDeletedAndEnqueued() {
        let samples = (1...3).map { i in
            makeNormalizedSample(userId: "u1", sourceId: "s1",
                                  sourceRecordId: "del-\(i)", startTimestamp: Int64(1700000000000 + i))
        }
        let (_, _, insertError) = sqlite.atomicInsertAndUpdateCursor(
            samples: samples, cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(insertError)
        let ids = ["del-1", "del-2", "del-3"]
        let timestamps: [Int64?] = [1700000000001, 1700000000002, nil]
        let (deletedCount, deleteError) = sqlite.softDeleteAndEnqueue(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: ids, startTimestamps: timestamps
        )
        XCTAssertNil(deleteError)
        XCTAssertEqual(deletedCount, 3)
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            let deleted = countRows(db: rawDb, table: "health_samples", where: "is_deleted = 1")
            XCTAssertEqual(deleted, 3)
            let queued = countRows(db: rawDb, table: "health_sample_deletion_queue")
            XCTAssertEqual(queued, 3)
            sqlite3_close_v2(rawDb)
        }
    }
    func testNonexistentIds_ZeroDeleted_NoError() {
        let (deletedCount, error) = sqlite.softDeleteAndEnqueue(
            userId: "u1", sourceId: "s1",
            sourceRecordIds: ["nonexistent-1", "nonexistent-2"],
            startTimestamps: [nil, nil]
        )
        XCTAssertNil(error)
        XCTAssertEqual(deletedCount, 0, "Non-existent IDs should result in 0 deletions")
    }
}
