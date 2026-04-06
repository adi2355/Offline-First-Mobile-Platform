import Foundation
import SQLite3
/
/
/
/
/
/
/
/
/
/
/
/
/
final class HealthIngestSQLite {
    private var db: OpaquePointer?
    private let writeQueue = DispatchQueue(label: "com.appplatform.healthingest.sqlite", qos: .userInitiated)
    private var isOpen = false
    /
    private var sampleUpsertStmt: OpaquePointer?
    private var cursorReadStmt: OpaquePointer?
    private var cursorCreateStmt: OpaquePointer?
    private var cursorUpdateHotStmt: OpaquePointer?
    private var cursorUpdateColdStmt: OpaquePointer?
    private var deletionQueueStmt: OpaquePointer?
    deinit {
        close()
    }
    /
    /
    /
    /
    /
    /
    /
    func open(dbPath: String, busyTimeoutMs: Int) -> NativeErrorCode? {
        return writeQueue.sync {
            guard !isOpen else { return nil }
            let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
            let result = sqlite3_open_v2(dbPath, &db, flags, nil)
            guard result == SQLITE_OK, let db = db else {
                let errMsg = db.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
                NSLog("[HealthIngestSQLite] Failed to open database at %@: %@ (code %d)", dbPath, errMsg, result)
                return .sqliteOpenFailed
            }
            if let error = configurePragmas(busyTimeoutMs: busyTimeoutMs) {
                sqlite3_close_v2(db)
                self.db = nil
                return error
            }
            if let error = verifySchema() {
                sqlite3_close_v2(db)
                self.db = nil
                return error
            }
            if let error = prepareStatements() {
                sqlite3_close_v2(db)
                self.db = nil
                return error
            }
            isOpen = true
            NSLog("[HealthIngestSQLite] Database opened successfully at %@", dbPath)
            return nil
        }
    }
    /
    func close() {
        writeQueue.sync {
            finalizeStatements()
            if let db = db {
                sqlite3_close_v2(db)
            }
            db = nil
            isOpen = false
        }
    }
    /
    /
    /
    /
    private func configurePragmas(busyTimeoutMs: Int) -> NativeErrorCode? {
        guard let db = db else { return .sqliteOpenFailed }
        if execSQL("PRAGMA busy_timeout = \(busyTimeoutMs)") != SQLITE_OK {
            NSLog("[HealthIngestSQLite] Failed to set busy_timeout")
            return .sqliteOpenFailed
        }
        var journalMode: String?
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "PRAGMA journal_mode", -1, &stmt, nil) == SQLITE_OK {
            if sqlite3_step(stmt) == SQLITE_ROW {
                if let cStr = sqlite3_column_text(stmt, 0) {
                    journalMode = String(cString: cStr)
                }
            }
            sqlite3_finalize(stmt)
        }
        if journalMode?.lowercased() != "wal" {
            NSLog("[HealthIngestSQLite] WAL mode not set, attempting to enable")
            if execSQL("PRAGMA journal_mode = WAL") != SQLITE_OK {
                NSLog("[HealthIngestSQLite] Failed to enable WAL mode")
                return .sqliteOpenFailed
            }
        }
        if execSQL("PRAGMA foreign_keys = ON") != SQLITE_OK {
            NSLog("[HealthIngestSQLite] Failed to enable foreign_keys")
            return .sqliteOpenFailed
        }
        return nil
    }
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    private func verifySchema() -> NativeErrorCode? {
        guard let db = db else { return .sqliteOpenFailed }
        let requiredCursorColumns: Set<String> = [
            "scope",                    
            "cold_backfill_end_ts",     
            "cold_backfill_start_ts",   
            "last_sync_at",             
            "last_ingest_timestamp",    
            "total_samples_ingested",   
            "anchor_data",              
            "cursor_version",           
        ]
        let staleColumns: Set<String> = ["last_ingest_at", "samples_fetched"]
        var foundColumns: Set<String> = []
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "PRAGMA table_info(health_ingest_cursors)", -1, &stmt, nil) == SQLITE_OK {
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let namePtr = sqlite3_column_text(stmt, 1) {
                    foundColumns.insert(String(cString: namePtr))
                }
            }
            sqlite3_finalize(stmt)
        }
        for col in requiredCursorColumns {
            if !foundColumns.contains(col) {
                NSLog("[HealthIngestSQLite] CRITICAL: health_ingest_cursors.%@ column missing. Found: %@",
                      col, foundColumns.sorted().joined(separator: ", "))
                return .notInitialized
            }
        }
        for col in staleColumns {
            if foundColumns.contains(col) {
                NSLog("[HealthIngestSQLite] CRITICAL: Stale column '%@' still exists (should have been renamed by DatabaseManager repair).", col)
                return .notInitialized
            }
        }
        var hasOldIndex = false
        if sqlite3_prepare_v2(db,
            "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_health_cursors_user_source_type'",
            -1, &stmt, nil) == SQLITE_OK {
            if sqlite3_step(stmt) == SQLITE_ROW {
                hasOldIndex = true
            }
            sqlite3_finalize(stmt)
        }
        if hasOldIndex {
            NSLog("[HealthIngestSQLite] CRITICAL: Old 3-col unique index 'uq_health_cursors_user_source_type' " +
                  "still exists. Lane isolation is broken — cannot create separate HOT/COLD/CHANGE cursors " +
                  "for the same (user, source, type). DatabaseManager repair may have failed.")
            return .notInitialized
        }
        var hasNewIndex = false
        if sqlite3_prepare_v2(db,
            "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_health_ingest_cursor'",
            -1, &stmt, nil) == SQLITE_OK {
            if sqlite3_step(stmt) == SQLITE_ROW {
                hasNewIndex = true
            }
            sqlite3_finalize(stmt)
        }
        if !hasNewIndex {
            NSLog("[HealthIngestSQLite] CRITICAL: 4-col unique index 'uq_health_ingest_cursor' missing. " +
                  "Cursor uniqueness is not enforced.")
            return .notInitialized
        }
        var sampleColumnCount = 0
        if sqlite3_prepare_v2(db, "PRAGMA table_info(health_samples)", -1, &stmt, nil) == SQLITE_OK {
            while sqlite3_step(stmt) == SQLITE_ROW {
                sampleColumnCount += 1
            }
            sqlite3_finalize(stmt)
        }
        if sampleColumnCount < 26 {
            NSLog("[HealthIngestSQLite] health_samples has %d columns, expected 26+", sampleColumnCount)
            return .notInitialized
        }
        return nil
    }
    /
    private func prepareStatements() -> NativeErrorCode? {
        guard let db = db else { return .sqliteOpenFailed }
        let sampleUpsertSQL = """
            INSERT INTO health_samples (
              id, user_id, source_id, source_record_id, sample_type, value_kind,
              start_timestamp, end_timestamp, value, unit, category_code,
              duration_seconds, device_id, external_uuid, metadata,
              upload_status, staged_batch_id, uploaded_at, upload_error,
              upload_attempt_count, next_upload_attempt_at, state_updated_at_ms,
              created_at, is_deleted, deleted_at_ms, upload_request_id
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                    'pending', NULL, NULL, NULL, 0, NULL, ?16, ?17, 0, NULL, NULL)
            ON CONFLICT (user_id, source_id, source_record_id, start_timestamp)
            DO UPDATE SET
              value = excluded.value,
              unit = excluded.unit,
              category_code = excluded.category_code,
              value_kind = excluded.value_kind,
              end_timestamp = excluded.end_timestamp,
              duration_seconds = excluded.duration_seconds,
              device_id = COALESCE(excluded.device_id, health_samples.device_id),
              external_uuid = COALESCE(excluded.external_uuid, health_samples.external_uuid),
              metadata = COALESCE(excluded.metadata, health_samples.metadata),
              state_updated_at_ms = excluded.state_updated_at_ms
            WHERE health_samples.is_deleted = 0
            """
        if sqlite3_prepare_v2(db, sampleUpsertSQL, -1, &sampleUpsertStmt, nil) != SQLITE_OK {
            NSLog("[HealthIngestSQLite] Failed to prepare sample upsert: %s", String(cString: sqlite3_errmsg(db)))
            return .sqliteWriteFailed
        }
        let cursorReadSQL = """
            SELECT
              id, user_id, source_id, sample_type, scope,
              anchor_data, cursor_version, last_ingest_timestamp,
              total_samples_ingested, cold_backfill_end_ts,
              cold_backfill_start_ts, last_sync_at,
              created_at, updated_at
            FROM health_ingest_cursors
            WHERE user_id = ?1 AND source_id = ?2 AND sample_type = ?3 AND scope = ?4
            """
        if sqlite3_prepare_v2(db, cursorReadSQL, -1, &cursorReadStmt, nil) != SQLITE_OK {
            NSLog("[HealthIngestSQLite] Failed to prepare cursor read: %s", String(cString: sqlite3_errmsg(db)))
            return .sqliteWriteFailed
        }
        let cursorCreateSQL = """
            INSERT INTO health_ingest_cursors (
              user_id, source_id, sample_type, scope,
              anchor_data, cursor_version, last_ingest_timestamp,
              total_samples_ingested, last_sync_at,
              cold_backfill_end_ts, cold_backfill_start_ts,
              created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            """
        if sqlite3_prepare_v2(db, cursorCreateSQL, -1, &cursorCreateStmt, nil) != SQLITE_OK {
            NSLog("[HealthIngestSQLite] Failed to prepare cursor create: %s", String(cString: sqlite3_errmsg(db)))
            return .sqliteWriteFailed
        }
        let cursorUpdateHotSQL = """
            UPDATE health_ingest_cursors
            SET
              anchor_data = ?1,
              cursor_version = ?2,
              last_ingest_timestamp = ?3,
              total_samples_ingested = total_samples_ingested + ?4,
              last_sync_at = ?5,
              updated_at = ?6
            WHERE
              user_id = ?7
              AND source_id = ?8
              AND sample_type = ?9
              AND scope = ?10
              AND cursor_version = ?11
            """
        if sqlite3_prepare_v2(db, cursorUpdateHotSQL, -1, &cursorUpdateHotStmt, nil) != SQLITE_OK {
            NSLog("[HealthIngestSQLite] Failed to prepare cursor update (hot): %s", String(cString: sqlite3_errmsg(db)))
            return .sqliteWriteFailed
        }
        let cursorUpdateColdSQL = """
            UPDATE health_ingest_cursors
            SET
              cold_backfill_end_ts = COALESCE(?1, cold_backfill_end_ts),
              cold_backfill_start_ts = COALESCE(cold_backfill_start_ts, ?2),
              cursor_version = ?3,
              last_ingest_timestamp = ?4,
              total_samples_ingested = total_samples_ingested + ?5,
              last_sync_at = ?6,
              updated_at = ?7
            WHERE
              user_id = ?8
              AND source_id = ?9
              AND sample_type = ?10
              AND scope = 'cold_time'
              AND cursor_version = ?11
            """
        if sqlite3_prepare_v2(db, cursorUpdateColdSQL, -1, &cursorUpdateColdStmt, nil) != SQLITE_OK {
            NSLog("[HealthIngestSQLite] Failed to prepare cursor update (cold): %s", String(cString: sqlite3_errmsg(db)))
            return .sqliteWriteFailed
        }
        let deletionQueueSQL = """
            INSERT INTO health_sample_deletion_queue (
              user_id, source_id, source_record_id, start_timestamp_ms,
              deleted_at_ms, upload_status, upload_attempt_count, state_updated_at_ms
            )
            VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6)
            ON CONFLICT (user_id, source_id, source_record_id, start_timestamp_ms)
            DO UPDATE SET
              deleted_at_ms = excluded.deleted_at_ms,
              upload_status = 'pending',
              upload_error = NULL,
              upload_attempt_count = 0,
              next_upload_attempt_at = NULL,
              state_updated_at_ms = excluded.state_updated_at_ms
            """
        if sqlite3_prepare_v2(db, deletionQueueSQL, -1, &deletionQueueStmt, nil) != SQLITE_OK {
            NSLog("[HealthIngestSQLite] Failed to prepare deletion queue: %s", String(cString: sqlite3_errmsg(db)))
            return .sqliteWriteFailed
        }
        return nil
    }
    /
    private func finalizeStatements() {
        if let stmt = sampleUpsertStmt { sqlite3_finalize(stmt) }
        if let stmt = cursorReadStmt { sqlite3_finalize(stmt) }
        if let stmt = cursorCreateStmt { sqlite3_finalize(stmt) }
        if let stmt = cursorUpdateHotStmt { sqlite3_finalize(stmt) }
        if let stmt = cursorUpdateColdStmt { sqlite3_finalize(stmt) }
        if let stmt = deletionQueueStmt { sqlite3_finalize(stmt) }
        sampleUpsertStmt = nil
        cursorReadStmt = nil
        cursorCreateStmt = nil
        cursorUpdateHotStmt = nil
        cursorUpdateColdStmt = nil
        deletionQueueStmt = nil
    }
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    func atomicInsertAndUpdateCursor(
        samples: [NormalizedHealthSample],
        cursor: CursorData?,
        newAnchorData: String?,
        newVersion: Int64,
        scope: CursorScope,
        coldBackfillEndTs: Int64? = nil,
        coldBackfillStartTs: Int64? = nil,
        lastIngestTimestampOverrideMs: Int64? = nil,
        explicitUserId: String? = nil,
        explicitSourceId: String? = nil,
        explicitSampleType: String? = nil
    ) -> (inserted: Int, skipped: Int, error: NativeErrorCode?) {
        return writeQueue.sync {
            guard let db = db, isOpen else {
                return (0, 0, .notInitialized)
            }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            var insertedCount = 0
            var skippedCount = 0
            if execSQL("BEGIN IMMEDIATE") != SQLITE_OK {
                let errCode = sqlite3_errcode(db)
                if errCode == SQLITE_BUSY {
                    return (0, 0, .sqliteBusy)
                }
                return (0, 0, .sqliteWriteFailed)
            }
            for sample in samples {
                guard let stmt = sampleUpsertStmt else {
                    _ = execSQL("ROLLBACK")
                    return (0, 0, .sqliteWriteFailed)
                }
                sqlite3_reset(stmt)
                sqlite3_clear_bindings(stmt)
                bindText(stmt, 1, sample.id)                    
                bindText(stmt, 2, sample.userId)                
                bindText(stmt, 3, sample.sourceId)              
                bindText(stmt, 4, sample.sourceRecordId)        
                bindText(stmt, 5, sample.sampleType)            
                bindText(stmt, 6, sample.valueKind)             
                sqlite3_bind_int64(stmt, 7, sample.startTimestamp)  
                sqlite3_bind_int64(stmt, 8, sample.endTimestamp)    
                bindOptionalDouble(stmt, 9, sample.value)       
                bindOptionalText(stmt, 10, sample.unit)         
                bindOptionalText(stmt, 11, sample.categoryCode) 
                bindOptionalInt(stmt, 12, sample.durationSeconds) 
                bindOptionalText(stmt, 13, sample.deviceId)     
                bindOptionalText(stmt, 14, sample.externalUuid) 
                bindOptionalText(stmt, 15, sample.metadata)     
                sqlite3_bind_int64(stmt, 16, sample.timestampMs)   
                sqlite3_bind_int64(stmt, 17, sample.timestampMs)   
                let stepResult = sqlite3_step(stmt)
                if stepResult == SQLITE_DONE {
                    let changes = sqlite3_changes(db)
                    if changes > 0 {
                        insertedCount += 1
                    } else {
                        skippedCount += 1 
                    }
                } else {
                    NSLog("[HealthIngestSQLite] Sample upsert failed: %s (code %d)",
                          String(cString: sqlite3_errmsg(db)), stepResult)
                    _ = execSQL("ROLLBACK")
                    return (insertedCount, skippedCount, .sqliteWriteFailed)
                }
            }
            let effectiveLastIngestTs = lastIngestTimestampOverrideMs ?? now
            let cursorError: NativeErrorCode?
            if let existingCursor = cursor, existingCursor.cursorVersion > 0 {
                cursorError = updateCursorCAS(
                    cursor: existingCursor,
                    newAnchorData: newAnchorData,
                    newVersion: newVersion,
                    scope: scope,
                    now: now,
                    lastIngestTimestamp: effectiveLastIngestTs,
                    samplesIngested: Int64(insertedCount),
                    coldBackfillEndTs: coldBackfillEndTs,
                    coldBackfillStartTs: coldBackfillStartTs
                )
            } else {
                let cursorUserId = explicitUserId ?? samples.first?.userId ?? cursor?.userId ?? ""
                let cursorSourceId = explicitSourceId ?? samples.first?.sourceId ?? cursor?.sourceId ?? ""
                let cursorSampleType = explicitSampleType ?? samples.first?.sampleType ?? cursor?.sampleType ?? ""
                guard !cursorUserId.isEmpty, !cursorSourceId.isEmpty, !cursorSampleType.isEmpty else {
                    NSLog("[HealthIngestSQLite] Cannot create cursor with empty identifiers: userId=%@, sourceId=%@, sampleType=%@",
                          cursorUserId, cursorSourceId, cursorSampleType)
                    _ = execSQL("ROLLBACK")
                    return (0, 0, .sqliteWriteFailed)
                }
                cursorError = createCursor(
                    userId: cursorUserId,
                    sourceId: cursorSourceId,
                    sampleType: cursorSampleType,
                    scope: scope,
                    anchorData: newAnchorData,
                    now: now,
                    lastIngestTimestamp: effectiveLastIngestTs,
                    samplesIngested: Int64(insertedCount),
                    coldBackfillEndTs: coldBackfillEndTs,
                    coldBackfillStartTs: coldBackfillStartTs
                )
            }
            if let error = cursorError {
                _ = execSQL("ROLLBACK")
                return (0, 0, error)
            }
            assert(insertedCount + skippedCount == samples.count,
                   "Insert/skip count mismatch: \(insertedCount)+\(skippedCount) != \(samples.count)")
            if execSQL("COMMIT") != SQLITE_OK {
                NSLog("[HealthIngestSQLite] COMMIT failed: %s", String(cString: sqlite3_errmsg(db)))
                _ = execSQL("ROLLBACK")
                return (0, 0, .sqliteWriteFailed)
            }
            return (insertedCount, skippedCount, nil)
        }
    }
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    func insertSamplesOnly(
        samples: [NormalizedHealthSample]
    ) -> (inserted: Int, skipped: Int, error: NativeErrorCode?) {
        return writeQueue.sync {
            guard let db = db, isOpen else {
                return (0, 0, .notInitialized)
            }
            if samples.isEmpty {
                return (0, 0, nil)
            }
            if execSQL("BEGIN IMMEDIATE") != SQLITE_OK {
                let errCode = sqlite3_errcode(db)
                if errCode == SQLITE_BUSY {
                    return (0, 0, .sqliteBusy)
                }
                return (0, 0, .sqliteWriteFailed)
            }
            var insertedCount = 0
            var skippedCount = 0
            for sample in samples {
                guard let stmt = sampleUpsertStmt else {
                    _ = execSQL("ROLLBACK")
                    return (0, 0, .sqliteWriteFailed)
                }
                sqlite3_reset(stmt)
                sqlite3_clear_bindings(stmt)
                bindText(stmt, 1, sample.id)
                bindText(stmt, 2, sample.userId)
                bindText(stmt, 3, sample.sourceId)
                bindText(stmt, 4, sample.sourceRecordId)
                bindText(stmt, 5, sample.sampleType)
                bindText(stmt, 6, sample.valueKind)
                sqlite3_bind_int64(stmt, 7, sample.startTimestamp)
                sqlite3_bind_int64(stmt, 8, sample.endTimestamp)
                bindOptionalDouble(stmt, 9, sample.value)
                bindOptionalText(stmt, 10, sample.unit)
                bindOptionalText(stmt, 11, sample.categoryCode)
                bindOptionalInt(stmt, 12, sample.durationSeconds)
                bindOptionalText(stmt, 13, sample.deviceId)
                bindOptionalText(stmt, 14, sample.externalUuid)
                bindOptionalText(stmt, 15, sample.metadata)
                sqlite3_bind_int64(stmt, 16, sample.timestampMs)
                sqlite3_bind_int64(stmt, 17, sample.timestampMs)
                let stepResult = sqlite3_step(stmt)
                if stepResult == SQLITE_DONE {
                    let changes = sqlite3_changes(db)
                    if changes > 0 {
                        insertedCount += 1
                    } else {
                        skippedCount += 1
                    }
                } else {
                    NSLog("[HealthIngestSQLite] insertSamplesOnly: upsert failed: %s (code %d)",
                          String(cString: sqlite3_errmsg(db)), stepResult)
                    _ = execSQL("ROLLBACK")
                    return (insertedCount, skippedCount, .sqliteWriteFailed)
                }
            }
            if execSQL("COMMIT") != SQLITE_OK {
                NSLog("[HealthIngestSQLite] insertSamplesOnly: COMMIT failed: %s",
                      String(cString: sqlite3_errmsg(db)))
                _ = execSQL("ROLLBACK")
                return (0, 0, .sqliteWriteFailed)
            }
            return (insertedCount, skippedCount, nil)
        }
    }
    /
    /
    /
    func readCursor(
        userId: String,
        sourceId: String,
        sampleType: String,
        scope: CursorScope
    ) -> CursorData? {
        return writeQueue.sync {
            guard let db = db, let stmt = cursorReadStmt, isOpen else { return nil }
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
            bindText(stmt, 1, userId)
            bindText(stmt, 2, sourceId)
            bindText(stmt, 3, sampleType)
            bindText(stmt, 4, scope.rawValue)
            guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
            return CursorData(
                id: sqlite3_column_int64(stmt, 0),
                userId: columnText(stmt, 1) ?? "",
                sourceId: columnText(stmt, 2) ?? "",
                sampleType: columnText(stmt, 3) ?? "",
                scope: CursorScope(rawValue: columnText(stmt, 4) ?? "") ?? .changeAnchor,
                anchorData: columnText(stmt, 5),
                cursorVersion: sqlite3_column_int64(stmt, 6),
                lastIngestTimestamp: columnOptionalInt64(stmt, 7),
                totalSamplesIngested: sqlite3_column_int64(stmt, 8),
                coldBackfillEndTs: columnOptionalInt64(stmt, 9),
                coldBackfillStartTs: columnOptionalInt64(stmt, 10),
                lastSyncAt: columnOptionalInt64(stmt, 11)
            )
        }
    }
    /
    /
    /
    /
    /
    /
    /
    /
    private func updateCursorCAS(
        cursor: CursorData,
        newAnchorData: String?,
        newVersion: Int64,
        scope: CursorScope,
        now: Int64,
        lastIngestTimestamp: Int64,
        samplesIngested: Int64,
        coldBackfillEndTs: Int64?,
        coldBackfillStartTs: Int64?
    ) -> NativeErrorCode? {
        guard let db = db else { return .notInitialized }
        let isColdLane = scope == .coldTime
        let stmt: OpaquePointer?
        if isColdLane {
            stmt = cursorUpdateColdStmt
        } else {
            stmt = cursorUpdateHotStmt
        }
        guard let updateStmt = stmt else { return .sqliteWriteFailed }
        sqlite3_reset(updateStmt)
        sqlite3_clear_bindings(updateStmt)
        if isColdLane {
            bindOptionalInt64(updateStmt, 1, coldBackfillEndTs)
            bindOptionalInt64(updateStmt, 2, coldBackfillStartTs)
            sqlite3_bind_int64(updateStmt, 3, newVersion)
            sqlite3_bind_int64(updateStmt, 4, lastIngestTimestamp)   
            sqlite3_bind_int64(updateStmt, 5, samplesIngested)
            sqlite3_bind_int64(updateStmt, 6, now)                   
            sqlite3_bind_int64(updateStmt, 7, now)                   
            bindText(updateStmt, 8, cursor.userId)
            bindText(updateStmt, 9, cursor.sourceId)
            bindText(updateStmt, 10, cursor.sampleType)
            sqlite3_bind_int64(updateStmt, 11, cursor.cursorVersion)
        } else {
            bindOptionalText(updateStmt, 1, newAnchorData)
            sqlite3_bind_int64(updateStmt, 2, newVersion)
            sqlite3_bind_int64(updateStmt, 3, lastIngestTimestamp)   
            sqlite3_bind_int64(updateStmt, 4, samplesIngested)
            sqlite3_bind_int64(updateStmt, 5, now)                   
            sqlite3_bind_int64(updateStmt, 6, now)                   
            bindText(updateStmt, 7, cursor.userId)
            bindText(updateStmt, 8, cursor.sourceId)
            bindText(updateStmt, 9, cursor.sampleType)
            bindText(updateStmt, 10, scope.rawValue)
            sqlite3_bind_int64(updateStmt, 11, cursor.cursorVersion)
        }
        let stepResult = sqlite3_step(updateStmt)
        guard stepResult == SQLITE_DONE else {
            NSLog("[HealthIngestSQLite] Cursor CAS UPDATE failed: %s", String(cString: sqlite3_errmsg(db)))
            return .sqliteWriteFailed
        }
        let affected = sqlite3_changes(db)
        assert(affected == 0 || affected == 1,
               "CAS update affected \(affected) rows, expected 0 or 1")
        if affected != 1 {
            NSLog("[HealthIngestSQLite] CAS failure: changes() = %d (expected 1). Cursor version conflict.", affected)
            return .sqliteWriteFailed
        }
        return nil
    }
    /
    /
    /
    /
    private func createCursor(
        userId: String,
        sourceId: String,
        sampleType: String,
        scope: CursorScope,
        anchorData: String?,
        now: Int64,
        lastIngestTimestamp: Int64,
        samplesIngested: Int64,
        coldBackfillEndTs: Int64?,
        coldBackfillStartTs: Int64?
    ) -> NativeErrorCode? {
        guard let db = db, let stmt = cursorCreateStmt else { return .notInitialized }
        sqlite3_reset(stmt)
        sqlite3_clear_bindings(stmt)
        bindText(stmt, 1, userId)
        bindText(stmt, 2, sourceId)
        bindText(stmt, 3, sampleType)
        bindText(stmt, 4, scope.rawValue)
        bindOptionalText(stmt, 5, anchorData)
        sqlite3_bind_int64(stmt, 6, lastIngestTimestamp)  
        sqlite3_bind_int64(stmt, 7, samplesIngested)
        sqlite3_bind_int64(stmt, 8, now)                   
        bindOptionalInt64(stmt, 9, coldBackfillEndTs)
        bindOptionalInt64(stmt, 10, coldBackfillStartTs)
        sqlite3_bind_int64(stmt, 11, now)                  
        sqlite3_bind_int64(stmt, 12, now)                  
        let stepResult = sqlite3_step(stmt)
        if stepResult == SQLITE_DONE {
            return nil
        }
        let extErrCode = sqlite3_extended_errcode(db)
        if extErrCode == 2067 { 
            NSLog("[HealthIngestSQLite] Cursor already exists (concurrent creation). CAS failure.")
            return .sqliteWriteFailed
        }
        NSLog("[HealthIngestSQLite] Cursor create failed: %s (code %d, ext %d)",
              String(cString: sqlite3_errmsg(db)), stepResult, extErrCode)
        return .sqliteWriteFailed
    }
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    func lookupStartTimestamps(
        userId: String,
        sourceId: String,
        sourceRecordIds: [String]
    ) -> [String: Int64] {
        return writeQueue.sync {
            guard let db = db, isOpen else { return [:] }
            var result: [String: Int64] = [:]
            let chunks = stride(from: 0, to: sourceRecordIds.count, by: MAX_ROWS_PER_CHUNK)
            for chunkStart in chunks {
                let chunkEnd = min(chunkStart + MAX_ROWS_PER_CHUNK, sourceRecordIds.count)
                let chunkIds = Array(sourceRecordIds[chunkStart..<chunkEnd])
                let placeholders = chunkIds.map { _ in "?" }.joined(separator: ", ")
                let lookupSQL = """
                    SELECT source_record_id, start_timestamp
                    FROM health_samples
                    WHERE user_id = ?1 AND source_id = ?2
                      AND source_record_id IN (\(placeholders))
                    """
                var stmt: OpaquePointer?
                guard sqlite3_prepare_v2(db, lookupSQL, -1, &stmt, nil) == SQLITE_OK else {
                    NSLog("[HealthIngestSQLite] Failed to prepare start timestamp lookup: %s",
                          String(cString: sqlite3_errmsg(db)))
                    continue
                }
                bindText(stmt!, 1, userId)
                bindText(stmt!, 2, sourceId)
                for (i, recordId) in chunkIds.enumerated() {
                    bindText(stmt!, Int32(3 + i), recordId)
                }
                while sqlite3_step(stmt!) == SQLITE_ROW {
                    if let recordIdPtr = sqlite3_column_text(stmt!, 0) {
                        let recordId = String(cString: recordIdPtr)
                        let startTimestamp = sqlite3_column_int64(stmt!, 1)
                        if result[recordId] == nil {
                            result[recordId] = startTimestamp
                        }
                    }
                }
                sqlite3_finalize(stmt)
            }
            return result
        }
    }
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    /
    func softDeleteAndEnqueue(
        userId: String,
        sourceId: String,
        sourceRecordIds: [String],
        startTimestamps: [Int64?]
    ) -> (deletedCount: Int, error: NativeErrorCode?) {
        return writeQueue.sync {
            guard let db = db, isOpen else {
                return (0, .notInitialized)
            }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            var totalDeleted = 0
            if execSQL("BEGIN IMMEDIATE") != SQLITE_OK {
                let errCode = sqlite3_errcode(db)
                if errCode == SQLITE_BUSY { return (0, .sqliteBusy) }
                return (0, .sqliteWriteFailed)
            }
            let chunks = stride(from: 0, to: sourceRecordIds.count, by: MAX_ROWS_PER_CHUNK)
            for chunkStart in chunks {
                let chunkEnd = min(chunkStart + MAX_ROWS_PER_CHUNK, sourceRecordIds.count)
                let chunkIds = Array(sourceRecordIds[chunkStart..<chunkEnd])
                let chunkTimestamps = Array(startTimestamps[chunkStart..<chunkEnd])
                let placeholders = chunkIds.map { _ in "?" }.joined(separator: ", ")
                let softDeleteSQL = """
                    UPDATE health_samples
                    SET is_deleted = 1, deleted_at_ms = ?1, state_updated_at_ms = ?2
                    WHERE user_id = ?3 AND source_id = ?4
                      AND source_record_id IN (\(placeholders))
                      AND is_deleted = 0
                    """
                var deleteStmt: OpaquePointer?
                if sqlite3_prepare_v2(db, softDeleteSQL, -1, &deleteStmt, nil) == SQLITE_OK {
                    sqlite3_bind_int64(deleteStmt!, 1, now)      
                    sqlite3_bind_int64(deleteStmt!, 2, now)      
                    bindText(deleteStmt!, 3, userId)             
                    bindText(deleteStmt!, 4, sourceId)           
                    for (i, recordId) in chunkIds.enumerated() {
                        bindText(deleteStmt!, Int32(5 + i), recordId)
                    }
                    if sqlite3_step(deleteStmt!) == SQLITE_DONE {
                        totalDeleted += Int(sqlite3_changes(db))
                    }
                    sqlite3_finalize(deleteStmt)
                }
                for (i, recordId) in chunkIds.enumerated() {
                    guard let stmt = deletionQueueStmt else {
                        NSLog("[HealthIngestSQLite] Deletion queue stmt is nil. ROLLING BACK to prevent partial delete.")
                        _ = execSQL("ROLLBACK")
                        return (0, .sqliteWriteFailed)
                    }
                    sqlite3_reset(stmt)
                    sqlite3_clear_bindings(stmt)
                    let effectiveTimestamp = chunkTimestamps[i] ?? UNKNOWN_START_TIMESTAMP_SENTINEL
                    bindText(stmt, 1, userId)                    
                    bindText(stmt, 2, sourceId)                  
                    bindText(stmt, 3, recordId)                  
                    sqlite3_bind_int64(stmt, 4, effectiveTimestamp)  
                    sqlite3_bind_int64(stmt, 5, now)             
                    sqlite3_bind_int64(stmt, 6, now)             
                    let stepResult = sqlite3_step(stmt)
                    if stepResult != SQLITE_DONE {
                        NSLog("[HealthIngestSQLite] Deletion queue enqueue FAILED for %@: %s (code %d). " +
                              "ROLLING BACK entire transaction to prevent partial delete (soft-delete without server notification).",
                              recordId, String(cString: sqlite3_errmsg(db)), stepResult)
                        _ = execSQL("ROLLBACK")
                        return (0, .sqliteWriteFailed)
                    }
                }
            }
            if execSQL("COMMIT") != SQLITE_OK {
                _ = execSQL("ROLLBACK")
                return (0, .sqliteWriteFailed)
            }
            return (totalDeleted, nil)
        }
    }
    /
    private func execSQL(_ sql: String) -> Int32 {
        guard let db = db else { return SQLITE_ERROR }
        return sqlite3_exec(db, sql, nil, nil, nil)
    }
    /
    private func bindText(_ stmt: OpaquePointer, _ index: Int32, _ value: String) {
        sqlite3_bind_text(stmt, index, (value as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    }
    /
    private func bindOptionalText(_ stmt: OpaquePointer, _ index: Int32, _ value: String?) {
        if let value = value {
            sqlite3_bind_text(stmt, index, (value as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }
    /
    private func bindOptionalDouble(_ stmt: OpaquePointer, _ index: Int32, _ value: Double?) {
        if let value = value {
            sqlite3_bind_double(stmt, index, value)
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }
    /
    private func bindOptionalInt(_ stmt: OpaquePointer, _ index: Int32, _ value: Int?) {
        if let value = value {
            sqlite3_bind_int(stmt, index, Int32(value))
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }
    /
    private func bindOptionalInt64(_ stmt: OpaquePointer, _ index: Int32, _ value: Int64?) {
        if let value = value {
            sqlite3_bind_int64(stmt, index, value)
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }
    /
    private func columnText(_ stmt: OpaquePointer, _ index: Int32) -> String? {
        guard let cStr = sqlite3_column_text(stmt, index) else { return nil }
        return String(cString: cStr)
    }
    /
    private func columnOptionalInt64(_ stmt: OpaquePointer, _ index: Int32) -> Int64? {
        if sqlite3_column_type(stmt, index) == SQLITE_NULL {
            return nil
        }
        return sqlite3_column_int64(stmt, index)
    }
}
