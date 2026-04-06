import {
  HealthSampleRepository,
  HealthDeletionQueueRepository,
  type DomainHealthSample,
  type DomainDeletionQueueItem,
} from '../../repositories/health';
import {
  type HealthSyncCoordinationState,
  getHealthSyncCoordinationState,
} from './HealthSyncCoordinationState';
import { logger } from '../../utils/logger';
import {
  computeBatchPayloadHash,
  tryGetMetricDefinitionUnknown,
  HEALTH_CONFIG_VERSION,
  roundMetricValue,
  normalizeTimestampToIso,
  sanitizeMetadata,
} from '@shared/contracts';
import { metrics } from '../metrics/Metrics';
import type { CooperativeYieldController } from '../sync/SyncScheduler';
import { SyncLeaseManager, SyncLeaseDeniedError } from '../sync/SyncLeaseManager';
import { isFeatureEnabled } from '../../config/featureFlags';
import type {
  HealthMetricCode,
  BatchUpsertSamplesRequest,
  BatchUpsertSamplesResponse,
  BatchUpsertSamplesCompletedResponse,
  HealthSample,
  DeletionItem,
} from '@shared/contracts';
export class PreSendValidationError extends Error {
  public readonly code = 'PRE_SEND_VALIDATION_FAILED';
  public readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'PreSendValidationError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PreSendValidationError);
    }
  }
}
export class PayloadTooLargeError extends Error {
  public readonly code = 'PAYLOAD_TOO_LARGE';
  public readonly retryable = true;
  public readonly estimatedBytes: number;
  public readonly limitBytes: number;
  constructor(message: string, estimatedBytes: number = 0, limitBytes: number = 0) {
    super(message);
    this.name = 'PayloadTooLargeError';
    this.estimatedBytes = estimatedBytes;
    this.limitBytes = limitBytes;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PayloadTooLargeError);
    }
  }
}
export function roundNumericValue(value: number, decimals: number = 3): number {
  const factor = Math.pow(10, Math.max(0, Math.floor(decimals)));
  return Math.round(value * factor) / factor;
}
export interface BatchUploadResult {
  readonly success: boolean;
  readonly batchId: string;
  readonly samplesUploaded: number;
  readonly samplesRejected: number;
  readonly samplesFailed: number;
  readonly samplesQuarantined: number; 
  readonly totalSamples: number;
  readonly deletionsUploaded: number;
  readonly deletionsFailed: number;
  readonly totalDeletions: number;
  readonly durationMs: number;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly deferred?: boolean;
}
export interface UploadSessionResult {
  readonly batchesProcessed: number;
  readonly totalSamplesUploaded: number;
  readonly totalSamplesRejected: number;
  readonly totalSamplesFailed: number;
  readonly totalDeletionsUploaded: number;
  readonly totalDeletionsFailed: number;
  readonly totalDurationMs: number;
  readonly batchResults: readonly BatchUploadResult[];
}
export interface HealthUploadHttpClient {
  uploadBatch(
    request: BatchUpsertSamplesRequest,
    authToken: string
  ): Promise<BatchUpsertSamplesResponse>;
}
export interface HealthUploadEnginePorts {
  readonly repository: HealthSampleRepository;
  readonly deletionQueueRepository: HealthDeletionQueueRepository;
  readonly httpClient: HealthUploadHttpClient;
  readonly coordinationState: HealthSyncCoordinationState;
  readonly getAuthToken: () => Promise<string | null>;
  readonly getUserId: () => string | null;
  readonly syncLeaseManager?: SyncLeaseManager;
  readonly delay?: (ms: number) => Promise<void>;
}
export class HealthUploadEngine {
  private readonly repository: HealthSampleRepository;
  private readonly deletionQueueRepository: HealthDeletionQueueRepository;
  private readonly httpClient: HealthUploadHttpClient;
  private readonly coordinationState: HealthSyncCoordinationState;
  private readonly getAuthToken: () => Promise<string | null>;
  private readonly getUserId: () => string | null;
  private readonly syncLeaseManager?: SyncLeaseManager;
  private readonly delayFn: (ms: number) => Promise<void>;
  private initialized = false;
  constructor(ports: HealthUploadEnginePorts) {
    this.repository = ports.repository;
    this.deletionQueueRepository = ports.deletionQueueRepository;
    this.httpClient = ports.httpClient;
    this.coordinationState = ports.coordinationState;
    this.getAuthToken = ports.getAuthToken;
    this.getUserId = ports.getUserId;
    this.syncLeaseManager = ports.syncLeaseManager;
    this.delayFn = ports.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  async initialize(): Promise<number> {
    if (this.initialized) {
      logger.debug('[HealthUploadEngine] Already initialized, skipping crash recovery');
      return 0;
    }
    const userId = this.getUserId();
    if (!userId) {
      logger.debug('[HealthUploadEngine] No user ID available, skipping crash recovery');
      this.initialized = true;
      return 0;
    }
    try {
      logger.info('[HealthUploadEngine] Initializing with comprehensive crash recovery', { userId });
      const releasedSamplesCount = await this.repository.releaseExpiredStagedSamples(userId);
      if (releasedSamplesCount > 0) {
        logger.info('[HealthUploadEngine] Released expired staged samples', {
          userId,
          releasedCount: releasedSamplesCount,
        });
      }
      const recoveredSamplesCount = await this.repository.recoverStuckUploadingSamples(
        userId,
        HealthSampleRepository.STUCK_UPLOADING_THRESHOLD_MS
      );
      if (recoveredSamplesCount > 0) {
        logger.info('[HealthUploadEngine] Recovered stuck uploading samples', {
          userId,
          recoveredCount: recoveredSamplesCount,
          threshold: HealthSampleRepository.STUCK_UPLOADING_THRESHOLD_MS,
        });
      }
      const releasedDeletionsCount = await this.deletionQueueRepository.releaseExpiredStagedDeletions(userId);
      if (releasedDeletionsCount > 0) {
        logger.info('[HealthUploadEngine] Released expired staged deletions', {
          userId,
          releasedCount: releasedDeletionsCount,
        });
      }
      const recoveredDeletionsCount = await this.deletionQueueRepository.recoverStuckUploadingDeletions(userId);
      if (recoveredDeletionsCount > 0) {
        logger.info('[HealthUploadEngine] Recovered stuck uploading deletions', {
          userId,
          recoveredCount: recoveredDeletionsCount,
        });
      }
      const totalRecovered = releasedSamplesCount + recoveredSamplesCount +
        releasedDeletionsCount + recoveredDeletionsCount;
      this.initialized = true;
      return totalRecovered;
    } catch (error: unknown) {
      logger.error('[HealthUploadEngine] Crash recovery failed (non-fatal)', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      this.initialized = true;
      return 0;
    }
  }
  async uploadPendingSamples(
    abortSignal?: AbortSignal,
    yieldController?: CooperativeYieldController
  ): Promise<UploadSessionResult> {
    if (this.coordinationState.isWithinUploadMinInterval()) {
      logger.debug('[HealthUploadEngine] Within min upload interval, skipping', {
        remainingMs: this.coordinationState.HARD_MIN_UPLOAD_INTERVAL_MS -
          (Date.now() - this.coordinationState.lastUploadAttemptTime),
      });
      return this.createEmptyResult();
    }
    if (this.coordinationState.uploadInProgress) {
      const existingPromise = this.coordinationState.activeUploadPromise;
      if (existingPromise) {
        logger.debug('[HealthUploadEngine] Upload already in progress, joining existing session');
        try {
          await existingPromise;
        } catch {
        }
      }
      return this.createEmptyResult();
    }
    if (abortSignal?.aborted) {
      logger.info('[HealthUploadEngine] Upload aborted before starting');
      return this.createEmptyResult();
    }
    const uploadPromise = this.doUploadPendingSamplesInternal(abortSignal, yieldController);
    const acquired = this.coordinationState.acquireUploadLock(uploadPromise);
    if (!acquired) {
      logger.debug('[HealthUploadEngine] Failed to acquire upload lock, concurrent session detected');
      return this.createEmptyResult();
    }
    this.coordinationState.recordUploadAttempt();
    return uploadPromise;
  }
  private async doUploadPendingSamplesInternal(
    abortSignal?: AbortSignal,
    yieldController?: CooperativeYieldController
  ): Promise<UploadSessionResult> {
    const startTime = Date.now();
    const batchResults: BatchUploadResult[] = [];
    logger.info('[HealthUploadEngine] Starting upload session');
    try {
      const userId = this.getUserId();
      if (!userId) {
        logger.warn('[HealthUploadEngine] No user ID available, skipping upload');
        return this.createEmptyResult();
      }
      const authToken = await this.getAuthToken();
      if (this.coordinationState.isInUploadBackoff()) {
        const remainingMs = this.coordinationState.getRemainingUploadBackoffMs();
        logger.info('[HealthUploadEngine] In backoff period', { remainingMs });
        return this.createEmptyResult();
      }
      let batchCount = 0;
      let effectiveBatchSize = this.coordinationState.MAX_BATCH_SIZE;
      let rechunkAttempts = 0;
      const maxBatches = 10; 
      const maxRechunkAttempts = 5; 
      while (batchCount < maxBatches) {
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_upload_batch_start');
        }
        if (abortSignal?.aborted) {
          logger.info('[HealthUploadEngine] Upload aborted - stopping batch loop', {
            batchesCompleted: batchCount,
          });
          break;
        }
        let batchResult: BatchUploadResult | null;
        try {
          batchResult = await this.uploadSingleBatch(
            userId,
            authToken ?? '',
            yieldController,
            effectiveBatchSize < this.coordinationState.MAX_BATCH_SIZE
              ? effectiveBatchSize
              : undefined
          );
        } catch (rechunkError: unknown) {
          if (rechunkError instanceof PayloadTooLargeError) {
            rechunkAttempts++;
            if (rechunkAttempts > maxRechunkAttempts) {
              logger.error('[HealthUploadEngine] RECHUNK LIMIT EXCEEDED: Cannot reduce batch size further', {
                effectiveBatchSize,
                rechunkAttempts,
                maxRechunkAttempts,
                estimatedBytes: rechunkError.estimatedBytes,
                limitBytes: rechunkError.limitBytes,
              });
              this.coordinationState.recordUploadError();
              break;
            }
            const previousSize = effectiveBatchSize;
            effectiveBatchSize = Math.max(1, Math.floor(effectiveBatchSize / 2));
            logger.info('[HealthUploadEngine] Auto-rechunking: halving batch size', {
              previousSize,
              newSize: effectiveBatchSize,
              rechunkAttempt: rechunkAttempts,
              maxRechunkAttempts,
            });
            continue;
          }
          throw rechunkError;
        }
        if (!batchResult) {
          break;
        }
        rechunkAttempts = 0;
        batchResults.push(batchResult);
        batchCount++;
        if (!batchResult.success && !batchResult.retryable) {
          logger.warn('[HealthUploadEngine] Non-retryable batch failure, stopping', {
            batchId: batchResult.batchId,
            failureReason: batchResult.errorMessage,
          });
          break;
        }
        if (!batchResult.success) {
          this.coordinationState.recordUploadError();
          if (batchResult.deferred) {
            logger.info('[HealthUploadEngine] Batch deferred (server processing), backoff escalated', {
              batchId: batchResult.batchId,
              backoffMs: this.coordinationState.uploadBackoffMs,
              consecutiveErrors: this.coordinationState.consecutiveUploadErrors,
              reason: batchResult.errorMessage,
            });
          } else {
            logger.info('[HealthUploadEngine] Batch upload failed, entering backoff', {
              batchId: batchResult.batchId,
              backoffMs: this.coordinationState.uploadBackoffMs,
              consecutiveErrors: this.coordinationState.consecutiveUploadErrors,
            });
          }
          break;
        }
        await this.delay(this.coordinationState.INTER_BATCH_UPLOAD_DELAY_MS);
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_upload_batch_end');
        }
      }
      const allBatchesSucceeded = batchResults.length > 0 && batchResults.every((r) => r.success);
      if (allBatchesSucceeded) {
        this.coordinationState.clearUploadBackoff();
      }
      const result = this.aggregateBatchResults(batchResults, Date.now() - startTime);
      logger.info('[HealthUploadEngine] Upload session complete', {
        batchesProcessed: result.batchesProcessed,
        samplesUploaded: result.totalSamplesUploaded,
        samplesRejected: result.totalSamplesRejected,
        samplesFailed: result.totalSamplesFailed,
        durationMs: result.totalDurationMs,
      });
      metrics.trackEvent('metricsHealth', 'health_upload_session_summary', {
        batches_processed: result.batchesProcessed,
        samples_uploaded: result.totalSamplesUploaded,
        samples_failed: result.totalSamplesFailed,
        samples_rejected: result.totalSamplesRejected,
        deletions_uploaded: result.totalDeletionsUploaded,
        deletions_failed: result.totalDeletionsFailed,
        duration_ms: result.totalDurationMs,
      });
      return result;
    } catch (error: unknown) {
      logger.error('[HealthUploadEngine] Upload session failed', {
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
        durationMs: Date.now() - startTime,
      });
      this.coordinationState.recordUploadError();
      return {
        batchesProcessed: batchResults.length,
        totalSamplesUploaded: batchResults.reduce((sum, r) => sum + r.samplesUploaded, 0),
        totalSamplesRejected: batchResults.reduce((sum, r) => sum + r.samplesRejected, 0),
        totalSamplesFailed: batchResults.reduce((sum, r) => sum + r.samplesFailed, 0),
        totalDeletionsUploaded: batchResults.reduce((sum, r) => sum + r.deletionsUploaded, 0),
        totalDeletionsFailed: batchResults.reduce((sum, r) => sum + r.deletionsFailed, 0),
        totalDurationMs: Date.now() - startTime,
        batchResults,
      };
    }
  }
  async uploadSingleBatch(
    userId: string,
    authToken: string,
    yieldController?: CooperativeYieldController,
    batchSizeOverride?: number
  ): Promise<BatchUploadResult | null> {
    const startTime = Date.now();
    const effectiveMaxBatchSize = batchSizeOverride ?? this.coordinationState.MAX_BATCH_SIZE;
    const deferredSampleBatch = await this.repository.getDeferredBatch(userId);
    const sampleStageResult = deferredSampleBatch
      ? { batchId: deferredSampleBatch.batchId, requestId: deferredSampleBatch.requestId }
      : await this.repository.stageForUpload(
          userId,
          effectiveMaxBatchSize
        );
    const deferredDeletionBatch = !sampleStageResult
      ? await this.deletionQueueRepository.getDeferredBatch(userId)
      : null;
    const deletionStageResult = deferredDeletionBatch
      ? { batchId: deferredDeletionBatch.batchId, requestId: deferredDeletionBatch.requestId }
      : (!deferredSampleBatch
          ? await this.deletionQueueRepository.stageForUpload(
              userId,
              effectiveMaxBatchSize,
              sampleStageResult ? {
                batchId: sampleStageResult.batchId,
                requestId: sampleStageResult.requestId,
              } : undefined
            )
          : null);
    if (yieldController) {
      await yieldController.yieldIfNeeded('health_upload_stage_complete');
    }
    if (!sampleStageResult && !deletionStageResult) {
      logger.debug('[HealthUploadEngine] No samples or deletions to upload');
      return null;
    }
    const batchId = sampleStageResult?.batchId ?? deletionStageResult?.batchId ?? '';
    const requestId = sampleStageResult?.requestId ?? deletionStageResult?.requestId ?? '';
    logger.debug('[HealthUploadEngine] Staged batch for upload', {
      batchId,
      requestId,
      hasSamples: !!sampleStageResult,
      hasDeletions: !!deletionStageResult,
      reusedSampleBatch: !!deferredSampleBatch,
      reusedDeletionBatch: !!deferredDeletionBatch,
    });
    let quarantinedCount = 0;
    let stagedDeletions: DomainDeletionQueueItem[] = [];
    let serializationDurationMs: number | null = null;
    let payloadHashDurationMs: number | undefined = undefined;
    try {
      const samples = sampleStageResult
        ? await this.repository.getStagedSamples(sampleStageResult.batchId)
        : [];
      const deletionBatchId = deletionStageResult?.batchId ?? sampleStageResult?.batchId;
      stagedDeletions = deletionBatchId
        ? await this.deletionQueueRepository.getStagedDeletions(deletionBatchId)
        : [];
      if (samples.length === 0 && stagedDeletions.length === 0) {
        logger.warn('[HealthUploadEngine] Staged batch has no samples or deletions', { batchId });
        return null;
      }
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_upload_retrieve_complete');
      }
      if (deferredSampleBatch || deferredDeletionBatch) {
        const now = Date.now();
        const nextDeletionAttempt = stagedDeletions
          .map((d) => d.nextUploadAttemptAt)
          .filter((t): t is number => t != null)
          .sort((a, b) => a - b)[0];
        if (nextDeletionAttempt != null && nextDeletionAttempt > now) {
          const retryAfterMs = nextDeletionAttempt - now;
          this.coordinationState.setUploadBackoffMs(retryAfterMs, 'deferred_batch_not_ready');
          return {
            success: false,
            batchId,
            samplesUploaded: 0,
            samplesRejected: 0,
            samplesFailed: 0,
            samplesQuarantined: 0,
            totalSamples: samples.length,
            deletionsUploaded: 0,
            deletionsFailed: 0,
            totalDeletions: stagedDeletions.length,
            durationMs: Date.now() - startTime,
            errorMessage: 'Deferred batch not ready for retry',
            retryable: true,
            deferred: true,
          };
        }
      }
      let leaseId: string | undefined;
      const shouldUseLease = !!this.syncLeaseManager && isFeatureEnabled('syncLease');
      const isDeferredBatch = !!deferredSampleBatch || !!deferredDeletionBatch;
      if (shouldUseLease) {
        try {
          leaseId = await this.syncLeaseManager!.getLeaseId({
            kind: 'health_upload',
            requestedBatchSize: samples.length + stagedDeletions.length,
          });
        } catch (error) {
          if (error instanceof SyncLeaseDeniedError) {
            const retryAfterMs = error.retryAfterMs ?? 60_000;
            if (isDeferredBatch) {
              await this.repository.deferBatchForRetry(userId, batchId, retryAfterMs);
              if (batchId) {
                await this.deletionQueueRepository.deferBatchForRetry(userId, batchId, retryAfterMs);
              }
            } else {
              if (batchId) {
                await this.repository.unstageBatch(batchId);
                await this.deletionQueueRepository.unstageBatch(userId, batchId);
              }
            }
            this.coordinationState.setUploadBackoffMs(retryAfterMs, 'sync_lease_denied');
            return {
              success: false,
              batchId,
              samplesUploaded: 0,
              samplesRejected: 0,
              samplesFailed: 0,
              samplesQuarantined: 0,
              totalSamples: samples.length,
              deletionsUploaded: 0,
              deletionsFailed: 0,
              totalDeletions: stagedDeletions.length,
              durationMs: Date.now() - startTime,
              errorMessage: error.message,
              retryable: true,
            };
          }
          throw error;
        }
      }
      if (samples.length > 0) {
        await this.repository.markUploading(userId, samples.map((s) => s.id));
      }
      if (stagedDeletions.length > 0) {
        await this.deletionQueueRepository.markUploading(
          userId,
          stagedDeletions.map((d) => d.id)
        );
      }
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_upload_mark_uploading');
      }
      const buildStartTime = Date.now();
      const {
        request,
        quarantinedIds,
        metricQuarantinedIds,
        categoryQuarantinedIds,
        numericValidationQuarantinedIds,
        durationQuarantinedIds,
        payloadHashDurationMs: buildPayloadHashDurationMs,
      } = await this.buildUploadRequest(
        samples,
        stagedDeletions,
        requestId,
        leaseId,
        yieldController
      );
      serializationDurationMs = Date.now() - buildStartTime;
      payloadHashDurationMs = buildPayloadHashDurationMs;
      quarantinedCount = quarantinedIds.length;
      if (metricQuarantinedIds.length > 0) {
        await this.repository.markRejected(userId, metricQuarantinedIds, 'INVALID_METRIC_CODE');
        logger.warn('[HealthUploadEngine] Quarantined samples with invalid metric codes', {
          batchId,
          quarantinedCount: metricQuarantinedIds.length,
        });
      }
      if (categoryQuarantinedIds.length > 0) {
        await this.repository.markRejected(userId, categoryQuarantinedIds, 'MISSING_CATEGORY_CODE');
        logger.warn('[HealthUploadEngine] Quarantined CATEGORY samples missing categoryCode', {
          batchId,
          quarantinedCount: categoryQuarantinedIds.length,
        });
      }
      if (numericValidationQuarantinedIds.length > 0) {
        await this.repository.markRejected(userId, numericValidationQuarantinedIds, 'MISSING_NUMERIC_VALUE');
        logger.warn('[HealthUploadEngine] Quarantined numeric samples missing value or unit', {
          batchId,
          quarantinedCount: numericValidationQuarantinedIds.length,
        });
      }
      if (durationQuarantinedIds.length > 0) {
        await this.repository.markRejected(userId, durationQuarantinedIds, 'MISSING_DURATION_SECONDS');
        logger.warn('[HealthUploadEngine] Quarantined INTERVAL_NUM samples missing durationSeconds', {
          batchId,
          quarantinedCount: durationQuarantinedIds.length,
        });
      }
      if (request.samples.length === 0 && request.deleted.length === 0) {
        return {
          success: true, 
          batchId,
          samplesUploaded: 0,
          samplesRejected: 0,
          samplesFailed: 0,
          samplesQuarantined: quarantinedCount,
          totalSamples: samples.length,
          deletionsUploaded: 0,
          deletionsFailed: 0,
          totalDeletions: 0,
          durationMs: Date.now() - startTime,
          retryable: false,
        };
      }
      const maxBatchSize = this.coordinationState.MAX_BATCH_SIZE;
      if (request.samples.length > maxBatchSize) {
        const errorMsg = `PRE-SEND VALIDATION FAILED: Batch size ${request.samples.length} exceeds contract maximum ${maxBatchSize}. This indicates a bug in staging logic.`;
        logger.error(`[HealthUploadEngine] ${errorMsg}`, {
          batchId,
          actualSize: request.samples.length,
          maxAllowed: maxBatchSize,
        });
        throw new PreSendValidationError(errorMsg);
      }
      const estimatedBytes = this.estimateRequestBytes(request);
      if (estimatedBytes > this.coordinationState.MAX_BATCH_BYTES) {
        logger.warn('[HealthUploadEngine] PAYLOAD_TOO_LARGE: Pre-send byte estimate exceeds limit', {
          batchId,
          estimatedBytes,
          maxBytes: this.coordinationState.MAX_BATCH_BYTES,
          sampleCount: request.samples.length,
          deletionCount: request.deleted.length,
          avgBytesPerSample: request.samples.length > 0
            ? Math.round(estimatedBytes / request.samples.length)
            : 0,
        });
        throw new PayloadTooLargeError(
          `Payload ${estimatedBytes} bytes exceeds limit ${this.coordinationState.MAX_BATCH_BYTES}`,
          estimatedBytes,
          this.coordinationState.MAX_BATCH_BYTES
        );
      }
      const uploadStartTime = Date.now();
      const response = await this.httpClient.uploadBatch(request, authToken);
      const responseDurationMs = Date.now() - uploadStartTime;
      if ('processing' in response.data && response.data.processing) {
        const retryAfterMs = response.data.retryAfterMs ?? 60_000;
        await this.repository.deferBatchForRetry(userId, batchId, retryAfterMs);
        if (batchId) {
          await this.deletionQueueRepository.deferBatchForRetry(userId, batchId, retryAfterMs);
        }
        this.coordinationState.setUploadBackoffMs(retryAfterMs, 'server_processing');
        return {
          success: false,
          batchId,
          samplesUploaded: 0,
          samplesRejected: 0,
          samplesFailed: 0,
          samplesQuarantined: quarantinedCount,
          totalSamples: request.samples.length,
          deletionsUploaded: 0,
          deletionsFailed: 0,
          totalDeletions: request.deleted.length,
          durationMs: Date.now() - startTime,
          errorMessage: 'Server processing in progress',
          retryable: true,
          deferred: true,
        };
      }
      const validSamples = samples.filter((s) => !quarantinedIds.includes(s.id));
      const result = await this.processUploadResponse(
        userId,
        batchId,
        validSamples,
        stagedDeletions,
        response as BatchUpsertSamplesCompletedResponse,
        startTime,
        quarantinedCount,
        yieldController
      );
      if (metrics.isEnabled('metricsHealth')) {
        metrics.trackEvent('metricsHealth', 'health_upload_batch_timing', {
          batch_id: batchId,
          samples_sent: request.samples.length,
          deletions_sent: request.deleted.length,
          quarantined_count: quarantinedCount,
          serialize_ms: serializationDurationMs ?? 0,
          payload_hash_ms: payloadHashDurationMs ?? 0,
          response_ms: responseDurationMs,
          retryable: result.retryable,
          consecutive_upload_errors: this.coordinationState.consecutiveUploadErrors,
        });
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof PayloadTooLargeError) {
        if (batchId) {
          await this.repository.unstageBatch(batchId);
          await this.deletionQueueRepository.unstageBatch(userId, batchId);
        }
        logger.info('[HealthUploadEngine] Unstaged oversized batch for rechunking', {
          batchId,
          estimatedBytes: error.estimatedBytes,
          limitBytes: error.limitBytes,
        });
        throw error;
      }
      const samples = sampleStageResult
        ? await this.repository.getStagedSamples(sampleStageResult.batchId)
        : [];
      const sampleIds = samples.map((s) => s.id);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorClassification = this.classifyError(error);
      const isRetryable = errorClassification.retryable;
      if (errorClassification.code === 'PROCESSING') {
        const retryAfterMs = errorClassification.retryAfterMs ?? 30_000;
        if (batchId) {
          await this.repository.deferBatchForRetry(userId, batchId, retryAfterMs);
          await this.deletionQueueRepository.deferBatchForRetry(userId, batchId, retryAfterMs);
        }
        this.coordinationState.setUploadBackoffMs(retryAfterMs, 'server_processing');
        return {
          success: false,
          batchId,
          samplesUploaded: 0,
          samplesRejected: 0,
          samplesFailed: 0,
          samplesQuarantined: quarantinedCount,
          totalSamples: sampleIds.length,
          deletionsUploaded: 0,
          deletionsFailed: 0,
          totalDeletions: stagedDeletions.length,
          durationMs: Date.now() - startTime,
          errorMessage,
          retryable: true,
          deferred: true,
        };
      }
      if (errorClassification.code === 'PAYLOAD_TOO_LARGE') {
        if (batchId) {
          await this.repository.unstageBatch(batchId);
          await this.deletionQueueRepository.unstageBatch(userId, batchId);
        }
        logger.info('[HealthUploadEngine] Unstaged batch after server 413, will rechunk', {
          batchId,
          sampleCount: sampleIds.length,
          deletionCount: stagedDeletions.length,
        });
        throw new PayloadTooLargeError(
          `Server returned 413 for batch with ${sampleIds.length} samples`,
          0, 
          this.coordinationState.MAX_BATCH_BYTES
        );
      }
      if (metrics.isEnabled('metricsHealth')) {
        metrics.trackEvent('metricsHealth', 'health_upload_batch_failure', {
          batch_id: batchId,
          samples_sent: sampleIds.length,
          deletions_sent: stagedDeletions.length,
          quarantined_count: quarantinedCount,
          serialize_ms: serializationDurationMs ?? 0,
          payload_hash_ms: payloadHashDurationMs ?? 0,
          retryable: isRetryable,
          error_code: errorClassification.code,
          retry_after_ms: errorClassification.retryAfterMs ?? 0,
          consecutive_upload_errors: this.coordinationState.consecutiveUploadErrors,
        });
      }
      if (sampleIds.length > 0) {
        await this.repository.markFailed(userId, sampleIds, errorMessage, isRetryable);
      }
      if (stagedDeletions.length > 0) {
        await this.deletionQueueRepository.markFailed(
          userId,
          stagedDeletions.map((d) => d.id),
          errorMessage,
          isRetryable
        );
      }
      if (isRetryable && errorClassification.retryAfterMs != null) {
        this.coordinationState.setUploadBackoffMs(
          errorClassification.retryAfterMs,
          `Server-provided: ${errorClassification.code}`
        );
        logger.info('[HealthUploadEngine] Using server-provided backoff', {
          batchId,
          retryAfterMs: errorClassification.retryAfterMs,
          errorCode: errorClassification.code,
        });
      }
      logger.error('[HealthUploadEngine] Batch upload failed', {
        batchId,
        sampleCount: sampleIds.length,
        deletionCount: stagedDeletions.length,
        isRetryable,
        errorCode: errorClassification.code,
        retryAfterMs: errorClassification.retryAfterMs,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      return {
        success: false,
        batchId,
        samplesUploaded: 0,
        samplesRejected: 0,
        samplesFailed: sampleIds.length,
        samplesQuarantined: quarantinedCount,
        totalSamples: sampleIds.length + quarantinedCount,
        deletionsUploaded: 0,
        deletionsFailed: stagedDeletions.length,
        totalDeletions: stagedDeletions.length,
        durationMs: Date.now() - startTime,
        errorMessage,
        retryable: isRetryable,
      };
    }
  }
  private estimateRequestBytes(request: BatchUpsertSamplesRequest): number {
    return JSON.stringify(request).length;
  }
  private async buildUploadRequest(
    samples: readonly DomainHealthSample[],
    deletions: readonly DomainDeletionQueueItem[],
    requestId: string,
    leaseId?: string,
    yieldController?: CooperativeYieldController
  ): Promise<{
    request: BatchUpsertSamplesRequest;
    quarantinedIds: string[];
    metricQuarantinedIds: string[];
    categoryQuarantinedIds: string[];
    numericValidationQuarantinedIds: string[];
    durationQuarantinedIds: string[];
    payloadHashDurationMs?: number;
  }> {
    const precisionEnabled = isFeatureEnabled('healthPrecisionV3');
    const validSamples: DomainHealthSample[] = [];
    const metricQuarantinedIds: string[] = [];
    const categoryQuarantinedIds: string[] = [];
    const numericValidationQuarantinedIds: string[] = [];
    const durationQuarantinedIds: string[] = [];
    for (const sample of samples) {
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_upload_validate_metric');
      }
      const metricDef = tryGetMetricDefinitionUnknown(sample.sampleType);
      if (!metricDef) {
        logger.warn('[HealthUploadEngine] Invalid metric code, quarantining sample', {
          sampleId: sample.id,
          metricCode: sample.sampleType,
        });
        metricQuarantinedIds.push(sample.id);
        continue;
      }
      validSamples.push(sample);
    }
    const contractDeletions: DeletionItem[] = [];
    for (const deletion of deletions) {
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_upload_map_deletion');
      }
      contractDeletions.push({
        sourceId: deletion.sourceId,
        sourceRecordId: deletion.sourceRecordId.toLowerCase(),
        startAt: deletion.startTimestampMs !== null
          ? normalizeTimestampToIso(deletion.startTimestampMs)
          : undefined,
        deletedAt: deletion.deletedAtMs !== null
          ? normalizeTimestampToIso(deletion.deletedAtMs)
          : normalizeTimestampToIso(Date.now()),
      });
    }
    let allQuarantinedIds = [
      ...metricQuarantinedIds,
      ...categoryQuarantinedIds,
      ...durationQuarantinedIds,
    ];
    if (validSamples.length === 0 && contractDeletions.length === 0) {
      const payloadHashStart = Date.now();
      const payloadHash = await computeBatchPayloadHash({ samples: [], deleted: [] });
      const payloadHashDurationMs = Date.now() - payloadHashStart;
      return {
        request: {
          requestId,
          payloadHash,
          ...(leaseId ? { leaseId } : {}),
          configVersion: precisionEnabled ? HEALTH_CONFIG_VERSION : 2,
          samples: [],
          deleted: [],
        },
        quarantinedIds: allQuarantinedIds,
        metricQuarantinedIds,
        categoryQuarantinedIds,
        numericValidationQuarantinedIds,
        durationQuarantinedIds,
        payloadHashDurationMs,
      };
    }
    const contractSamples: HealthSample[] = [];
    for (const sample of validSamples) {
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_upload_map_sample');
      }
      const metricDef = tryGetMetricDefinitionUnknown(sample.sampleType)!;
      const metricCode = sample.sampleType as HealthMetricCode;
      const valueKind = metricDef.valueKind;
      const sanitizedMetadata = sample.metadata != null
        ? sanitizeMetadata(sample.metadata as Record<string, unknown>)
        : null;
      const baseFields = {
        sourceId: sample.sourceId,
        sourceRecordId: sample.sourceRecordId.toLowerCase(),
        metricCode,
        startAt: normalizeTimestampToIso(sample.startTimestamp),
        endAt: normalizeTimestampToIso(sample.endTimestamp),
        ...(sample.durationSeconds != null && { durationSeconds: sample.durationSeconds }),
        ...(sample.deviceId != null && { deviceId: sample.deviceId }),
        ...(sample.externalUuid != null && { externalUuid: sample.externalUuid }),
        ...(sanitizedMetadata != null && { metadata: sanitizedMetadata }),
      };
      if (valueKind === 'CATEGORY') {
        let categoryCode: string | null = null;
        if (sample.categoryCode) {
          categoryCode = sample.categoryCode;
        } else if (sample.unit?.startsWith('category:')) {
          categoryCode = sample.unit.substring('category:'.length);
        } else if (sample.metadata && typeof sample.metadata === 'object' && 'categoryCode' in sample.metadata) {
          categoryCode = String(sample.metadata.categoryCode);
        }
        if (!categoryCode || categoryCode.trim() === '') {
          logger.warn('[HealthUploadEngine] CATEGORY sample missing categoryCode, quarantining', {
            sampleId: sample.id,
            metricCode: sample.sampleType,
            attemptedSources: ['categoryCode column', 'unit prefix', 'metadata'],
          });
          categoryQuarantinedIds.push(sample.id);
          continue;
        }
        contractSamples.push({
          ...baseFields,
          valueKind: 'CATEGORY' as const,
          categoryCode,
        } as HealthSample);
        continue;
      }
      if (sample.value == null || sample.unit == null) {
        logger.warn('[HealthUploadEngine] Numeric sample missing value or unit, quarantining', {
          sampleId: sample.id,
          metricCode: sample.sampleType,
          valueKind,
          hasValue: sample.value != null,
          hasUnit: sample.unit != null,
        });
        numericValidationQuarantinedIds.push(sample.id);
        continue;
      }
      if (valueKind === 'INTERVAL_NUM' && sample.durationSeconds == null) {
        logger.warn('[HealthUploadEngine] INTERVAL_NUM sample missing durationSeconds, quarantining', {
          sampleId: sample.id,
          metricCode: sample.sampleType,
        });
        durationQuarantinedIds.push(sample.id);
        continue;
      }
      const roundedValue = precisionEnabled
        ? roundMetricValue(metricCode, sample.value)
        : roundNumericValue(sample.value);
      contractSamples.push({
        ...baseFields,
        valueKind,
        value: roundedValue,   
        unit: sample.unit,     
      } as HealthSample);
    }
    allQuarantinedIds = [
      ...metricQuarantinedIds,
      ...categoryQuarantinedIds,
      ...numericValidationQuarantinedIds,
      ...durationQuarantinedIds,
    ];
    const deletionsForHash = contractDeletions.map((d) => ({
      sourceId: d.sourceId,
      sourceRecordId: d.sourceRecordId,
      startAt: d.startAt,
    }));
    const payloadHashStart = Date.now();
    const payloadHash = await computeBatchPayloadHash({
      samples: contractSamples as Array<Record<string, unknown>>,
      deleted: deletionsForHash,
      configVersion: precisionEnabled ? HEALTH_CONFIG_VERSION : 2,
    });
    const payloadHashDurationMs = Date.now() - payloadHashStart;
    return {
      request: {
        requestId,
        payloadHash,
        ...(leaseId ? { leaseId } : {}),
        configVersion: precisionEnabled ? HEALTH_CONFIG_VERSION : 2,
        samples: contractSamples,
        deleted: contractDeletions,
      },
      quarantinedIds: allQuarantinedIds,
      metricQuarantinedIds,
      categoryQuarantinedIds,
      numericValidationQuarantinedIds,
      durationQuarantinedIds,
      payloadHashDurationMs,
    };
  }
  private static makeSampleCompositeKey(
    sourceId: string,
    sourceRecordId: string,
    startTimestamp: number
  ): string {
    return `${sourceId}|${sourceRecordId}|${startTimestamp}`;
  }
  private static normalizeTimestampToMs(isoString: string): number {
    return new Date(isoString).getTime();
  }
  private async processUploadResponse(
    userId: string,
    batchId: string,
    samples: readonly DomainHealthSample[],
    deletions: readonly DomainDeletionQueueItem[],
    response: BatchUpsertSamplesCompletedResponse,
    startTime: number,
    quarantinedCount: number = 0,
    yieldController?: CooperativeYieldController
  ): Promise<BatchUploadResult> {
    const sampleByCompositeKey = new Map<string, DomainHealthSample>();
    for (const sample of samples) {
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_upload_index_samples');
      }
      const key = HealthUploadEngine.makeSampleCompositeKey(
        sample.sourceId,
        sample.sourceRecordId,
        sample.startTimestamp
      );
      sampleByCompositeKey.set(key, sample);
    }
    const uploadedIds: string[] = [];
    const rejectedIds: string[] = [];        
    const retryableFailedIds: string[] = []; 
    const failureReasons: Map<string, string> = new Map();
    for (const successful of response.data.successful) {
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_upload_process_success');
      }
      const startAtMs = HealthUploadEngine.normalizeTimestampToMs(successful.startAt);
      const key = HealthUploadEngine.makeSampleCompositeKey(
        successful.sourceId,
        successful.sourceRecordId,
        startAtMs
      );
      const sample = sampleByCompositeKey.get(key);
      if (sample) {
        uploadedIds.push(sample.id);
      }
    }
    for (const failed of response.data.failed) {
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_upload_process_failed');
      }
      const startAtMs = HealthUploadEngine.normalizeTimestampToMs(failed.startAt);
      const key = HealthUploadEngine.makeSampleCompositeKey(
        failed.sourceId,
        failed.sourceRecordId,
        startAtMs
      );
      const sample = sampleByCompositeKey.get(key);
      if (sample) {
        const reason = `${failed.errorCode}: ${failed.error}`;
        failureReasons.set(sample.id, reason);
        if (failed.retryable) {
          retryableFailedIds.push(sample.id);
        } else {
          rejectedIds.push(sample.id);
        }
      }
    }
    if (uploadedIds.length > 0) {
      await this.repository.markUploaded(userId, uploadedIds);
    }
    if (rejectedIds.length > 0) {
      for (const id of rejectedIds) {
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_upload_mark_rejected');
        }
        const reason = failureReasons.get(id) ?? 'Unknown rejection reason';
        await this.repository.markRejected(userId, [id], reason);
      }
    }
    if (retryableFailedIds.length > 0) {
      for (const id of retryableFailedIds) {
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_upload_mark_failed');
        }
        const reason = failureReasons.get(id) ?? 'Unknown error';
        await this.repository.markFailed(userId, [id], reason, true);
      }
    }
    const processedIds = new Set([...uploadedIds, ...rejectedIds, ...retryableFailedIds]);
    const missingIds = samples
      .filter((s) => !processedIds.has(s.id))
      .map((s) => s.id);
    if (missingIds.length > 0) {
      await this.repository.markFailed(userId, missingIds, 'Not in server response', true);
    }
    const totalSamplesFailed = retryableFailedIds.length + missingIds.length;
    const deletionByPreciseKey = new Map<string, DomainDeletionQueueItem>();
    const deletionByLegacyKey = new Map<string, DomainDeletionQueueItem>();
    for (const deletion of deletions) {
      if (yieldController) {
        await yieldController.yieldIfNeeded('health_upload_index_deletions');
      }
      const preciseKey = `${deletion.sourceId}|${deletion.sourceRecordId}|${deletion.startTimestampMs}`;
      deletionByPreciseKey.set(preciseKey, deletion);
      const legacyKey = `${deletion.sourceId}|${deletion.sourceRecordId}`;
      if (!deletionByLegacyKey.has(legacyKey)) {
        deletionByLegacyKey.set(legacyKey, deletion);
      }
    }
    const deletionUploadedIds: number[] = [];
    const deletionFailedIds: number[] = [];
    const deletionFailureReasons: Map<number, string> = new Map();
    const deletionRetryableFlags: Map<number, boolean> = new Map();
    const findDeletion = (
      sourceId: string,
      sourceRecordId: string,
      startAt?: string
    ): DomainDeletionQueueItem | undefined => {
      if (startAt) {
        const startTimestampMs = new Date(startAt).getTime();
        const preciseKey = `${sourceId}|${sourceRecordId}|${startTimestampMs}`;
        const precise = deletionByPreciseKey.get(preciseKey);
        if (precise) return precise;
      }
      const legacyKey = `${sourceId}|${sourceRecordId}`;
      return deletionByLegacyKey.get(legacyKey);
    };
    if (response.data.deletions) {
      for (const successful of response.data.deletions.successful) {
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_upload_deletion_success');
        }
        const deletion = findDeletion(
          successful.sourceId,
          successful.sourceRecordId,
          successful.startAt
        );
        if (deletion) {
          deletionUploadedIds.push(deletion.id);
        }
      }
      for (const failed of response.data.deletions.failed) {
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_upload_deletion_failed');
        }
        const deletion = findDeletion(
          failed.sourceId,
          failed.sourceRecordId,
          failed.startAt
        );
        if (deletion) {
          const reason = `${failed.errorCode}: ${failed.error}`;
          deletionFailureReasons.set(deletion.id, reason);
          if (failed.errorCode === 'DELETE_NOT_FOUND') {
            deletionUploadedIds.push(deletion.id);
          } else if (failed.retryable) {
            deletionFailedIds.push(deletion.id);
            deletionRetryableFlags.set(deletion.id, true);
          } else {
            deletionFailedIds.push(deletion.id);
            deletionRetryableFlags.set(deletion.id, false);
          }
        }
      }
    }
    if (deletionUploadedIds.length > 0) {
      await this.deletionQueueRepository.markUploaded(userId, deletionUploadedIds);
    }
    const processedDeletionIds = new Set([...deletionUploadedIds, ...deletionFailedIds]);
    const missingDeletions = deletions.filter((d) => !processedDeletionIds.has(d.id));
    const allFailedDeletionIds = [
      ...deletionFailedIds,
      ...missingDeletions.map((d) => d.id),
    ];
    if (allFailedDeletionIds.length > 0) {
      for (const id of allFailedDeletionIds) {
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_upload_mark_deletion_failed');
        }
        const reason = deletionFailureReasons.get(id) ?? 'Not in server response';
        const hasServerResponse = deletionRetryableFlags.has(id);
        const isRetryable = hasServerResponse
          ? deletionRetryableFlags.get(id)!  
          : true;                             
        await this.deletionQueueRepository.markFailed(userId, [id], reason, isRetryable);
      }
    }
    const sampleSuccess = samples.length === 0 || (uploadedIds.length > 0 && totalSamplesFailed === 0);
    const deletionSuccess = deletions.length === 0 || deletionUploadedIds.length > 0;
    const success = sampleSuccess && deletionSuccess;
    logger.info('[HealthUploadEngine] Batch processed', {
      batchId,
      samplesUploaded: uploadedIds.length,
      samplesRejected: rejectedIds.length,
      samplesQuarantined: quarantinedCount,
      samplesRetryableFailed: retryableFailedIds.length,
      samplesMissing: missingIds.length,
      totalSamples: samples.length,
      deletionsUploaded: deletionUploadedIds.length,
      deletionsFailed: allFailedDeletionIds.length,
      totalDeletions: deletions.length,
      success,
    });
    return {
      success,
      batchId,
      samplesUploaded: uploadedIds.length,
      samplesRejected: rejectedIds.length,
      samplesFailed: totalSamplesFailed,
      samplesQuarantined: quarantinedCount,
      totalSamples: samples.length + quarantinedCount,
      deletionsUploaded: deletionUploadedIds.length,
      deletionsFailed: allFailedDeletionIds.length,
      totalDeletions: deletions.length,
      durationMs: Date.now() - startTime,
      retryable: totalSamplesFailed > 0 || allFailedDeletionIds.length > 0,
    };
  }
  private classifyError(error: unknown): {
    retryable: boolean;
    retryAfterMs?: number;
    code: string;
  } {
    if (typeof error === 'object' && error !== null) {
      const errObj = error as Record<string, unknown>;
      const httpStatus =
        (errObj as { statusCode?: number }).statusCode ??
        (errObj as { status?: number }).status;
      if (httpStatus === 409) {
        return this.classifyHttpStatus(409);
      }
    }
    if (typeof error === 'object' && error !== null) {
      const err = error as Record<string, unknown>;
      if ('retryable' in err && typeof err.retryable === 'boolean') {
        return {
          retryable: err.retryable,
          retryAfterMs: typeof err.retryAfterMs === 'number' ? err.retryAfterMs : undefined,
          code: typeof err.code === 'string' ? err.code : 'UNKNOWN',
        };
      }
      if ('error' in err && typeof err.error === 'object' && err.error !== null) {
        const innerErr = err.error as Record<string, unknown>;
        if ('retryable' in innerErr && typeof innerErr.retryable === 'boolean') {
          return {
            retryable: innerErr.retryable,
            retryAfterMs: typeof innerErr.retryAfterMs === 'number' ? innerErr.retryAfterMs : undefined,
            code: typeof innerErr.code === 'string' ? innerErr.code : 'UNKNOWN',
          };
        }
      }
      const status =
        (err as { status?: number }).status ??
        (err as { statusCode?: number }).statusCode ??
        (err as { code?: number }).code;
      if (typeof status === 'number') {
        return this.classifyHttpStatus(status);
      }
    }
    if (error instanceof PreSendValidationError) {
      return { retryable: false, code: error.code };
    }
    if (error instanceof PayloadTooLargeError) {
      return {
        retryable: true,
        retryAfterMs: 1_000,
        code: error.code,
      };
    }
    if (error instanceof SyncLeaseDeniedError) {
      return {
        retryable: true,
        retryAfterMs: error.retryAfterMs ?? 60_000,
        code: 'SYNC_LEASE_DENIED',
      };
    }
    if (error instanceof TypeError) {
      const message = error.message.toLowerCase();
      const isNetworkTypeError =
        message.includes('network request failed') ||
        message.includes('failed to fetch') ||
        message.includes('fetch failed') ||
        message.includes('load failed') ||
        message.includes('network error') ||
        message.includes('request failed');
      if (isNetworkTypeError) {
        logger.debug('[HealthUploadEngine] TypeError classified as network error (retryable)', {
          message: error.message,
        });
        return { retryable: true, code: 'NETWORK_ERROR' };
      }
      const isPropertyAccessError =
        message.includes('cannot read property') ||
        message.includes('cannot read properties') ||
        message.includes('is not a function') ||
        message.includes('is not iterable') ||
        message.includes('is undefined') ||
        message.includes('is null');
      if (isPropertyAccessError) {
        logger.error('[HealthUploadEngine] TypeError classified as CODE BUG (NOT retryable)', {
          message: error.message,
          errorType: 'CODE_ERROR',
          stack: error.stack?.split('\n').slice(0, 5).join('\n'), 
        });
        return { retryable: false, code: 'CODE_ERROR' };
      }
      logger.warn('[HealthUploadEngine] Unknown TypeError - defaulting to non-retryable', {
        message: error.message,
        errorName: error.name,
      });
      return { retryable: false, code: 'UNKNOWN_TYPE_ERROR' };
    }
    if (error instanceof Error) {
      const errWithStatus = error as Error & {
        status?: number;
        statusCode?: number;
        response?: { status?: number };
      };
      const status =
        errWithStatus.status ??
        errWithStatus.statusCode ??
        errWithStatus.response?.status;
      if (typeof status === 'number') {
        return this.classifyHttpStatus(status);
      }
      if (
        error.name === 'NetworkError' ||
        error.name === 'AbortError' ||
        error.name === 'TimeoutError'
      ) {
        return { retryable: true, code: error.name.toUpperCase() };
      }
    }
    logger.warn('[HealthUploadEngine] Unknown error type, defaulting to retryable', {
      errorType: typeof error,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return { retryable: true, code: 'UNKNOWN' };
  }
  private classifyHttpStatus(status: number): {
    retryable: boolean;
    retryAfterMs?: number;
    code: string;
  } {
    if (status >= 200 && status < 300) {
      return { retryable: false, code: `HTTP_${status}` };
    }
    if (status >= 400 && status < 500) {
      if (status === 409) {
        return { retryable: true, retryAfterMs: 90_000, code: 'PROCESSING' };
      }
      if (status === 429) {
        return { retryable: true, retryAfterMs: 60_000, code: 'RATE_LIMITED' };
      }
      if (status === 404) {
        logger.error('[HealthUploadEngine] CONFIGURATION ERROR: 404 from health endpoint', {
          errorCode: 'ENDPOINT_NOT_FOUND',
          likelyCause: 'Base URL misconfiguration (check for duplicate /api/v1 prefix)',
          actionRequired: 'Check EXPO_PUBLIC_API_URL configuration',
          dataPreserved: true,
          message: 'Samples will be retained for retry after configuration is fixed',
        });
        return {
          retryable: true,
          retryAfterMs: 5 * 60 * 1000, 
          code: 'ENDPOINT_NOT_FOUND',
        };
      }
      if (status === 413) {
        logger.warn('[HealthUploadEngine] PAYLOAD_TOO_LARGE: Server rejected batch size (413)', {
          errorCode: 'PAYLOAD_TOO_LARGE',
          actionRequired: 'Auto-rechunking will halve batch size on next attempt',
          dataPreserved: true,
        });
        return {
          retryable: true,
          retryAfterMs: 1_000, 
          code: 'PAYLOAD_TOO_LARGE',
        };
      }
      if (status === 401 || status === 403) {
        return { retryable: false, code: `HTTP_${status}` };
      }
      return { retryable: false, code: `HTTP_${status}` };
    }
    if (status >= 500) {
      return { retryable: true, code: `HTTP_${status}` };
    }
    return { retryable: true, code: `HTTP_${status}` };
  }
  private isRetryableError(error: unknown): boolean {
    return this.classifyError(error).retryable;
  }
  private createEmptyResult(): UploadSessionResult {
    return {
      batchesProcessed: 0,
      totalSamplesUploaded: 0,
      totalSamplesRejected: 0,
      totalSamplesFailed: 0,
      totalDeletionsUploaded: 0,
      totalDeletionsFailed: 0,
      totalDurationMs: 0,
      batchResults: [],
    };
  }
  private aggregateBatchResults(
    batchResults: readonly BatchUploadResult[],
    totalDurationMs: number
  ): UploadSessionResult {
    return {
      batchesProcessed: batchResults.length,
      totalSamplesUploaded: batchResults.reduce((sum, r) => sum + r.samplesUploaded, 0),
      totalSamplesRejected: batchResults.reduce((sum, r) => sum + r.samplesRejected, 0),
      totalSamplesFailed: batchResults.reduce((sum, r) => sum + r.samplesFailed, 0),
      totalDeletionsUploaded: batchResults.reduce((sum, r) => sum + r.deletionsUploaded, 0),
      totalDeletionsFailed: batchResults.reduce((sum, r) => sum + r.deletionsFailed, 0),
      totalDurationMs,
      batchResults,
    };
  }
  private delay(ms: number): Promise<void> {
    return this.delayFn(ms);
  }
}
export function createHealthUploadEngine(
  ports: Omit<HealthUploadEnginePorts, 'coordinationState'>
): HealthUploadEngine {
  return new HealthUploadEngine({
    ...ports,
    coordinationState: getHealthSyncCoordinationState(),
  });
}
