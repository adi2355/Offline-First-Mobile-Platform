import NetInfo from '@react-native-community/netinfo';
import { AppState, AppStateStatus } from 'react-native';
import { QueryClient } from '@tanstack/react-query';
import { debounce, DebouncedFunc } from 'lodash';
import { SQLiteDatabase } from 'expo-sqlite';
import { DatabaseManager } from '../../DatabaseManager';
import { BackendAPIClient } from '../api/BackendAPIClient';
import { secureStorage, DataSensitivity } from '../SecureStorageService';
import { logger, toLogError } from '../../utils/logger';
import type { LogContext } from '../../utils/logger';
import { DeviceIdManager } from '../../utils/DeviceIdManager';
import { dataChangeEmitter, dbEvents, DataChangeEvent } from '../../utils/EventEmitter';
import { buildDeviceCreatePayload } from '../../utils/devicePayload';
import type { ZodSchema } from 'zod';
import {
  OutboxRepository,
  CursorRepository,
  IdMapRepository,
  TombstoneRepository,
  OutboxCommand,
} from '../../repositories/offline';
import {
  type EntityType,
  canonicalizeEntityType,
  tryCanonicalizeEntityType,
  isEntityType,
  ENTITY_SYNC_ORDER,
  ENTITY_TYPES,
  getSyncOrder,
  getForeignKeyFields,
  getOptionalForeignKeyFields,
  getTargetEntityForFkField,
  type CompositeCursor,
  type EntityCursor,
  buildCompositeCursor,
  encodeCompositeCursor,
  decodeCompositeCursor,
  tryDecodeCompositeCursor,
  decodeEntityCursor,
  encodeEntityCursor,
  InvalidCursorError,
  CursorBackwardError,
  CURSOR_SCHEMA_VERSION,
  type ConflictResolutionOutcome,
} from '@shared/contracts';
import { LocalDeviceRepository } from '../../repositories/LocalDeviceRepository';
import { FrontendSyncHandlerRegistry } from './handlers';
import {
  IntegrityGate,
  IntegrityCheckExecutionError,
  type IntegrityReport,
} from './IntegrityGate';
import { SyncBatchContext, createSyncBatchContext } from './SyncBatchContext';
import { SyncScheduler, type SyncTaskPriority } from './SyncScheduler';
import { SyncLeaseManager, SyncLeaseDeniedError } from './SyncLeaseManager';
import {
  createSyncEngineStack,
  type SyncEngineStack,
} from './engines/compositionRoot';
import type { ISyncCoordinator } from './engines/interfaces';
import { SYNC_ERROR_CODES, type SyncReport, type SyncOptions } from './engines/types';
import { isFeatureEnabled } from '../../config/featureFlags';
import {
  type EntityColumnConfig,
  ENTITY_COLUMN_MAPPINGS,
  ENTITY_CLIENT_ID_FIELDS,
  ENTITY_HARDWARE_ID_FIELDS,
  ENTITY_USER_COLUMN,
  getSyncableEntityTypes,
  isSyncableEntity,
  getEntityUserColumn,
  extractClientIdFromPayload,
  buildEntityInsert,
  buildEntityUpdate,
  getEntityColumnConfig,
  assertEntityMappingsValid,
  validateBusinessRules,
  validateSchemaAlignment,
  validateAllUserColumnChecks,
} from './config/entity-mappings';
import {
  CreateConsumptionDtoSchema,
  UpdateConsumptionDtoSchema,
  CreateSessionDtoSchema,
  UpdateSessionDtoSchema,
  CreateJournalEntryDtoSchema,
  UpdateJournalEntryDtoSchema,
  CreateGoalDtoSchema,
  UpdateGoalDtoSchema,
  CreatePurchaseDtoSchema,
  UpdatePurchaseDtoSchema,
  CreateInventoryItemDtoSchema,
  UpdateInventoryItemDtoSchema,
  CreateProductDtoSchema,
  UpdateProductDtoSchema,
  CreateDeviceDtoSchema,
  UpdateDeviceDtoSchema,
  CreateAiUsageRecordDtoSchema,
  UpdateAiUsageRecordDtoSchema,
} from '../../utils/ValidationSchemas';
export enum SyncStatus {
  IDLE = 'idle',
  SYNCING = 'syncing',
  SUCCESS = 'success',
  ERROR = 'error',
  OFFLINE = 'offline',
}
export interface SyncState {
  status: SyncStatus;
  lastSyncTime?: number;
  pendingCommands: number;
  pendingTombstones: number;
  pendingUploads: number; 
  entitiesSyncing: EntityType[];
  totalConflicts: number;
  errorMessage?: string;
}
export enum ConflictResolution {
  SERVER_WINS = 'server_wins',
  CLIENT_WINS = 'client_wins',
  MERGE = 'merge',
  MANUAL = 'manual',
}
export interface SyncConflict {
  id: string;
  entityType: EntityType;
  localData: Record<string, unknown>;
  serverData: Record<string, unknown>;
  conflictFields: string[];
  timestamp: number;
  resolution?: ConflictResolution;
}
export interface EntityDiscrepancy {
  entityType: EntityType;
  localCount: number;
  backendCount: number;
  discrepancyRatio: number;
  needsRepair: boolean;
}
export interface DataIntegrityReport {
  checkedAt: string;
  entityTypes: EntityType[];
  discrepancies: EntityDiscrepancy[];
  entitiesRepaired: EntityType[];
  pullTriggered: boolean;
  error: string | null;
}
interface SyncLogContext extends LogContext {
  correlationId: string;
  userId?: string;
  entityType?: string;
  operation: 'PUSH' | 'PULL' | 'CONFLICT';
  entityId?: string;
  clientId?: string;
  version?: number;
  syncStatus?: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  metrics?: {
    durationMs: number;
    recordsProcessed: number;
  };
}
type OutboxPayloadValidator = {
  create?: ZodSchema;
  update?: ZodSchema;
};
const OUTBOX_PAYLOAD_VALIDATORS: Partial<Record<EntityType, OutboxPayloadValidator>> = {
  consumptions: {
    create: CreateConsumptionDtoSchema,
    update: UpdateConsumptionDtoSchema,
  },
  sessions: {
    create: CreateSessionDtoSchema,
    update: UpdateSessionDtoSchema,
  },
  journal_entries: {
    create: CreateJournalEntryDtoSchema,
    update: UpdateJournalEntryDtoSchema,
  },
  goals: {
    create: CreateGoalDtoSchema,
    update: UpdateGoalDtoSchema,
  },
  purchases: {
    create: CreatePurchaseDtoSchema,
    update: UpdatePurchaseDtoSchema,
  },
  inventory_items: {
    create: CreateInventoryItemDtoSchema,
    update: UpdateInventoryItemDtoSchema,
  },
  products: {
    create: CreateProductDtoSchema,
    update: UpdateProductDtoSchema,
  },
  devices: {
    create: CreateDeviceDtoSchema,
    update: UpdateDeviceDtoSchema,
  },
  ai_usage_records: {
    create: CreateAiUsageRecordDtoSchema,
    update: UpdateAiUsageRecordDtoSchema,
  },
};
export interface PushCommandsRequest {
  deviceId: string;
  changes: {
    entityType: EntityType;
    entityId: string; 
    changeType: 'CREATE' | 'UPDATE' | 'DELETE';
    clientId?: string; 
    requestId?: string; 
    data: Record<string, unknown>;
    version: number;
    timestamp: string;
  }[];
  syncOperationId: string;
  lastSyncCursor?: string;
}
export interface PushCommandsResponse {
  successful: {
    clientId: string;
    serverId: string;
    entityType: string;
    requestId?: string;
  }[];
  failed: {
    clientId: string;
    error: string;
    retryable: boolean;
    requestId?: string;
    errorCode?: string;
    details?: Record<string, unknown>;
  }[];
  conflicts: {
    id: string;
    entityType: string;
    entityId: string;
    userId: string;
    requestId?: string; 
    remoteVersion?: Record<string, unknown>; 
  }[];
}
export interface PullChangesRequest {
  cursor?: string;
  entityTypes: EntityType[];
  limit?: number;
}
export interface PullChangesResponse {
  changes: {
    entityType: EntityType;
    operation: 'CREATE' | 'UPDATE' | 'DELETE';
    serverId: string;
    data?: Record<string, unknown>;
    timestamp: string;
  }[];
  cursor: string | null; 
  hasMore: boolean;
  recordsReturned: number;
  entityCursors: Record<string, string>; 
}
export class DataSyncService {
  private static instance: DataSyncService | null = null;
  private readonly instanceId: string;
  private static instanceCounter: number = 0;
  private static sharedInitializationPromise: Promise<void> | null = null;
  private static sharedInitializationInProgress: boolean = false;
  private static sharedActiveSyncPromise: Promise<void> | null = null;
  private static sharedSyncInProgress: boolean = false;
  private static sharedLastSyncSourceTime: Map<string, number> = new Map();
  private static readonly SOURCE_COOLDOWN_MS = 30_000; 
  private static sharedBackoffMs: number = 0;
  private static sharedConsecutiveRateLimitErrors: number = 0;
  private static sharedLastRateLimitErrorTime: number = 0;
  private static sharedLastManualOverrideTime: number = 0;
  private static readonly MIN_BACKOFF_MS = 5_000; 
  private static readonly MAX_BACKOFF_MS = 300_000; 
  private static readonly BACKOFF_MULTIPLIER = 2; 
  private static readonly BACKOFF_JITTER_FACTOR = 0.2; 
  private static readonly MANUAL_OVERRIDE_COOLDOWN_MS = 30_000; 
  private static sharedLastSyncAttemptTime: number = 0;
  private static readonly MIN_SYNC_DEBOUNCE_MS = 30_000; 
  private static readonly SMART_SYNC_THRESHOLD_MS = 60_000; 
  private static readonly HARD_MIN_SYNC_INTERVAL_MS = 5_000; 
  private static sharedLastCacheBustTime: number = 0;
  private static readonly CACHE_BUST_COOLDOWN_MS = 3_000; 
  private static readonly MAX_ALLOWED_CLOCK_SKEW_MS = 5 * 60 * 1000; 
  private static startupGatePromise: Promise<void> | null = null;
  private static startupGateResolver: (() => void) | null = null;
  private syncState: SyncState;
  private syncInterval?: NodeJS.Timeout;
  private networkListener?: () => void;
  private queryClient?: QueryClient; 
  private isInitialized: boolean = false; 
  private currentUserId: string | null = null; 
  private debouncedSyncTrigger: DebouncedFunc<() => Promise<void>>;
  private pendingSyncEventCount: number = 0;
  private pendingSyncEventSources: Set<string> = new Set();
  private dataChangeHandler?: (event?: DataChangeEvent) => void;
  private integrityGate: IntegrityGate | null = null;
  private syncEngineStack: SyncEngineStack | null = null;
  private syncScheduler: SyncScheduler | null = null;
  private syncLeaseManager: SyncLeaseManager | null = null;
  private static readonly LAST_SYNC_KEY = 'last_sync_timestamp';
  private static readonly SYNC_CONFLICTS_KEY = 'sync_conflicts';
  private currentSyncIntervalMs: number = 600_000; 
  private static readonly ACTIVE_SYNC_INTERVAL = 600_000; 
  private static readonly BACKGROUND_SYNC_INTERVAL = 1200_000; 
  private appStateSubscription?: ReturnType<typeof AppState.addEventListener>
  constructor(
    private db: DatabaseManager,
    private apiClient: BackendAPIClient,
    private outboxRepo: OutboxRepository,
    private cursorRepo: CursorRepository,
    private idMapRepo: IdMapRepository,
    private tombstoneRepo: TombstoneRepository,
    private handlerRegistry: FrontendSyncHandlerRegistry,
  ) {
    DataSyncService.instanceCounter++;
    this.instanceId = `DSS-${DataSyncService.instanceCounter}-${Date.now().toString(36)}`;
    logger.warn('[DataSyncService] New instance created', {
      instanceId: this.instanceId,
      totalInstances: DataSyncService.instanceCounter,
      hasExistingInstance: !!DataSyncService.instance,
      existingInstanceId: DataSyncService.instance?.instanceId,
    });
    if (DataSyncService.instanceCounter > 1) {
      logger.error('[DataSyncService] MULTIPLE INSTANCES DETECTED - possible Hot Refresh issue', {
        newInstanceId: this.instanceId,
        totalInstances: DataSyncService.instanceCounter,
        note: 'Using static shared state to ensure coordination',
      });
    }
    this.syncState = {
      status: SyncStatus.IDLE,
      pendingCommands: 0,
      pendingTombstones: 0,
      pendingUploads: 0,
      entitiesSyncing: [],
      totalConflicts: 0,
    };
    this.debouncedSyncTrigger = debounce(
      async () => {
        if (this.isInitialized && !DataSyncService.sharedSyncInProgress) {
          const eventCount = this.pendingSyncEventCount;
          const eventSources = Array.from(this.pendingSyncEventSources);
          this.pendingSyncEventCount = 0;
          this.pendingSyncEventSources.clear();
          logger.debug('[DataSyncService] Auto-sync triggered by local data change event', {
            instanceId: this.instanceId,
            batchedEventCount: eventCount,
            eventSources: eventSources.length > 3 
              ? [...eventSources.slice(0, 3), `+${eventSources.length - 3} more`]
              : eventSources,
          });
          await this.performFullSync({ source: 'DATA_CHANGE_EVENT' });
        }
      },
      10000, 
      { maxWait: 60000 } 
    );
    this.initializeNetworkListener();
  }
  public static configureStartupGate(enabled: boolean): void {
    if (!enabled) {
      DataSyncService.startupGatePromise = null;
      DataSyncService.startupGateResolver = null;
      return;
    }
    if (!DataSyncService.startupGatePromise) {
      DataSyncService.startupGatePromise = new Promise<void>((resolve) => {
        DataSyncService.startupGateResolver = resolve;
      });
    }
  }
  public static releaseStartupGate(): void {
    if (DataSyncService.startupGateResolver) {
      DataSyncService.startupGateResolver();
    }
    DataSyncService.startupGatePromise = null;
    DataSyncService.startupGateResolver = null;
  }
  public static getInstance(
    db?: DatabaseManager,
    apiClient?: BackendAPIClient,
    outboxRepo?: OutboxRepository,
    cursorRepo?: CursorRepository,
    idMapRepo?: IdMapRepository,
    tombstoneRepo?: TombstoneRepository,
    handlerRegistry?: FrontendSyncHandlerRegistry,
  ): DataSyncService {
    if (!DataSyncService.instance) {
      if (!db || !apiClient || !outboxRepo || !cursorRepo || !idMapRepo || !tombstoneRepo || !handlerRegistry) {
        throw new Error(
          'DataSyncService: All dependencies (db, apiClient, outboxRepo, cursorRepo, idMapRepo, tombstoneRepo, handlerRegistry) must be provided on first getInstance() call',
        );
      }
      DataSyncService.instance = new DataSyncService(
        db,
        apiClient,
        outboxRepo,
        cursorRepo,
        idMapRepo,
        tombstoneRepo,
        handlerRegistry,
      );
    }
    return DataSyncService.instance;
  }
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.debug('DataSync: Already initialized, skipping re-initialization');
      return;
    }
    if (DataSyncService.sharedInitializationPromise) {
      logger.debug('DataSync: Initialization already in progress - waiting for completion', {
        instanceId: this.instanceId,
      });
      try {
        await DataSyncService.sharedInitializationPromise;
        this.isInitialized = true;
        await this.loadSyncState();
        logger.debug('DataSync: Waited for in-progress initialization to complete', {
          instanceId: this.instanceId,
          isInitialized: this.isInitialized,
        });
      } catch (initError) {
        logger.warn('DataSync: In-progress initialization failed, waiter can retry', {
          instanceId: this.instanceId,
          error: initError instanceof Error
            ? { name: initError.name, message: initError.message }
            : { name: 'Error', message: String(initError) },
        });
      }
      return;
    }
    if (DataSyncService.sharedInitializationInProgress) {
      logger.warn('DataSync: Initialization already in progress (static check), skipping', {
        instanceId: this.instanceId,
      });
      return;
    }
    DataSyncService.sharedInitializationInProgress = true;
    let resolveInitPromise: () => void;
    let rejectInitPromise: (error: Error) => void;
    DataSyncService.sharedInitializationPromise = new Promise<void>((resolve, reject) => {
      resolveInitPromise = resolve;
      rejectInitPromise = reject;
    });
    logger.debug('DataSync: Acquired initialization lock', { instanceId: this.instanceId });
    try {
      logger.info('DataSync: Initializing cursor-based sync service');
      if (DataSyncService.startupGatePromise) {
        logger.info('DataSync: Waiting for startup gate before initialization', {
          instanceId: this.instanceId,
        });
        await DataSyncService.startupGatePromise;
      }
      assertEntityMappingsValid(
        ENTITY_COLUMN_MAPPINGS,
        ENTITY_CLIENT_ID_FIELDS,
        ENTITY_HARDWARE_ID_FIELDS
      );
      const businessRuleResult = validateBusinessRules(ENTITY_COLUMN_MAPPINGS);
      if (!businessRuleResult.success) {
        throw new Error(
          `ENTITY_COLUMN_MAPPINGS business rule violations:\n` +
          businessRuleResult.errors.map((e) => `  - ${e}`).join('\n')
        );
      }
      const schemaAlignmentResult = validateSchemaAlignment(ENTITY_COLUMN_MAPPINGS);
      if (!schemaAlignmentResult.success) {
        throw new Error(
          `ENTITY_COLUMN_MAPPINGS schema alignment violations:\n` +
          schemaAlignmentResult.errors.map((e) => `  - ${e}`).join('\n')
        );
      }
      const userColumnResult = validateAllUserColumnChecks(ENTITY_USER_COLUMN, ENTITY_COLUMN_MAPPINGS);
      if (!userColumnResult.success) {
        throw new Error(
          `ENTITY_USER_COLUMN validation failed:\n` +
          userColumnResult.errors.map((e) => `  - ${e}`).join('\n')
        );
      }
      logger.debug('DataSync: Entity column mappings validated successfully');
      await this.loadSyncState();
      const sqliteDb = await this.db.getDatabase('DeviceEvents');
      if (!sqliteDb) {
        throw new Error('DataSync: SQLite database not available - cannot initialize sync engine stack');
      }
      this.syncEngineStack = createSyncEngineStack({
        db: sqliteDb,
        apiClient: this.apiClient,
        outboxRepo: this.outboxRepo,
        cursorRepo: this.cursorRepo,
        idMapRepo: this.idMapRepo,
        tombstoneRepo: this.tombstoneRepo,
        handlerRegistry: this.handlerRegistry,
        queryClient: this.queryClient,
        getCurrentUserId: () => this.currentUserId,
      });
      if (this.currentUserId) {
        await this.syncEngineStack.coordinator.initialize(this.currentUserId);
      }
      logger.info('DataSync: Engine stack created successfully (engine-only mode)', {
        instanceId: this.instanceId,
      });
      this.initializeAppStateListener();
      this.setupEventListeners();
      const networkState = await NetInfo.fetch();
      if (networkState.isConnected) {
        this.startPeriodicSync();
        logger.info('DataSync: Triggering immediate initial sync pull');
        this.performFullSync({ force: true, source: 'DATASYNC_INITIALIZE' }).catch((syncError: unknown) => {
          const err = syncError instanceof Error ? syncError : new Error(String(syncError));
          logger.warn('DataSync: Initial sync failed, will retry on next interval', {
            error: { name: err.name, message: err.message },
          });
        });
      }
      this.isInitialized = true;
      logger.info('DataSync: Sync service initialized', { syncState: this.syncState });
      resolveInitPromise!();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DataSync: Failed to initialize sync service', {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
      });
      rejectInitPromise!(err);
      throw err;
    } finally {
      DataSyncService.sharedInitializationInProgress = false;
    }
  }
  private setupEventListeners(): void {
    this.dataChangeHandler = (event?: DataChangeEvent) => {
      const shouldTriggerSync =
        event?.mode === 'offline' ||
        event?.source?.includes('_OFFLINE');
      if (shouldTriggerSync) {
        this.pendingSyncEventCount++;
        if (event?.source) {
          this.pendingSyncEventSources.add(event.source);
        }
        if (this.pendingSyncEventCount === 1) {
          logger.debug('[DataSyncService] Scheduling sync due to local data change (batching...)', { 
            source: event?.source,
            mode: event?.mode,
          });
        }
        this.debouncedSyncTrigger();
      }
    };
    dataChangeEmitter.on(dbEvents.DATA_CHANGED, this.dataChangeHandler);
    logger.debug('[DataSyncService] Event listeners setup for LOCAL-FIRST auto-sync');
  }
  public setQueryClient(queryClient: QueryClient): void {
    this.queryClient = queryClient;
    logger.info('DataSync: QueryClient configured for cache invalidation');
  }
  public setSyncScheduler(scheduler: SyncScheduler | null): void {
    this.syncScheduler = scheduler;
    if (scheduler) {
      logger.info('DataSync: SyncScheduler configured for coordinated sync execution');
    }
  }
  public setSyncLeaseManager(manager: SyncLeaseManager | null): void {
    this.syncLeaseManager = manager;
    if (manager) {
      logger.info('DataSync: SyncLeaseManager configured for lease enforcement');
    }
  }
  public setCurrentUserId(userId: string | null): void {
    this.currentUserId = userId;
    logger.info('DataSync: Active user context updated', {
      userId: userId ?? 'none',
    });
  }
  public getCurrentUserId(): string | null {
    return this.currentUserId;
  }
  private getActiveUserId(context: string): string | null {
    if (!this.currentUserId) {
      logger.warn('DataSync: Skipping operation - no active user context', { context });
      return null;
    }
    return this.currentUserId;
  }
  private getIntegrityGate(): IntegrityGate {
    if (!this.integrityGate) {
      this.integrityGate = new IntegrityGate(
        () => this.db.getDatabase('DeviceEvents')
      );
      this.integrityGate.setFailFastMode(false);
      logger.info('DataSync: IntegrityGate initialized (warn-only mode)');
    }
    return this.integrityGate;
  }
  public setIntegrityGateFailFastMode(enabled: boolean): void {
    const gate = this.getIntegrityGate();
    gate.setFailFastMode(enabled);
  }
  private async runIntegrityCheck(ctx: SyncBatchContext): Promise<IntegrityReport> {
    const gate = this.getIntegrityGate();
    const touchedSourceIds = ctx.getTouchedIds();
    const touchedTargetIds = ctx.getTouchedTargetIds();
    const entityTypesWithDeletes = ctx.getEntityTypesWithDeletes();
    const hasIdReplacements = ctx.hasIdReplacements();
    const hasDeletes = entityTypesWithDeletes.length > 0;
    const hasOverflow = ctx.hasOverflow();
    if (hasIdReplacements || hasDeletes || hasOverflow) {
      logger.debug('DataSync: Running integrity check with extended scoping', {
        batchId: ctx.batchId,
        hadIdReplacements: hasIdReplacements,
        deletedEntityTypes: entityTypesWithDeletes,
        hasSourceOverflow: ctx.hasSourceOverflow(),
        hasTargetOverflow: ctx.hasTargetOverflow(),
        sourceOverflowEntities: ctx.getSourceOverflowEntities(),
        targetOverflowEntities: ctx.getTargetOverflowEntities(),
      });
    }
    const report = await gate.checkIntegrity({
      touchedIds: touchedSourceIds,
      touchedTargetIds: touchedTargetIds,
      entityTypesWithDeletes: entityTypesWithDeletes,
      syncBatchId: ctx.batchId,
      onQueryError: 'throw',
    });
    logger.info('DataSync: Integrity check completed', {
      batchId: ctx.batchId,
      status: report.status,
      violationCount: report.violationCount,
      relationsPlanned: report.relationsPlanned,
      relationsExecuted: report.relationsExecuted,
      relationsSkipped: report.relationsSkipped,
      durationMs: report.durationMs,
      hadIdReplacements: hasIdReplacements,
      hadDeletes: hasDeletes,
    });
    return report;
  }
  private async persistDeferredCursors(ctx: SyncBatchContext): Promise<void> {
    const updates = ctx.getDeferredCursorUpdates();
    if (updates.length === 0) {
      return;
    }
    logger.debug('DataSync: Persisting deferred cursor updates', {
      batchId: ctx.batchId,
      count: updates.length,
    });
    for (const update of updates) {
      await this.cursorRepo.setCursor(update.entityType, update.cursor, {
        records_synced: update.recordsSynced,
        has_more: update.hasMore,
      });
    }
    logger.debug('DataSync: Deferred cursor updates persisted', {
      batchId: ctx.batchId,
      entityTypes: updates.map((u) => u.entityType),
    });
  }
  getSyncState(): SyncState {
    return { ...this.syncState };
  }
  public startSync(): void {
    if (!this.isInitialized) {
      logger.warn('DataSync: Cannot start sync - service not initialized. Call initialize() first.');
      return;
    }
    logger.info('DataSync: Starting sync service explicitly');
    this.stopPeriodicSync();
    this.startPeriodicSync();
    this.performFullSync({ force: true, source: 'DATASYNC_START' }).catch((syncError: unknown) => {
      const err = syncError instanceof Error ? syncError : new Error(String(syncError));
      logger.warn('DataSync: startSync() immediate sync failed, will retry on next interval', {
        error: { name: err.name, message: err.message },
      });
    });
  }
  async repairDataIntegrity(
    entityTypes: EntityType[] = ['consumptions', 'sessions'],
    discrepancyThreshold: number = 0.1
  ): Promise<DataIntegrityReport> {
    const report: DataIntegrityReport = {
      checkedAt: new Date().toISOString(),
      entityTypes,
      discrepancies: [],
      entitiesRepaired: [],
      pullTriggered: false,
      error: null,
    };
    try {
      const userId = this.getActiveUserId('repairDataIntegrity');
      if (!userId) {
        report.error = 'No active user';
        return report;
      }
      logger.info('DataSync: Starting data integrity repair check', {
        entityTypes,
        discrepancyThreshold,
      });
      const database = await this.db.getDatabase('DeviceEvents');
      const entitiesToRepair: EntityType[] = [];
      for (const entityType of entityTypes) {
        try {
          const userColumn = getEntityUserColumn(entityType);
          let localCountResult: { count: number } | null;
          if (userColumn) {
            localCountResult = await database.getFirstAsync<{ count: number }>(
              `SELECT COUNT(*) as count FROM "${entityType}" WHERE "${userColumn}" = ?`,
              [userId]
            );
          } else {
            logger.debug('DataSync: Entity not user-scoped, counting all rows', { entityType });
            localCountResult = await database.getFirstAsync<{ count: number }>(
              `SELECT COUNT(*) as count FROM "${entityType}"`
            );
          }
          const localCount = localCountResult?.count ?? 0;
          let backendCount = 0;
          try {
            const response = await this.apiClient.get<{
              items: unknown[];
              pagination: { total: number; page: number; pageSize: number };
            }>(`/${entityType}`, {
              params: {
                page: '1',
                pageSize: '1', 
              },
            });
            backendCount = response.data.pagination?.total ?? 0;
          } catch (apiError) {
            logger.warn('DataSync: Could not get backend count for integrity check', {
              entityType,
              error: apiError instanceof Error
                ? { name: apiError.name, message: apiError.message }
                : { name: 'Error', message: String(apiError) },
            });
            continue;
          }
          const discrepancy = backendCount > 0
            ? Math.abs(backendCount - localCount) / backendCount
            : (localCount > 0 ? 1 : 0);
          const discrepancyInfo: EntityDiscrepancy = {
            entityType,
            localCount,
            backendCount,
            discrepancyRatio: discrepancy,
            needsRepair: discrepancy >= discrepancyThreshold,
          };
          report.discrepancies.push(discrepancyInfo);
          if (discrepancyInfo.needsRepair) {
            logger.warn('DataSync: Data integrity discrepancy detected', {
              entityType,
              localCount,
              backendCount,
              discrepancyRatio: discrepancy,
              threshold: discrepancyThreshold,
            });
            entitiesToRepair.push(entityType);
          } else {
            logger.debug('DataSync: Entity counts within acceptable range', {
              entityType,
              localCount,
              backendCount,
              discrepancyRatio: discrepancy,
            });
          }
        } catch (entityCheckError) {
          logger.error('DataSync: Failed to check entity during integrity repair', {
            entityType,
            error: entityCheckError instanceof Error
              ? { name: entityCheckError.name, message: entityCheckError.message }
              : { name: 'Error', message: String(entityCheckError) },
          });
        }
      }
      if (entitiesToRepair.length > 0) {
        logger.info('DataSync: Resetting cursors for entities with discrepancies', {
          entities: entitiesToRepair,
        });
        for (const entityType of entitiesToRepair) {
          await this.cursorRepo.resetCursor(entityType);
          report.entitiesRepaired.push(entityType);
        }
        logger.info('DataSync: Triggering repair pull for entities via engine stack', {
          entities: entitiesToRepair,
        });
        if (!this.syncEngineStack) {
          throw new Error('Engine stack not initialized - cannot trigger repair pull');
        }
        const repairSyncOptions: SyncOptions = {
          source: 'REPAIR_INTEGRITY',
          force: true,
          skipPush: true,
          entityTypes: entitiesToRepair,
        };
        const repairReport = await this.syncEngineStack.coordinator.performFullSync(repairSyncOptions);
        if (!repairReport.success) {
          logger.warn('DataSync: Repair pull completed with errors', {
            error: repairReport.error
              ? { name: repairReport.error.name, message: repairReport.error.message }
              : undefined,
          });
        }
        report.pullTriggered = true;
        logger.info('DataSync: Data integrity repair completed', {
          repairedEntities: entitiesToRepair,
        });
      } else {
        logger.info('DataSync: Data integrity check passed - no repairs needed', {
          entityTypes,
        });
      }
      return report;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      report.error = err.message;
      logger.error('DataSync: Data integrity repair failed', {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
      });
      return report;
    }
  }
  async hasLocalChanges(): Promise<boolean> {
    try {
      const userId = this.getActiveUserId('hasLocalChanges');
      if (!userId) {
        return false;
      }
      const pendingCommands = await this.outboxRepo.getPendingCount(userId);
      const pendingTombstones = await this.tombstoneRepo.getPendingCount(userId);
      const hasChanges = pendingCommands > 0 || pendingTombstones > 0;
      logger.debug('DataSync: Local changes check', {
        pendingCommands,
        pendingTombstones,
        hasChanges,
      });
      return hasChanges;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DataSync: Failed to check local changes', {
        error: {
          name: err.name,
          message: err.message,
        },
      });
      return true;
    }
  }
  private requiresCatalogLease(entityTypes?: readonly EntityType[]): boolean {
    if (!entityTypes || entityTypes.length === 0) {
      return true;
    }
    return entityTypes.includes('products');
  }
  async performFullSync(options?: SyncOptions): Promise<void> {
    const schedulerEnabled = !!this.syncScheduler && isFeatureEnabled('syncScheduler') && !options?.yieldController;
    if (schedulerEnabled) {
      const source = options?.source ?? 'EXTERNAL';
      const priority: SyncTaskPriority =
        source === 'MANUAL_REFRESH' ? 'high' :
        source === 'AUTH_SIGNIN' || source === 'AUTH_GOOGLE' || source === 'AUTH_PHONE' ? 'high' :
        source === 'APP_FOREGROUND' ? 'normal' :
        source === 'PERIODIC_INTERVAL' ? 'low' :
        'normal';
      const taskId = `sync-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      return this.syncScheduler!.runTask(
        {
          id: taskId,
          name: 'data_sync_full',
          kind: 'data_sync',
          priority,
          deadlineMs: priority === 'high' ? 60_000 : 5 * 60_000,
          resources: { network: 1, sqlite: 1 },
          sliceBudgetMs: 8,
          tags: { source },
        },
        async (ctx) => {
          await this.performFullSync({
            ...options,
            yieldController: ctx.yieldController,
          });
        }
      );
    }
    const force = options?.force ?? false;
    const source = options?.source ?? 'UNKNOWN';
    const now = Date.now();
    if (this.apiClient.isTerminalFailure()) {
      logger.debug('DataSync: Skipping sync - terminal authentication failure active', {
        instanceId: this.instanceId,
        source
      });
      return;
    }
    if (!this.getActiveUserId('performFullSync')) {
      return;
    }
    if (DataSyncService.sharedActiveSyncPromise) {
      logger.debug('DataSync: Sync already in progress - waiting for completion', {
        instanceId: this.instanceId,
        source,
        force,
      });
      try {
        await DataSyncService.sharedActiveSyncPromise;
        logger.debug('DataSync: Waited for in-progress sync to complete', {
          instanceId: this.instanceId,
          source,
        });
      } catch (waitError: unknown) {
        logger.debug('DataSync: In-progress sync failed, waiter returning', {
          instanceId: this.instanceId,
          source,
        });
      }
      return;
    }
    if (DataSyncService.sharedSyncInProgress) {
      logger.warn('DataSync: Sync already in progress (static check), skipping', {
        instanceId: this.instanceId,
        source,
      });
      return;
    }
    const lastSourceTime = DataSyncService.sharedLastSyncSourceTime.get(source) ?? 0;
    const timeSinceSourceSync = now - lastSourceTime;
    let cooldownMs = DataSyncService.SOURCE_COOLDOWN_MS;
    if (source === 'DATASYNC_INITIALIZE') {
      cooldownMs = 30_000; 
    }
    if (source !== 'MANUAL_REFRESH' && timeSinceSourceSync < cooldownMs) {
      logger.debug('DataSync: Skipping sync - per-source cooldown active', {
        instanceId: this.instanceId,
        source,
        timeSinceSourceSyncMs: timeSinceSourceSync,
        cooldownMs,
        remainingMs: cooldownMs - timeSinceSourceSync,
      });
      return;
    }
    const timeSinceLastSync = now - DataSyncService.sharedLastSyncAttemptTime;
    if (!force && timeSinceLastSync < DataSyncService.MIN_SYNC_DEBOUNCE_MS) {
      logger.debug('DataSync: Skipping sync - debounce guard active', {
        instanceId: this.instanceId,
        source,
        timeSinceLastSyncMs: timeSinceLastSync,
        minDebounceMs: DataSyncService.MIN_SYNC_DEBOUNCE_MS,
        remainingMs: DataSyncService.MIN_SYNC_DEBOUNCE_MS - timeSinceLastSync,
      });
      return;
    }
    if (DataSyncService.sharedBackoffMs > 0 && now < DataSyncService.sharedLastRateLimitErrorTime + DataSyncService.sharedBackoffMs) {
      const remainingBackoffMs = DataSyncService.sharedLastRateLimitErrorTime + DataSyncService.sharedBackoffMs - now;
      const remainingBackoff = Math.ceil(remainingBackoffMs / 1000);
      if (source === 'MANUAL_REFRESH') {
        const sinceLastOverride = now - DataSyncService.sharedLastManualOverrideTime;
        if (sinceLastOverride >= DataSyncService.MANUAL_OVERRIDE_COOLDOWN_MS) {
          DataSyncService.sharedLastManualOverrideTime = now;
          logger.warn('DataSync: Manual sync overriding rate-limit backoff', {
            instanceId: this.instanceId,
            remainingBackoffSeconds: remainingBackoff,
            consecutiveRateLimitErrors: DataSyncService.sharedConsecutiveRateLimitErrors,
          });
        } else {
          const retryInSeconds = Math.ceil((DataSyncService.MANUAL_OVERRIDE_COOLDOWN_MS - sinceLastOverride) / 1000);
          this.updateSyncState({
            status: SyncStatus.ERROR,
            errorMessage: `Rate limit backoff active. Try again in ${retryInSeconds}s`,
          });
          logger.debug('DataSync: Manual sync blocked - backoff override cooldown active', {
            instanceId: this.instanceId,
            remainingBackoffSeconds: remainingBackoff,
            retryInSeconds,
          });
          return;
        }
      } else {
        logger.debug('DataSync: Skipping sync - in backoff period', {
          instanceId: this.instanceId,
          source,
          remainingBackoffSeconds: remainingBackoff,
          consecutiveRateLimitErrors: DataSyncService.sharedConsecutiveRateLimitErrors,
        });
        return;
      }
    }
    const timeSinceLastSyncAttempt = now - DataSyncService.sharedLastSyncAttemptTime;
    if (source !== 'MANUAL_REFRESH' && timeSinceLastSyncAttempt < DataSyncService.HARD_MIN_SYNC_INTERVAL_MS) {
      logger.debug('DataSync: Skipping sync - hard minimum interval active', {
        instanceId: this.instanceId,
        source,
        timeSinceLastSyncAttemptMs: timeSinceLastSyncAttempt,
        hardMinIntervalMs: DataSyncService.HARD_MIN_SYNC_INTERVAL_MS,
        remainingMs: DataSyncService.HARD_MIN_SYNC_INTERVAL_MS - timeSinceLastSyncAttempt,
      });
      return;
    }
    if (DataSyncService.sharedActiveSyncPromise || DataSyncService.sharedSyncInProgress) {
      logger.debug('DataSync: Sync was started by another call while checking guards', {
        instanceId: this.instanceId,
        source,
      });
      return;
    }
    DataSyncService.sharedSyncInProgress = true;
    DataSyncService.sharedLastSyncSourceTime.set(source, now);
    DataSyncService.sharedLastSyncAttemptTime = now;
    let resolveSyncPromise: () => void;
    let rejectSyncPromise: (error: Error) => void;
    DataSyncService.sharedActiveSyncPromise = new Promise<void>((resolve, reject) => {
      resolveSyncPromise = resolve;
      rejectSyncPromise = reject;
    });
    logger.debug('DataSync: Acquired sync lock', {
      instanceId: this.instanceId,
      source,
      force,
    });
    try {
      await this.apiClient.ensureTokensFresh();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('DataSync: Token refresh failed, releasing lock', {
        error: { name: err.name, message: err.message },
      });
      DataSyncService.sharedSyncInProgress = false;
      DataSyncService.sharedActiveSyncPromise = null;
      resolveSyncPromise!(); 
      return;
    }
    if (!this.apiClient.isAuthenticated()) {
      logger.debug('DataSync: Skipping sync - user not authenticated, releasing lock');
      DataSyncService.sharedSyncInProgress = false;
      DataSyncService.sharedActiveSyncPromise = null;
      resolveSyncPromise!();
      return;
    }
    let leaseId = options?.leaseId;
    let usedCatalogLease = false;
    if (
      !leaseId &&
      this.syncLeaseManager &&
      isFeatureEnabled('syncLease') &&
      this.requiresCatalogLease(options?.entityTypes)
    ) {
      try {
        leaseId = await this.syncLeaseManager.getLeaseId({
          kind: 'catalog_sync',
        });
        usedCatalogLease = true;
      } catch (error) {
        if (error instanceof SyncLeaseDeniedError) {
          this.handle429RateLimitError({
            retryAfterSeconds: Math.ceil((error.retryAfterMs ?? 60_000) / 1000),
          });
          DataSyncService.sharedSyncInProgress = false;
          DataSyncService.sharedActiveSyncPromise = null;
          resolveSyncPromise!();
          return;
        }
        throw error;
      }
    }
    if (this.syncEngineStack) {
      try {
        dataChangeEmitter.suppress(dbEvents.DATA_CHANGED);
        this.updateSyncState({ status: SyncStatus.SYNCING });
        logger.info('DataSync: Delegating to SyncCoordinator (engine stack)', {
          instanceId: this.instanceId,
          source,
          force,
        });
        const syncOptions: SyncOptions = {
          source: source as SyncOptions['source'],
          force,
          skipPush: options?.skipPush ?? false,
          skipPull: options?.skipPull ?? false,
          skipIntegrityCheck: options?.skipIntegrityCheck ?? false,
          bustCache: options?.bustCache,
          entityTypes: options?.entityTypes,
          timeoutMs: options?.timeoutMs,
          yieldController: options?.yieldController,
          leaseId,
        };
        const report = await this.syncEngineStack.coordinator.performFullSync(syncOptions);
        if (report.success) {
          if (DataSyncService.sharedConsecutiveRateLimitErrors > 0) {
            logger.info('DataSync: Sync successful - resetting backoff (engine stack)', {
              instanceId: this.instanceId,
              previousConsecutiveErrors: DataSyncService.sharedConsecutiveRateLimitErrors,
            });
          }
          DataSyncService.sharedConsecutiveRateLimitErrors = 0;
          DataSyncService.sharedBackoffMs = 0;
          const nowTimestamp = Date.now();
          await secureStorage.setItem(
            DataSyncService.LAST_SYNC_KEY,
            nowTimestamp.toString(),
            DataSensitivity.PRIVATE,
          );
          this.updateSyncState({
            status: SyncStatus.SUCCESS,
            lastSyncTime: nowTimestamp,
            errorMessage: undefined,
          });
          logger.info('DataSync: Engine stack sync completed successfully', {
            source,
            durationMs: report.durationMs,
            pushCommands: report.push?.commandsProcessed ?? 0,
            pullChanges: report.pull?.recordsReturned ?? 0,
            integrityPassed: report.integrityPassed,
          });
        } else {
          const errorMessage = report.error?.message
            ?? this.extractFallbackErrorMessage(report);
          if (report.error?.code === 'RATE_LIMITED') {
            this.handle429RateLimitError(report.error);
          } else {
            this.updateSyncState({
              status: SyncStatus.ERROR,
              errorMessage,
            });
            logger.error('DataSync: Engine stack sync failed', {
              source,
              error: { name: report.error?.name ?? 'SyncError', code: report.error?.code, message: errorMessage },
            });
          }
        }
        resolveSyncPromise!();
        return;
      } catch (engineError) {
        const err = engineError instanceof Error ? engineError : new Error(String(engineError));
        logger.error('DataSync: Engine stack sync threw exception', {
          instanceId: this.instanceId,
          source,
          error: { name: err.name, message: err.message },
        });
        this.updateSyncState({
          status: SyncStatus.ERROR,
          errorMessage: err.message,
        });
        rejectSyncPromise!(err);
        throw err;
      } finally {
        dataChangeEmitter.resume(dbEvents.DATA_CHANGED);
        DataSyncService.sharedSyncInProgress = false;
        DataSyncService.sharedActiveSyncPromise = null;
        if (usedCatalogLease && this.syncLeaseManager) {
          this.syncLeaseManager.invalidateLease('catalog_sync', 'sync_complete');
        }
      }
    }
    const errorMessage = 'DataSync: Engine stack not initialized - cannot perform sync. ' +
      'This indicates a critical initialization failure.';
    logger.error(errorMessage, {
      instanceId: this.instanceId,
      source,
      hasSyncEngineStack: !!this.syncEngineStack,
    });
    this.updateSyncState({
      status: SyncStatus.ERROR,
      errorMessage,
    });
    DataSyncService.sharedSyncInProgress = false;
    const error = new Error(errorMessage);
    rejectSyncPromise!(error);
    DataSyncService.sharedActiveSyncPromise = null;
    throw error;
  }
  private extractFallbackErrorMessage(report: SyncReport): string {
    const parts: string[] = [];
    if (report.push && !report.push.success && report.push.failed.length > 0) {
      const pushErrors = report.push.failed
        .map((f) => f.error)
        .filter(Boolean)
        .slice(0, 3); 
      parts.push(
        `Push: ${report.push.failed.length} failure(s)${pushErrors.length > 0 ? ` [${pushErrors.join(', ')}]` : ''}`
      );
    }
    if (report.pull && !report.pull.success) {
      parts.push('Pull failed');
    }
    if (report.integrityPassed === false) {
      parts.push('Integrity check failed');
    }
    return parts.length > 0 ? parts.join('; ') : 'Sync failed (no details available)';
  }
  private handle429RateLimitError(error: unknown): void {
    DataSyncService.sharedConsecutiveRateLimitErrors++;
    DataSyncService.sharedLastRateLimitErrorTime = Date.now();
    let backoffMs = DataSyncService.MIN_BACKOFF_MS;
    if (error && typeof error === 'object' && 'retryAfterSeconds' in error) {
      const retryAfter = (error as { retryAfterSeconds: number }).retryAfterSeconds;
      backoffMs = retryAfter * 1000;
    } else {
      backoffMs = Math.min(
        DataSyncService.MIN_BACKOFF_MS * Math.pow(DataSyncService.BACKOFF_MULTIPLIER, DataSyncService.sharedConsecutiveRateLimitErrors - 1),
        DataSyncService.MAX_BACKOFF_MS
      );
    }
    const jitter = backoffMs * DataSyncService.BACKOFF_JITTER_FACTOR * (Math.random() * 2 - 1);
    DataSyncService.sharedBackoffMs = Math.round(backoffMs + jitter);
    logger.warn('DataSync: Rate limit exceeded - applying exponential backoff', {
      instanceId: this.instanceId,
      consecutiveRateLimitErrors: DataSyncService.sharedConsecutiveRateLimitErrors,
      backoffMs: DataSyncService.sharedBackoffMs,
      backoffSeconds: Math.ceil(DataSyncService.sharedBackoffMs / 1000),
      nextSyncTime: new Date(DataSyncService.sharedLastRateLimitErrorTime + DataSyncService.sharedBackoffMs).toISOString(),
    });
    this.updateSyncState({
      status: SyncStatus.ERROR,
      errorMessage: `Rate limit exceeded. Next sync in ${Math.ceil(DataSyncService.sharedBackoffMs / 1000)}s`,
    });
  }
  private async detectConflict(localRecord: Record<string, unknown>, serverData: Record<string, unknown>): Promise<boolean> {
    const userId = this.getActiveUserId('detectConflict');
    if (!userId) {
      return false;
    }
    const isPending = await this.outboxRepo.isPending(localRecord.id as string, userId);
    if (!isPending) {
      return false;
    }
    const recordData = typeof localRecord.data === 'string' ? JSON.parse(localRecord.data) : localRecord.data || {};
    const localData = recordData as Record<string, unknown>;
    const localVersion = typeof localData.version === 'number' ? localData.version : 0;
    const serverVersion = typeof serverData.version === 'number' ? serverData.version : 0;
    if (localVersion !== 0 || serverVersion !== 0) {
      return localVersion !== serverVersion;
    }
    const localModified = new Date(localRecord.updated_at as string || localRecord.updatedAt as string || 0).getTime();
    const serverModified = new Date((serverData.updatedAt || serverData.updated_at) as string || 0).getTime();
    return localModified > serverModified;
  }
  private async handleConflict(
    entityType: EntityType,
    localData: Record<string, unknown>,
    serverData: Record<string, unknown>,
  ): Promise<void> {
    try {
      logger.info('DataSync: Conflict detected', {
        entityType,
        localId: localData.id,
        serverId: serverData.id,
      });
      const conflict: SyncConflict = {
        id: `${entityType}_${localData.id}_${Date.now()}`,
        entityType,
        localData,
        serverData,
        conflictFields: this.identifyConflictFields(localData, serverData),
        timestamp: Date.now(),
      };
      await this.storeConflict(conflict);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DataSync: Failed to handle conflict', {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
        entityType,
        localId: localData.id,
      });
    }
  }
  private async resolveConflicts(
    strategy: ConflictResolution = ConflictResolution.SERVER_WINS,
    ctx?: SyncBatchContext,
  ): Promise<void> {
    try {
      const conflicts = await this.getStoredConflicts();
      if (conflicts.length === 0) {
        return;
      }
      logger.info('DataSync: Resolving conflicts', {
        count: conflicts.length,
        strategy,
        batchId: ctx?.batchId,
      });
      for (const conflict of conflicts) {
        await this.resolveConflict(conflict, strategy, ctx);
      }
      await this.clearStoredConflicts();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DataSync: Failed to resolve conflicts', {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
        batchId: ctx?.batchId,
      });
    }
  }
  private async resolveConflict(
    conflict: SyncConflict,
    strategy: ConflictResolution,
    ctx?: SyncBatchContext,
  ): Promise<void> {
    const localId = typeof conflict.localData.id === 'string' || typeof conflict.localData.id === 'number' 
      ? String(conflict.localData.id) 
      : String(conflict.localData.id);
    const db = await this.db.getDatabase('DeviceEvents');
    const nowIso = new Date().toISOString();
    const entityType = conflict.entityType as EntityType;
    switch (strategy) {
      case ConflictResolution.SERVER_WINS:
        await this.applyDataToLocalEntity(db, conflict.entityType, localId, conflict.serverData, nowIso);
        {
          const userId = this.getActiveUserId('resolveConflict:SERVER_WINS');
          if (userId) {
            await this.outboxRepo.markSyncedByAggregateId(localId, userId);
          }
        }
        if (ctx && isEntityType(entityType)) {
          ctx.touch(entityType, localId);
        }
        break;
      case ConflictResolution.CLIENT_WINS:
        {
          const userId = this.getActiveUserId('resolveConflict');
          if (!userId) {
            logger.warn('DataSync: Cannot enqueue client-wins conflict - no user context', {
              conflictId: conflict.id,
              entityType: conflict.entityType,
            });
            break;
          }
          await this.outboxRepo.enqueue({
            userId,
            aggregateType: conflict.entityType, 
            aggregateId: localId,
            eventType: 'UPDATE',
            payload: conflict.localData,
          });
          if (ctx && isEntityType(entityType)) {
            ctx.touch(entityType, localId);
          }
        }
        break;
      case ConflictResolution.MERGE:
        const mergedData = this.mergeConflictData(conflict.localData, conflict.serverData, conflict.entityType);
        await this.applyDataToLocalEntity(db, conflict.entityType, localId, mergedData as Record<string, unknown>, nowIso);
        {
          const mergeUserId = this.getActiveUserId('resolveConflict:MERGE');
          if (mergeUserId) {
            await this.outboxRepo.markSyncedByAggregateId(localId, mergeUserId);
          }
        }
        if (ctx && isEntityType(entityType)) {
          ctx.touch(entityType, localId);
        }
        break;
      case ConflictResolution.MANUAL:
        logger.info('DataSync: Conflict marked for manual resolution', {
          conflictId: conflict.id,
        });
        break;
    }
  }
  private async applyDataToLocalEntity(
    db: SQLiteDatabase,
    entityType: string,
    localId: string,
    data: Record<string, unknown>,
    nowIso: string,
  ): Promise<void> {
    const config = ENTITY_COLUMN_MAPPINGS[entityType];
    if (!config) {
      logger.warn('DataSync: No column mapping for entity type in conflict resolution', {
        entityType,
        localId,
        dataKeys: Object.keys(data),
      });
      return;
    }
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (config.baseColumns.hasData) {
      setClauses.push('data = ?');
      params.push(JSON.stringify(data));
    }
    setClauses.push(`${config.baseColumns.updatedAtColumn} = ?`);
    params.push(nowIso);
    for (const col of config.requiredColumns) {
      const rawValue = data[col.backendField];
      if (rawValue !== undefined) {
        const transformedValue = col.transform
          ? col.transform(rawValue)
          : (rawValue as string | number | null);
        setClauses.push(`${col.sqliteColumn} = ?`);
        params.push(transformedValue);
      }
    }
    if (setClauses.length === 0) {
      logger.warn('DataSync: No columns to update in conflict resolution', {
        entityType,
        localId,
      });
      return;
    }
    params.push(localId);
    const sql = `UPDATE ${entityType} SET ${setClauses.join(', ')} WHERE id = ?`;
    try {
      await db.runAsync(sql, params);
      logger.debug('DataSync: Applied conflict resolution data to local entity', {
        entityType,
        localId,
        updatedColumns: setClauses.length,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DataSync: Failed to apply conflict resolution data', {
        entityType,
        localId,
        sql: sql.substring(0, 100) + '...',
        error: { name: err.name, message: err.message },
      });
      throw error;
    }
  }
  private identifyConflictFields(localData: Record<string, unknown>, serverData: Record<string, unknown>): string[] {
    const conflictFields: string[] = [];
    const fieldsToCheck = ['quantity', 'method', 'rating', 'notes', 'effects', 'mood'];
    for (const field of fieldsToCheck) {
      if (localData[field] !== serverData[field]) {
        conflictFields.push(field);
      }
    }
    return conflictFields;
  }
  private mergeConflictData(localData: unknown, serverData: unknown, entityType: EntityType): unknown {
    const handler = this.handlerRegistry.get(entityType);
    let merged: unknown;
    if (handler) {
      merged = handler.merge(localData, serverData);
      logger.debug(`DataSync: Conflict merged via entity-specific handler for ${entityType}`, {
        localId: (localData as { id?: string })?.id,
        serverId: (serverData as { id?: string })?.id,
        handlerClass: handler.constructor.name,
      });
    } else {
      merged = { ...localData as Record<string, unknown> };
      if (serverData && typeof serverData === 'object') {
        Object.keys(serverData).forEach((key) => {
          const mergedObj = merged as Record<string, unknown>;
          const serverObj = serverData as Record<string, unknown>;
          if (!mergedObj[key] && serverObj[key]) {
            mergedObj[key] = serverObj[key];
          }
        });
      }
      logger.warn(`DataSync: No specific merge handler for ${entityType}, falling back to generic merge.`, {
        entityType,
        registeredHandlers: this.handlerRegistry.getRegisteredEntityTypes(),
      });
    }
    const localVersion = typeof (localData as { version?: number })?.version === 'number'
      ? (localData as { version: number }).version
      : 0;
    const serverVersion = typeof (serverData as { version?: number })?.version === 'number'
      ? (serverData as { version: number }).version
      : 0;
    (merged as { version: number; updatedAt: string }).version = Math.max(localVersion, serverVersion) + 1;
    (merged as { updatedAt: string }).updatedAt = new Date().toISOString();
    return merged;
  }
  private async storeConflict(conflict: SyncConflict): Promise<void> {
    const conflicts = await this.getStoredConflicts();
    conflicts.push(conflict);
    await secureStorage.setItem(
      DataSyncService.SYNC_CONFLICTS_KEY,
      JSON.stringify(conflicts),
      DataSensitivity.PRIVATE,
    );
  }
  private async getStoredConflicts(): Promise<SyncConflict[]> {
    try {
      const conflictsJson = await secureStorage.getItem(
        DataSyncService.SYNC_CONFLICTS_KEY,
        DataSensitivity.PRIVATE,
      );
      return conflictsJson ? JSON.parse(conflictsJson) : [];
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DataSync: Failed to get stored conflicts', {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
      });
      return [];
    }
  }
  private async clearStoredConflicts(): Promise<void> {
    await secureStorage.removeValue(
      DataSyncService.SYNC_CONFLICTS_KEY,
      DataSensitivity.PRIVATE,
    );
  }
  private async cleanupStaleConflicts(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const conflicts = await this.getStoredConflicts();
      if (conflicts.length === 0) {
        return 0;
      }
      const now = Date.now();
      const cutoffTime = now - maxAgeMs;
      const freshConflicts = conflicts.filter((conflict) => {
        const conflictTimestamp = conflict.timestamp;
        return conflictTimestamp > cutoffTime;
      });
      const removedCount = conflicts.length - freshConflicts.length;
      if (removedCount > 0) {
        if (freshConflicts.length > 0) {
          await secureStorage.setItem(
            DataSyncService.SYNC_CONFLICTS_KEY,
            JSON.stringify(freshConflicts),
            DataSensitivity.PRIVATE,
          );
        } else {
          await this.clearStoredConflicts();
        }
        logger.info('DataSync: Cleaned up stale conflicts', {
          context: {
            removedCount,
            remainingCount: freshConflicts.length,
            maxAgeHours: maxAgeMs / (60 * 60 * 1000),
          },
        });
        this.updateSyncState({
          totalConflicts: freshConflicts.length,
        });
      }
      return removedCount;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DataSync: Failed to cleanup stale conflicts', {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
      });
      return 0;
    }
  }
  private async autoResolveConflictsAfterSync(): Promise<number> {
    try {
      const conflicts = await this.getStoredConflicts();
      if (conflicts.length === 0) {
        return 0;
      }
      logger.info('DataSync: Auto-resolving conflicts after successful sync', {
        count: conflicts.length,
      });
      await this.resolveConflicts(ConflictResolution.SERVER_WINS);
      return conflicts.length;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('DataSync: Auto-resolve conflicts failed (non-fatal)', {
        error: {
          name: err.name,
          message: err.message,
        },
      });
      return 0;
    }
  }
  private async loadSyncState(): Promise<void> {
    try {
      const lastSyncTimeStr = await secureStorage.getItem(
        DataSyncService.LAST_SYNC_KEY,
        DataSensitivity.PRIVATE,
      );
      await this.cleanupStaleConflicts();
      const userId = this.currentUserId;
      const pendingCommands = userId ? await this.outboxRepo.getPendingCount(userId) : 0;
      const pendingTombstones = userId ? await this.tombstoneRepo.getPendingCount(userId) : 0;
      const conflicts = await this.getStoredConflicts();
      this.syncState = {
        status: SyncStatus.IDLE,
        lastSyncTime: lastSyncTimeStr ? parseInt(lastSyncTimeStr) : undefined,
        pendingCommands,
        pendingTombstones,
        pendingUploads: pendingCommands + pendingTombstones,
        entitiesSyncing: [],
        totalConflicts: conflicts.length,
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DataSync: Failed to load sync state', {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
      });
    }
  }
  private updateSyncState(updates: Partial<SyncState>): void {
    const mergedState = { ...this.syncState, ...updates };
    if (mergedState.pendingCommands < 0) {
      logger.warn('DataSync: pendingCommands would be negative, flooring to 0', {
        attemptedValue: mergedState.pendingCommands,
        previousValue: this.syncState.pendingCommands,
        hint: 'This indicates stale in-memory state - consider using refreshPendingCounts()',
      });
      mergedState.pendingCommands = 0;
    }
    if (mergedState.pendingTombstones < 0) {
      logger.warn('DataSync: pendingTombstones would be negative, flooring to 0', {
        attemptedValue: mergedState.pendingTombstones,
        previousValue: this.syncState.pendingTombstones,
        hint: 'This indicates stale in-memory state - consider using refreshPendingCounts()',
      });
      mergedState.pendingTombstones = 0;
    }
    mergedState.pendingUploads = mergedState.pendingCommands + mergedState.pendingTombstones;
    this.syncState = mergedState;
    logger.debug('DataSync: Sync state updated', { syncState: this.syncState });
  }
  private async refreshPendingCounts(): Promise<{ pendingCommands: number; pendingTombstones: number }> {
    const userId = this.getActiveUserId('refreshPendingCounts');
    const pendingCommands = userId ? await this.outboxRepo.getPendingCount(userId) : 0;
    const pendingTombstones = userId ? await this.tombstoneRepo.getPendingCount(userId) : 0;
    this.updateSyncState({
      pendingCommands,
      pendingTombstones,
    });
    logger.debug('DataSync: Pending counts refreshed from database', {
      pendingCommands,
      pendingTombstones,
      pendingUploads: pendingCommands + pendingTombstones,
    });
    return { pendingCommands, pendingTombstones };
  }
  private initializeNetworkListener(): void {
    if (this.networkListener) {
      this.networkListener();
      this.networkListener = undefined;
    }
    let wasOffline = false;
    this.networkListener = NetInfo.addEventListener((state) => {
      const isCurrentlyOnline = state.isConnected === true;
      if (isCurrentlyOnline && wasOffline) {
        logger.info('DataSync: Network re-connected, triggering sync');
        this.performFullSync({ source: 'NETWORK_RECONNECT' }).catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn('DataSync: Network reconnect sync failed', {
            error: { name: err.name, message: err.message },
          });
        });
      }
      wasOffline = !isCurrentlyOnline;
    });
  }
  private initializeAppStateListener(): void {
    try {
      if (this.appStateSubscription) {
        this.appStateSubscription.remove();
        this.appStateSubscription = undefined;
        logger.debug('DataSync: Removed existing AppState listener before re-initialization');
      }
      this.appStateSubscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
        if (nextAppState === 'active') {
          logger.info('DataSync: App became active, switching to fast sync interval', {
            newInterval: DataSyncService.ACTIVE_SYNC_INTERVAL,
          });
          this.currentSyncIntervalMs = DataSyncService.ACTIVE_SYNC_INTERVAL;
          this.stopPeriodicSync();
          this.startPeriodicSync();
          this.performFullSync({ source: 'APP_FOREGROUND' }).catch((error: unknown) => {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error('DataSync: Foreground sync failed', {
              error: {
                name: err.name,
                message: err.message,
                stack: err.stack,
              },
            });
          });
        } else if (nextAppState === 'background' || nextAppState === 'inactive') {
          logger.info('DataSync: App went to background, switching to slow sync interval', {
            newInterval: DataSyncService.BACKGROUND_SYNC_INTERVAL,
          });
          this.currentSyncIntervalMs = DataSyncService.BACKGROUND_SYNC_INTERVAL;
          this.stopPeriodicSync();
          this.startPeriodicSync();
        }
      });
      logger.debug('DataSync: AppState listener initialized for backpressure');
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DataSync: Failed to initialize AppState listener (non-critical)', {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
        },
      });
    }
  }
  private startPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
    }
    this.syncInterval = setInterval(() => {
      if (!DataSyncService.sharedSyncInProgress) {
        this.performFullSync({ source: 'PERIODIC_INTERVAL' }).catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error('DataSync: Periodic sync failed', {
            error: {
              name: err.name,
              message: err.message,
              stack: err.stack,
            },
          });
        });
      }
    }, this.currentSyncIntervalMs);
    logger.info('DataSync: Periodic sync started', {
      intervalMs: this.currentSyncIntervalMs,
      appState: AppState.currentState,
    });
  }
  stopPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
      logger.info('DataSync: Periodic sync stopped');
    }
  }
  private orderCommandsByType(commands: OutboxCommand[]): OutboxCommand[] {
    const opOrder = { CREATE: 1, UPDATE: 2, DELETE: 3 };
    return [...commands].sort((a, b) => {
      const opDiff = opOrder[a.eventType] - opOrder[b.eventType];
      if (opDiff !== 0) return opDiff;
      if (a.eventType === 'CREATE') {
        const entityTypeA = tryCanonicalizeEntityType(a.aggregateType);
        const entityTypeB = tryCanonicalizeEntityType(b.aggregateType);
        const orderA = entityTypeA !== null ? getSyncOrder(entityTypeA) : 999;
        const orderB = entityTypeB !== null ? getSyncOrder(entityTypeB) : 999;
        return orderA - orderB;
      }
      return 0;
    });
  }
  private collectCreateIdsByEntity(commands: OutboxCommand[]): Map<string, Set<string>> {
    const createIdsByEntity = new Map<string, Set<string>>();
    for (const cmd of commands) {
      if (cmd.eventType !== 'CREATE') continue;
      const entityType = tryCanonicalizeEntityType(cmd.aggregateType)
        ?? cmd.aggregateType.toLowerCase();
      const set = createIdsByEntity.get(entityType) ?? new Set<string>();
      set.add(cmd.aggregateId);
      createIdsByEntity.set(entityType, set);
    }
    return createIdsByEntity;
  }
  private async resolveClientIdsInCommand(
    command: OutboxCommand,
    createIdsByEntityType?: Map<string, Set<string>>,
  ): Promise<OutboxCommand & { _resolvedServerId?: string }> {
    const resolvedPayload = { ...command.payload };
    const canonicalType = tryCanonicalizeEntityType(command.aggregateType);
    if (!canonicalType) {
      logger.warn('DataSync: Unknown entity type in outbox command - cannot resolve FK fields', {
        aggregateType: command.aggregateType,
        aggregateId: command.aggregateId.substring(0, 8) + '...',
        hint: 'Add entity type to ENTITY_TYPES in @shared/contracts',
      });
      const mainServerId = await this.idMapRepo.getServerId(command.aggregateId);
      return {
        ...command,
        aggregateId: mainServerId || command.aggregateId,
        payload: resolvedPayload,
        _resolvedServerId: mainServerId || undefined,
      };
    }
    const fkFields = getForeignKeyFields(canonicalType);
    const optionalFkFields = getOptionalForeignKeyFields(canonicalType);
    for (const field of fkFields) {
      if (resolvedPayload[field] && typeof resolvedPayload[field] === 'string') {
        const clientId = resolvedPayload[field] as string;
        const serverId = await this.idMapRepo.getServerId(clientId);
        if (serverId) {
          logger.debug('DataSync: Resolved FK field to server ID', {
            entityType: canonicalType,
            aggregateId: command.aggregateId.substring(0, 8) + '...',
            field,
            clientId: clientId.substring(0, 8) + '...',
            serverId: serverId.substring(0, 8) + '...',
          });
          resolvedPayload[field] = serverId;
        } else if (optionalFkFields.has(field)) {
          const referencedType = getTargetEntityForFkField(canonicalType, field);
          const pendingCreates = referencedType
            ? createIdsByEntityType?.get(referencedType)
            : undefined;
          const pendingCount = pendingCreates?.size ?? 0;
          const isInPending = pendingCreates?.has(clientId) ?? false;
          if (isInPending) {
            logger.debug('DataSync: FK field found in pending creates - keeping client ID', {
              entityType: canonicalType,
              aggregateId: command.aggregateId.substring(0, 8) + '...',
              field,
              clientId: clientId.substring(0, 8) + '...',
              referencedType,
              pendingCount,
            });
            continue;
          }
          const isStableId = field === 'deviceId' || field === 'sessionId';
          const looksLikeValidId = clientId && clientId.length >= 17;
          if (isStableId && looksLikeValidId) {
            logger.debug('DataSync: Preserving stable FK field despite no local mapping', {
              entityType: canonicalType,
              aggregateId: command.aggregateId.substring(0, 8) + '...',
              field,
              clientId: clientId.substring(0, 8) + '...',
              reason: 'Field is stable ID (device/session) with valid-looking value',
              clientIdLength: clientId.length,
            });
            continue;
          }
          logger.warn('DataSync: Removing unresolved nullable FK field', {
            entityType: canonicalType,
            aggregateId: command.aggregateId.substring(0, 8) + '...',
            field,
            clientId: clientId.substring(0, 8) + '...',
            clientIdLength: clientId.length,
            reason: 'Referenced entity not yet synced to backend',
            isStableId,
            looksLikeValidId,
            referencedType,
            pendingCount,
          });
          delete resolvedPayload[field];
        } else {
          logger.debug('DataSync: Keeping unresolved non-nullable FK field (will cause sync failure)', {
            entityType: canonicalType,
            aggregateId: command.aggregateId.substring(0, 8) + '...',
            field,
            clientId: clientId.substring(0, 8) + '...',
            reason: 'Non-nullable FK with no server ID - sync will fail correctly',
          });
        }
      }
    }
    const mainServerId = await this.idMapRepo.getServerId(command.aggregateId);
    return {
      ...command,
      aggregateId: mainServerId || command.aggregateId, 
      payload: resolvedPayload,
      _resolvedServerId: mainServerId || undefined, 
    };
  }
  private extractMissingReference(
    details?: Record<string, unknown>,
  ): { field?: string; value?: string; entityType?: string } | null {
    if (!details || typeof details !== 'object') return null;
    const missing = (details as Record<string, unknown>).missingReference;
    if (!missing || typeof missing !== 'object' || Array.isArray(missing)) return null;
    const missingRecord = missing as Record<string, unknown>;
    return {
      field: typeof missingRecord.field === 'string' ? missingRecord.field : undefined,
      value: typeof missingRecord.value === 'string' ? missingRecord.value : undefined,
      entityType: typeof missingRecord.entityType === 'string' ? missingRecord.entityType : undefined,
    };
  }
  private async handleMissingReferenceFailure(
    failed: PushCommandsResponse['failed'][number],
  ): Promise<void> {
    const missing = this.extractMissingReference(failed.details);
    if (!missing?.field || !missing.value) {
      return;
    }
    if (missing.field === 'deviceId') {
      await this.ensureDeviceResync(missing.value);
    }
  }
  private extractOrphanUpdate(
    details?: Record<string, unknown>,
  ): { entityType?: string; entityId?: string; clientId?: string; hint?: string } | null {
    if (!details || typeof details !== 'object') return null;
    const orphan = (details as Record<string, unknown>).orphanUpdate;
    if (!orphan || typeof orphan !== 'object' || Array.isArray(orphan)) return null;
    const orphanRecord = orphan as Record<string, unknown>;
    return {
      entityType: typeof orphanRecord.entityType === 'string' ? orphanRecord.entityType : undefined,
      entityId: typeof orphanRecord.entityId === 'string' ? orphanRecord.entityId : undefined,
      clientId: typeof orphanRecord.clientId === 'string' ? orphanRecord.clientId : undefined,
      hint: typeof orphanRecord.hint === 'string' ? orphanRecord.hint : undefined,
    };
  }
  private async handleOrphanUpdateFailure(
    failed: PushCommandsResponse['failed'][number],
  ): Promise<void> {
    const orphan = this.extractOrphanUpdate(failed.details);
    if (!orphan?.entityType || !orphan.entityId) {
      return;
    }
    logger.warn('[DataSyncService] Orphan UPDATE detected - entity not found on server', {
      entityType: orphan.entityType,
      entityId: orphan.entityId,
      clientId: orphan.clientId,
      hint: orphan.hint,
    });
    if (orphan.entityType === 'devices') {
      await this.ensureDeviceResync(orphan.entityId);
      return;
    }
    logger.warn('[DataSyncService] Orphan UPDATE recovery not implemented for entity type', {
      entityType: orphan.entityType,
      entityId: orphan.entityId,
      recommendation: 'Consider implementing entity-specific resync recovery',
    });
  }
  private async ensureDeviceResync(deviceId: string): Promise<void> {
    try {
      await this.db.ensureInitialized();
      const deviceRepo = new LocalDeviceRepository({ drizzleDb: this.db.getDrizzle() });
      const device = await deviceRepo.getById(deviceId);
      if (!device) {
        logger.warn('[DataSyncService] Missing device for resync recovery', { deviceId });
        return;
      }
      await deviceRepo.markForResync(deviceId, 'Missing device reference on backend');
      const hasPendingCreate = await this.outboxRepo.hasPendingCreateForAggregate(deviceId, device.userId);
      if (!hasPendingCreate) {
        const payload = buildDeviceCreatePayload(device);
        await this.outboxRepo.enqueue({
          userId: device.userId,
          aggregateType: 'Device',
          aggregateId: deviceId,
          eventType: 'CREATE',
          payload,
        });
      }
      try {
        await this.idMapRepo.deleteMapping(deviceId);
      } catch (error) {
        logger.warn('[DataSyncService] Failed to clear stale device ID mapping', {
          deviceId,
          error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
        });
      }
    } catch (error) {
      logger.error('[DataSyncService] Device resync recovery failed', {
        deviceId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      });
    }
  }
  private async getBlockedSessionIdsForPendingConsumptions(
    userId: string
  ): Promise<{ sessionIds: Set<string>; deadLetterCount: number }> {
    const sessionIds = new Set<string>();
    if (!userId) {
      return { sessionIds, deadLetterCount: 0 };
    }
    const pendingCommands = await this.outboxRepo.getUncompletedCommandsByAggregateType(
      'Consumption',
      userId
    );
    if (pendingCommands.length === 0) {
      return { sessionIds, deadLetterCount: 0 };
    }
    let deadLetterCount = 0;
    const lookupIds: string[] = [];
    for (const command of pendingCommands) {
      if (command.status === 'DEAD_LETTER') {
        deadLetterCount++;
        continue;
      }
      const idsFromPayload = this.extractSessionIdsFromConsumptionPayload(command.payload);
      if (idsFromPayload.length > 0) {
        for (const sessionId of idsFromPayload) {
          sessionIds.add(sessionId);
        }
        continue;
      }
      if (command.aggregateId) {
        lookupIds.push(command.aggregateId);
      }
    }
    if (lookupIds.length > 0) {
      const database = await this.db.getDatabase('DeviceEvents');
      const chunkSize = 250;
      for (let i = 0; i < lookupIds.length; i += chunkSize) {
        const chunk = lookupIds.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(', ');
        const params = [...chunk, ...chunk, ...chunk];
        const rows = await database.getAllAsync<{ session_id: string | null }>(
          `SELECT session_id FROM consumptions
           WHERE id IN (${placeholders})
              OR server_id IN (${placeholders})
              OR client_consumption_id IN (${placeholders})`,
          params
        );
        for (const row of rows) {
          if (row.session_id) {
            sessionIds.add(row.session_id);
          }
        }
      }
    }
    return { sessionIds, deadLetterCount };
  }
  private extractSessionIdsFromConsumptionPayload(payload: Record<string, unknown>): string[] {
    if (!payload || typeof payload !== 'object') {
      return [];
    }
    const sessionIds: string[] = [];
    const candidates = [
      payload['sessionId'],
      payload['_sessionId'],
      payload['_previousSessionId'],
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        sessionIds.push(candidate);
      }
    }
    return Array.from(new Set(sessionIds));
  }
  private sanitizeOutboxPayload(payload: Record<string, unknown>): {
    payload: Record<string, unknown>;
    nonFiniteNumberPaths: string[];
  } {
    const nonFiniteNumberPaths: string[] = [];
    const sanitize = (value: unknown, path: string[]): unknown => {
      if (value === undefined) {
        return undefined;
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          nonFiniteNumberPaths.push(path.join('.'));
          return value;
        }
        return value;
      }
      if (Array.isArray(value)) {
        const sanitizedItems = value
          .map((item, index) => sanitize(item, [...path, String(index)]))
          .filter((item) => item !== undefined);
        return sanitizedItems;
      }
      if (typeof value === 'object' && value !== null) {
        const sanitized: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          if (key.startsWith('_')) {
            continue;
          }
          const sanitizedValue = sanitize(val, [...path, key]);
          if (sanitizedValue !== undefined) {
            sanitized[key] = sanitizedValue;
          }
        }
        return sanitized;
      }
      return value;
    };
    const sanitizedPayload = sanitize(payload, []) as Record<string, unknown>;
    return { payload: sanitizedPayload, nonFiniteNumberPaths };
  }
  private validateOutboxPayload(
    entityType: EntityType,
    changeType: OutboxCommand['eventType'],
    payload: Record<string, unknown>
  ): { payload: Record<string, unknown>; errors: string[] } {
    if (changeType === 'DELETE') {
      return { payload: {}, errors: [] };
    }
    const { payload: sanitizedPayload, nonFiniteNumberPaths } = this.sanitizeOutboxPayload(payload);
    const convertedPayload = this.convertSQLiteDatetimesToISO(sanitizedPayload);
    const errors: string[] = [];
    if (nonFiniteNumberPaths.length > 0) {
      errors.push(`Non-finite numbers detected at: ${nonFiniteNumberPaths.join(', ')}`);
    }
    const validator = OUTBOX_PAYLOAD_VALIDATORS[entityType];
    const schema = changeType === 'CREATE'
      ? validator?.create
      : changeType === 'UPDATE'
        ? validator?.update
        : undefined;
    if (!schema) {
      return { payload: convertedPayload, errors };
    }
    const result = schema.safeParse(convertedPayload);
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors;
      for (const [field, messages] of Object.entries(fieldErrors)) {
        if (messages && messages.length > 0) {
          errors.push(`${field}: ${messages.join(', ')}`);
        }
      }
      if (errors.length === 0) {
        errors.push('Payload failed schema validation');
      }
      return { payload: convertedPayload, errors };
    }
    return { payload: result.data as Record<string, unknown>, errors };
  }
  private normalizeChangeTimestamp(value: string | null | undefined): string {
    const normalized = this.safeToISOTimestamp(value);
    const serverNow = this.apiClient.getServerTime();
    const normalizedMs = new Date(normalized).getTime();
    const skewMs = Math.abs(normalizedMs - serverNow.getTime());
    if (skewMs > DataSyncService.MAX_ALLOWED_CLOCK_SKEW_MS) {
      logger.warn('DataSync: Clock skew detected for change timestamp, using server time', {
        normalizedTimestamp: normalized,
        serverTimestamp: serverNow.toISOString(),
        skewMs,
      });
      return serverNow.toISOString();
    }
    return normalized;
  }
  private safeToISOTimestamp(value: string | null | undefined): string {
    if (!value) {
      return new Date().toISOString();
    }
    const iso8601WithTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
    const iso8601WithoutTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
    const sqliteDatetime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;
    try {
      if (iso8601WithTimezone.test(value)) {
        const parsed = new Date(value);
        if (isNaN(parsed.getTime())) {
          throw new Error(`Invalid date: ${value}`);
        }
        return parsed.toISOString();
      }
      if (iso8601WithoutTimezone.test(value)) {
        const parsed = new Date(value + 'Z');
        if (isNaN(parsed.getTime())) {
          throw new Error(`Invalid date: ${value}`);
        }
        return parsed.toISOString();
      }
      if (sqliteDatetime.test(value)) {
        const converted = value.replace(' ', 'T') + 'Z';
        const parsed = new Date(converted);
        if (isNaN(parsed.getTime())) {
          throw new Error(`Invalid date after conversion: ${converted}`);
        }
        return parsed.toISOString();
      }
      const parsed = new Date(value);
      if (isNaN(parsed.getTime())) {
        throw new Error(`Unrecognized date format: ${value}`);
      }
      return parsed.toISOString();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('DataSync: Failed to convert timestamp to ISO 8601, using current time', {
        originalValue: value,
        error: {
          name: err.name,
          message: err.message,
        },
      });
      return new Date().toISOString();
    }
  }
  private convertSQLiteDatetimesToISO(obj: Record<string, unknown>): Record<string, unknown> {
    const sqliteDatetimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    const convert = (value: unknown): unknown => {
      if (value === null || value === undefined) {
        return value;
      }
      if (typeof value === 'string') {
        if (sqliteDatetimeRegex.test(value)) {
          try {
            const isoString = new Date(value.replace(' ', 'T') + 'Z').toISOString();
            return isoString;
          } catch (error: unknown) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn('DataSync: Failed to convert SQLite datetime to ISO 8601', {
              value,
              error: {
                name: err.name,
                message: err.message,
              },
            });
            return value;
          }
        }
        return value;
      }
      if (Array.isArray(value)) {
        return value.map((item) => convert(item));
      }
      if (typeof value === 'object' && value !== null) {
        const converted: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          converted[key] = convert(val);
        }
        return converted;
      }
      return value;
    };
    return convert(obj) as Record<string, unknown>;
  }
  cleanup(): void {
    this.stopPeriodicSync();
    if (this.networkListener) {
      this.networkListener();
      this.networkListener = undefined;
    }
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = undefined;
      logger.debug('DataSync: AppState listener removed');
    }
    if (this.dataChangeHandler) {
      dataChangeEmitter.off(dbEvents.DATA_CHANGED, this.dataChangeHandler);
      this.dataChangeHandler = undefined;
      logger.debug('DataSync: Data change event listener removed');
    }
    if (this.debouncedSyncTrigger) {
      this.debouncedSyncTrigger.cancel();
      logger.debug('DataSync: Debounced sync trigger cancelled');
    }
    this.isInitialized = false;
    logger.debug('DataSync: Cleanup completed, service can be re-initialized');
  }
  public async resetForUserChange(reason: string): Promise<void> {
    logger.warn('DataSync: Resetting sync state for user change', {
      instanceId: this.instanceId,
      reason,
    });
    this.currentUserId = null;
    this.cleanup();
    DataSyncService.resetSharedState();
    await secureStorage.removeValue(DataSyncService.LAST_SYNC_KEY, DataSensitivity.PRIVATE);
    await this.clearStoredConflicts();
    const results = await Promise.allSettled([
      this.outboxRepo.clearAll(),
      this.tombstoneRepo.clearAll(),
      this.cursorRepo.resetAllCursors(),
      this.idMapRepo.clearAllMappings(),
    ]);
    const failures = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === 'rejected');
    if (failures.length > 0) {
      logger.error('DataSync: Failed to fully reset sync state', {
        instanceId: this.instanceId,
        reason,
        failures: failures.map(({ index, result }) => ({
          index,
          error: (result as PromiseRejectedResult).reason instanceof Error
            ? (result as PromiseRejectedResult).reason.message
            : String((result as PromiseRejectedResult).reason),
        })),
      });
      throw new Error('Failed to reset sync state for user change');
    }
    await this.loadSyncState();
  }
  private static resetSharedState(): void {
    DataSyncService.sharedInitializationPromise = null;
    DataSyncService.sharedInitializationInProgress = false;
    DataSyncService.sharedActiveSyncPromise = null;
    DataSyncService.sharedSyncInProgress = false;
    DataSyncService.sharedLastSyncSourceTime.clear();
    DataSyncService.sharedLastSyncAttemptTime = 0;
    DataSyncService.sharedLastCacheBustTime = 0;
    DataSyncService.sharedBackoffMs = 0;
    DataSyncService.sharedConsecutiveRateLimitErrors = 0;
    DataSyncService.sharedLastRateLimitErrorTime = 0;
    DataSyncService.sharedLastManualOverrideTime = 0;
  }
}
export const getDataSyncService = (
  db?: DatabaseManager,
  apiClient?: BackendAPIClient,
  outboxRepo?: OutboxRepository,
  cursorRepo?: CursorRepository,
  idMapRepo?: IdMapRepository,
  tombstoneRepo?: TombstoneRepository,
  handlerRegistry?: FrontendSyncHandlerRegistry,
): DataSyncService => {
  return DataSyncService.getInstance(db, apiClient, outboxRepo, cursorRepo, idMapRepo, tombstoneRepo, handlerRegistry);
};
