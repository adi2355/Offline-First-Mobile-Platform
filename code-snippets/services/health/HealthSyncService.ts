import { AppState, Platform, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import NetInfo, { type NetInfoSubscription, type NetInfoState } from '@react-native-community/netinfo';
import { logger, toLogError } from '../../utils/logger';
import type { DrizzleDB } from '../../db/client';
import {
  HealthIngestionEngine,
  type HealthDataProviderAdapter,
  type MetricIngestionConfig,
} from './HealthIngestionEngine';
import {
  HealthUploadEngine,
  type HealthUploadHttpClient,
} from './HealthUploadEngine';
import { HealthSampleRepository } from '../../repositories/health/HealthSampleRepository';
import { HealthCursorRepository } from '../../repositories/health/HealthCursorRepository';
import { HealthDeletionQueueRepository } from '../../repositories/health/HealthDeletionQueueRepository';
import {
  getHealthSyncCoordinationState,
  type HealthSyncSource,
  type HealthSyncResult,
} from './HealthSyncCoordinationState';
import { SyncScheduler, type CooperativeYieldController } from '../sync/SyncScheduler';
import { SyncLeaseManager } from '../sync/SyncLeaseManager';
import { isFeatureEnabled } from '../../config/featureFlags';
import type { IHealthIngestionDriver, LaneResult, NativeInitConfig, NativeMetricConfig } from './types/ingestion-driver.types';
import { NativeErrorCode } from './types/ingestion-driver.types';
import { resolveHealthSourceId } from './HealthSourceRegistry';
import { createHealthIngestionDriver, HealthDriverInitError } from './drivers/createHealthIngestionDriver';
import type { DriverFallbackPolicy } from './drivers/createHealthIngestionDriver';
import { databaseManager } from '../../DatabaseManager';
import { HEALTH_METRIC_DEFINITIONS } from '@shared/contracts';
import type { HealthProjectionRefreshService } from './HealthProjectionRefreshService';
import { LocalRollupDirtyKeyRepository } from '../../repositories/health/LocalRollupDirtyKeyRepository';
import { LocalSleepDirtyNightRepository } from '../../repositories/health/LocalSleepDirtyNightRepository';
export type HealthPermissionStatus = 'not_determined' | 'denied' | 'authorized';
export interface HealthSyncServicePorts {
  readonly drizzleDb: DrizzleDB;
  readonly httpClient: HealthUploadHttpClient;
  readonly healthDataProvider: HealthDataProviderAdapter;
  readonly metricConfigs: readonly MetricIngestionConfig[];
  readonly getUserId: () => string | null;
  readonly getAuthToken: () => Promise<string | null>;
  readonly getPermissionStatus: () => HealthPermissionStatus;
  readonly appVersion?: string;
  readonly getRecentFirstResetVersion?: () => Promise<string | null>;
  readonly setRecentFirstResetVersion?: (version: string) => Promise<void>;
  readonly syncScheduler?: SyncScheduler;
  readonly syncLeaseManager?: SyncLeaseManager;
  readonly delayFn?: (ms: number) => Promise<void>;
}
export interface HealthSyncServiceState {
  readonly initialized: boolean;
  readonly enginesReady: boolean;
  readonly isSyncing: boolean;
  readonly isColdRunning: boolean;
  readonly isChangeRunning: boolean;
  readonly lastIngestTime: number | null;
  readonly lastUploadTime: number | null;
  readonly currentUserId: string | null;
  readonly permissionStatus: HealthPermissionStatus;
}
export interface FullSyncResult {
  readonly success: boolean;
  readonly ingestionResult: IngestionSummary | null;
  readonly uploadResult: HealthSyncResult | null;
  readonly durationMs: number;
  readonly source: HealthSyncSource;
  readonly errorMessage?: string;
}
interface IngestionSummary {
  readonly success: boolean;
  readonly totalSamplesIngested: number;
  readonly totalSamplesDeleted: number;
  readonly durationMs: number;
}
export class HealthSyncService {
  private static instance: HealthSyncService | null = null;
  public static getInstance(ports?: HealthSyncServicePorts): HealthSyncService {
    if (!HealthSyncService.instance) {
      if (!ports) {
        throw new Error(
          '[HealthSyncService] Cannot create instance without ports. ' +
          'Provide ports on first getInstance() call.'
        );
      }
      HealthSyncService.instance = new HealthSyncService(ports);
    }
    return HealthSyncService.instance;
  }
  public static hasInstance(): boolean {
    return HealthSyncService.instance !== null;
  }
  public static reset(): void {
    if (HealthSyncService.instance) {
      HealthSyncService.instance.cleanup();
    }
    HealthSyncService.instance = null;
  }
  private readonly ports: HealthSyncServicePorts;
  private readonly syncScheduler?: SyncScheduler;
  private readonly syncLeaseManager?: SyncLeaseManager;
  private ingestionEngine: HealthIngestionEngine | null = null;
  private uploadEngine: HealthUploadEngine | null = null;
  private ingestionDriver: IHealthIngestionDriver | null = null;
  private resolvedSourceId: string | null = null;
  private sampleRepository: HealthSampleRepository | null = null;
  private cursorRepository: HealthCursorRepository | null = null;
  private deletionQueueRepository: HealthDeletionQueueRepository | null = null;
  private healthProjectionRefreshService: HealthProjectionRefreshService | null = null;
  private readonly coordinationState = getHealthSyncCoordinationState();
  private initialized = false;
  private enginesReady = false;
  private isSyncing = false;
  private currentUserId: string | null = null;
  private permissionStatus: HealthPermissionStatus = 'not_determined';
  private isColdRunning = false;
  private isChangeRunning = false;
  private lastIngestTime: number | null = null;
  private lastUploadTime: number | null = null;
  private ingestIntervalId: ReturnType<typeof setInterval> | null = null;
  private uploadIntervalId: ReturnType<typeof setInterval> | null = null;
  private changeLaneIntervalId: ReturnType<typeof setInterval> | null = null;
  private idleTimerId: ReturnType<typeof setTimeout> | null = null;
  private appStateSubscription: NativeEventSubscription | null = null;
  private networkSubscription: NetInfoSubscription | null = null;
  private static readonly IDLE_TIMEOUT_MS = 30_000;
  private currentAppState: AppStateStatus = 'active';
  private wasOffline = false;
  private stateChangeListeners: Set<(state: HealthSyncServiceState) => void> = new Set();
  private syncAbortController: AbortController | null = null;
  private constructor(ports: HealthSyncServicePorts) {
    this.ports = ports;
    this.syncScheduler = ports.syncScheduler;
    this.syncLeaseManager = ports.syncLeaseManager;
    logger.debug('[HealthSyncService] Instance created');
  }
  public async initialize(): Promise<void> {
    if (this.initialized) {
      logger.debug('[HealthSyncService] Already initialized, skipping');
      return;
    }
    logger.info('[HealthSyncService] Initializing...');
    try {
      this.setupAppStateListener();
      this.setupNetworkListener();
      this.startPeriodicScheduling();
      this.initialized = true;
      logger.info('[HealthSyncService] Initialization complete');
    } catch (error) {
      logger.error('[HealthSyncService] Initialization failed', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  public setCurrentUserId(userId: string | null): void {
    const previousUserId = this.currentUserId;
    this.currentUserId = userId;
    logger.info('[HealthSyncService] User ID changed', {
      previousUserId: previousUserId ? '[redacted]' : null,
      newUserId: userId ? '[redacted]' : null,
    });
    if (userId && !previousUserId) {
      this.handleAuthSignIn();
    } else if (!userId && previousUserId) {
      this.handleAuthSignOut();
    }
  }
  public getCurrentUserId(): string | null {
    return this.currentUserId;
  }
  public setHealthProjectionRefreshService(service: HealthProjectionRefreshService): void {
    this.healthProjectionRefreshService = service;
    logger.debug('[HealthSyncService] HealthProjectionRefreshService injected');
  }
  public onPermissionsGranted(): void {
    const previousStatus = this.permissionStatus;
    this.permissionStatus = 'authorized';
    logger.info('[HealthSyncService] Permissions granted', {
      previousStatus,
    });
    if (this.currentUserId && !this.enginesReady) {
      this.tryCreateEngines().then(async (ready) => {
        if (ready) {
          await this.maybeResetRecentFirstCursors();
          this.triggerSync('HEALTH_SYNC_INITIALIZE').catch((error) => {
            logger.warn('[HealthSyncService] Post-permission sync failed', {
              error: toLogError(error),
            });
          });
        }
      });
    }
  }
  public setPermissionStatus(status: HealthPermissionStatus): void {
    const previousStatus = this.permissionStatus;
    this.permissionStatus = status;
    if (status !== previousStatus) {
      logger.info('[HealthSyncService] Permission status changed', {
        previousStatus,
        newStatus: status,
      });
      if (status === 'authorized' && this.currentUserId && !this.enginesReady) {
        this.tryCreateEngines().then(async (ready) => {
          if (ready) {
            await this.maybeResetRecentFirstCursors();
            this.triggerSync('HEALTH_SYNC_INITIALIZE').catch((error) => {
              logger.warn('[HealthSyncService] Post-permission-change sync failed', {
                error: toLogError(error),
              });
            });
          }
        });
      }
    }
  }
  public async triggerSync(source: HealthSyncSource): Promise<FullSyncResult | null> {
    const startTime = Date.now();
    logger.info('[HealthSyncService] Sync triggered', { source });
    if (this.isSyncing) {
      logger.info('[HealthSyncService] Sync already in progress, skipping', {
        source,
        reason: 'isSyncing guard',
      });
      return null;
    }
    if (!await this.ensureEnginesReady()) {
      logger.debug('[HealthSyncService] Engines not ready, skipping sync');
      return null;
    }
    if (source !== 'MANUAL_REFRESH' && this.coordinationState.isSourceInCooldown(source)) {
      logger.debug('[HealthSyncService] Source in cooldown, skipping', { source });
      return null;
    }
    this.coordinationState.recordSourceTime(source);
    this.isSyncing = true;
    this.notifyStateChange();
    this.syncAbortController = new AbortController();
    const abortSignal = this.syncAbortController.signal;
    try {
      let ingestionResult: IngestionSummary | null = null;
      if (this.ingestionDriver && this.resolvedSourceId && !abortSignal.aborted) {
        ingestionResult = await this.performIngestion(abortSignal);
      }
      let uploadResult: HealthSyncResult | null = null;
      if (this.uploadEngine && !abortSignal.aborted) {
        uploadResult = await this.performUpload(abortSignal);
      }
      const durationMs = Date.now() - startTime;
      const success = (ingestionResult?.success ?? true) && (uploadResult?.success ?? true);
      const result: FullSyncResult = {
        success,
        ingestionResult,
        uploadResult,
        durationMs,
        source,
      };
      logger.info('[HealthSyncService] Sync completed', {
        source,
        success,
        durationMs,
        samplesIngested: ingestionResult?.totalSamplesIngested ?? 0,
        samplesUploaded: uploadResult?.samplesUploaded ?? 0,
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[HealthSyncService] Sync failed', {
        source,
        durationMs,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return {
        success: false,
        ingestionResult: null,
        uploadResult: null,
        durationMs,
        source,
        errorMessage,
      };
    } finally {
      this.isSyncing = false;
      this.syncAbortController = null; 
      this.notifyStateChange();
    }
  }
  public async triggerUploadOnly(source: HealthSyncSource): Promise<HealthSyncResult | null> {
    logger.info('[HealthSyncService] Upload-only triggered', { source });
    if (this.isSyncing) {
      logger.info('[HealthSyncService] Sync/upload already in progress, skipping', {
        source,
        reason: 'isSyncing guard',
      });
      return null;
    }
    if (!await this.ensureEnginesReady()) {
      logger.debug('[HealthSyncService] Engines not ready, skipping upload');
      return null;
    }
    if (source !== 'MANUAL_REFRESH' && this.coordinationState.isSourceInCooldown(source)) {
      logger.debug('[HealthSyncService] Source in cooldown, skipping', { source });
      return null;
    }
    this.coordinationState.recordSourceTime(source);
    this.isSyncing = true;
    this.notifyStateChange();
    try {
      return await this.performUpload();
    } catch (error) {
      logger.error('[HealthSyncService] Upload-only failed', {
        source,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return null;
    } finally {
      this.isSyncing = false;
      this.notifyStateChange();
    }
  }
  public async triggerColdBackfill(source: HealthSyncSource): Promise<LaneResult | null> {
    if (this.isColdRunning) {
      logger.debug('[HealthSyncService] Cold backfill already running, skipping');
      return null;
    }
    if (!this.ingestionDriver || !this.resolvedSourceId || !this.currentUserId) {
      return null; 
    }
    this.isColdRunning = true;
    this.notifyStateChange();
    try {
      const result = await this.syncColdBackfill();
      if (result) {
        const wasPreempted = result.partial &&
          result.errors.some(e => e.code === NativeErrorCode.COLD_CANCELLED);
        if (wasPreempted) {
          const preemptionCount = this.coordinationState.recordColdPreemption();
          const madeProgress = result.samplesInserted > 0 || result.coldCursorsAdvanced > 0;
          if (madeProgress) {
            this.coordinationState.recordColdLaneProgress();
          }
          if (this.coordinationState.isColdPreemptionExcessive()) {
            logger.warn('[HealthSyncService] COLD STARVATION ALERT: cold lane preempted excessively', {
              consecutivePreemptions: preemptionCount,
              threshold: this.coordinationState.COLD_PREEMPTION_ALERT_THRESHOLD,
              coldLaneLastProgressAt: this.coordinationState.getDebugSnapshot().coldLaneLastProgressAt,
              samplesInsertedBeforePreemption: result.samplesInserted,
              recommendation: 'Cold lane cannot complete due to continuous hot-lane activity. Consider increasing hot budget or scheduling cold during low-activity windows.',
            });
          } else {
            logger.info('[HealthSyncService] Cold lane preempted by hot lane', {
              consecutivePreemptions: preemptionCount,
              threshold: this.coordinationState.COLD_PREEMPTION_ALERT_THRESHOLD,
              samplesInsertedBeforePreemption: result.samplesInserted,
            });
          }
        } else {
          const fullSuccess = result.errors.length === 0 && !result.partial;
          if (fullSuccess) {
            this.coordinationState.recordColdLaneCompletion();
          } else {
            const partialProgress = result.samplesInserted > 0 || result.coldCursorsAdvanced > 0;
            if (partialProgress) {
              this.coordinationState.recordColdLaneProgress();
            }
            if (result.errors.length > 0) {
              logger.warn('[HealthSyncService] Cold lane completed with non-preemption errors', {
                errorCount: result.errors.length,
                partial: result.partial,
                firstErrorCode: result.errors[0]?.code,
                samplesInserted: result.samplesInserted,
                coldCursorsAdvanced: result.coldCursorsAdvanced,
                progressRecorded: partialProgress,
              });
            }
          }
        }
      }
      return result;
    } catch (error) {
      logger.error('[HealthSyncService] Cold backfill failed', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      this.coordinationState.recordIngestError();
      return null;
    } finally {
      this.isColdRunning = false;
      this.notifyStateChange();
    }
  }
  public async triggerChangeDetection(source: HealthSyncSource): Promise<LaneResult | null> {
    if (this.isChangeRunning) {
      logger.debug('[HealthSyncService] Change detection already running, skipping');
      return null;
    }
    if (!this.ingestionDriver || !this.resolvedSourceId || !this.currentUserId) {
      return null; 
    }
    this.isChangeRunning = true;
    this.notifyStateChange();
    try {
      const result = await this.syncChanges();
      if (result) {
        const fullSuccess = result.errors.length === 0 && !result.partial;
        if (fullSuccess) {
          this.coordinationState.recordChangeLaneCompletion();
        } else if (result.errors.length > 0) {
          logger.warn('[HealthSyncService] Change lane completed with errors', {
            errorCount: result.errors.length,
            partial: result.partial,
            firstErrorCode: result.errors[0]?.code,
            samplesInserted: result.samplesInserted,
          });
          this.coordinationState.recordIngestError();
        }
      }
      return result;
    } catch (error) {
      logger.error('[HealthSyncService] Change detection failed', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      this.coordinationState.recordIngestError();
      return null;
    } finally {
      this.isChangeRunning = false;
      this.notifyStateChange();
    }
  }
  public getSyncState(): HealthSyncServiceState {
    return {
      initialized: this.initialized,
      enginesReady: this.enginesReady,
      isSyncing: this.isSyncing,
      isColdRunning: this.isColdRunning,
      isChangeRunning: this.isChangeRunning,
      lastIngestTime: this.lastIngestTime,
      lastUploadTime: this.lastUploadTime,
      currentUserId: this.currentUserId,
      permissionStatus: this.permissionStatus,
    };
  }
  public subscribeToStateChanges(listener: (state: HealthSyncServiceState) => void): () => void {
    this.stateChangeListeners.add(listener);
    listener(this.getSyncState());
    return () => {
      this.stateChangeListeners.delete(listener);
    };
  }
  private notifyStateChange(): void {
    const currentState = this.getSyncState();
    for (const listener of this.stateChangeListeners) {
      try {
        listener(currentState);
      } catch (error) {
        logger.warn('[HealthSyncService] State change listener threw', {
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
        });
      }
    }
  }
  public async getPendingSamplesCount(): Promise<number> {
    if (!this.sampleRepository) {
      return 0;
    }
    const userId = this.currentUserId;
    if (!userId) {
      return 0;
    }
    try {
      const stats = await this.sampleRepository.getStats(userId);
      return stats.pendingCount;
    } catch (error) {
      logger.warn('[HealthSyncService] Failed to get pending count', {
        error: toLogError(error),
      });
      return 0;
    }
  }
  public getDebugSnapshot(): Record<string, unknown> {
    return {
      serviceState: this.getSyncState(),
      coordinationState: this.coordinationState.getDebugSnapshot(),
      hasIngestionEngine: !!this.ingestionEngine,
      hasIngestionDriver: !!this.ingestionDriver,
      ingestionDriverId: this.ingestionDriver?.driverId ?? null,
      hasResolvedSourceId: !!this.resolvedSourceId,
      hasUploadEngine: !!this.uploadEngine,
      hasRepositories: !!(this.sampleRepository && this.cursorRepository && this.deletionQueueRepository),
    };
  }
  public async resetRejectedSamples(): Promise<number> {
    if (!this.sampleRepository) {
      logger.warn('[HealthSyncService] Cannot reset rejected samples - repository not initialized');
      return 0;
    }
    const userId = this.currentUserId;
    if (!userId) {
      logger.warn('[HealthSyncService] Cannot reset rejected samples - no user ID');
      return 0;
    }
    try {
      const count = await this.sampleRepository.resetRejectedToPending(userId);
      logger.info('[HealthSyncService] Reset rejected samples to pending', {
        userId,
        count,
      });
      return count;
    } catch (error) {
      logger.error('[HealthSyncService] Failed to reset rejected samples', {
        userId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  public async resetFailedSamples(): Promise<number> {
    if (!this.sampleRepository) {
      logger.warn('[HealthSyncService] Cannot reset failed samples - repository not initialized');
      return 0;
    }
    const userId = this.currentUserId;
    if (!userId) {
      logger.warn('[HealthSyncService] Cannot reset failed samples - no user ID');
      return 0;
    }
    try {
      const count = await this.sampleRepository.resetFailedToPending(userId);
      logger.info('[HealthSyncService] Reset failed samples to pending', {
        userId,
        count,
      });
      return count;
    } catch (error) {
      logger.error('[HealthSyncService] Failed to reset failed samples', {
        userId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  public async resetVitalSignCursors(triggerImmediateSync = true): Promise<{
    cursorsReset: number;
    syncTriggered: boolean;
    syncResult?: FullSyncResult | null;
  }> {
    logger.info('[HealthSyncService] Resetting recent-data-first cursors');
    if (!this.ingestionEngine) {
      logger.warn('[HealthSyncService] Cannot reset cursors - ingestion engine not initialized');
      return { cursorsReset: 0, syncTriggered: false };
    }
    const recentFirstMetrics = this.coordinationState.RECENT_DATA_PRIORITY_METRICS;
    let cursorsReset = 0;
    for (const metricCode of recentFirstMetrics) {
      try {
        await this.ingestionEngine.resetCursor(metricCode, 'hot_anchor');
        cursorsReset++;
        logger.debug('[HealthSyncService] Reset cursor for metric', { metricCode });
      } catch (error) {
        logger.warn('[HealthSyncService] Failed to reset cursor for metric', {
          metricCode,
          error: toLogError(error),
        });
      }
    }
    logger.info('[HealthSyncService] Recent-data-first cursors reset', {
      cursorsReset,
      totalMetrics: recentFirstMetrics.length,
    });
    let syncResult: FullSyncResult | null = null;
    if (triggerImmediateSync && cursorsReset > 0) {
      syncResult = await this.triggerSync('MANUAL_REFRESH');
    }
    return {
      cursorsReset,
      syncTriggered: triggerImmediateSync && cursorsReset > 0,
      syncResult,
    };
  }
  public cleanup(): void {
    logger.info('[HealthSyncService] Cleaning up...');
    if (this.syncAbortController) {
      logger.debug('[HealthSyncService] Aborting active sync operations');
      this.syncAbortController.abort();
      this.syncAbortController = null;
    }
    if (this.ingestionDriver) {
      logger.debug('[HealthSyncService] Disposing ingestion driver');
      this.ingestionDriver.dispose();
      this.ingestionDriver = null;
    }
    if (this.ingestIntervalId) {
      clearInterval(this.ingestIntervalId);
      this.ingestIntervalId = null;
    }
    if (this.uploadIntervalId) {
      clearInterval(this.uploadIntervalId);
      this.uploadIntervalId = null;
    }
    if (this.changeLaneIntervalId) {
      clearInterval(this.changeLaneIntervalId);
      this.changeLaneIntervalId = null;
    }
    if (this.idleTimerId) {
      clearTimeout(this.idleTimerId);
      this.idleTimerId = null;
    }
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    if (this.networkSubscription) {
      this.networkSubscription();
      this.networkSubscription = null;
    }
    this.coordinationState.forceReleaseIngestLock();
    this.initialized = false;
    this.enginesReady = false;
    this.isSyncing = false;
    this.isColdRunning = false;
    this.isChangeRunning = false;
    this.currentUserId = null;
    this.permissionStatus = 'not_determined';
    this.resolvedSourceId = null;
    logger.info('[HealthSyncService] Cleanup complete');
  }
  private async ensureEnginesReady(): Promise<boolean> {
    if (this.enginesReady && this.ingestionEngine && this.ingestionDriver && this.resolvedSourceId && this.uploadEngine) {
      return true;
    }
    return await this.tryCreateEngines();
  }
  private async tryCreateEngines(): Promise<boolean> {
    const userId = this.currentUserId ?? this.ports.getUserId();
    if (!userId) {
      logger.debug('[HealthSyncService] Cannot create engines - no user ID');
      return false;
    }
    const permStatus = this.permissionStatus !== 'not_determined'
      ? this.permissionStatus
      : this.ports.getPermissionStatus();
    if (permStatus !== 'authorized') {
      logger.debug('[HealthSyncService] Cannot create engines - permissions not authorized', {
        permissionStatus: permStatus,
      });
      return false;
    }
    this.currentUserId = userId;
    this.permissionStatus = permStatus;
    logger.info('[HealthSyncService] Creating engines...');
    try {
      if (!this.sampleRepository) {
        this.sampleRepository = new HealthSampleRepository(this.ports.drizzleDb);
      }
      if (!this.cursorRepository) {
        this.cursorRepository = new HealthCursorRepository(this.ports.drizzleDb);
      }
      if (!this.deletionQueueRepository) {
        this.deletionQueueRepository = new HealthDeletionQueueRepository(this.ports.drizzleDb);
      }
      const projectionTablesReady = databaseManager.healthProjectionTablesReady;
      this.ingestionEngine = new HealthIngestionEngine({
        sampleRepository: this.sampleRepository,
        cursorRepository: this.cursorRepository,
        coordinationState: this.coordinationState,
        healthDataProvider: this.ports.healthDataProvider,
        getUserId: () => this.currentUserId,
        rollupDirtyKeyRepository: projectionTablesReady
          ? new LocalRollupDirtyKeyRepository(this.ports.drizzleDb)
          : undefined,
        sleepDirtyNightRepository: projectionTablesReady
          ? new LocalSleepDirtyNightRepository(this.ports.drizzleDb)
          : undefined,
      });
      const fallbackPolicy: DriverFallbackPolicy = isFeatureEnabled('healthJsFallbackInProd')
        ? 'allow-fallback'
        : 'fail-fast';
      const jsDeps = {
        engine: this.ingestionEngine,
        getMetricConfigs: (metricCodes: string[]) => {
          return this.ports.metricConfigs.filter(
            (config) => metricCodes.includes(config.metricCode)
          );
        },
        getAllMetricConfigs: () => this.ports.metricConfigs,
        coordinationState: this.coordinationState,
      };
      this.ingestionDriver = await createHealthIngestionDriver({
        jsDeps,
        fallbackPolicy,
      });
      if (this.ingestionDriver.driverId === 'native' && !databaseManager.healthCursorScopeReady) {
        this.ingestionDriver.dispose();
        if (fallbackPolicy === 'fail-fast') {
          const initError = new HealthDriverInitError({
            reason: 'native_module_error',
            message: 'Cursor scope migration not ready (healthCursorScopeReady=false). ' +
              'Native Swift module requires the scope column on health_ingest_cursors. ' +
              'Set healthJsFallbackInProd=true for emergency JS fallback.',
            platform: 'ios',
            nativeIngestEnabled: true,
            fallbackPolicy,
          });
          logger.error('[HealthSyncService] Native driver blocked: cursor scope not ready, fallback DENIED', initError.toDiagnostics());
          throw initError;
        }
        logger.error('[HealthSyncService] Native driver blocked: cursor scope not ready. Falling back to JS driver (DEGRADED MODE)', {
          healthCursorScopeReady: false,
          fallbackPolicy,
          warning: 'JS driver lacks native OperationQueue parallelism and two-pass HOT catch-up. See ADR-001.',
        });
        const { JsHealthIngestionDriver } = await import('./drivers/JsHealthIngestionDriver');
        this.ingestionDriver = new JsHealthIngestionDriver(jsDeps);
      } else if (this.ingestionDriver.driverId === 'native') {
        try {
          await import('./drivers/NativeHealthIngestionDriver');
          const nativeDriver = this.ingestionDriver as unknown as {
            initializeNativeModule: (config: NativeInitConfig) => Promise<void>;
            setBackgroundDeliveryEnabled: (enabled: boolean) => Promise<void>;
          };
          if (typeof nativeDriver.initializeNativeModule !== 'function') {
            throw new Error('Native driver missing initializeNativeModule');
          }
          const nativeInitConfig: NativeInitConfig = {
            dbPath: databaseManager.getDbFilePath(),
            metrics: this.ports.metricConfigs.map((config): NativeMetricConfig => {
              const def = HEALTH_METRIC_DEFINITIONS[config.metricCode];
              return {
                metricCode: config.metricCode,
                hkIdentifier: config.providerIdentifier,
                queryUnit: config.queryUnit ?? null,
                valueKind: config.valueKind,
                isCategory: config.isCategory,
                ...(def?.minValue !== undefined && { minBound: def.minValue }),
                ...(def?.maxValue !== undefined && { maxBound: def.maxValue }),
                ...(def?.canonicalUnit !== undefined && { canonicalUnit: def.canonicalUnit }),
              };
            }),
            laneConstants: (() => {
              const c = this.coordinationState.getLaneConstants();
                return {
                  hotBudgetMs: c.hotBudgetMs,
                  recentDataQueryLimit: c.recentDataQueryLimit,
                  hotLookbackDays: c.hotLookbackDays,
                  hotOverlapMs: c.hotOverlapMs,
                  hotUiWindowMs: c.hotUiWindowMs,
                  hotCatchupChunkWindowMs: c.hotCatchupChunkWindowMs,
                  hotCatchupMaxChunksPerRun: c.hotCatchupMaxChunksPerRun,
                  hotCatchupQueryLimit: c.hotCatchupQueryLimit,
                  coldChunkBudgetMs: c.coldChunkBudgetMs,
                coldMaxChunks: c.coldMaxChunks,
                coldBackfillDays: c.coldBackfillDays,
                coldGraceWindowDays: c.coldGraceWindowDays,
                coldChunkWindowMs: c.coldChunkWindowMs,
                coldQueryLimitPerChunk: c.coldQueryLimitPerChunk,
                maxSamplesPerChunk: c.maxSamplesPerChunk,
                busyTimeoutMs: c.busyTimeoutMs,
                hotTwoPassEnabled: isFeatureEnabled('hotTwoPassEnabled'),
              };
            })(),
          };
          await nativeDriver.initializeNativeModule(nativeInitConfig);
          logger.info('[HealthSyncService] Native driver initialized successfully', {
            dbPath: nativeInitConfig.dbPath,
            metricCount: nativeInitConfig.metrics.length,
          });
          try {
            const bgDeliveryEnabled = isFeatureEnabled('healthBackgroundDelivery');
            await nativeDriver.setBackgroundDeliveryEnabled(bgDeliveryEnabled);
            logger.info('[HealthSyncService] Background delivery flag wired to native', {
              enabled: bgDeliveryEnabled,
            });
          } catch (bgError: unknown) {
            logger.warn('[HealthSyncService] Failed to set background delivery flag', {
              error: toLogError(bgError),
            });
          }
        } catch (initError: unknown) {
          this.ingestionDriver.dispose();
          if (fallbackPolicy === 'fail-fast') {
            const cause = initError instanceof Error ? initError : new Error(String(initError));
            const driverError = new HealthDriverInitError({
              reason: 'native_module_error',
              message: `Native driver initializeNativeModule failed: ${cause.message}. ` +
                'Set healthJsFallbackInProd=true for emergency JS fallback.',
              platform: 'ios',
              nativeIngestEnabled: true,
              fallbackPolicy,
              cause,
            });
            logger.error('[HealthSyncService] Native driver init failed, fallback DENIED', driverError.toDiagnostics());
            throw driverError;
          }
          logger.error('[HealthSyncService] Native driver initialization failed, falling back to JS driver (DEGRADED MODE)', {
            error: toLogError(initError),
            fallbackPolicy,
            warning: 'JS driver lacks native OperationQueue parallelism and two-pass HOT catch-up. See ADR-001.',
          });
          const { JsHealthIngestionDriver } = await import('./drivers/JsHealthIngestionDriver');
          this.ingestionDriver = new JsHealthIngestionDriver(jsDeps);
        }
      }
      const baseSourceId = this.ports.healthDataProvider.getSourceId();
      const resolvedSource = await resolveHealthSourceId({ baseSourceId });
      this.resolvedSourceId = resolvedSource.sourceId;
      this.coordinationState.setActiveDriverId(this.ingestionDriver.driverId);
      const nativeIngestFlag = isFeatureEnabled('healthNativeIngest');
      const jsFallbackFlag = isFeatureEnabled('healthJsFallbackInProd');
      logger.info('[HealthSyncService] Ingestion driver SELECTED', {
        driverId: this.ingestionDriver.driverId,
        sourceId: this.resolvedSourceId,
        fallbackPolicy,
        flags: {
          healthNativeIngest: nativeIngestFlag,
          healthJsFallbackInProd: jsFallbackFlag,
        },
        platform: Platform.OS,
        cursorScopeReady: databaseManager.healthCursorScopeReady,
        ...(this.ingestionDriver.driverId === 'js' && nativeIngestFlag && {
          degradedMode: true,
          degradedWarning: 'Running JS driver despite healthNativeIngest=true. Lane semantics are degraded. See ADR-001.',
        }),
      });
      this.uploadEngine = new HealthUploadEngine({
        repository: this.sampleRepository,
        deletionQueueRepository: this.deletionQueueRepository,
        httpClient: this.ports.httpClient,
        coordinationState: this.coordinationState,
        getAuthToken: this.ports.getAuthToken,
        getUserId: () => this.currentUserId,
        syncLeaseManager: this.syncLeaseManager,
        ...(this.ports.delayFn && { delay: this.ports.delayFn }),
      });
      await this.uploadEngine.initialize();
      this.enginesReady = true;
      this.coordinationState.recordHealthSyncStarted();
      logger.info('[HealthSyncService] Engines created and initialized');
      return true;
    } catch (error) {
      if (error instanceof HealthDriverInitError) {
        logger.error('[HealthSyncService] Health sync DISABLED: native driver unavailable and JS fallback denied', {
          ...error.toDiagnostics(),
          action: 'Health sync will not run. Set healthJsFallbackInProd=true for emergency JS fallback.',
        });
      } else {
        logger.error('[HealthSyncService] Failed to create engines', {
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
        });
      }
      return false;
    }
  }
  private async maybeResetRecentFirstCursors(): Promise<boolean> {
    const { appVersion, getRecentFirstResetVersion, setRecentFirstResetVersion } = this.ports;
    if (!appVersion || !getRecentFirstResetVersion || !setRecentFirstResetVersion) {
      return false;
    }
    try {
      const storedVersion = await getRecentFirstResetVersion();
      if (storedVersion === appVersion) {
        return false;
      }
      const result = await this.resetVitalSignCursors(false);
      await setRecentFirstResetVersion(appVersion);
      logger.info('[HealthSyncService] Recent-first cursor reset completed', {
        appVersion,
        cursorsReset: result.cursorsReset,
      });
      return true;
    } catch (error) {
      logger.warn('[HealthSyncService] Recent-first cursor reset failed', {
        error: toLogError(error),
        appVersion,
      });
      return false;
    }
  }
  private handleAuthSignIn(): void {
    logger.info('[HealthSyncService] Handling auth sign in');
    this.tryCreateEngines().then(async (ready) => {
      if (ready) {
        await this.maybeResetRecentFirstCursors();
        this.triggerSync('AUTH_SIGNIN').catch((error) => {
          logger.warn('[HealthSyncService] Post-auth sync failed', {
            error: toLogError(error),
          });
        });
      }
    });
  }
  private handleAuthSignOut(): void {
    logger.info('[HealthSyncService] Handling auth sign out');
    this.enginesReady = false;
    if (this.ingestionDriver) {
      this.ingestionDriver.dispose();
      this.ingestionDriver = null;
    }
    this.resolvedSourceId = null;
    this.ingestionEngine = null;
    this.uploadEngine = null;
    this.sampleRepository = null;
    this.cursorRepository = null;
    this.deletionQueueRepository = null;
    this.lastIngestTime = null;
    this.lastUploadTime = null;
    getHealthSyncCoordinationState().resetAllState();
  }
  private async syncColdBackfill(abortSignal?: AbortSignal): Promise<LaneResult | null> {
    if (!this.ingestionDriver || !this.resolvedSourceId || !this.currentUserId) {
      return null;
    }
    if (abortSignal?.aborted) {
      return null;
    }
    const laneConstants = this.coordinationState.getLaneConstants();
    try {
      return await this.ingestionDriver.ingestCold(
        this.currentUserId,
        this.resolvedSourceId,
        {
          chunkBudgetMs: laneConstants.coldChunkBudgetMs,
          maxChunks: laneConstants.coldMaxChunks,
          abortSignal,
        }
      );
    } catch (error) {
      logger.error('[HealthSyncService] syncColdBackfill error', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return null;
    }
  }
  private async syncChanges(abortSignal?: AbortSignal): Promise<LaneResult | null> {
    if (!this.ingestionDriver || !this.resolvedSourceId || !this.currentUserId) {
      return null;
    }
    if (abortSignal?.aborted) {
      return null;
    }
    try {
      return await this.ingestionDriver.ingestChanges(
        this.currentUserId,
        this.resolvedSourceId,
        { abortSignal }
      );
    } catch (error) {
      logger.error('[HealthSyncService] syncChanges error', {
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'Error', message: String(error) },
      });
      return null;
    }
  }
  private schedulePostHotTasks(): void {
    if (this.coordinationState.isChangeLaneDue()) {
      this.triggerChangeDetection('HEALTHKIT_INGEST').catch((error) => {
        logger.warn('[HealthSyncService] Post-hot change detection failed', {
          error: toLogError(error),
        });
      });
    }
  }
  private resetIdleTimer(): void {
    if (this.idleTimerId) {
      clearTimeout(this.idleTimerId);
      this.idleTimerId = null;
    }
    this.idleTimerId = setTimeout(() => {
      this.handleIdleTimeout();
    }, HealthSyncService.IDLE_TIMEOUT_MS);
  }
  private handleIdleTimeout(): void {
    this.idleTimerId = null;
    if (this.currentAppState !== 'active') {
      return; 
    }
    if (this.coordinationState.isColdOverdue()) {
      logger.info('[HealthSyncService] Idle timeout: triggering cold backfill (overdue)');
      this.triggerColdBackfill('HEALTHKIT_INGEST').catch((error) => {
        logger.warn('[HealthSyncService] Idle cold backfill failed', {
          error: toLogError(error),
        });
      });
    }
  }
  private async performIngestion(abortSignal?: AbortSignal): Promise<IngestionSummary> {
    if (!this.ingestionDriver) {
      throw new Error('Ingestion driver not initialized');
    }
    if (!this.resolvedSourceId) {
      throw new Error('Source ID not resolved');
    }
    if (!this.currentUserId) {
      throw new Error('User ID not set');
    }
    if (abortSignal?.aborted) {
      logger.info('[HealthSyncService] Ingestion aborted before starting');
      return {
        success: false,
        totalSamplesIngested: 0,
        totalSamplesDeleted: 0,
        durationMs: 0,
      };
    }
    const startTime = Date.now();
    const schedulerEnabled = !!this.syncScheduler && isFeatureEnabled('syncScheduler');
    try {
      const metricCodes = this.ports.metricConfigs.map(c => c.metricCode);
      const { hotBudgetMs } = this.coordinationState.getLaneConstants();
      const runIngest = async (yieldController?: CooperativeYieldController) => {
        void yieldController; 
        return this.ingestionDriver!.ingestHot(
          this.currentUserId!,
          this.resolvedSourceId!,
          metricCodes,
          { budgetMs: hotBudgetMs, abortSignal }
        );
      };
      const laneResult: LaneResult = schedulerEnabled
        ? await this.syncScheduler!.runTask(
            {
              id: `health-ingest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
              name: 'health_ingest',
              kind: 'health_ingest',
              priority: 'low',
              deadlineMs: 10 * 60_000,
              resources: { sqlite: 1 },
              sliceBudgetMs: 8,
            },
            async (ctx) => runIngest(ctx.yieldController)
          )
        : await runIngest();
      this.coordinationState.recordHotLaneCompletion(laneResult.durationMs);
      const summary = this.mapLaneResultToIngestionSummary(laneResult);
      const fullSuccess = laneResult.errors.length === 0 && !laneResult.partial;
      this.resetIdleTimer();
      if (fullSuccess) {
        this.lastIngestTime = Date.now();
        this.coordinationState.clearIngestBackoff();
        if (this.healthProjectionRefreshService && this.currentUserId) {
          this.healthProjectionRefreshService
            .runRepairPass(this.currentUserId)
            .catch((err: unknown) => {
              logger.warn('[HealthSyncService] Projection repair pass failed (non-critical)', {
                error: toLogError(err),
              });
            });
        }
        this.schedulePostHotTasks();
      } else if (laneResult.errors.length > 0) {
        logger.warn('[HealthSyncService] Ingestion had errors, recording for backoff', {
          errorCount: laneResult.errors.length,
          firstErrorCode: laneResult.errors[0]?.code,
          samplesInserted: laneResult.samplesInserted,
          partial: laneResult.partial,
          laneSuccess: laneResult.success,
          fullSuccess,
        });
        this.coordinationState.recordIngestError();
      }
      return summary;
    } catch (error) {
      this.coordinationState.recordIngestError();
      throw error;
    }
  }
  private mapLaneResultToIngestionSummary(laneResult: LaneResult): IngestionSummary {
    return {
      success: laneResult.success,
      totalSamplesIngested: laneResult.samplesInserted,
      totalSamplesDeleted: 0, 
      durationMs: laneResult.durationMs,
    };
  }
  private async performUpload(abortSignal?: AbortSignal): Promise<HealthSyncResult> {
    if (!this.uploadEngine) {
      throw new Error('Upload engine not initialized');
    }
    if (abortSignal?.aborted) {
      logger.info('[HealthSyncService] Upload aborted before starting');
      return {
        success: false,
        samplesUploaded: 0,
        samplesRejected: 0,
        samplesFailed: 0,
        deletionsUploaded: 0,
        deletionsFailed: 0,
        durationMs: 0,
        errorMessage: 'Aborted',
      };
    }
    const schedulerEnabled = !!this.syncScheduler && isFeatureEnabled('syncScheduler');
    try {
      const uploadPending = async (yieldController?: CooperativeYieldController) => {
        return this.uploadEngine!.uploadPendingSamples(abortSignal, yieldController);
      };
      const uploadResult = schedulerEnabled
        ? await this.syncScheduler!.runTask(
            {
              id: `health-upload-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
              name: 'health_upload',
              kind: 'health_upload',
              priority: 'low',
              deadlineMs: 10 * 60_000,
              resources: { network: 1, sqlite: 1 },
              sliceBudgetMs: 8,
            },
            async (ctx) => uploadPending(ctx.yieldController)
          )
        : await uploadPending();
      const success =
        uploadResult.totalSamplesFailed === 0 &&
        uploadResult.totalDeletionsFailed === 0;
      const result: HealthSyncResult = {
        success,
        samplesUploaded: uploadResult.totalSamplesUploaded,
        samplesRejected: uploadResult.totalSamplesRejected,
        samplesFailed: uploadResult.totalSamplesFailed,
        deletionsUploaded: uploadResult.totalDeletionsUploaded,
        deletionsFailed: uploadResult.totalDeletionsFailed,
        durationMs: uploadResult.totalDurationMs,
      };
      if (success) {
        this.lastUploadTime = Date.now();
        this.coordinationState.clearUploadBackoff();
      } else {
        if (uploadResult.totalSamplesFailed > 0 || uploadResult.totalDeletionsFailed > 0) {
          logger.warn('[HealthSyncService] Upload had failures', {
            samplesFailed: uploadResult.totalSamplesFailed,
            deletionsFailed: uploadResult.totalDeletionsFailed,
            samplesUploaded: uploadResult.totalSamplesUploaded,
            deletionsUploaded: uploadResult.totalDeletionsUploaded,
          });
        }
      }
      this.coordinationState.recordSyncResult(result);
      return result;
    } catch (error) {
      this.coordinationState.recordUploadError();
      throw error;
    }
  }
  private startPeriodicScheduling(): void {
    this.ingestIntervalId = setInterval(() => {
      this.handlePeriodicIngest();
    }, this.coordinationState.INGEST_INTERVAL_MS);
    this.uploadIntervalId = setInterval(() => {
      this.handlePeriodicUpload();
    }, this.coordinationState.ACTIVE_UPLOAD_INTERVAL_MS);
    this.changeLaneIntervalId = setInterval(() => {
      if (this.currentAppState !== 'active') {
        return; 
      }
      if (this.coordinationState.isChangeLaneDue()) {
        this.triggerChangeDetection('HEALTHKIT_INGEST').catch((error) => {
          logger.warn('[HealthSyncService] Periodic change detection failed', {
            error: toLogError(error),
          });
        });
      }
    }, this.coordinationState.CHANGE_LANE_INTERVAL_MS);
    logger.debug('[HealthSyncService] Periodic scheduling started', {
      ingestIntervalMs: this.coordinationState.INGEST_INTERVAL_MS,
      uploadIntervalMs: this.coordinationState.ACTIVE_UPLOAD_INTERVAL_MS,
      changeLaneIntervalMs: this.coordinationState.CHANGE_LANE_INTERVAL_MS,
    });
  }
  private handlePeriodicIngest(): void {
    if (this.currentAppState !== 'active') {
      return;
    }
    if (this.coordinationState.isColdStarved()) {
      logger.info('[HealthSyncService] Cold starvation watchdog: forcing cold backfill, deferring hot to next tick', {
        isColdStarved: true,
        coldDebug: {
          coldLaneLastProgressAt: this.coordinationState.getDebugSnapshot().coldLaneLastProgressAt,
          healthSyncStartedAt: this.coordinationState.getDebugSnapshot().healthSyncStartedAt,
          coldLaneLastCompletedAt: this.coordinationState.getDebugSnapshot().coldLaneLastCompletedAt,
        },
      });
      this.triggerColdBackfill('HEALTHKIT_INGEST').catch((error) => {
        logger.warn('[HealthSyncService] Starvation cold backfill failed', {
          error: toLogError(error),
        });
      });
      return; 
    }
    this.triggerSync('HEALTHKIT_INGEST').catch((error) => {
      logger.warn('[HealthSyncService] Periodic ingest failed', {
        error: toLogError(error),
      });
    });
  }
  private handlePeriodicUpload(): void {
    if (this.currentAppState !== 'active') {
      return;
    }
    if (this.wasOffline) {
      logger.debug('[HealthSyncService] Skipping periodic upload - device offline');
      return;
    }
    NetInfo.fetch()
      .then((state) => {
        if (!state.isConnected) {
          logger.debug('[HealthSyncService] Skipping periodic upload - network check failed');
          return;
        }
        return this.triggerUploadOnly('PERIODIC_UPLOAD').catch((error) => {
          logger.warn('[HealthSyncService] Periodic upload failed', {
            error: toLogError(error),
          });
        });
      })
      .catch((error) => {
        logger.debug('[HealthSyncService] NetInfo check failed, proceeding with upload', {
          error: toLogError(error),
        });
        this.triggerUploadOnly('PERIODIC_UPLOAD').catch((uploadError) => {
          logger.warn('[HealthSyncService] Periodic upload failed', {
            error: toLogError(uploadError),
          });
        });
      });
  }
  private setupAppStateListener(): void {
    this.currentAppState = AppState.currentState;
    this.appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      this.handleAppStateChange(nextAppState);
    });
    logger.debug('[HealthSyncService] AppState listener set up', {
      initialState: this.currentAppState,
    });
  }
  private handleAppStateChange(nextAppState: AppStateStatus): void {
    const previousAppState = this.currentAppState;
    this.currentAppState = nextAppState;
    logger.debug('[HealthSyncService] AppState changed', {
      previousAppState,
      nextAppState,
    });
    if (nextAppState === 'active' && previousAppState !== 'active') {
      if (this.coordinationState.isHotLaneStale()) {
        logger.info('[HealthSyncService] Foreground return: hot data stale, triggering sync');
        this.triggerSync('APP_FOREGROUND').catch((error) => {
          logger.warn('[HealthSyncService] Foreground hot sync failed', {
            error: toLogError(error),
          });
        });
      }
      this.triggerUploadOnly('APP_FOREGROUND').catch((error) => {
        logger.warn('[HealthSyncService] Foreground upload failed', {
          error: toLogError(error),
        });
      });
    }
    if (nextAppState === 'background' && previousAppState !== 'background') {
      if (this.healthProjectionRefreshService && this.currentUserId) {
        logger.info('[HealthSyncService] Background transition: triggering projection repair pass');
        this.healthProjectionRefreshService
          .runRepairPass(this.currentUserId)
          .catch((err: unknown) => {
            logger.warn('[HealthSyncService] Background projection repair pass failed (non-critical)', {
              error: toLogError(err),
            });
          });
      }
    }
  }
  private setupNetworkListener(): void {
    this.networkSubscription = NetInfo.addEventListener((state) => {
      this.handleNetworkChange(state);
    });
    logger.debug('[HealthSyncService] Network listener set up');
  }
  private handleNetworkChange(state: NetInfoState): void {
    const isConnected = state.isConnected ?? false;
    logger.debug('[HealthSyncService] Network state changed', {
      isConnected,
      wasOffline: this.wasOffline,
      type: state.type,
    });
    if (isConnected && this.wasOffline) {
      this.triggerUploadOnly('NETWORK_RECONNECT').catch((error) => {
        logger.warn('[HealthSyncService] Network reconnect upload failed', {
          error: toLogError(error),
        });
      });
    }
    this.wasOffline = !isConnected;
  }
}
export function getHealthSyncService(): HealthSyncService {
  return HealthSyncService.getInstance();
}
