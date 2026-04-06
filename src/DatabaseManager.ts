import AsyncStorage from '@react-native-async-storage/async-storage';
import { openDatabaseAsync, deleteDatabaseAsync, SQLiteDatabase } from 'expo-sqlite';
import * as FileSystem from 'expo-file-system';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { DEVICE_HITS_DATABASE_NAME } from './constants';
import { drizzleMigrations, CURRENT_DB_VERSION } from './migrations';
import * as schema from './db/schema';
import * as relations from './db/relations';
import {
  SyncStatus,
  SYNC_STATUS,
  generateUUID,
  getCurrentTimestamp,
} from './db/schema-helpers';
const combinedSchema = { ...schema, ...relations };
export type DrizzleDB = ReturnType<typeof drizzle<typeof combinedSchema>>;
export const DB_VERSION_KEY = 'dbVersion';
export const SAFETY_DB_NAME = 'SafetyRecords';
export const ACHIEVEMENTS_DB_NAME = 'achievements.db';
export interface PaginationParams {
  page: number;
  limit: number;
}
export interface StrainSearchFilters {
  geneticType?: string;
  effects?: string[];
  sort?: 'rating' | 'name' | 'compound_a';
}
export interface SyncMetadata {
  id: string;
  table_name: string;
  local_id: string;
  server_id?: string;
  sync_status: 'pending' | 'synced' | 'conflict' | 'error';
  last_modified: number;
  conflict_data?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
}
export class DatabaseManager {
  private databaseConnections: Map<string, SQLiteDatabase> = new Map();
  private drizzleDb: DrizzleDB | null = null;
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private static instance: DatabaseManager;
  private hasAttemptedAutoRecovery: boolean = false;
  private _healthProjectionTablesReady: boolean = false;
  private _healthCursorScopeReady: boolean = false;
  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }
  public constructor() {}
  public async initialize(options: { forceCleanup?: boolean } = {}): Promise<void> {
    if (options.forceCleanup) {
      await this.cleanup();
      this.initialized = false;
    }
    if (this.initialized) {
      return;
    }
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    console.info('[DatabaseManager] Initializing database with Drizzle ORM...');
    this.initializationPromise = this.doInitializeWithAutoRecovery().finally(() => {
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }
  private async doInitializeWithAutoRecovery(): Promise<void> {
    try {
      await this.doInitialize();
    } catch (error) {
      console.error('[DatabaseManager] Initialization failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 500) }
          : { name: 'Error', message: String(error) },
        hasAttemptedAutoRecovery: this.hasAttemptedAutoRecovery,
      });
      if (this.hasAttemptedAutoRecovery) {
        console.error(
          '[DatabaseManager] AUTO-RECOVERY ALREADY ATTEMPTED - not retrying to prevent infinite loop. ' +
          'User will see manual reset UI.'
        );
        throw error;
      }
      this.hasAttemptedAutoRecovery = true;
      console.warn(
        '[DatabaseManager] ATTEMPTING AUTO-RECOVERY: Wiping database and retrying initialization...'
      );
      try {
        await this.resetDatabase();
        this.hasAttemptedAutoRecovery = true;
        console.log('[DatabaseManager] Database wiped successfully for auto-recovery.');
        await this.doInitialize();
        console.log('[DatabaseManager] AUTO-RECOVERY SUCCESSFUL: Database recreated and initialized.');
      } catch (recoveryError) {
        console.error('[DatabaseManager] AUTO-RECOVERY FAILED:', {
          originalError: error instanceof Error ? error.message : String(error),
          recoveryError: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
        });
        throw new Error(
          `Database auto-recovery failed. Original error: ${
            error instanceof Error ? error.message : String(error)
          }. Recovery error: ${
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          }. Please use "Reset Local Data" to recover.`
        );
      }
    }
  }
  private async doInitialize(): Promise<void> {
    try {
      console.log('[DatabaseManager] Starting database initialization...');
      const dbConn = await openDatabaseAsync(DEVICE_HITS_DATABASE_NAME + '.db');
      this.databaseConnections.set(DEVICE_HITS_DATABASE_NAME, dbConn);
      await dbConn.execAsync('PRAGMA foreign_keys = ON;');
      await dbConn.execAsync('PRAGMA journal_mode = WAL;');
      await dbConn.execAsync('PRAGMA busy_timeout = 5000;');
      this.drizzleDb = drizzle(dbConn, { schema: combinedSchema });
      console.log('[DatabaseManager] Running Drizzle migrations...');
      await migrate(this.drizzleDb, drizzleMigrations);
      console.log('[DatabaseManager] Drizzle migrations completed');
      await this.repairMigration0000IfNeeded(dbConn);
      await this.repairMigration0003IfNeeded(dbConn);
      await this.repairMigration0004IfNeeded(dbConn);
      await this.repairMigration0005IfNeeded(dbConn);
      await this.repairMigration0009IfNeeded(dbConn);
      await this.repairMigration0010IfNeeded(dbConn);
      await this.repairMigration0011IfNeeded(dbConn);
      await this.repairHealthCursorScopeIfNeeded(dbConn);
      await this.repairSourceRecordIdCaseIfNeeded(dbConn);
      await this.repairAppMetadataTableIfNeeded(dbConn);
      await this.repairClientProductIdColumnIfNeeded(dbConn);
      await this.repairOutboxUserIdIfNeeded(dbConn);
      await this.repairHealthProjectionTablesIfNeeded(dbConn);
      await this.initializeFTS5(dbConn);
      await AsyncStorage.setItem(DB_VERSION_KEY, CURRENT_DB_VERSION.toString());
      await this.initializeCursorState(dbConn);
      await this.initializeSyncTables(dbConn);
      await this.backfillSyncUserIds(dbConn);
      await this.validateCriticalTables(dbConn);
      this.initialized = true;
      console.log('[DatabaseManager] Database initialization completed successfully.');
    } catch (error) {
      console.error('[DatabaseManager] Failed to initialize database:', error);
      throw error;
    }
  }
  private async repairMigration0000IfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const tableCheck = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='products'`
      );
      if (tableCheck) {
        return; 
      }
      console.error(
        '[DatabaseManager] CRITICAL: products table missing - migration 0000 may have failed. ' +
        'This indicates a migration that was marked as applied without executing SQL statements.'
      );
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY NOT NULL,
          userId TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT DEFAULT 'TYPE_A',
          category TEXT,
          compoundAContent REAL,
          compoundBContent REAL,
          attributes TEXT,
          description TEXT,
          effects TEXT,
          medicalUses TEXT,
          variantGenetics TEXT,
          typeAPercentage REAL,
          typeBPercentage REAL,
          genetics TEXT,
          isPublic INTEGER DEFAULT 0,
          version INTEGER DEFAULT 1,
          createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
          updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
          sync_status TEXT DEFAULT 'synced',
          deleted_at TEXT,
          server_id TEXT,
          last_modified_at TEXT
        )
      `);
      await db.execAsync('CREATE INDEX IF NOT EXISTS idx_products_user_id ON products (userId)');
      await db.execAsync('CREATE INDEX IF NOT EXISTS idx_products_type ON products (type)');
      await db.execAsync('CREATE INDEX IF NOT EXISTS idx_products_is_public ON products (isPublic)');
      await db.execAsync('CREATE INDEX IF NOT EXISTS idx_products_name_search ON products (name)');
      await db.execAsync('CREATE INDEX IF NOT EXISTS idx_products_sync_status ON products (sync_status, last_modified_at)');
      await db.execAsync('CREATE INDEX IF NOT EXISTS idx_products_genetics ON products (variantGenetics)');
      await db.execAsync('CREATE INDEX IF NOT EXISTS idx_products_deleted ON products (deleted_at)');
      console.log('[DatabaseManager] Migration 0000 repair completed - products table created');
    } catch (error) {
      console.error('[DatabaseManager] Migration 0000 repair failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async repairMigration0003IfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const tablesResult = await db.getAllAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('devices', 'devices_new')`
      );
      const tableNames = tablesResult.map((t) => t.name);
      const hasDevices = tableNames.includes('devices');
      const hasDevicesNew = tableNames.includes('devices_new');
      if (hasDevicesNew && !hasDevices) {
        console.warn('[DatabaseManager] Migration 0003 crashed - completing table rename...');
        await db.execAsync('ALTER TABLE devices_new RENAME TO devices');
        await this.recreateDevicesIndexes(db);
        console.log('[DatabaseManager] Migration 0003 repair (rename) completed');
        return;
      }
      if (hasDevicesNew && hasDevices) {
        console.warn('[DatabaseManager] Migration 0003 has orphan devices_new - cleaning up...');
        await db.execAsync('DROP TABLE IF EXISTS devices_new');
        console.log('[DatabaseManager] Removed orphan devices_new table');
      }
      if (!hasDevices) {
        return;
      }
      const columns = await db.getAllAsync<{ name: string; notnull: number }>(
        `PRAGMA table_info(devices)`
      );
      const manufacturerCol = columns.find((c) => c.name === 'manufacturer');
      const modelCol = columns.find((c) => c.name === 'model');
      const connectionTypeCol = columns.find((c) => c.name === 'connection_type');
      const needsRepair =
        (manufacturerCol?.notnull === 1) ||
        (modelCol?.notnull === 1) ||
        (connectionTypeCol?.notnull === 1);
      if (!needsRepair) {
        return; 
      }
      console.warn('[DatabaseManager] Migration 0003 incomplete - repairing devices table...');
      await db.execAsync('PRAGMA foreign_keys=OFF');
      await db.execAsync('BEGIN TRANSACTION');
      try {
        const allColumns = columns.map((c) => c.name).join(', ');
        await db.execAsync(`
          CREATE TABLE devices_new (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            device_name TEXT NOT NULL,
            device_type TEXT DEFAULT 'OTHER',
            manufacturer TEXT,
            model TEXT,
            serial_number TEXT,
            mac_address TEXT,
            connection_type TEXT,
            firmware_version TEXT,
            hardware_version TEXT,
            settings TEXT DEFAULT '{}',
            last_calibrated TEXT,
            calibration_data TEXT,
            requires_calibration INTEGER DEFAULT 0,
            is_paired INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            last_connected TEXT,
            battery_level INTEGER,
            total_sessions INTEGER DEFAULT 0,
            total_duration_ms INTEGER DEFAULT 0,
            last_used TEXT,
            paired_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            server_id TEXT,
            data TEXT,
            sync_status TEXT DEFAULT 'pending',
            last_synced_at TEXT,
            deleted_at TEXT,
            version INTEGER DEFAULT 1,
            sync_error TEXT,
            status TEXT DEFAULT 'ACTIVE',
            type TEXT DEFAULT 'OTHER',
            bluetooth_id TEXT,
            specifications TEXT,
            brand TEXT,
            last_seen TEXT
          )
        `);
        await db.execAsync(`INSERT INTO devices_new SELECT ${allColumns} FROM devices`);
        await db.execAsync('DROP TABLE devices');
        await db.execAsync('ALTER TABLE devices_new RENAME TO devices');
        await this.recreateDevicesIndexes(db);
        await db.execAsync('COMMIT');
        console.log('[DatabaseManager] Migration 0003 repair (rebuild) completed');
      } catch (rebuildError) {
        await db.execAsync('ROLLBACK');
        throw rebuildError;
      } finally {
        await db.execAsync('PRAGMA foreign_keys=ON');
      }
    } catch (error) {
      console.error('[DatabaseManager] Migration 0003 repair failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async recreateDevicesIndexes(db: SQLiteDatabase): Promise<void> {
    await db.execAsync('CREATE UNIQUE INDEX IF NOT EXISTS devices_mac_address_unique ON devices (mac_address)');
    await db.execAsync('CREATE UNIQUE INDEX IF NOT EXISTS devices_bluetooth_id_unique ON devices (bluetooth_id)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices (user_id)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_mac_address ON devices (mac_address)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_type ON devices (type)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_server_id ON devices (server_id)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_sync_status ON devices (sync_status)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_deleted_at ON devices (deleted_at)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_serial_number ON devices (serial_number)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_bluetooth_id ON devices (bluetooth_id)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_status ON devices (status)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_is_active ON devices (is_active)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen)');
  }
  private async repairMigration0004IfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const outboxColumns = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(outbox_events)`
      );
      const hasOutboxUserId = outboxColumns.some((col) => col.name === 'user_id');
      const tombstoneColumns = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(tombstones)`
      );
      const hasTombstoneUserId = tombstoneColumns.some((col) => col.name === 'user_id');
      if (!hasOutboxUserId || !hasTombstoneUserId) {
        console.warn('[DatabaseManager] Migration 0004 incomplete - repairing...');
        if (!hasOutboxUserId) {
          console.log('[DatabaseManager] Adding user_id column to outbox_events...');
          await db.execAsync('ALTER TABLE outbox_events ADD COLUMN user_id TEXT');
          await db.execAsync(
            'CREATE INDEX IF NOT EXISTS idx_outbox_events_user_status ON outbox_events (user_id, status)'
          );
          console.log('[DatabaseManager] outbox_events.user_id column added successfully');
        }
        if (!hasTombstoneUserId) {
          console.log('[DatabaseManager] Adding user_id column to tombstones...');
          await db.execAsync('ALTER TABLE tombstones ADD COLUMN user_id TEXT');
          await db.execAsync(
            'CREATE INDEX IF NOT EXISTS idx_tombstones_user_status ON tombstones (user_id, sync_status)'
          );
          console.log('[DatabaseManager] tombstones.user_id column added successfully');
        }
        console.log('[DatabaseManager] Migration 0004 repair completed');
      }
    } catch (error) {
      console.error('[DatabaseManager] Migration 0004 repair failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async repairMigration0005IfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const tablesResult = await db.getAllAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('journal_entries', 'journal_entries_new')`
      );
      const tableNames = tablesResult.map((t) => t.name);
      const hasJournalEntries = tableNames.includes('journal_entries');
      const hasJournalEntriesNew = tableNames.includes('journal_entries_new');
      if (hasJournalEntriesNew && !hasJournalEntries) {
        console.warn('[DatabaseManager] Migration 0005 crashed - completing table rename...');
        await db.execAsync('ALTER TABLE journal_entries_new RENAME TO journal_entries');
        await this.recreateJournalIndexes(db);
        console.log('[DatabaseManager] Migration 0005 repair (rename) completed');
        return;
      }
      if (hasJournalEntriesNew && hasJournalEntries) {
        console.warn('[DatabaseManager] Migration 0005 has orphan journal_entries_new - cleaning up...');
        await db.execAsync('DROP TABLE IF EXISTS journal_entries_new');
        console.log('[DatabaseManager] Removed orphan journal_entries_new table');
      }
      if (!hasJournalEntries) {
        return;
      }
      const columns = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(journal_entries)`
      );
      const columnNames = columns.map((c) => c.name);
      const hasSyncError = columnNames.includes('sync_error');
      const hasLastSyncAttempt = columnNames.includes('last_sync_attempt');
      const hasClientEntryId = columnNames.includes('client_entry_id');
      let repaired = false;
      if (!hasSyncError) {
        console.log('[DatabaseManager] Adding sync_error column to journal_entries...');
        await db.execAsync('ALTER TABLE journal_entries ADD COLUMN sync_error TEXT');
        repaired = true;
      }
      if (!hasLastSyncAttempt) {
        console.log('[DatabaseManager] Adding last_sync_attempt column to journal_entries...');
        await db.execAsync('ALTER TABLE journal_entries ADD COLUMN last_sync_attempt TEXT');
        repaired = true;
      }
      if (!hasClientEntryId) {
        console.log('[DatabaseManager] Adding client_entry_id column to journal_entries...');
        await db.execAsync('ALTER TABLE journal_entries ADD COLUMN client_entry_id TEXT');
        repaired = true;
      }
      await this.recreateJournalIndexes(db);
      if (repaired) {
        console.log('[DatabaseManager] Migration 0005 repair (add columns) completed');
      }
    } catch (error) {
      console.error('[DatabaseManager] Migration 0005 repair failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async recreateJournalIndexes(db: SQLiteDatabase): Promise<void> {
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_journal_user_id ON journal_entries (user_id)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_journal_entry_date ON journal_entries (entry_date)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_journal_consumption_id ON journal_entries (consumption_id)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_journal_session_id ON journal_entries (session_id)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_journal_sync_status ON journal_entries (sync_status)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_journal_product_id ON journal_entries (product_id)');
  }
  private async repairMigration0009IfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const tableCheck = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='health_samples'`
      );
      if (!tableCheck) {
        console.warn('[DatabaseManager] health_samples table missing - creating from schema...');
        await db.execAsync(`
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
        `);
        await this.recreateHealthSamplesIndexes(db);
        console.log('[DatabaseManager] Migration 0009 repair (create table) completed');
        return;
      }
      const columns = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(health_samples)`
      );
      const columnNames = columns.map((c) => c.name);
      let repaired = false;
      if (!columnNames.includes('value_kind')) {
        console.log('[DatabaseManager] Adding value_kind column to health_samples...');
        await db.execAsync("ALTER TABLE health_samples ADD COLUMN value_kind TEXT NOT NULL DEFAULT 'SCALAR_NUM'");
        repaired = true;
      }
      if (!columnNames.includes('upload_request_id')) {
        console.log('[DatabaseManager] Adding upload_request_id column to health_samples...');
        await db.execAsync('ALTER TABLE health_samples ADD COLUMN upload_request_id TEXT');
        repaired = true;
      }
      if (!columnNames.includes('is_deleted')) {
        console.log('[DatabaseManager] Adding is_deleted column to health_samples...');
        await db.execAsync('ALTER TABLE health_samples ADD COLUMN is_deleted INTEGER DEFAULT 0 NOT NULL');
        repaired = true;
      }
      if (!columnNames.includes('deleted_at_ms')) {
        console.log('[DatabaseManager] Adding deleted_at_ms column to health_samples...');
        await db.execAsync('ALTER TABLE health_samples ADD COLUMN deleted_at_ms INTEGER');
        repaired = true;
      }
      if (!columnNames.includes('duration_seconds')) {
        console.log('[DatabaseManager] Adding duration_seconds column to health_samples...');
        await db.execAsync('ALTER TABLE health_samples ADD COLUMN duration_seconds INTEGER');
        repaired = true;
      }
      if (!columnNames.includes('device_id')) {
        console.log('[DatabaseManager] Adding device_id column to health_samples...');
        await db.execAsync('ALTER TABLE health_samples ADD COLUMN device_id TEXT');
        repaired = true;
      }
      if (!columnNames.includes('external_uuid')) {
        console.log('[DatabaseManager] Adding external_uuid column to health_samples...');
        await db.execAsync('ALTER TABLE health_samples ADD COLUMN external_uuid TEXT');
        repaired = true;
      }
      await this.recreateHealthSamplesIndexes(db);
      if (repaired) {
        console.log('[DatabaseManager] Migration 0009/0011 repair (add columns) completed');
      }
    } catch (error) {
      console.error('[DatabaseManager] Migration 0009 repair failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async repairMigration0010IfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const sourcesCheck = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='health_sources'`
      );
      if (!sourcesCheck) {
        console.warn('[DatabaseManager] health_sources table missing - creating from schema...');
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS health_sources (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            source_app_id TEXT NOT NULL,
            device_id TEXT NOT NULL DEFAULT '__NO_DEVICE__',
            source_name TEXT,
            hardware_id TEXT,
            is_active INTEGER DEFAULT 1,
            last_sync_at INTEGER,
            server_id TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now')*1000),
            updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
          )
        `);
        await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_sources_user_id ON health_sources (user_id)');
        await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_sources_user_platform ON health_sources (user_id, platform)');
        await db.execAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_health_sources_key ON health_sources (user_id, platform, source_app_id, device_id)');
        console.log('[DatabaseManager] health_sources table created');
      }
      const cursorsCheck = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='health_ingest_cursors'`
      );
      if (!cursorsCheck) {
        console.warn('[DatabaseManager] health_ingest_cursors table missing - creating from schema...');
        await db.execAsync(`
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
        `);
        await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_ingest_cursors_lookup ON health_ingest_cursors (user_id, source_id, sample_type, scope)');
        await db.execAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_health_ingest_cursor ON health_ingest_cursors (user_id, source_id, sample_type, scope)');
        console.log('[DatabaseManager] health_ingest_cursors table created');
      }
    } catch (error) {
      console.error('[DatabaseManager] Migration 0010 repair failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async repairMigration0011IfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const tableCheck = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='health_sample_deletion_queue'`
      );
      if (!tableCheck) {
        console.warn('[DatabaseManager] health_sample_deletion_queue table missing - creating from schema...');
        await db.execAsync(`
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
        `);
        await this.recreateDeletionQueueIndexes(db);
        console.log('[DatabaseManager] Migration 0011 repair (create table) completed');
        return;
      }
      await this.repairDeletionQueueColumns(db);
      await this.recreateDeletionQueueIndexes(db);
    } catch (error) {
      console.error('[DatabaseManager] Migration 0011 repair failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async repairDeletionQueueColumns(db: SQLiteDatabase): Promise<void> {
    const columns = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info(health_sample_deletion_queue)`
    );
    const columnNames = columns.map((c) => c.name);
    let repaired = false;
    if (!columnNames.includes('upload_request_id')) {
      console.log('[DatabaseManager] Adding upload_request_id column to health_sample_deletion_queue...');
      await db.execAsync('ALTER TABLE health_sample_deletion_queue ADD COLUMN upload_request_id TEXT');
      repaired = true;
    }
    if (!columnNames.includes('deleted_at_ms')) {
      console.log('[DatabaseManager] Adding deleted_at_ms column to health_sample_deletion_queue...');
      await db.execAsync(`
        ALTER TABLE health_sample_deletion_queue 
        ADD COLUMN deleted_at_ms INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
      `);
      repaired = true;
    }
    if (!columnNames.includes('staged_batch_id')) {
      console.log('[DatabaseManager] Adding staged_batch_id column to health_sample_deletion_queue...');
      await db.execAsync('ALTER TABLE health_sample_deletion_queue ADD COLUMN staged_batch_id TEXT');
      repaired = true;
    }
    if (!columnNames.includes('start_timestamp_ms')) {
      console.log('[DatabaseManager] Adding start_timestamp_ms column to health_sample_deletion_queue...');
      await db.execAsync('ALTER TABLE health_sample_deletion_queue ADD COLUMN start_timestamp_ms INTEGER');
      repaired = true;
    }
    if (!columnNames.includes('created_at')) {
      console.log('[DatabaseManager] Adding created_at column to health_sample_deletion_queue...');
      await db.execAsync(`
        ALTER TABLE health_sample_deletion_queue 
        ADD COLUMN created_at INTEGER DEFAULT (strftime('%s','now')*1000)
      `);
      repaired = true;
    }
    if (repaired) {
      console.log('[DatabaseManager] health_sample_deletion_queue columns repaired successfully');
    }
  }
  private async recreateDeletionQueueIndexes(db: SQLiteDatabase): Promise<void> {
    await db.execAsync(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_deletion_queue_sample
      ON health_sample_deletion_queue (user_id, source_id, source_record_id, start_timestamp_ms)
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_deletion_queue_pending
      ON health_sample_deletion_queue (user_id, upload_status)
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_deletion_queue_retry
      ON health_sample_deletion_queue (upload_status, next_upload_attempt_at)
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_deletion_queue_state_recovery
      ON health_sample_deletion_queue (upload_status, state_updated_at_ms)
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_deletion_queue_batch
      ON health_sample_deletion_queue (staged_batch_id)
    `);
  }
  private async repairHealthCursorScopeIfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const tableCheck = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='health_ingest_cursors'`
      );
      if (!tableCheck) {
        console.error('[DatabaseManager] health_ingest_cursors table does not exist - cannot repair cursor scope');
        this._healthCursorScopeReady = false;
        return;
      }
      const tableInfo = await db.getAllAsync<{ name: string }>(
        `PRAGMA table_info(health_ingest_cursors)`
      );
      const columnNames = new Set(tableInfo.map(col => col.name));
      if (columnNames.has('last_ingest_at') && !columnNames.has('last_ingest_timestamp')) {
        console.log('[DatabaseManager] Renaming last_ingest_at → last_ingest_timestamp');
        await db.execAsync(
          `ALTER TABLE health_ingest_cursors RENAME COLUMN last_ingest_at TO last_ingest_timestamp`
        );
      }
      if (columnNames.has('samples_fetched') && !columnNames.has('total_samples_ingested')) {
        console.log('[DatabaseManager] Renaming samples_fetched → total_samples_ingested');
        await db.execAsync(
          `ALTER TABLE health_ingest_cursors RENAME COLUMN samples_fetched TO total_samples_ingested`
        );
      }
      if (!columnNames.has('scope')) {
        console.log('[DatabaseManager] Adding scope column to health_ingest_cursors...');
        await db.execAsync(
          `ALTER TABLE health_ingest_cursors ADD COLUMN scope TEXT NOT NULL DEFAULT 'change_anchor'`
        );
      }
      if (!columnNames.has('cold_backfill_end_ts')) {
        await db.execAsync(
          `ALTER TABLE health_ingest_cursors ADD COLUMN cold_backfill_end_ts INTEGER`
        );
      }
      if (!columnNames.has('cold_backfill_start_ts')) {
        await db.execAsync(
          `ALTER TABLE health_ingest_cursors ADD COLUMN cold_backfill_start_ts INTEGER`
        );
      }
      if (!columnNames.has('cold_page_from_ts')) {
        await db.execAsync(
          `ALTER TABLE health_ingest_cursors ADD COLUMN cold_page_from_ts INTEGER`
        );
      }
      if (!columnNames.has('last_sync_at')) {
        await db.execAsync(
          `ALTER TABLE health_ingest_cursors ADD COLUMN last_sync_at INTEGER`
        );
      }
      await db.execAsync(`
        BEGIN TRANSACTION;
        DROP INDEX IF EXISTS uq_health_cursors_user_source_type;
        DROP INDEX IF EXISTS idx_health_cursors_user;
        DROP INDEX IF EXISTS uq_health_ingest_cursor;
        DROP INDEX IF EXISTS idx_health_ingest_cursors_lookup;
        CREATE UNIQUE INDEX uq_health_ingest_cursor
          ON health_ingest_cursors (user_id, source_id, sample_type, scope);
        CREATE INDEX idx_health_ingest_cursors_lookup
          ON health_ingest_cursors (user_id, source_id, sample_type, scope);
        COMMIT;
      `);
      const ready = await this.verifyHealthCursorSchemaComplete(db);
      this._healthCursorScopeReady = ready;
      if (ready) {
        console.log('[DatabaseManager] Health cursor scope migration completed successfully');
      } else {
        console.error(
          '[DatabaseManager] Health cursor scope repair executed but verification FAILED. ' +
          'Native health ingestion will be disabled (healthCursorScopeReady=false).'
        );
      }
    } catch (error) {
      this._healthCursorScopeReady = false;
      console.error('[DatabaseManager] Health cursor scope migration failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async verifyHealthCursorSchemaComplete(db: SQLiteDatabase): Promise<boolean> {
    const tableInfo = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info(health_ingest_cursors)`
    );
    const columnNames = new Set(tableInfo.map(col => col.name));
    const requiredColumns = [
      'scope',                    
      'cold_backfill_end_ts',     
      'cold_backfill_start_ts',   
      'last_sync_at',             
      'last_ingest_timestamp',    
      'total_samples_ingested',   
      'anchor_data',              
      'cursor_version',           
    ];
    for (const col of requiredColumns) {
      if (!columnNames.has(col)) {
        console.error(
          `[DatabaseManager] Health cursor schema verification FAILED: missing column '${col}'. ` +
          `Found columns: [${[...columnNames].join(', ')}]`
        );
        return false;
      }
    }
    const staleColumns = ['last_ingest_at', 'samples_fetched'];
    for (const col of staleColumns) {
      if (columnNames.has(col)) {
        console.error(
          `[DatabaseManager] Health cursor schema verification FAILED: stale column '${col}' ` +
          `still exists (should have been renamed). Column rename may have failed.`
        );
        return false;
      }
    }
    const oldIndex = await db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='uq_health_cursors_user_source_type'`
    );
    if (oldIndex) {
      console.error(
        '[DatabaseManager] Health cursor schema verification FAILED: old 3-col unique index ' +
        "'uq_health_cursors_user_source_type' still exists. Lane isolation is broken — " +
        'cannot create separate HOT/COLD/CHANGE cursors for the same (user, source, type).'
      );
      return false;
    }
    const newIndex = await db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='uq_health_ingest_cursor'`
    );
    if (!newIndex) {
      console.error(
        '[DatabaseManager] Health cursor schema verification FAILED: 4-col unique index ' +
        "'uq_health_ingest_cursor' is missing. Cursor uniqueness is not enforced."
      );
      return false;
    }
    return true;
  }
  private async repairSourceRecordIdCaseIfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const samplesNeedRepair = await db.getFirstAsync<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM health_samples WHERE source_record_id != lower(source_record_id) LIMIT 1`
      );
      let dqNeedsRepair = false;
      try {
        const dqCheck = await db.getFirstAsync<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM health_sample_deletion_queue WHERE source_record_id != lower(source_record_id) LIMIT 1`
        );
        dqNeedsRepair = !!(dqCheck && dqCheck.cnt > 0);
      } catch {
      }
      if ((!samplesNeedRepair || samplesNeedRepair.cnt === 0) && !dqNeedsRepair) {
        return; 
      }
      const samplesCount = samplesNeedRepair?.cnt ?? 0;
      console.log(`[DatabaseManager] Repairing source_record_id case normalization (${samplesCount} samples, dq=${dqNeedsRepair})...`);
      await db.execAsync('BEGIN TRANSACTION');
      try {
        await db.execAsync(`
          DELETE FROM health_samples
          WHERE id IN (
            SELECT hs.id FROM health_samples hs
            WHERE hs.source_record_id != lower(hs.source_record_id)
            AND EXISTS (
              SELECT 1 FROM health_samples dup
              WHERE dup.user_id = hs.user_id
              AND dup.source_id = hs.source_id
              AND dup.source_record_id = lower(hs.source_record_id)
              AND dup.start_timestamp = hs.start_timestamp
              AND dup.id != hs.id
            )
          )
        `);
        await db.execAsync(`
          UPDATE health_samples
          SET source_record_id = lower(source_record_id)
          WHERE source_record_id != lower(source_record_id)
        `);
        if (dqNeedsRepair) {
          await db.execAsync(`
            DELETE FROM health_sample_deletion_queue
            WHERE id IN (
              SELECT dq.id FROM health_sample_deletion_queue dq
              WHERE dq.source_record_id != lower(dq.source_record_id)
              AND EXISTS (
                SELECT 1 FROM health_sample_deletion_queue dup
                WHERE dup.user_id = dq.user_id
                AND dup.source_id = dq.source_id
                AND dup.source_record_id = lower(dq.source_record_id)
                AND dup.start_timestamp_ms IS dq.start_timestamp_ms
                AND dup.id != dq.id
              )
            )
          `);
          await db.execAsync(`
            UPDATE health_sample_deletion_queue
            SET source_record_id = lower(source_record_id)
            WHERE source_record_id != lower(source_record_id)
          `);
        }
        await db.execAsync('COMMIT');
        console.log('[DatabaseManager] source_record_id case normalization repair completed');
      } catch (txError) {
        await db.execAsync('ROLLBACK');
        throw txError;
      }
    } catch (error) {
      console.error('[DatabaseManager] source_record_id case normalization repair failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private async repairAppMetadataTableIfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS app_metadata (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (error) {
      console.error('[DatabaseManager] Failed to create app_metadata table:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  private async repairClientProductIdColumnIfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      await db.execAsync(`ALTER TABLE products ADD COLUMN clientProductId TEXT`);
      console.log('[DatabaseManager] Added clientProductId column to products table.');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('duplicate column name')) {
        return;
      }
      console.error('[DatabaseManager] Failed to add clientProductId column:', { error: msg });
      throw error;
    }
  }
  private async repairOutboxUserIdIfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      const result = await db.runAsync(
        `UPDATE outbox_events
         SET status = 'DEAD_LETTER',
             error = 'Legacy: missing user_id — orphaned by v16 migration',
             updated_at = datetime('now')
         WHERE user_id IS NULL AND status != 'DEAD_LETTER'`
      );
      if (result.changes > 0) {
        console.log(`[DatabaseManager] Dead-lettered ${result.changes} orphaned outbox rows with NULL user_id.`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[DatabaseManager] Failed to dead-letter orphaned outbox rows:', { error: msg });
    }
  }
  private async repairHealthProjectionTablesIfNeeded(db: SQLiteDatabase): Promise<void> {
    try {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS local_health_rollup_day (
          id TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL,
          metric_code TEXT NOT NULL,
          day_utc TEXT NOT NULL,
          value_kind TEXT NOT NULL,
          sum_val REAL,
          count_val INTEGER NOT NULL DEFAULT 0,
          min_val REAL,
          max_val REAL,
          avg_val REAL,
          timezone_offset_min INTEGER,
          freshness_status TEXT NOT NULL DEFAULT 'NO_DATA',
          computed_at_iso TEXT,
          source_watermark TEXT NOT NULL DEFAULT '0',
          compute_version INTEGER NOT NULL DEFAULT 1,
          data_quality TEXT NOT NULL DEFAULT 'FULL',
          fetched_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now')*1000),
          updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
        )
      `);
      await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS uq_local_rollup_natural_key ON local_health_rollup_day (user_id, metric_code, day_utc)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_rollup_lookup ON local_health_rollup_day (user_id, metric_code, day_utc)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_rollup_status ON local_health_rollup_day (user_id, freshness_status)`);
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS local_sleep_night_summary (
          id TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL,
          night_local_date TEXT NOT NULL,
          timezone_offset_min INTEGER NOT NULL,
          sleep_start_ts TEXT,
          sleep_end_ts TEXT,
          in_bed_start_ts TEXT,
          in_bed_end_ts TEXT,
          total_sleep_min INTEGER,
          in_bed_min INTEGER,
          awake_min INTEGER,
          rem_min INTEGER,
          deep_min INTEGER,
          light_min INTEGER,
          sleep_efficiency REAL,
          wake_events INTEGER,
          sleep_latency_min INTEGER,
          had_session_before INTEGER NOT NULL DEFAULT 0,
          session_id_before TEXT,
          hours_before_bed REAL,
          has_rem_data INTEGER NOT NULL DEFAULT 0,
          has_deep_data INTEGER NOT NULL DEFAULT 0,
          has_light_data INTEGER NOT NULL DEFAULT 0,
          has_awake_data INTEGER NOT NULL DEFAULT 0,
          canonical_source_id TEXT,
          source_count INTEGER NOT NULL DEFAULT 1,
          source_coverage REAL,
          data_quality_score REAL,
          freshness_status TEXT NOT NULL DEFAULT 'NO_DATA',
          computed_at_iso TEXT,
          source_watermark TEXT NOT NULL DEFAULT '0',
          compute_version INTEGER NOT NULL DEFAULT 1,
          data_quality TEXT NOT NULL DEFAULT 'FULL',
          fetched_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now')*1000),
          updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
        )
      `);
      await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS uq_local_sleep_natural_key ON local_sleep_night_summary (user_id, night_local_date)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_sleep_lookup ON local_sleep_night_summary (user_id, night_local_date)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_sleep_status ON local_sleep_night_summary (user_id, freshness_status)`);
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS local_session_impact_summary (
          id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          metric_code TEXT NOT NULL,
          window_minutes INTEGER NOT NULL DEFAULT 60,
          resolution TEXT NOT NULL DEFAULT '1min',
          avg_before REAL,
          min_before REAL,
          max_before REAL,
          count_before INTEGER NOT NULL DEFAULT 0,
          avg_during REAL,
          min_during REAL,
          max_during REAL,
          count_during INTEGER NOT NULL DEFAULT 0,
          avg_after REAL,
          min_after REAL,
          max_after REAL,
          count_after INTEGER NOT NULL DEFAULT 0,
          delta_during_abs REAL,
          delta_during_pct REAL,
          delta_after_abs REAL,
          delta_after_pct REAL,
          before_coverage REAL,
          during_coverage REAL,
          after_coverage REAL,
          has_significant_gaps INTEGER NOT NULL DEFAULT 0,
          is_reliable INTEGER NOT NULL DEFAULT 1,
          freshness_status TEXT NOT NULL DEFAULT 'NO_DATA',
          computed_at_iso TEXT,
          source_watermark TEXT NOT NULL DEFAULT '0',
          compute_version INTEGER NOT NULL DEFAULT 1,
          data_quality TEXT NOT NULL DEFAULT 'FULL',
          fetched_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now')*1000),
          updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
        )
      `);
      await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS uq_local_impact_natural_key ON local_session_impact_summary (session_id, metric_code, window_minutes, resolution)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_impact_session ON local_session_impact_summary (user_id, session_id)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_impact_status ON local_session_impact_summary (user_id, freshness_status)`);
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS local_product_impact_rollup (
          id TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          product_name TEXT NOT NULL,
          product_type TEXT NOT NULL,
          variant_genetics TEXT,
          metric_code TEXT NOT NULL,
          window_minutes INTEGER NOT NULL DEFAULT 60,
          resolution TEXT NOT NULL DEFAULT '1min',
          period_days INTEGER NOT NULL DEFAULT 90,
          session_count INTEGER NOT NULL DEFAULT 0,
          min_sessions_required INTEGER NOT NULL DEFAULT 3,
          avg_delta_during_abs REAL,
          avg_delta_during_pct REAL,
          avg_delta_after_abs REAL,
          avg_delta_after_pct REAL,
          median_delta_after_pct REAL,
          period_start TEXT,
          period_end TEXT,
          baseline_value REAL,
          baseline_method TEXT,
          baseline_n INTEGER,
          baseline_window TEXT,
          coverage_score REAL,
          is_reliable INTEGER NOT NULL DEFAULT 0,
          quality_flags TEXT,
          exactness TEXT NOT NULL DEFAULT 'ESTIMATED',
          confidence_tier TEXT NOT NULL DEFAULT 'INSUFFICIENT',
          confidence_score REAL,
          ci_low REAL,
          ci_high REAL,
          freshness_status TEXT NOT NULL DEFAULT 'NO_DATA',
          computed_at_iso TEXT,
          source_watermark TEXT NOT NULL DEFAULT '0',
          compute_version INTEGER NOT NULL DEFAULT 1,
          data_quality TEXT NOT NULL DEFAULT 'FULL',
          evidence_session_count INTEGER NOT NULL DEFAULT 0,
          evidence_session_ids TEXT,
          fetched_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now')*1000),
          updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
        )
      `);
      await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS uq_local_product_impact_natural_key ON local_product_impact_rollup (user_id, product_id, metric_code, window_minutes, resolution, period_days)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_product_impact_metric ON local_product_impact_rollup (user_id, metric_code, period_days)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_product_impact_product ON local_product_impact_rollup (user_id, product_id)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_product_impact_status ON local_product_impact_rollup (user_id, freshness_status)`);
      try {
        await db.execAsync(`ALTER TABLE local_product_impact_rollup ADD COLUMN period_start TEXT`);
      } catch {
      }
      try {
        await db.execAsync(`ALTER TABLE local_product_impact_rollup ADD COLUMN period_end TEXT`);
      } catch {
      }
      try {
        await db.execAsync(`ALTER TABLE local_product_impact_rollup ADD COLUMN baseline_window TEXT`);
      } catch {
      }
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS local_rollup_dirty_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          metric_code TEXT NOT NULL,
          day_utc TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT 'new_samples',
          enqueued_at INTEGER NOT NULL
        )
      `);
      await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rollup_dirty_key ON local_rollup_dirty_keys (user_id, metric_code, day_utc)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_rollup_dirty_dequeue ON local_rollup_dirty_keys (user_id, enqueued_at)`);
      try {
        await db.execAsync(`ALTER TABLE local_rollup_dirty_keys ADD COLUMN reason TEXT NOT NULL DEFAULT 'new_samples'`);
      } catch {
      }
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS local_sleep_dirty_nights (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          night_local_date TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT 'new_samples',
          enqueued_at INTEGER NOT NULL
        )
      `);
      await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sleep_dirty_night ON local_sleep_dirty_nights (user_id, night_local_date)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_sleep_dirty_dequeue ON local_sleep_dirty_nights (user_id, enqueued_at)`);
      try {
        await db.execAsync(`ALTER TABLE local_sleep_dirty_nights ADD COLUMN reason TEXT NOT NULL DEFAULT 'new_samples'`);
      } catch {
      }
      await db.execAsync(`DROP TABLE IF EXISTS local_health_insights`);
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS local_health_insights (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          insight_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          domain TEXT NOT NULL,
          insight_type TEXT NOT NULL,
          icon TEXT NOT NULL,
          metric TEXT NOT NULL,
          description TEXT NOT NULL,
          display_type TEXT NOT NULL DEFAULT 'secondary',
          confidence_tier TEXT NOT NULL DEFAULT 'low',
          evidence TEXT NOT NULL DEFAULT '{}',
          freshness_status TEXT NOT NULL DEFAULT 'NO_DATA',
          computed_at_iso TEXT,
          source_watermark TEXT NOT NULL DEFAULT '0',
          compute_version INTEGER NOT NULL DEFAULT 1,
          data_quality TEXT NOT NULL DEFAULT 'FULL',
          start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          fetched_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now')*1000),
          updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
        )
      `);
      await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS uq_local_insights_user_insight ON local_health_insights (user_id, insight_id)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_insights_domain ON local_health_insights (user_id, domain, start_date, end_date)`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_local_insights_fetched ON local_health_insights (user_id, fetched_at)`);
      this._healthProjectionTablesReady = true;
      console.log('[DatabaseManager] Health projection tables repair completed');
    } catch (error) {
      this._healthProjectionTablesReady = false;
      console.error('[DatabaseManager] Health projection tables repair failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async recreateHealthSamplesIndexes(db: SQLiteDatabase): Promise<void> {
    try {
      await db.execAsync('DROP INDEX IF EXISTS idx_health_samples_unique');
    } catch (error) {
      console.debug('[DatabaseManager] idx_health_samples_unique did not exist (OK)');
    }
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_user_type_time ON health_samples (user_id, sample_type, start_timestamp)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_upload_status ON health_samples (upload_status)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_staged_batch ON health_samples (staged_batch_id)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_source_record ON health_samples (user_id, source_id, source_record_id, start_timestamp)');
    await db.execAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_health_samples_source_record ON health_samples (user_id, source_id, source_record_id, start_timestamp)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_retry ON health_samples (user_id, upload_status, next_upload_attempt_at)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_state_recovery ON health_samples (user_id, upload_status, state_updated_at_ms)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_user_deleted ON health_samples (user_id, is_deleted)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_deleted_at ON health_samples (deleted_at_ms)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_retention_purge ON health_samples (user_id, upload_status, uploaded_at)');
    await db.execAsync('CREATE INDEX IF NOT EXISTS idx_health_samples_deleted_purge ON health_samples (user_id, is_deleted, deleted_at_ms)');
  }
  private async initializeFTS5(db: SQLiteDatabase): Promise<void> {
    try {
      const ftsExists = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='products_fts'`
      );
      if (ftsExists) {
        console.log('[DatabaseManager] FTS5 products_fts already exists, skipping initialization');
        return;
      }
      console.log('[DatabaseManager] Initializing FTS5 full-text search...');
      await db.execAsync(`
        CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
          name,
          description,
          content='products',
          content_rowid='rowid'
        )
      `);
      await db.execAsync(`
        INSERT INTO products_fts(rowid, name, description)
        SELECT rowid, COALESCE(name, ''), COALESCE(description, '')
        FROM products
        WHERE deleted_at IS NULL
      `);
      await db.execAsync(`
        CREATE TRIGGER IF NOT EXISTS products_fts_ai
        AFTER INSERT ON products
        WHEN NEW.deleted_at IS NULL
        BEGIN
          INSERT INTO products_fts(rowid, name, description)
          VALUES (NEW.rowid, COALESCE(NEW.name, ''), COALESCE(NEW.description, ''));
        END
      `);
      await db.execAsync(`
        CREATE TRIGGER IF NOT EXISTS products_fts_au_delete
        AFTER UPDATE ON products
        BEGIN
          INSERT INTO products_fts(products_fts, rowid, name, description)
          VALUES ('delete', OLD.rowid, COALESCE(OLD.name, ''), COALESCE(OLD.description, ''));
        END
      `);
      await db.execAsync(`
        CREATE TRIGGER IF NOT EXISTS products_fts_au_insert
        AFTER UPDATE ON products
        WHEN NEW.deleted_at IS NULL
        BEGIN
          INSERT INTO products_fts(rowid, name, description)
          VALUES (NEW.rowid, COALESCE(NEW.name, ''), COALESCE(NEW.description, ''));
        END
      `);
      await db.execAsync(`
        CREATE TRIGGER IF NOT EXISTS products_fts_ad
        AFTER DELETE ON products
        BEGIN
          INSERT INTO products_fts(products_fts, rowid, name, description)
          VALUES ('delete', OLD.rowid, COALESCE(OLD.name, ''), COALESCE(OLD.description, ''));
        END
      `);
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_products_server_id ON products(server_id)
      `);
      console.log('[DatabaseManager] FTS5 full-text search initialized successfully');
    } catch (error) {
      console.error('[DatabaseManager] FTS5 initialization failed (will use LIKE fallback):', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async validateCriticalTables(db: SQLiteDatabase): Promise<void> {
    const criticalTables = [
      'products',
      'consumptions',
      'sessions',
      'devices',
      'cursor_state',
      'outbox_events',
      'tombstones',
      'journal_entries',
    ];
    try {
      const placeholders = criticalTables.map(() => '?').join(',');
      const results = await db.getAllAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`,
        criticalTables
      );
      const existingTables = new Set(results.map((r) => r.name));
      const missingTables = criticalTables.filter((t) => !existingTables.has(t));
      if (missingTables.length > 0) {
        console.error('[DatabaseManager] CRITICAL: Missing required tables after migration repair', {
          missingTables,
          existingTables: Array.from(existingTables),
          hint: 'This indicates a severe migration failure. Consider resetDatabase() for recovery.',
        });
        throw new Error(
          `Database schema validation failed. Missing critical tables: ${missingTables.join(', ')}. ` +
          'The database may need to be reset. This error prevents data corruption from incomplete schema.'
        );
      }
      console.log('[DatabaseManager] Critical table validation passed', {
        validatedTables: criticalTables.length,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing critical tables')) {
        throw error; 
      }
      console.error('[DatabaseManager] Critical table validation query failed:', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
    }
  }
  private async initializeCursorState(db: SQLiteDatabase): Promise<void> {
    const entityTypes = [
      'consumptions', 'sessions', 'journal_entries', 'goals',
      'purchases', 'inventory_items', 'ai_usage_records', 'devices', 'products'
    ];
    for (const entityType of entityTypes) {
      await db.runAsync(
        `INSERT OR IGNORE INTO cursor_state (entity_type, sync_status, created_at, updated_at)
         VALUES (?, 'idle', datetime('now'), datetime('now'))`,
        [entityType]
      );
    }
  }
  public getDrizzle(): DrizzleDB {
    if (!this.drizzleDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.drizzleDb;
  }
  get healthProjectionTablesReady(): boolean {
    return this._healthProjectionTablesReady;
  }
  get healthCursorScopeReady(): boolean {
    return this._healthCursorScopeReady;
  }
  public async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
  public async getDatabase(dbName: string): Promise<SQLiteDatabase> {
    await this.ensureInitialized();
    const existingConnection = this.databaseConnections.get(dbName);
    if (existingConnection) {
      return existingConnection;
    }
    console.log(`[DatabaseManager] Opening new connection to database: ${dbName}`);
    const dbConn = await openDatabaseAsync(dbName + '.db');
    this.databaseConnections.set(dbName, dbConn);
    return dbConn;
  }
  public getMainDatabaseSync(): SQLiteDatabase {
    if (!this.initialized) {
      throw new Error(
        '[DatabaseManager] getMainDatabaseSync() called before initialization. ' +
        'Call initialize() first or use getDatabase() for async access.'
      );
    }
    const mainDb = this.databaseConnections.get(DEVICE_HITS_DATABASE_NAME);
    if (!mainDb) {
      throw new Error(
        '[DatabaseManager] Main database connection not found. ' +
        'This should not happen after initialization.'
      );
    }
    return mainDb;
  }
  public getDbFilePath(): string {
    const documentDirectory = FileSystem.documentDirectory;
    if (!documentDirectory) {
      throw new Error(
        '[DatabaseManager] FileSystem.documentDirectory is null. ' +
        'Cannot determine database path on this platform.'
      );
    }
    return `${documentDirectory}SQLite/${DEVICE_HITS_DATABASE_NAME}.db`;
  }
  public async cleanup(): Promise<void> {
    console.log('[DatabaseManager] Cleaning up database connections...');
    for (const [name, connection] of this.databaseConnections.entries()) {
      try {
        await connection.closeAsync();
        console.log(`[DatabaseManager] Closed connection to ${name}`);
      } catch (err) {
        console.error(`[DatabaseManager] Error closing connection to ${name}:`, err);
      }
    }
    this.databaseConnections.clear();
    this.drizzleDb = null;
    this.initialized = false;
    this.hasAttemptedAutoRecovery = false;
    console.log('[DatabaseManager] Database cleanup completed');
  }
  public async resetDatabase(
    dbName: string = DEVICE_HITS_DATABASE_NAME,
    options: { throwOnError?: boolean } = {}
  ): Promise<void> {
    const { throwOnError = false } = options;
    console.warn('[DatabaseManager] Resetting database (destructive)', { dbName, throwOnError });
    await this.cleanup();
    this.initializationPromise = null;
    const errors: string[] = [];
    try {
      await deleteDatabaseAsync(`${dbName}.db`);
      console.log('[DatabaseManager] Database file deleted', { dbName });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn('[DatabaseManager] Failed to delete database file', {
        dbName,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      if (throwOnError) {
        errors.push(`Failed to delete database file: ${errorMsg}`);
      }
    }
    const sidecarExtensions = ['-wal', '-shm', '-journal'];
    const dbFileName = `${dbName}.db`;
    const documentsSqlitePath = `${FileSystem.documentDirectory}SQLite/`;
    for (const ext of sidecarExtensions) {
      const sidecarPath = `${documentsSqlitePath}${dbFileName}${ext}`;
      try {
        const info = await FileSystem.getInfoAsync(sidecarPath);
        if (info.exists) {
          await FileSystem.deleteAsync(sidecarPath, { idempotent: true });
          console.log('[DatabaseManager] Deleted sidecar file:', `${dbFileName}${ext}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn('[DatabaseManager] Failed to delete sidecar file:', {
          file: `${dbFileName}${ext}`,
          error: errorMsg,
        });
        if (throwOnError) {
          errors.push(`Failed to delete sidecar ${ext}: ${errorMsg}`);
        }
      }
    }
    try {
      await AsyncStorage.removeItem(DB_VERSION_KEY);
      console.log('[DatabaseManager] Cleared stored database version', { key: DB_VERSION_KEY });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn('[DatabaseManager] Failed to clear DB version key', {
        key: DB_VERSION_KEY,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      if (throwOnError) {
        errors.push(`Failed to clear version key: ${errorMsg}`);
      }
    }
    if (throwOnError && errors.length > 0) {
      throw new Error(`Database reset failed: ${errors.join('; ')}`);
    }
  }
  private async initializeSyncTables(db: SQLiteDatabase): Promise<void> {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        local_id TEXT NOT NULL,
        server_id TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        last_modified INTEGER NOT NULL,
        conflict_data TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(table_name, local_id)
      )
    `);
    await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_sync_metadata_status ON sync_metadata(sync_status)`);
    await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_sync_metadata_table_local ON sync_metadata(table_name, local_id)`);
    await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_sync_metadata_server_id ON sync_metadata(server_id)`);
  }
  private async backfillSyncUserIds(db: SQLiteDatabase): Promise<void> {
    try {
      await db.runAsync(
        `UPDATE outbox_events
         SET user_id = (SELECT user_id FROM consumptions WHERE id = outbox_events.aggregate_id)
         WHERE user_id IS NULL AND aggregate_type = 'Consumption'
           AND EXISTS (SELECT 1 FROM consumptions WHERE id = outbox_events.aggregate_id)`
      );
      await db.runAsync(
        `UPDATE outbox_events
         SET user_id = (SELECT userId FROM sessions WHERE id = outbox_events.aggregate_id)
         WHERE user_id IS NULL AND aggregate_type = 'Session'
           AND EXISTS (SELECT 1 FROM sessions WHERE id = outbox_events.aggregate_id)`
      );
      await db.runAsync(
        `UPDATE outbox_events
         SET user_id = (SELECT user_id FROM journal_entries WHERE id = outbox_events.aggregate_id)
         WHERE user_id IS NULL AND aggregate_type = 'JournalEntry'
           AND EXISTS (SELECT 1 FROM journal_entries WHERE id = outbox_events.aggregate_id)`
      );
      await db.runAsync(
        `UPDATE outbox_events
         SET user_id = (SELECT userId FROM products WHERE id = outbox_events.aggregate_id)
         WHERE user_id IS NULL AND aggregate_type = 'Product'
           AND EXISTS (SELECT 1 FROM products WHERE id = outbox_events.aggregate_id)`
      );
      await db.runAsync(
        `UPDATE outbox_events
         SET user_id = (SELECT user_id FROM devices WHERE id = outbox_events.aggregate_id)
         WHERE user_id IS NULL AND aggregate_type = 'Device'
           AND EXISTS (SELECT 1 FROM devices WHERE id = outbox_events.aggregate_id)`
      );
      await db.runAsync(
        `UPDATE tombstones
         SET user_id = (SELECT user_id FROM consumptions WHERE id = tombstones.entity_id)
         WHERE user_id IS NULL AND entity_type = 'consumptions'
           AND EXISTS (SELECT 1 FROM consumptions WHERE id = tombstones.entity_id)`
      );
      await db.runAsync(
        `UPDATE tombstones
         SET user_id = (SELECT user_id FROM journal_entries WHERE id = tombstones.entity_id)
         WHERE user_id IS NULL AND entity_type = 'journal_entries'
           AND EXISTS (SELECT 1 FROM journal_entries WHERE id = tombstones.entity_id)`
      );
      await db.runAsync(
        `UPDATE outbox_events
         SET status = 'DEAD_LETTER',
             error = 'Missing user_id after migration',
             error_details = 'User-scoped outbox entries require user_id to sync'
         WHERE user_id IS NULL AND status != 'COMPLETED'`
      );
      await db.runAsync(
        `UPDATE tombstones
         SET sync_status = 'error',
             error_message = 'Missing user_id after migration'
         WHERE user_id IS NULL AND sync_status != 'synced'`
      );
      console.log('[DatabaseManager] Sync user_id backfill completed');
    } catch (error) {
      console.warn('[DatabaseManager] Sync user_id backfill failed (non-fatal)', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
    }
  }
  async getAllPendingSync(tableName: string): Promise<unknown[]> {
    const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
    return db.getAllAsync(
      `
      SELECT r.*, sm.server_id, sm.sync_status, sm.last_modified, sm.error_message
      FROM ${tableName} r
      LEFT JOIN sync_metadata sm ON r.id = sm.local_id AND sm.table_name = ?
      WHERE sm.sync_status = 'pending' OR sm.sync_status IS NULL
      ORDER BY r.created_at ASC
    `,
      [tableName]
    );
  }
  async getPendingSyncCount(): Promise<number> {
    const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
    const result = (await db.getFirstAsync(`
      SELECT COUNT(*) as count FROM sync_metadata WHERE sync_status = 'pending'
    `)) as { count: number };
    return result?.count || 0;
  }
  async findByServerId(tableName: string, serverId: string): Promise<unknown | null> {
    const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
    return db.getFirstAsync(
      `
      SELECT r.*, sm.sync_status, sm.last_modified, sm.conflict_data
      FROM ${tableName} r
      INNER JOIN sync_metadata sm ON r.id = sm.local_id
      WHERE sm.server_id = ? AND sm.table_name = ?
    `,
      [serverId, tableName]
    );
  }
  async updateSyncStatus(
    tableName: string,
    localId: string,
    syncStatus: SyncStatus,
    serverId?: string,
    errorMessage?: string,
    conflictData?: Record<string, unknown>
  ): Promise<void> {
    const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
    const now = getCurrentTimestamp();
    const existing = await db.getFirstAsync(`SELECT id FROM sync_metadata WHERE local_id = ? AND table_name = ?`, [
      localId,
      tableName,
    ]);
    if (existing) {
      await db.runAsync(
        `
        UPDATE sync_metadata
        SET sync_status = ?, server_id = COALESCE(?, server_id), error_message = ?,
            conflict_data = ?, updated_at = ?
        WHERE local_id = ? AND table_name = ?
      `,
        [
          syncStatus,
          serverId ?? null,
          errorMessage ?? null,
          conflictData ? JSON.stringify(conflictData) : null,
          now,
          localId,
          tableName,
        ]
      );
    } else {
      await db.runAsync(
        `
        INSERT INTO sync_metadata (id, table_name, local_id, server_id, sync_status, last_modified, error_message, conflict_data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          `${tableName}_${localId}_${Date.now()}`,
          tableName,
          localId,
          serverId ?? null,
          syncStatus,
          Date.now(),
          errorMessage ?? null,
          conflictData ? JSON.stringify(conflictData) : null,
          now,
          now,
        ]
      );
    }
  }
  async insertRecord(
    tableName: string,
    data: Record<string, unknown>,
    syncStatus: SyncStatus = SYNC_STATUS.PENDING,
    serverId?: string
  ): Promise<string> {
    const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
    const recordId: string =
      (typeof data.id === 'string' && data.id) || generateUUID();
    const now = getCurrentTimestamp();
    await db.execAsync('BEGIN TRANSACTION');
    try {
      const columns = Object.keys(data).filter((key) => key !== 'id');
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map((key) => {
        const value = data[key];
        if (value === undefined) return null;
        if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
          return JSON.stringify(value);
        }
        return value;
      });
      await db.runAsync(
        `INSERT INTO ${tableName} (id, ${columns.join(', ')}, created_at, updated_at) VALUES (?, ${placeholders}, ?, ?)`,
        [recordId, ...values, now, now] as (string | number | boolean | null | Uint8Array)[]
      );
      await db.runAsync(
        `INSERT INTO sync_metadata (id, table_name, local_id, server_id, sync_status, last_modified, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [`${tableName}_${recordId}_${Date.now()}`, tableName, recordId, serverId ?? null, syncStatus, Date.now(), now, now]
      );
      await db.execAsync('COMMIT');
      return recordId;
    } catch (error) {
      await db.execAsync('ROLLBACK');
      throw error;
    }
  }
  async updateRecord(
    tableName: string,
    recordId: string,
    data: Record<string, unknown>,
    syncStatus: SyncStatus = SYNC_STATUS.PENDING
  ): Promise<void> {
    const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
    const now = getCurrentTimestamp();
    await db.execAsync('BEGIN TRANSACTION');
    try {
      const columns = Object.keys(data).filter((key) => key !== 'id');
      const setClause = columns.map((key) => `${key} = ?`).join(', ');
      const values = columns.map((key) => {
        const value = data[key];
        if (value === undefined) return null;
        if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
          return JSON.stringify(value);
        }
        return value;
      });
      await db.runAsync(
        `UPDATE ${tableName} SET ${setClause}, updated_at = ? WHERE id = ?`,
        [...values, now, recordId] as (string | number | boolean | null | Uint8Array)[]
      );
      await this.updateSyncStatus(tableName, recordId, syncStatus);
      await db.execAsync('COMMIT');
    } catch (error) {
      await db.execAsync('ROLLBACK');
      throw error;
    }
  }
  public async clearUserData(userId: string): Promise<void> {
    if (!userId) {
      console.warn('[DatabaseManager] clearUserData called with empty userId, skipping');
      return;
    }
    console.log('[DatabaseManager] Clearing user data', { userId });
    const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
    await db.withExclusiveTransactionAsync(async () => {
      await db.runAsync(
        `DELETE FROM purchase_items WHERE purchaseId IN (SELECT id FROM purchases WHERE userId = ?)`,
        [userId]
      );
      await db.runAsync(
        `DELETE FROM session_products WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ?)`,
        [userId]
      );
      await db.runAsync(`DELETE FROM journal_effects WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM consumptions WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM journal_entries WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM inventory_adjustments WHERE userId = ?`, [userId]);
      await db.runAsync(`DELETE FROM inventory_items WHERE userId = ?`, [userId]);
      await db.runAsync(`DELETE FROM purchases WHERE userId = ?`, [userId]);
      await db.runAsync(`DELETE FROM sessions WHERE userId = ?`, [userId]);
      await db.runAsync(`DELETE FROM products WHERE userId = ? AND isPublic = 0`, [userId]);
      await db.runAsync(`DELETE FROM goals WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM devices WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM ai_usage_records WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM safety_records_new WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM sync_operations WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM device_telemetry WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM analytics_events WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM refresh_tokens WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM ai_summaries WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM daily_stats WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM user_consumption_profiles WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM user_routine_profiles WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM user_achievements WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM consumption_sessions WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM health_samples WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM health_sources WHERE user_id = ?`, [userId]);
      try { await db.runAsync(`DELETE FROM health_ingest_cursors WHERE user_id = ?`, [userId]); } catch {  }
      try { await db.runAsync(`DELETE FROM health_sample_deletion_queue WHERE user_id = ?`, [userId]); } catch {  }
      try { await db.runAsync(`DELETE FROM local_health_rollup_day WHERE user_id = ?`, [userId]); } catch {  }
      try { await db.runAsync(`DELETE FROM local_sleep_night_summary WHERE user_id = ?`, [userId]); } catch {  }
      try { await db.runAsync(`DELETE FROM local_session_impact_summary WHERE user_id = ?`, [userId]); } catch {  }
      try { await db.runAsync(`DELETE FROM local_rollup_dirty_keys WHERE user_id = ?`, [userId]); } catch {  }
      try { await db.runAsync(`DELETE FROM local_sleep_dirty_nights WHERE user_id = ?`, [userId]); } catch {  }
      try { await db.runAsync(`DELETE FROM local_product_impact_rollup WHERE user_id = ?`, [userId]); } catch {  }
      try { await db.runAsync(`DELETE FROM local_health_insights WHERE user_id = ?`, [userId]); } catch {  }
      await db.runAsync(`DELETE FROM outbox_events WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM tombstones WHERE user_id = ?`, [userId]);
      await db.runAsync(`DELETE FROM users WHERE id = ?`, [userId]);
    });
    console.log('[DatabaseManager] User data cleared successfully', { userId });
  }
  async isProductsFtsReady(): Promise<boolean> {
    try {
      const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
      const tableCheck = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='products_fts'`
      );
      if (!tableCheck) {
        console.log('[DatabaseManager] products_fts table does not exist');
        return false;
      }
      const countCheck = await db.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) as count FROM products_fts`
      );
      const hasData = (countCheck?.count ?? 0) > 0;
      console.log('[DatabaseManager] products_fts ready check', {
        exists: true,
        hasData,
        count: countCheck?.count ?? 0,
      });
      return hasData;
    } catch (error) {
      console.warn('[DatabaseManager] FTS ready check failed', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      return false;
    }
  }
  async rebuildProductsFtsIndex(): Promise<void> {
    console.log('[DatabaseManager] Rebuilding products FTS5 index...');
    const startTime = Date.now();
    try {
      const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
      const tableCheck = await db.getFirstAsync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='products_fts'`
      );
      if (!tableCheck) {
        const error = new Error(
          '[DatabaseManager] FTS5 table missing. Migration 0008_add_products_fts.sql may not have been applied. ' +
          'This is a configuration/migration issue that must be resolved.'
        );
        console.error('[DatabaseManager] Cannot rebuild FTS: products_fts table does not exist');
        throw error;
      }
      await db.execAsync(`INSERT INTO products_fts(products_fts) VALUES('rebuild')`);
      const duration = Date.now() - startTime;
      console.log('[DatabaseManager] FTS5 rebuild completed', { durationMs: duration });
    } catch (error) {
      console.error('[DatabaseManager] FTS5 rebuild failed', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async getProductsFtsCount(): Promise<number> {
    try {
      const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
      const result = await db.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) as count FROM products_fts`
      );
      return result?.count ?? 0;
    } catch (error) {
      console.error('[DatabaseManager] FTS count query failed', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async searchProductsFts(query: string, limit: number = 50): Promise<number[]> {
    const db = await this.getDatabase(DEVICE_HITS_DATABASE_NAME);
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) {
      return []; 
    }
    const ftsQuery = sanitizeFtsQuery(normalizedQuery);
    const hasEmoji = /\p{Emoji}/u.test(normalizedQuery);
    const hasSpecialChars = /[^a-zA-Z0-9\s\-_*]/.test(normalizedQuery);
    const isMultiWord = normalizedQuery.split(/\s+/).length > 1;
    if (hasEmoji || hasSpecialChars || isMultiWord) {
      console.log('[DatabaseManager] FTS5 edge case query detected', {
        query: normalizedQuery,
        hasEmoji,
        hasSpecialChars,
        isMultiWord,
        sanitizedFtsQuery: ftsQuery,
        charCodes: Array.from(normalizedQuery).map(c => c.charCodeAt(0)),
      });
    }
    try {
      const startTime = Date.now();
      const results = await db.getAllAsync<{ rowid: number; rank: number; name: string; id: string }>(
        `SELECT fts.rowid, fts.rank, p.name, p.id
         FROM products_fts fts
         INNER JOIN products p ON p.rowid = fts.rowid
         WHERE fts.products_fts MATCH ?
         ORDER BY
           CASE WHEN LOWER(p.name) = LOWER(?) THEN 0 ELSE 1 END,
           CASE WHEN LOWER(p.name) LIKE LOWER(?) || '%' THEN 0 ELSE 1 END,
           fts.rank,
           p.name COLLATE NOCASE,
           p.id
         LIMIT ?`,
        [ftsQuery, normalizedQuery, normalizedQuery, limit]
      );
      const duration = Date.now() - startTime;
      console.log('[DatabaseManager] FTS5 search completed', {
        query,
        ftsQuery,
        normalizedQuery,
        resultCount: results.length,
        durationMs: duration,
        sampleResults: results.slice(0, 3).map(r => ({
          rowid: r.rowid,
          rank: r.rank,
          name: r.name,
          id: r.id,
          isExactMatch: r.name.toLowerCase() === normalizedQuery.toLowerCase(),
          isPrefixMatch: r.name.toLowerCase().startsWith(normalizedQuery.toLowerCase()),
        }))
      });
      return results.map((r) => r.rowid);
    } catch (error) {
      console.error('[DatabaseManager] FTS search failed', {
        query,
        ftsQuery,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
        recoveryHint: 'Check FTS5 migration status. Try rebuildProductsFtsIndex() to repair.',
      });
      throw error;
    }
  }
}
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(token => token.length > 0);
  if (tokens.length === 0) {
    return '';
  }
  const quotedTokens = tokens.map(token => {
    const escaped = token.replace(/"/g, '""');
    return `"${escaped}"`;
  });
  const lastIndex = quotedTokens.length - 1;
  quotedTokens[lastIndex] = quotedTokens[lastIndex] + '*';
  return quotedTokens.join(' ');
}
export const databaseManager = DatabaseManager.getInstance();
