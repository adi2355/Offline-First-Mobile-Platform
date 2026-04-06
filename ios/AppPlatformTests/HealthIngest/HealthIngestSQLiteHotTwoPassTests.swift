import XCTest
import SQLite3
@testable import AppPlatform
final class InsertSamplesOnlyTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_insert_only_\(UUID().uuidString).db")
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
    func testInsertSamplesOnly_NoCursorExists_InsertsWithoutCreatingCursor() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "rec-1", sampleType: "heart_rate")
        let (inserted, skipped, error) = sqlite.insertSamplesOnly(samples: [sample])
        XCTAssertNil(error)
        XCTAssertEqual(inserted, 1)
        XCTAssertEqual(skipped, 0)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                        sampleType: "heart_rate", scope: .hotAnchor)
        XCTAssertNil(cursor, "insertSamplesOnly must NOT create a cursor")
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            let count = countRows(db: rawDb, table: "health_samples",
                                  where: "source_record_id = 'rec-1'")
            XCTAssertEqual(count, 1)
            sqlite3_close_v2(rawDb)
        }
    }
    func testInsertSamplesOnly_ExistingCursor_NotModified() {
        let setup = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                          sourceRecordId: "setup-rec", sampleType: "heart_rate")
        let (_, _, setupError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [setup], cursor: nil, newAnchorData: "anchor-v1",
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(setupError)
        let cursorBefore = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                              sampleType: "heart_rate", scope: .hotAnchor)!
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "pass-a-rec", sampleType: "heart_rate")
        let (inserted, _, error) = sqlite.insertSamplesOnly(samples: [sample])
        XCTAssertNil(error)
        XCTAssertEqual(inserted, 1)
        let cursorAfter = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                             sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(cursorAfter.cursorVersion, cursorBefore.cursorVersion,
                       "Cursor version must not change after insertSamplesOnly")
        XCTAssertEqual(cursorAfter.totalSamplesIngested, cursorBefore.totalSamplesIngested,
                       "Total samples ingested must not change after insertSamplesOnly")
        XCTAssertEqual(cursorAfter.lastIngestTimestamp, cursorBefore.lastIngestTimestamp,
                       "Watermark must not change after insertSamplesOnly")
    }
    func testInsertSamplesOnly_EmptySamples_ReturnsZeroNoError() {
        let (inserted, skipped, error) = sqlite.insertSamplesOnly(samples: [])
        XCTAssertNil(error)
        XCTAssertEqual(inserted, 0)
        XCTAssertEqual(skipped, 0)
    }
    func testInsertSamplesOnly_DuplicateSamples_UpsertDedup() {
        let sample1 = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                            sourceRecordId: "dup-rec",
                                            startTimestamp: 1700000000000,
                                            value: 72.0)
        let (inserted1, _, error1) = sqlite.insertSamplesOnly(samples: [sample1])
        XCTAssertNil(error1)
        XCTAssertEqual(inserted1, 1)
        let sample2 = makeNormalizedSample(id: UUID().uuidString.lowercased(),
                                            userId: "u1", sourceId: "s1",
                                            sourceRecordId: "dup-rec",
                                            startTimestamp: 1700000000000,
                                            value: 85.0)
        let (inserted2, skipped2, error2) = sqlite.insertSamplesOnly(samples: [sample2])
        XCTAssertNil(error2)
        XCTAssertEqual(inserted2, 1, "ON CONFLICT DO UPDATE should count as change")
        XCTAssertEqual(skipped2, 0)
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            let count = countRows(db: rawDb, table: "health_samples",
                                  where: "source_record_id = 'dup-rec'")
            XCTAssertEqual(count, 1, "Dedup should keep exactly 1 row")
            sqlite3_close_v2(rawDb)
        }
    }
    func testInsertSamplesOnly_SoftDeletedRow_Skipped() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "del-rec",
                                           startTimestamp: 1700000000000)
        let (_, _, insertError) = sqlite.insertSamplesOnly(samples: [sample])
        XCTAssertNil(insertError)
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            execTestSQL(rawDb, "UPDATE health_samples SET is_deleted = 1 WHERE source_record_id = 'del-rec'")
            sqlite3_close_v2(rawDb)
        }
        let sameKey = makeNormalizedSample(id: UUID().uuidString.lowercased(),
                                            userId: "u1", sourceId: "s1",
                                            sourceRecordId: "del-rec",
                                            startTimestamp: 1700000000000)
        let (inserted, skipped, error) = sqlite.insertSamplesOnly(samples: [sameKey])
        XCTAssertNil(error)
        XCTAssertEqual(inserted, 0, "Soft-deleted row should be skipped")
        XCTAssertEqual(skipped, 1)
    }
    func testInsertSamplesOnly_MultipleSamples_AllInserted() {
        let samples = (1...5).map { i in
            makeNormalizedSample(userId: "u1", sourceId: "s1",
                                  sourceRecordId: "multi-\(i)",
                                  startTimestamp: Int64(1700000000000 + i))
        }
        let (inserted, skipped, error) = sqlite.insertSamplesOnly(samples: samples)
        XCTAssertNil(error)
        XCTAssertEqual(inserted, 5)
        XCTAssertEqual(skipped, 0)
    }
}
final class WatermarkOverrideTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_watermark_\(UUID().uuidString).db")
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
    func testOverride_SetsExactWatermark() {
        let sample1 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        let (_, _, createError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample1], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(createError)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        let overrideMs: Int64 = 1_600_000_000_000  
        let sample2 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r2")
        let (_, _, updateError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample2], cursor: cursor, newAnchorData: nil,
            newVersion: 2, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: overrideMs
        )
        XCTAssertNil(updateError)
        let updated = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                          sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(updated.lastIngestTimestamp, overrideMs,
                       "Watermark should be the override value, not now")
    }
    func testNoOverride_UsesNow() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        let beforeMs = Int64(Date().timeIntervalSince1970 * 1000)
        let (_, _, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(error)
        let afterMs = Int64(Date().timeIntervalSince1970 * 1000)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertNotNil(cursor.lastIngestTimestamp)
        XCTAssertGreaterThanOrEqual(cursor.lastIngestTimestamp!, beforeMs)
        XCTAssertLessThanOrEqual(cursor.lastIngestTimestamp!, afterMs + 5000)
    }
    func testOverride_OnCreate_SetsWatermark() {
        let overrideMs: Int64 = 1_500_000_000_000
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        let (_, _, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: overrideMs
        )
        XCTAssertNil(error)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(cursor.lastIngestTimestamp, overrideMs,
                       "New cursor should use override value for watermark")
    }
    func testOverride_OnUpdate_SetsWatermark_LastSyncAtStillNow() {
        let sample1 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        let (_, _, createError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample1], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(createError)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        let overrideMs: Int64 = 1_600_000_000_000
        let beforeMs = Int64(Date().timeIntervalSince1970 * 1000)
        let sample2 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r2")
        let (_, _, updateError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample2], cursor: cursor, newAnchorData: nil,
            newVersion: 2, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: overrideMs
        )
        XCTAssertNil(updateError)
        let afterMs = Int64(Date().timeIntervalSince1970 * 1000)
        let updated = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                          sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(updated.lastIngestTimestamp, overrideMs)
        XCTAssertNotNil(updated.lastSyncAt)
        XCTAssertGreaterThanOrEqual(updated.lastSyncAt!, beforeMs)
        XCTAssertLessThanOrEqual(updated.lastSyncAt!, afterMs + 5000)
    }
    func testOverride_EmptySamples_StillAdvancesWatermark() {
        let sample1 = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "r1")
        let (_, _, createError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample1], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(createError)
        let cursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                         sampleType: "heart_rate", scope: .hotAnchor)!
        let overrideMs: Int64 = 1_700_000_000_000
        let (inserted, _, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [],
            cursor: cursor,
            newAnchorData: nil,
            newVersion: 2,
            scope: .hotAnchor,
            lastIngestTimestampOverrideMs: overrideMs,
            explicitUserId: "u1",
            explicitSourceId: "s1",
            explicitSampleType: "heart_rate"
        )
        XCTAssertNil(error)
        XCTAssertEqual(inserted, 0)
        let updated = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                          sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(updated.lastIngestTimestamp, overrideMs,
                       "Empty samples + override should still advance watermark")
        XCTAssertEqual(updated.cursorVersion, 2)
    }
}
final class TwoPassSimulationTests: XCTestCase {
    private var sqlite: HealthIngestSQLite!
    private var dbPath: String = ""
    override func setUp() {
        super.setUp()
        let tempDir = NSTemporaryDirectory()
        dbPath = (tempDir as NSString).appendingPathComponent("test_twopass_\(UUID().uuidString).db")
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
    /
    /
    /
    /
    /
    /
    func testFullTwoPass_PassAThenPassBThenFinalize() {
        let userId = "u1"
        let sourceId = "s1"
        let metricCode = "heart_rate"
        let nowMs: Int64 = 1_700_000_000_000
        let bootstrapSample = makeNormalizedSample(userId: userId, sourceId: sourceId,
                                                    sourceRecordId: "bootstrap",
                                                    sampleType: metricCode)
        let oldWatermarkMs: Int64 = nowMs - (48 * 3_600_000) 
        let (_, _, bootError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [bootstrapSample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: oldWatermarkMs
        )
        XCTAssertNil(bootError)
        let passASamples = (1...3).map { i in
            makeNormalizedSample(userId: userId, sourceId: sourceId,
                                  sourceRecordId: "passA-\(i)", sampleType: metricCode,
                                  startTimestamp: nowMs - Int64(i * 1000))
        }
        let (passAInserted, _, passAError) = sqlite.insertSamplesOnly(samples: passASamples)
        XCTAssertNil(passAError)
        XCTAssertEqual(passAInserted, 3)
        let cursorAfterA = sqlite.readCursor(userId: userId, sourceId: sourceId,
                                              sampleType: metricCode, scope: .hotAnchor)!
        XCTAssertEqual(cursorAfterA.cursorVersion, 1, "Pass A must not touch cursor")
        XCTAssertEqual(cursorAfterA.lastIngestTimestamp, oldWatermarkMs)
        let chunk1EndMs: Int64 = oldWatermarkMs + 21_600_000  
        let chunk1Sample = makeNormalizedSample(userId: userId, sourceId: sourceId,
                                                 sourceRecordId: "passB-c1",
                                                 sampleType: metricCode)
        let (_, _, c1Error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [chunk1Sample], cursor: cursorAfterA, newAnchorData: nil,
            newVersion: 2, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: chunk1EndMs
        )
        XCTAssertNil(c1Error)
        let cursorAfterC1 = sqlite.readCursor(userId: userId, sourceId: sourceId,
                                               sampleType: metricCode, scope: .hotAnchor)!
        XCTAssertEqual(cursorAfterC1.cursorVersion, 2)
        XCTAssertEqual(cursorAfterC1.lastIngestTimestamp, chunk1EndMs)
        let chunk2EndMs: Int64 = chunk1EndMs + 21_600_000  
        let chunk2Sample = makeNormalizedSample(userId: userId, sourceId: sourceId,
                                                 sourceRecordId: "passB-c2",
                                                 sampleType: metricCode)
        let (_, _, c2Error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [chunk2Sample], cursor: cursorAfterC1, newAnchorData: nil,
            newVersion: 3, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: chunk2EndMs
        )
        XCTAssertNil(c2Error)
        let cursorAfterC2 = sqlite.readCursor(userId: userId, sourceId: sourceId,
                                               sampleType: metricCode, scope: .hotAnchor)!
        XCTAssertEqual(cursorAfterC2.lastIngestTimestamp, chunk2EndMs)
        let (_, _, finalError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [], cursor: cursorAfterC2, newAnchorData: nil,
            newVersion: 4, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: nowMs,
            explicitUserId: userId, explicitSourceId: sourceId,
            explicitSampleType: metricCode
        )
        XCTAssertNil(finalError)
        let finalCursor = sqlite.readCursor(userId: userId, sourceId: sourceId,
                                             sampleType: metricCode, scope: .hotAnchor)!
        XCTAssertEqual(finalCursor.cursorVersion, 4)
        XCTAssertEqual(finalCursor.lastIngestTimestamp, nowMs,
                       "Watermark should be advanced to nowMs after finalization")
        XCTAssertEqual(finalCursor.totalSamplesIngested, 3,
                       "Bootstrap=1 + chunk1=1 + chunk2=1 = 3 (Pass A samples not counted via cursor)")
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            let count = countRows(db: rawDb, table: "health_samples")
            XCTAssertEqual(count, 6, "Total samples: 1 bootstrap + 3 passA + 2 passB chunks")
            sqlite3_close_v2(rawDb)
        }
    }
    func testPassA_DoesNotBlockPassB_CursorVersionUnchanged() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1", sourceRecordId: "init")
        let (_, _, initError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
        XCTAssertNil(initError)
        let cursorV1 = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                           sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(cursorV1.cursorVersion, 1)
        let passASample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                                sourceRecordId: "passA-1")
        let (_, _, passAError) = sqlite.insertSamplesOnly(samples: [passASample])
        XCTAssertNil(passAError)
        let cursorStillV1 = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                                sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(cursorStillV1.cursorVersion, 1,
                       "insertSamplesOnly must not increment cursor version")
        let passBSample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                                sourceRecordId: "passB-1")
        let (_, _, passBError) = sqlite.atomicInsertAndUpdateCursor(
            samples: [passBSample], cursor: cursorStillV1, newAnchorData: nil,
            newVersion: 2, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: 1_600_000_000_000
        )
        XCTAssertNil(passBError, "Pass B should succeed because Pass A didn't change cursor version")
        let cursorV2 = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                           sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(cursorV2.cursorVersion, 2)
    }
    func testPassB_MultiChunk_WatermarkAdvancesIncrementally() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "init", sampleType: "heart_rate")
        sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: 1_000_000_000_000
        )
        var currentCursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                                sampleType: "heart_rate", scope: .hotAnchor)!
        let chunkBoundaries: [Int64] = [
            1_000_021_600_000,  
            1_000_043_200_000,  
            1_000_064_800_000,  
        ]
        for (i, boundary) in chunkBoundaries.enumerated() {
            let chunkSample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                                    sourceRecordId: "chunk-\(i)",
                                                    sampleType: "heart_rate")
            let (_, _, error) = sqlite.atomicInsertAndUpdateCursor(
                samples: [chunkSample], cursor: currentCursor, newAnchorData: nil,
                newVersion: Int64(i + 2), scope: .hotAnchor,
                lastIngestTimestampOverrideMs: boundary
            )
            XCTAssertNil(error)
            currentCursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                                sampleType: "heart_rate", scope: .hotAnchor)!
            XCTAssertEqual(currentCursor.lastIngestTimestamp, boundary,
                           "Watermark should be at chunk boundary \(i) = \(boundary)")
        }
    }
    func testPartialCatchup_WatermarkStaysAtLastChunk() {
        let oldWatermark: Int64 = 1_000_000_000_000
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "init", sampleType: "heart_rate")
        sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: oldWatermark
        )
        var currentCursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                                sampleType: "heart_rate", scope: .hotAnchor)!
        let chunk1End: Int64 = oldWatermark + 21_600_000
        let chunk2End: Int64 = chunk1End + 21_600_000
        for (i, boundary) in [chunk1End, chunk2End].enumerated() {
            let s = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                          sourceRecordId: "partial-\(i)",
                                          sampleType: "heart_rate")
            sqlite.atomicInsertAndUpdateCursor(
                samples: [s], cursor: currentCursor, newAnchorData: nil,
                newVersion: Int64(i + 2), scope: .hotAnchor,
                lastIngestTimestampOverrideMs: boundary
            )
            currentCursor = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                                sampleType: "heart_rate", scope: .hotAnchor)!
        }
        XCTAssertEqual(currentCursor.lastIngestTimestamp, chunk2End,
                       "Partial catch-up: watermark stays at last completed chunk")
    }
    func testCASConflict_InPassB_RollsBackSamples() {
        let sample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                           sourceRecordId: "init", sampleType: "heart_rate")
        sqlite.atomicInsertAndUpdateCursor(
            samples: [sample], cursor: nil, newAnchorData: nil,
            newVersion: 1, scope: .hotAnchor
        )
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
        let newSample = makeNormalizedSample(userId: "u1", sourceId: "s1",
                                              sourceRecordId: "conflict-sample",
                                              sampleType: "heart_rate")
        let (_, _, error) = sqlite.atomicInsertAndUpdateCursor(
            samples: [newSample], cursor: staleCursor, newAnchorData: nil,
            newVersion: 1000, scope: .hotAnchor,
            lastIngestTimestampOverrideMs: 1_600_000_000_000
        )
        XCTAssertEqual(error, .sqliteWriteFailed, "CAS conflict should return sqliteWriteFailed")
        var rawDb: OpaquePointer?
        sqlite3_open_v2(dbPath, &rawDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        if let rawDb = rawDb {
            let count = countRows(db: rawDb, table: "health_samples",
                                  where: "source_record_id = 'conflict-sample'")
            XCTAssertEqual(count, 0, "CAS failure should ROLLBACK inserted samples")
            sqlite3_close_v2(rawDb)
        }
        let unchanged = sqlite.readCursor(userId: "u1", sourceId: "s1",
                                            sampleType: "heart_rate", scope: .hotAnchor)!
        XCTAssertEqual(unchanged.cursorVersion, 1)
    }
}
