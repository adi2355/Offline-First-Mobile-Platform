import { eq, and, inArray, sql, lt, lte, or, isNull, isNotNull, asc } from 'drizzle-orm';
import { healthSampleDeletionQueue, type DbHealthSampleDeletionQueue } from '../../db/schema';
import type { DrizzleDB } from '../../db/client';
import { logger, toLogError } from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import type { CooperativeYieldController } from '../../services/sync/SyncScheduler';
export const MAX_DELETION_BATCH_SIZE = 500;
export const UNKNOWN_START_TIMESTAMP_SENTINEL = -1 as const;
export const STAGED_EXPIRY_THRESHOLD_MS = 10 * 60 * 1000;
export const STUCK_UPLOADING_THRESHOLD_MS = 5 * 60 * 1000;
export const MAX_RETRY_ATTEMPTS = 10;
export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;
export interface DomainDeletionQueueItem {
  readonly id: number;
  readonly userId: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly startTimestampMs: number | null;
  readonly deletedAtMs: number;
  readonly uploadStatus: 'pending' | 'staged' | 'uploading' | 'uploaded' | 'failed';
  readonly uploadedAt: number | null;
  readonly uploadError: string | null;
  readonly uploadAttemptCount: number;
  readonly nextUploadAttemptAt: number | null;
  readonly stagedBatchId: string | null;
  readonly stateUpdatedAtMs: number | null;
  readonly createdAt: number | null;
  readonly isLosslessMode: boolean;
}
export interface EnqueueDeletionInput {
  readonly userId: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly startTimestampMs?: number | null;
  readonly deletedAtMs: number;
}
export interface StageDeletionsResult {
  readonly batchId: string;
  readonly requestId: string; 
  readonly stagedCount: number;
}
export class HealthDeletionQueueRepository {
  private db: DrizzleDB;
  constructor(drizzleDb: DrizzleDB) {
    this.db = drizzleDb;
  }
  async enqueueDeletions(
    deletions: readonly EnqueueDeletionInput[],
    yieldController?: CooperativeYieldController
  ): Promise<number> {
    if (deletions.length === 0) {
      return 0;
    }
    try {
      const now = Date.now();
      let enqueuedCount = 0;
      let losslessModeCount = 0;
      const CHUNK_SIZE = 100;
      for (let i = 0; i < deletions.length; i += CHUNK_SIZE) {
        if (yieldController) {
          await yieldController.yieldIfNeeded('health_deletion_queue_chunk');
        }
        const chunk = deletions.slice(i, i + CHUNK_SIZE);
        for (const deletion of chunk) {
          const effectiveStartTimestampMs = deletion.startTimestampMs != null
            ? deletion.startTimestampMs
            : UNKNOWN_START_TIMESTAMP_SENTINEL;
          if (effectiveStartTimestampMs === UNKNOWN_START_TIMESTAMP_SENTINEL) {
            losslessModeCount++;
          }
          await this.db
            .insert(healthSampleDeletionQueue)
            .values({
              userId: deletion.userId,
              sourceId: deletion.sourceId,
              sourceRecordId: deletion.sourceRecordId,
              startTimestampMs: effectiveStartTimestampMs, 
              deletedAtMs: deletion.deletedAtMs,
              uploadStatus: 'pending',
              uploadAttemptCount: 0,
              stateUpdatedAtMs: now,
            })
            .onConflictDoUpdate({
              target: [
                healthSampleDeletionQueue.userId,
                healthSampleDeletionQueue.sourceId,
                healthSampleDeletionQueue.sourceRecordId,
                healthSampleDeletionQueue.startTimestampMs,
              ],
              set: {
                deletedAtMs: deletion.deletedAtMs,
                uploadStatus: 'pending',
                uploadError: null,
                uploadAttemptCount: 0,
                nextUploadAttemptAt: null,
                stateUpdatedAtMs: now,
              },
            });
          enqueuedCount++;
        }
      }
      logger.debug('[HealthDeletionQueueRepository] Deletions enqueued', {
        count: enqueuedCount,
        losslessModeCount, 
      });
      return enqueuedCount;
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to enqueue deletions', {
        count: deletions.length,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async stageForUpload(
    userId: string,
    limit: number = MAX_DELETION_BATCH_SIZE,
    options?: { batchId?: string; requestId?: string }
  ): Promise<StageDeletionsResult | null> {
    try {
      const now = Date.now();
      const batchId = options?.batchId ?? uuidv4();
      const requestId = options?.requestId ?? uuidv4(); 
      const eligibleDeletions = await this.db
        .select({ id: healthSampleDeletionQueue.id })
        .from(healthSampleDeletionQueue)
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            or(
              eq(healthSampleDeletionQueue.uploadStatus, 'pending'),
              and(
                eq(healthSampleDeletionQueue.uploadStatus, 'failed'),
                lt(healthSampleDeletionQueue.uploadAttemptCount, MAX_RETRY_ATTEMPTS),
                or(
                  isNull(healthSampleDeletionQueue.nextUploadAttemptAt),
                  lte(healthSampleDeletionQueue.nextUploadAttemptAt, now)
                )
              )
            )
          )
        )
        .limit(limit);
      if (eligibleDeletions.length === 0) {
        return null;
      }
      const deletionIds = eligibleDeletions.map(d => d.id);
      await this.db
        .update(healthSampleDeletionQueue)
        .set({
          uploadStatus: 'staged',
          stagedBatchId: batchId,
          uploadRequestId: requestId,
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            inArray(healthSampleDeletionQueue.id, deletionIds)
          )
        );
      logger.debug('[HealthDeletionQueueRepository] Deletions staged for upload', {
        userId,
        batchId,
        requestId,
        count: deletionIds.length,
      });
      return {
        batchId,
        requestId,
        stagedCount: deletionIds.length,
      };
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to stage deletions', {
        userId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async getStagedDeletions(batchId: string): Promise<DomainDeletionQueueItem[]> {
    try {
      const rows = await this.db
        .select()
        .from(healthSampleDeletionQueue)
        .where(eq(healthSampleDeletionQueue.stagedBatchId, batchId));
      return rows.map(row => this.toDomain(row));
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to get staged deletions', {
        batchId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async getRequestIdForBatch(batchId: string): Promise<string | null> {
    try {
      const rows = await this.db
        .select({ requestId: healthSampleDeletionQueue.uploadRequestId })
        .from(healthSampleDeletionQueue)
        .where(eq(healthSampleDeletionQueue.stagedBatchId, batchId))
        .limit(1);
      return rows[0]?.requestId ?? null;
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to get request ID', {
        batchId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async unstageBatch(userId: string, batchId: string): Promise<void> {
    try {
      const now = Date.now();
      await this.db
        .update(healthSampleDeletionQueue)
        .set({
          uploadStatus: 'pending',
          stagedBatchId: null,
          uploadRequestId: null,
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            eq(healthSampleDeletionQueue.stagedBatchId, batchId)
          )
        );
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to unstage deletions', {
        userId,
        batchId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async getDeferredBatch(userId: string, now: number = Date.now()): Promise<{ batchId: string; requestId: string } | null> {
    try {
      const rows = await this.db
        .select({
          batchId: healthSampleDeletionQueue.stagedBatchId,
          requestId: healthSampleDeletionQueue.uploadRequestId,
        })
        .from(healthSampleDeletionQueue)
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            eq(healthSampleDeletionQueue.uploadStatus, 'staged'),
            isNotNull(healthSampleDeletionQueue.stagedBatchId),
            isNotNull(healthSampleDeletionQueue.uploadRequestId),
            or(
              isNull(healthSampleDeletionQueue.nextUploadAttemptAt),
              lte(healthSampleDeletionQueue.nextUploadAttemptAt, now)
            )
          )
        )
        .orderBy(asc(healthSampleDeletionQueue.nextUploadAttemptAt), asc(healthSampleDeletionQueue.stateUpdatedAtMs))
        .limit(1);
      const row = rows[0];
      if (!row?.batchId || !row.requestId) {
        return null;
      }
      return { batchId: row.batchId, requestId: row.requestId };
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to get deferred batch', {
        userId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async deferBatchForRetry(userId: string, batchId: string, retryAfterMs: number): Promise<void> {
    try {
      const now = Date.now();
      await this.db
        .update(healthSampleDeletionQueue)
        .set({
          uploadStatus: 'staged',
          nextUploadAttemptAt: now + retryAfterMs,
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            eq(healthSampleDeletionQueue.stagedBatchId, batchId),
            inArray(healthSampleDeletionQueue.uploadStatus, ['staged', 'uploading'])
          )
        );
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to defer batch', {
        userId,
        batchId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async markUploading(userId: string, deletionIds: number[]): Promise<void> {
    if (deletionIds.length === 0) return;
    try {
      const now = Date.now();
      await this.db
        .update(healthSampleDeletionQueue)
        .set({
          uploadStatus: 'uploading',
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            inArray(healthSampleDeletionQueue.id, deletionIds)
          )
        );
      logger.debug('[HealthDeletionQueueRepository] Deletions marked uploading', {
        userId,
        count: deletionIds.length,
      });
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to mark uploading', {
        userId,
        count: deletionIds.length,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async markUploaded(userId: string, deletionIds: number[]): Promise<void> {
    if (deletionIds.length === 0) return;
    try {
      const now = Date.now();
      await this.db
        .update(healthSampleDeletionQueue)
        .set({
          uploadStatus: 'uploaded',
          uploadedAt: now,
          uploadError: null,
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            inArray(healthSampleDeletionQueue.id, deletionIds)
          )
        );
      logger.debug('[HealthDeletionQueueRepository] Deletions marked uploaded', {
        userId,
        count: deletionIds.length,
      });
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to mark uploaded', {
        userId,
        count: deletionIds.length,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async markFailed(
    userId: string,
    deletionIds: number[],
    errorMessage: string,
    isRetryable: boolean = true
  ): Promise<void> {
    if (deletionIds.length === 0) return;
    try {
      const now = Date.now();
      const currentStates = await this.db
        .select({
          id: healthSampleDeletionQueue.id,
          attemptCount: healthSampleDeletionQueue.uploadAttemptCount,
        })
        .from(healthSampleDeletionQueue)
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            inArray(healthSampleDeletionQueue.id, deletionIds)
          )
        );
      const attemptCountMap = new Map<number, number>();
      for (const state of currentStates) {
        attemptCountMap.set(state.id, (state.attemptCount ?? 0) + 1);
      }
      for (const id of deletionIds) {
        const newAttemptCount = attemptCountMap.get(id) ?? 1;
        const nextRetryAt = isRetryable
          ? this.calculateNextRetryTime(newAttemptCount, now)
          : null;
        await this.db
          .update(healthSampleDeletionQueue)
          .set({
            uploadStatus: 'failed',
            uploadError: errorMessage,
            uploadAttemptCount: newAttemptCount,
            nextUploadAttemptAt: nextRetryAt,
            stagedBatchId: null, 
            stateUpdatedAtMs: now,
          })
          .where(
            and(
              eq(healthSampleDeletionQueue.id, id),
              eq(healthSampleDeletionQueue.userId, userId)
            )
          );
      }
      logger.debug('[HealthDeletionQueueRepository] Deletions marked failed', {
        userId,
        count: deletionIds.length,
        isRetryable,
      });
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to mark failed', {
        userId,
        count: deletionIds.length,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async releaseExpiredStagedDeletions(userId: string): Promise<number> {
    try {
      const now = Date.now();
      const expiryThreshold = now - STAGED_EXPIRY_THRESHOLD_MS;
      const expiredRows = await this.db
        .select({ id: healthSampleDeletionQueue.id })
        .from(healthSampleDeletionQueue)
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            eq(healthSampleDeletionQueue.uploadStatus, 'staged'),
            lt(healthSampleDeletionQueue.stateUpdatedAtMs, expiryThreshold)
          )
        );
      if (expiredRows.length === 0) {
        return 0;
      }
      const expiredIds = expiredRows.map(r => r.id);
      await this.db
        .update(healthSampleDeletionQueue)
        .set({
          uploadStatus: 'pending',
          stagedBatchId: null,
          uploadRequestId: null,
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            inArray(healthSampleDeletionQueue.id, expiredIds),
            eq(healthSampleDeletionQueue.uploadStatus, 'staged')
          )
        );
      logger.info('[HealthDeletionQueueRepository] Released expired staged deletions', {
        userId,
        releasedCount: expiredIds.length,
      });
      return expiredIds.length;
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to release expired staged', {
        userId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async recoverStuckUploadingDeletions(
    userId: string,
    thresholdMs: number = STUCK_UPLOADING_THRESHOLD_MS
  ): Promise<number> {
    try {
      const now = Date.now();
      const stuckThreshold = now - thresholdMs;
      const stuckRows = await this.db
        .select({ id: healthSampleDeletionQueue.id })
        .from(healthSampleDeletionQueue)
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            eq(healthSampleDeletionQueue.uploadStatus, 'uploading'),
            lt(healthSampleDeletionQueue.stateUpdatedAtMs, stuckThreshold)
          )
        );
      if (stuckRows.length === 0) {
        return 0;
      }
      const stuckIds = stuckRows.map(r => r.id);
      await this.db
        .update(healthSampleDeletionQueue)
        .set({
          uploadStatus: 'pending',
          stagedBatchId: null,
          uploadRequestId: null,
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            inArray(healthSampleDeletionQueue.id, stuckIds),
            eq(healthSampleDeletionQueue.uploadStatus, 'uploading')
          )
        );
      logger.info('[HealthDeletionQueueRepository] Recovered stuck uploading deletions', {
        userId,
        recoveredCount: stuckIds.length,
      });
      return stuckIds.length;
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to recover stuck uploading', {
        userId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async getPendingCount(userId: string): Promise<number> {
    try {
      const result = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(healthSampleDeletionQueue)
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            eq(healthSampleDeletionQueue.uploadStatus, 'pending')
          )
        );
      return result[0]?.count ?? 0;
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to get pending count', {
        userId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  async hasUploadableDeletions(userId: string): Promise<boolean> {
    try {
      const now = Date.now();
      const result = await this.db
        .select({ id: healthSampleDeletionQueue.id })
        .from(healthSampleDeletionQueue)
        .where(
          and(
            eq(healthSampleDeletionQueue.userId, userId),
            or(
              eq(healthSampleDeletionQueue.uploadStatus, 'pending'),
              and(
                eq(healthSampleDeletionQueue.uploadStatus, 'failed'),
                lt(healthSampleDeletionQueue.uploadAttemptCount, MAX_RETRY_ATTEMPTS),
                or(
                  isNull(healthSampleDeletionQueue.nextUploadAttemptAt),
                  lte(healthSampleDeletionQueue.nextUploadAttemptAt, now)
                )
              )
            )
          )
        )
        .limit(1);
      return result.length > 0;
    } catch (error) {
      logger.error('[HealthDeletionQueueRepository] Failed to check uploadable', {
        userId,
        error: toLogError(error),
      });
      throw error;
    }
  }
  private calculateNextRetryTime(attemptCount: number, now: number): number {
    const baseDelay = BASE_BACKOFF_MS * Math.pow(2, attemptCount - 1);
    const cappedDelay = Math.min(baseDelay, MAX_BACKOFF_MS);
    const jitter = cappedDelay * 0.1 * Math.random();
    return now + cappedDelay + jitter;
  }
  private toDomain(row: DbHealthSampleDeletionQueue): DomainDeletionQueueItem {
    const isLosslessMode = row.startTimestampMs === UNKNOWN_START_TIMESTAMP_SENTINEL;
    return {
      id: row.id,
      userId: row.userId,
      sourceId: row.sourceId,
      sourceRecordId: row.sourceRecordId,
      startTimestampMs: isLosslessMode ? null : row.startTimestampMs,
      deletedAtMs: row.deletedAtMs,
      uploadStatus: (row.uploadStatus ?? 'pending') as DomainDeletionQueueItem['uploadStatus'],
      uploadedAt: row.uploadedAt,
      uploadError: row.uploadError,
      uploadAttemptCount: row.uploadAttemptCount ?? 0,
      nextUploadAttemptAt: row.nextUploadAttemptAt,
      stagedBatchId: row.stagedBatchId ?? null,
      stateUpdatedAtMs: row.stateUpdatedAtMs,
      createdAt: row.createdAt,
      isLosslessMode,
    };
  }
}
