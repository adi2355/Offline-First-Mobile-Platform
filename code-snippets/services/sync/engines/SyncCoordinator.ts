import NetInfo from '@react-native-community/netinfo';
import type { EntityType } from '@shared/contracts';
import type { IPushEngine, IPullEngine, ISyncCoordinator, ISyncCoordinatorRepositories, SyncCoordinatorState } from './interfaces';
import type { SyncRunContext, SyncReport, SyncOptions, PushReport, PullReport } from './types';
import {
  createSyncRunContext,
  createFailedSyncReport,
  SyncEngineError,
  SYNC_ERROR_CODES,
  DEFAULT_SYNC_OPTIONS,
} from './types';
import { SyncCoordinationState, getSyncCoordinationState, type SyncSource } from './SyncCoordinationState';
import { createSyncBatchContext, type SyncBatchContext } from '../SyncBatchContext';
import { IntegrityGate, type IntegrityReport, type IntegrityCheckOptions } from '../IntegrityGate';
import { logger } from '../../../utils/logger';
import { DeviceIdManager } from '../../../utils/DeviceIdManager';
export interface SyncCoordinatorDependencies {
  readonly pushEngine: IPushEngine;
  readonly pullEngine: IPullEngine;
  readonly repositories: ISyncCoordinatorRepositories;
  readonly integrityGate: IntegrityGate;
  readonly getCurrentUserId: () => string | null;
}
export class SyncCoordinator implements ISyncCoordinator {
  private readonly pushEngine: IPushEngine;
  private readonly pullEngine: IPullEngine;
  private readonly repos: ISyncCoordinatorRepositories;
  private readonly integrityGate: IntegrityGate;
  private readonly getCurrentUserId: () => string | null;
  private get coordinationState(): SyncCoordinationState {
    return getSyncCoordinationState();
  }
  private userId: string | null = null;
  private lastSyncTime: number | null = null;
  private errorMessage: string | null = null;
  private periodicSyncTimer: ReturnType<typeof setInterval> | null = null;
  private isInForeground = true;
  private static readonly FOREGROUND_SYNC_INTERVAL_MS = 30_000; 
  private static readonly BACKGROUND_SYNC_INTERVAL_MS = 60_000; 
  private static readonly SMART_SYNC_THRESHOLD_MS = 10_000; 
  constructor(deps: SyncCoordinatorDependencies) {
    this.pushEngine = deps.pushEngine;
    this.pullEngine = deps.pullEngine;
    this.repos = deps.repositories;
    this.integrityGate = deps.integrityGate;
    this.getCurrentUserId = deps.getCurrentUserId;
  }
  async initialize(userId: string): Promise<void> {
    this.userId = userId;
    logger.info('[SyncCoordinator] Initialized', { userId: userId.substring(0, 8) + '...' });
  }
  async performFullSync(options?: SyncOptions): Promise<SyncReport> {
    const mergedOptions = { ...DEFAULT_SYNC_OPTIONS, ...options };
    const source = mergedOptions.source ?? 'EXTERNAL';
    const force = mergedOptions.force ?? false;
    const userId = this.userId ?? this.getCurrentUserId();
    if (!userId) {
      return this.createErrorReport('NO_USER', 'No authenticated user', source);
    }
    const deviceId = await DeviceIdManager.getDeviceId();
    if (!deviceId) {
      return this.createErrorReport('NO_DEVICE', 'Device ID not initialized', source);
    }
    if (this.coordinationState.isInBackoff()) {
      logger.debug('[SyncCoordinator] Skipping sync - in backoff');
      return this.createErrorReport('BACKOFF', 'Rate limit backoff active', source);
    }
    if (!force && this.coordinationState.isSourceInCooldown(source)) {
      logger.debug('[SyncCoordinator] Skipping sync - source in cooldown', { source });
      return this.createErrorReport('COOLDOWN', 'Source in cooldown', source);
    }
    if (this.coordinationState.syncInProgress) {
      logger.debug('[SyncCoordinator] Skipping sync - already in progress');
      return this.createErrorReport('LOCK_FAILED', 'Sync already in progress', source);
    }
    const startTime = Date.now();
    const batchContext = createSyncBatchContext();
    const ctx = createSyncRunContext(
      batchContext,
      userId,
      deviceId,
      source,
      force,
      mergedOptions.yieldController,
      mergedOptions.leaseId,
    );
    let resolveSyncLock!: () => void;
    let rejectSyncLock!: (error: Error) => void;
    const syncLockPromise = new Promise<void>((resolve, reject) => {
      resolveSyncLock = resolve;
      rejectSyncLock = reject;
    });
    if (!this.coordinationState.acquireSyncLock(syncLockPromise)) {
      logger.debug('[SyncCoordinator] Skipping sync - lock not acquired');
      return this.createErrorReport('LOCK_FAILED', 'Could not acquire sync lock', source);
    }
    try {
      logger.info('[SyncCoordinator] Starting full sync', {
        correlationId: ctx.correlationId,
        source,
        force,
      });
      const networkState = await NetInfo.fetch();
      if (!networkState.isConnected) {
        resolveSyncLock();
        return this.createErrorReport('OFFLINE', 'No network connection', source);
      }
      const hasLocalChanges = await this.hasLocalChanges(userId);
      let pushReport: PushReport | null = null;
      if (!mergedOptions.skipPush && hasLocalChanges) {
        logger.debug('[SyncCoordinator] Executing PUSH phase');
        pushReport = await this.pushEngine.push(ctx);
      } else {
        logger.debug('[SyncCoordinator] Skipping PUSH phase', {
          skipPush: mergedOptions.skipPush,
          hasLocalChanges,
        });
      }
      let pullReport: PullReport | null = null;
      if (!mergedOptions.skipPull) {
        const timeSinceLastSync = this.lastSyncTime
          ? Date.now() - this.lastSyncTime
          : Infinity;
        const shouldSkipPull = !force && !hasLocalChanges &&
          timeSinceLastSync < SyncCoordinator.SMART_SYNC_THRESHOLD_MS;
        if (shouldSkipPull) {
          logger.debug('[SyncCoordinator] Smart sync - skipping PULL');
        } else {
          if (mergedOptions.entityTypes && mergedOptions.entityTypes.length > 0) {
            logger.debug('[SyncCoordinator] Executing PULL phase (filtered)', {
              entityTypes: mergedOptions.entityTypes,
            });
            pullReport = await this.pullEngine.pullForEntityTypes(mergedOptions.entityTypes, ctx);
          } else {
            logger.debug('[SyncCoordinator] Executing PULL phase');
            pullReport = await this.pullEngine.pull(ctx);
          }
        }
      }
      let integrityPassed = true;
      if (!mergedOptions.skipIntegrityCheck && batchContext.hasTouchedEntities()) {
        logger.debug('[SyncCoordinator] Running IntegrityGate');
        const integrityReport = await this.runIntegrityCheck(batchContext);
        integrityPassed = integrityReport.status === 'ok' || integrityReport.status === 'violations';
      }
      const pushSuccess = pushReport?.success ?? true;
      const pullSuccess = pullReport?.success ?? true;
      const overallSuccess = pushSuccess && pullSuccess && integrityPassed;
      if (integrityPassed) {
        await this.commitDeferredCursors(batchContext);
      } else {
        logger.warn('[SyncCoordinator] Integrity check failed - NOT committing cursors');
      }
      let reportError: SyncEngineError | null = null;
      if (overallSuccess) {
        this.lastSyncTime = Date.now();
        this.errorMessage = null;
        this.coordinationState.clearBackoff();
      } else {
        const failureReasons: string[] = [];
        if (pushReport && !pushReport.success) {
          const pushErrors = pushReport.failed.map((f) => f.error).join(', ');
          failureReasons.push(
            `push: ${pushReport.failed.length} failure(s)${pushErrors ? ` [${pushErrors}]` : ''}`
          );
        }
        if (pullReport && !pullReport.success) {
          failureReasons.push('pull failed');
        }
        if (!integrityPassed) {
          failureReasons.push('integrity check failed');
        }
        this.errorMessage = failureReasons.join('; ');
        reportError = new SyncEngineError(
          'COORDINATOR',
          SYNC_ERROR_CODES.UNEXPECTED_ERROR,
          this.errorMessage,
          false,
        );
      }
      const report: SyncReport = {
        syncId: ctx.correlationId,
        userId,
        deviceId,
        source,
        success: overallSuccess,
        durationMs: Date.now() - startTime,
        push: pushReport,
        pull: pullReport,
        apply: null, 
        integrityPassed,
        error: reportError,
        completedAt: new Date(),
      };
      logger.info('[SyncCoordinator] Sync completed', {
        correlationId: ctx.correlationId,
        durationMs: report.durationMs,
        success: overallSuccess,
        pushCommands: pushReport?.commandsProcessed ?? 0,
        pushSuccess,
        pullChanges: pullReport?.recordsReturned ?? 0,
        pullSuccess,
        integrityPassed,
      });
      resolveSyncLock();
      return report;
    } catch (error) {
      const syncError = SyncEngineError.fromUnknown('COORDINATOR', error, {
        correlationId: ctx.correlationId,
      });
      logger.error('[SyncCoordinator] Sync failed', {
        correlationId: ctx.correlationId,
        error: { name: syncError.name, message: syncError.message },
      });
      if (syncError.code === SYNC_ERROR_CODES.RATE_LIMITED) {
        this.coordinationState.recordRateLimitError();
      }
      rejectSyncLock(syncError);
      return createFailedSyncReport(
        ctx.correlationId,
        userId,
        deviceId,
        source,
        syncError,
        Date.now() - startTime
      );
    }
  }
  getSyncState(): SyncCoordinatorState {
    return {
      status: this.isSyncing() ? 'syncing' : (this.errorMessage ? 'error' : 'idle'),
      lastSyncTime: this.lastSyncTime,
      pendingUploads: 0, 
      isSyncing: this.isSyncing(),
      errorMessage: this.errorMessage,
    };
  }
  isSyncing(): boolean {
    return this.coordinationState.syncInProgress;
  }
  cleanup(): void {
    this.stopPeriodicSync();
    logger.debug('[SyncCoordinator] Cleaned up');
  }
  async resetForUserChange(reason: string): Promise<void> {
    this.stopPeriodicSync();
    this.userId = null;
    this.lastSyncTime = null;
    this.errorMessage = null;
    this.coordinationState.forceReleaseSyncLock();
    this.coordinationState.clearBackoff();
    SyncCoordinationState.reset();
    logger.info('[SyncCoordinator] Reset for user change', { reason });
  }
  onNetworkReconnect(): void {
    logger.debug('[SyncCoordinator] Network reconnected - triggering sync');
    void this.performFullSync({ source: 'NETWORK_RECONNECT', force: false });
  }
  onAppForeground(): void {
    this.isInForeground = true;
    this.startPeriodicSync(SyncCoordinator.FOREGROUND_SYNC_INTERVAL_MS);
    void this.performFullSync({ source: 'APP_FOREGROUND', force: false });
  }
  onAppBackground(): void {
    this.isInForeground = false;
    this.startPeriodicSync(SyncCoordinator.BACKGROUND_SYNC_INTERVAL_MS);
  }
  startPeriodicSync(intervalMs?: number): void {
    const interval = intervalMs ?? (
      this.isInForeground
        ? SyncCoordinator.FOREGROUND_SYNC_INTERVAL_MS
        : SyncCoordinator.BACKGROUND_SYNC_INTERVAL_MS
    );
    this.stopPeriodicSync();
    this.periodicSyncTimer = setInterval(() => {
      void this.performFullSync({ source: 'PERIODIC_INTERVAL', force: false });
    }, interval);
    logger.debug('[SyncCoordinator] Started periodic sync', { intervalMs: interval });
  }
  stopPeriodicSync(): void {
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
      logger.debug('[SyncCoordinator] Stopped periodic sync');
    }
  }
  private async hasLocalChanges(userId: string): Promise<boolean> {
    const [outboxCount, tombstoneCount] = await Promise.all([
      this.repos.outbox.countActionable(userId),
      this.repos.tombstone.countActionable(userId),
    ]);
    return outboxCount > 0 || tombstoneCount > 0;
  }
  private async runIntegrityCheck(ctx: SyncBatchContext): Promise<IntegrityReport> {
    try {
      const integrityOptions: IntegrityCheckOptions = {
        touchedIds: ctx.getTouchedIds(),
        touchedTargetIds: ctx.getTouchedTargetIds(),
        entityTypesWithDeletes: ctx.getEntityTypesWithDeletes(),
        syncBatchId: ctx.batchId,
      };
      const report = await this.integrityGate.checkIntegrity(integrityOptions);
      return report;
    } catch (error) {
      logger.error('[SyncCoordinator] Integrity check error', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return {
        status: 'failed',
        relationResults: [],
        violations: [],
        violationCount: 0,
        timestamp: new Date().toISOString(),
        entitiesChecked: [],
        relationsPlanned: 0,
        relationsExecuted: 0,
        relationsSkipped: 0,
        relationsSucceeded: 0,
        relationsFailed: 1,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
        syncBatchId: ctx.batchId,
      };
    }
  }
  private async commitDeferredCursors(ctx: SyncBatchContext): Promise<void> {
    const deferredCursors = ctx.getDeferredCursorUpdates();
    if (deferredCursors.length === 0) {
      logger.debug('[SyncCoordinator] No deferred cursors to commit');
      return;
    }
    logger.debug('[SyncCoordinator] Committing deferred cursors', {
      count: deferredCursors.length,
    });
    const updates = deferredCursors.map((cursorUpdate) => ({
      entityType: cursorUpdate.entityType,
      cursor: cursorUpdate.cursor,
      stats: {
        recordsSynced: cursorUpdate.recordsSynced,
        hasMore: cursorUpdate.hasMore,
      },
    }));
    await this.repos.cursor.setMultipleCursors(updates);
  }
  private createErrorReport(
    code: string,
    message: string,
    source: SyncSource,
  ): SyncReport {
    const syncId = `error-${Date.now()}`;
    const error = new SyncEngineError(
      'COORDINATOR',
      code as any,
      message,
      false
    );
    return createFailedSyncReport(
      syncId,
      this.userId ?? 'unknown',
      'unknown',
      source,
      error,
      0
    );
  }
}
