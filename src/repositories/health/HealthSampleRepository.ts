import { eq, and, inArray, sql, count, isNull, isNotNull, desc, asc, lt, or, lte } from 'drizzle-orm';
import type { DrizzleDB, DrizzleTransactionClient } from '../../db/client';
import {
  healthSamples,
  type DbHealthSample,
  type DbHealthSampleInsert,
} from '../../db/schema';
import { safeJsonParse, safeJsonStringify } from '../../db/schema-helpers';
import { BaseRepository } from '../BaseRepository';
import { logger, toLogError } from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { HealthDeletionQueueRepository } from './HealthDeletionQueueRepository';
import { healthIngestCursors, type DbHealthIngestCursorInsert } from '../../db/schema';
import type { UpdateCursorInput, CursorUpdateResult, CursorScope } from './HealthCursorRepository';
import { DEFAULT_CURSOR_SCOPE } from './HealthCursorRepository';
import type { CooperativeYieldController } from '../../services/sync/SyncScheduler';
import {
  sanitizeMetadata,
  isHealthMetricCodeUnknown,
  isValueInBounds,
  isUnitAllowedForMetric,
  isCategoryCodeAllowed,
  getMetricDefinition,
  getCanonicalUnit,
  getCategoryAllowedCodes,
  type HealthMetricCode,
} from '@shared/contracts';
export type HealthUploadStatus =
  | 'pending'
  | 'staged'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'rejected';
export interface DomainHealthSample {
  id: string;
  userId: string;
  sourceId: string;
  sourceRecordId: string;
  sampleType: string;
  startTimestamp: number; 
  endTimestamp: number; 
  durationSeconds?: number | null;
  deviceId?: string | null;
  externalUuid?: string | null;
  value: number | null;
  unit: string | null;
  categoryCode: string | null;
  metadata?: Record<string, unknown> | null;
  uploadStatus: HealthUploadStatus;
  stagedBatchId?: string | null;
  uploadedAt?: number | null;
  uploadError?: string | null;
  uploadAttemptCount: number;
  nextUploadAttemptAt: number | null;
  stateUpdatedAtMs?: number | null;
  createdAt?: number | null;
}
export interface InsertHealthSampleInput {
  id?: string;
  userId: string;
  sourceId: string;
  sourceRecordId: string;
  sampleType: string;
  valueKind: 'SCALAR_NUM' | 'CUMULATIVE_NUM' | 'INTERVAL_NUM' | 'CATEGORY';
  startTimestamp: number;
  endTimestamp: number;
  durationSeconds?: number | null;
  value?: number | null;
  unit?: string | null;
  categoryCode?: string | null;
  metadata?: Record<string, unknown> | null;
  deviceId?: string | null;
  externalUuid?: string | null;
}
export interface BatchInsertResult {
  inserted: number;
  duplicatesSkipped: number;
  errors: Array<{ sourceRecordId: string; error: string }>;
}
export interface HealthSampleStats {
  pendingCount: number;
  stagedCount: number;
  uploadingCount: number;
  uploadedCount: number;
  failedCount: number;
  rejectedCount: number;
  totalCount: number;
  oldestPendingTimestamp: number | null;
  retryEligibleCount: number;
}
export interface StateTransitionResult {
  updated: number;
  skipped: number;
}
export const HEALTH_UPLOAD_RETRY_CONFIG = {
  BASE_DELAY_MS: 60_000,
  MAX_DELAY_MS: 86_400_000,
  MAX_ATTEMPTS: 5,
  JITTER_FACTOR: 0.25,
  BACKOFF_MULTIPLIER: 2,
} as const;
export const STAGED_LEASE_TIMEOUT_MS = 600_000; 
export const BULK_INSERT_CHUNK_SIZE = 200;
export interface TelemetryBucket {
  bucketCenterMs: number;
  value: number;
  minVal: number;
  maxVal: number;
  sumVal: number;
  sampleCount: number;
}
export interface AggregatedTelemetryResult {
  buckets: TelemetryBucket[];
  totalSampleCount: number;
  stats: {
    min: number;
    max: number;
    avg: number;
  };
  gaps: Array<{ startMs: number; endMs: number }>;
}
export function calculateNextRetryAt(attemptCount: number, now: number = Date.now()): number | null {
  if (attemptCount >= HEALTH_UPLOAD_RETRY_CONFIG.MAX_ATTEMPTS) {
    return null; 
  }
  const baseDelay = HEALTH_UPLOAD_RETRY_CONFIG.BASE_DELAY_MS * Math.pow(
    HEALTH_UPLOAD_RETRY_CONFIG.BACKOFF_MULTIPLIER,
    attemptCount - 1
  );
  const jitter = baseDelay * HEALTH_UPLOAD_RETRY_CONFIG.JITTER_FACTOR * Math.random();
  const delay = Math.min(baseDelay + jitter, HEALTH_UPLOAD_RETRY_CONFIG.MAX_DELAY_MS);
  return now + Math.floor(delay);
}
function mapDbHealthSampleToDomain(db: DbHealthSample): DomainHealthSample {
  let parsedMetadata: Record<string, unknown> | null = null;
  if (db.metadata != null && db.metadata !== '') {
    try {
      parsedMetadata = JSON.parse(db.metadata) as Record<string, unknown>;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[HealthSampleRepository] Failed to parse metadata JSON', {
        sampleId: db.id,
        sourceRecordId: db.sourceRecordId,
        jsonPreview: db.metadata.substring(0, 200),
        error: { name: err.name, message: err.message, stack: err.stack },
      });
    }
  }
  return {
    id: db.id,
    userId: db.userId,
    sourceId: db.sourceId,
    sourceRecordId: db.sourceRecordId,
    sampleType: db.sampleType,
    startTimestamp: db.startTimestamp,
    endTimestamp: db.endTimestamp,
    durationSeconds: db.durationSeconds ?? null,
    deviceId: db.deviceId ?? null,
    externalUuid: db.externalUuid ?? null,
    value: db.value,
    unit: db.unit,
    categoryCode: db.categoryCode,
    metadata: parsedMetadata,
    uploadStatus: (db.uploadStatus as HealthUploadStatus) || 'pending',
    stagedBatchId: db.stagedBatchId,
    uploadedAt: db.uploadedAt,
    uploadError: db.uploadError,
    uploadAttemptCount: db.uploadAttemptCount ?? 0,
    nextUploadAttemptAt: db.nextUploadAttemptAt,
    stateUpdatedAtMs: db.stateUpdatedAtMs,
    createdAt: db.createdAt,
  };
}
export class HealthSampleRepository extends BaseRepository {
  constructor(drizzleDb: DrizzleDB) {
    super({ drizzleDb });
  }
  private crashRecoveryState = {
    stuckUploading: {
      consecutiveFailures: 0,
      lastFailureTime: 0,
      alertTriggered: false,
    },
    expiredStaged: {
      consecutiveFailures: 0,
      lastFailureTime: 0,
      alertTriggered: false,
    },
  };
  static readonly CRASH_RECOVERY_ALERT_THRESHOLD = 3;
  private recordCrashRecoveryFailure(
    operation: 'stuckUploading' | 'expiredStaged'
  ): boolean {
    const state = this.crashRecoveryState[operation];
    state.consecutiveFailures++;
    state.lastFailureTime = Date.now();
    if (
      state.consecutiveFailures >= HealthSampleRepository.CRASH_RECOVERY_ALERT_THRESHOLD &&
      !state.alertTriggered
    ) {
      state.alertTriggered = true;
      logger.error('[HealthSampleRepository] ALERT: Crash recovery repeatedly failing', {
        operation,
        consecutiveFailures: state.consecutiveFailures,
        threshold: HealthSampleRepository.CRASH_RECOVERY_ALERT_THRESHOLD,
        alert: 'HEALTH_PIPELINE_DEGRADED',
      });
      return true;
    }
    return false;
  }
  private recordCrashRecoverySuccess(
    operation: 'stuckUploading' | 'expiredStaged'
  ): void {
    const state = this.crashRecoveryState[operation];
    state.consecutiveFailures = 0;
    state.alertTriggered = false;
  }
  getCrashRecoveryState(): {
    stuckUploading: { consecutiveFailures: number; lastFailureTime: number; alertTriggered: boolean };
    expiredStaged: { consecutiveFailures: number; lastFailureTime: number; alertTriggered: boolean };
    isPipelineDegraded: boolean;
  } {
    return {
      ...this.crashRecoveryState,
      isPipelineDegraded:
        this.crashRecoveryState.stuckUploading.alertTriggered ||
        this.crashRecoveryState.expiredStaged.alertTriggered,
    };
  }
  private validateSampleInvariants(sample: InsertHealthSampleInput): void {
    const VALID_VALUE_KINDS = ['SCALAR_NUM', 'CUMULATIVE_NUM', 'INTERVAL_NUM', 'CATEGORY'] as const;
    if (!sample.valueKind || !VALID_VALUE_KINDS.includes(sample.valueKind)) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: valueKind is required and must be one of ` +
        `[${VALID_VALUE_KINDS.join(', ')}] for sourceRecordId=${sample.sourceRecordId}. ` +
        `Got: ${sample.valueKind}`
      );
    }
    if (!sample.userId || typeof sample.userId !== 'string' || sample.userId.trim().length === 0) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: userId is required and must be a non-empty string`
      );
    }
    if (sample.userId.length > 128) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: userId length (${sample.userId.length}) exceeds maximum of 128`
      );
    }
    if (!sample.sourceId || typeof sample.sourceId !== 'string' || sample.sourceId.trim().length === 0) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: sourceId is required and must be a non-empty string`
      );
    }
    if (sample.sourceId.length > 128) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: sourceId length (${sample.sourceId.length}) exceeds maximum of 128`
      );
    }
    if (!sample.sampleType || typeof sample.sampleType !== 'string' || sample.sampleType.trim().length === 0) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: sampleType is required and must be a non-empty string`
      );
    }
    if (sample.sampleType.length > 64) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: sampleType length (${sample.sampleType.length}) exceeds maximum of 64`
      );
    }
    if (!sample.sourceRecordId || typeof sample.sourceRecordId !== 'string') {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: sourceRecordId is required and must be a non-empty string`
      );
    }
    const trimmed = sample.sourceRecordId.trim();
    if (trimmed !== sample.sourceRecordId) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: sourceRecordId must not have leading/trailing whitespace. ` +
        `Got: "${sample.sourceRecordId.substring(0, 50)}${sample.sourceRecordId.length > 50 ? '...' : ''}"`
      );
    }
    if (sample.sourceRecordId.length > 256) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: sourceRecordId length (${sample.sourceRecordId.length}) ` +
        `exceeds maximum of 256 characters. This suggests a data generation error.`
      );
    }
    if (/[\x00-\x1F\x7F]/.test(sample.sourceRecordId)) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: sourceRecordId contains control characters. ` +
        `sourceRecordId must contain only printable characters.`
      );
    }
    if (sample.startTimestamp > sample.endTimestamp) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: startTimestamp (${sample.startTimestamp}) ` +
        `must be <= endTimestamp (${sample.endTimestamp}) for sourceRecordId=${sample.sourceRecordId}`
      );
    }
    if (sample.durationSeconds != null) {
      if (!Number.isFinite(sample.durationSeconds) || sample.durationSeconds < 0) {
        throw new Error(
          `[HealthSampleRepository] Invalid sample: durationSeconds (${sample.durationSeconds}) ` +
          `must be a non-negative finite number for sourceRecordId=${sample.sourceRecordId}`
        );
      }
      const expectedSeconds = Math.max(
        0,
        Math.round((sample.endTimestamp - sample.startTimestamp) / 1000)
      );
      const delta = Math.abs(sample.durationSeconds - expectedSeconds);
      if (delta > 1) {
        throw new Error(
          `[HealthSampleRepository] Invalid sample: durationSeconds (${sample.durationSeconds}) ` +
          `does not match start/end delta (${expectedSeconds}s) ` +
          `for sourceRecordId=${sample.sourceRecordId}`
        );
      }
    }
    const hasNumericValue = sample.value != null;
    const hasUnit = sample.unit != null;
    const hasCategoryCode = sample.categoryCode != null;
    if (hasNumericValue !== hasUnit) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: value and unit must both be present or both be null ` +
        `for sourceRecordId=${sample.sourceRecordId}. Got value=${sample.value}, unit=${sample.unit}`
      );
    }
    if (hasCategoryCode && hasNumericValue) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: categoryCode and value are mutually exclusive ` +
        `for sourceRecordId=${sample.sourceRecordId}. Got categoryCode=${sample.categoryCode}, value=${sample.value}`
      );
    }
    if (!hasNumericValue && !hasCategoryCode) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: must have either (value + unit) or categoryCode ` +
        `for sourceRecordId=${sample.sourceRecordId}`
      );
    }
    const isNumericKind = ['SCALAR_NUM', 'CUMULATIVE_NUM', 'INTERVAL_NUM'].includes(sample.valueKind);
    const isCategoryKind = sample.valueKind === 'CATEGORY';
    if (isCategoryKind && !hasCategoryCode) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: valueKind is 'CATEGORY' but categoryCode is missing ` +
        `for sourceRecordId=${sample.sourceRecordId}. CATEGORY samples MUST have categoryCode.`
      );
    }
    if (isCategoryKind && hasNumericValue) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: valueKind is 'CATEGORY' but value/unit are present ` +
        `for sourceRecordId=${sample.sourceRecordId}. CATEGORY samples MUST NOT have value/unit.`
      );
    }
    if (isNumericKind && !hasNumericValue) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: valueKind is '${sample.valueKind}' (numeric) but value/unit are missing ` +
        `for sourceRecordId=${sample.sourceRecordId}. Numeric samples MUST have value and unit.`
      );
    }
    if (isNumericKind && hasCategoryCode) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: valueKind is '${sample.valueKind}' (numeric) but categoryCode is present ` +
        `for sourceRecordId=${sample.sourceRecordId}. Numeric samples MUST NOT have categoryCode.`
      );
    }
    if (sample.valueKind === 'INTERVAL_NUM' && sample.durationSeconds == null) {
      throw new Error(
        `[HealthSampleRepository] Invalid sample: durationSeconds is required for INTERVAL_NUM ` +
        `samples (sourceRecordId=${sample.sourceRecordId}).`
      );
    }
    const MAX_METADATA_SIZE_BYTES = 4096;
    if (sample.metadata != null) {
      if (typeof sample.metadata !== 'object' || Array.isArray(sample.metadata)) {
        throw new Error(
          `[HealthSampleRepository] Invalid sample: metadata must be an object, ` +
          `got ${Array.isArray(sample.metadata) ? 'array' : typeof sample.metadata} ` +
          `for sourceRecordId=${sample.sourceRecordId}. ` +
          `Error code: METADATA_INVALID_TYPE`
        );
      }
      let metadataSize: number;
      try {
        metadataSize = JSON.stringify(sample.metadata).length;
      } catch {
        throw new Error(
          `[HealthSampleRepository] Invalid sample: metadata is not JSON-serializable ` +
          `for sourceRecordId=${sample.sourceRecordId}. ` +
          `Error code: METADATA_NOT_SERIALIZABLE`
        );
      }
      if (metadataSize > MAX_METADATA_SIZE_BYTES) {
        throw new Error(
          `[HealthSampleRepository] Invalid sample: metadata size (${metadataSize} bytes) ` +
          `exceeds maximum of ${MAX_METADATA_SIZE_BYTES} bytes ` +
          `for sourceRecordId=${sample.sourceRecordId}. ` +
          `Error code: METADATA_TOO_LARGE`
        );
      }
    }
  }
  public static MetricValidationResult = class {
    public readonly isValid: boolean;
    public readonly errorCode: string | null;
    public readonly errorMessage: string | null;
    constructor(isValid: boolean, errorCode: string | null = null, errorMessage: string | null = null) {
      this.isValid = isValid;
      this.errorCode = errorCode;
      this.errorMessage = errorMessage;
    }
    static success(): InstanceType<typeof HealthSampleRepository.MetricValidationResult> {
      return new HealthSampleRepository.MetricValidationResult(true);
    }
    static failure(errorCode: string, errorMessage: string): InstanceType<typeof HealthSampleRepository.MetricValidationResult> {
      return new HealthSampleRepository.MetricValidationResult(false, errorCode, errorMessage);
    }
  };
  validateMetricSemantics(
    sample: InsertHealthSampleInput
  ): InstanceType<typeof HealthSampleRepository.MetricValidationResult> {
    if (!isHealthMetricCodeUnknown(sample.sampleType)) {
      return HealthSampleRepository.MetricValidationResult.failure(
        'INVALID_METRIC_CODE',
        `Unknown metric code: "${sample.sampleType}". ` +
        `Ensure sampleType is mapped to a canonical HEALTH_METRIC_CODE. ` +
        `If this is a HealthKit/Health Connect type, it needs mapping in the normalization layer.`
      );
    }
    const metricCode = sample.sampleType as HealthMetricCode;
    const metricDef = getMetricDefinition(metricCode);
    const hasNumericValue = sample.value != null;
    const hasCategoryCode = sample.categoryCode != null;
    if (hasNumericValue && sample.unit != null) {
      if (!isValueInBounds(metricCode, sample.value!)) {
        const bounds: string[] = [];
        if (metricDef.minValue !== undefined) bounds.push(`min: ${metricDef.minValue}`);
        if (metricDef.maxValue !== undefined) bounds.push(`max: ${metricDef.maxValue}`);
        return HealthSampleRepository.MetricValidationResult.failure(
          'VALUE_OUT_OF_BOUNDS',
          `Value ${sample.value} is outside allowed bounds for metric "${metricCode}" ` +
          `[${bounds.join(', ')}]. This may indicate a measurement error or data corruption.`
        );
      }
      if (!isUnitAllowedForMetric(metricCode, sample.unit)) {
        const canonicalUnit = getCanonicalUnit(metricCode);
        const allowedUnits = metricDef.allowedUnits;
        return HealthSampleRepository.MetricValidationResult.failure(
          'INVALID_UNIT',
          `Unit "${sample.unit}" is not allowed for metric "${metricCode}". ` +
          `Allowed units: [${allowedUnits.join(', ')}]. ` +
          `Canonical unit: "${canonicalUnit}". ` +
          `Ensure platform units are normalized before storage.`
        );
      }
    }
    if (hasCategoryCode) {
      if (metricDef.valueKind !== 'CATEGORY') {
        return HealthSampleRepository.MetricValidationResult.failure(
          'INVALID_CATEGORY_CODE',
          `Metric "${metricCode}" is not a CATEGORY metric (valueKind: ${metricDef.valueKind}), ` +
          `but categoryCode "${sample.categoryCode}" was provided. ` +
          `CATEGORY fields are only valid for CATEGORY metrics like 'sleep_stage'.`
        );
      }
      if (!isCategoryCodeAllowed(metricCode, sample.categoryCode!)) {
        const allowedCodes = getCategoryAllowedCodes(metricCode);
        return HealthSampleRepository.MetricValidationResult.failure(
          'INVALID_CATEGORY_CODE',
          `Category code "${sample.categoryCode}" is not valid for CATEGORY metric "${metricCode}". ` +
          `Allowed codes: [${allowedCodes.join(', ')}]. ` +
          `Ensure platform-specific category values are normalized to canonical codes.`
        );
      }
    }
    if (hasNumericValue && metricDef.valueKind === 'CATEGORY') {
      return HealthSampleRepository.MetricValidationResult.failure(
        'VALUE_OUT_OF_BOUNDS',
        `Metric "${metricCode}" is a CATEGORY metric but numeric value ${sample.value} was provided. ` +
        `CATEGORY metrics should use categoryCode instead of value/unit.`
      );
    }
    return HealthSampleRepository.MetricValidationResult.success();
  }
  validateMetricSemanticsMany(
    samples: InsertHealthSampleInput[]
  ): Map<string, InstanceType<typeof HealthSampleRepository.MetricValidationResult>> {
    const results = new Map<string, InstanceType<typeof HealthSampleRepository.MetricValidationResult>>();
    for (const sample of samples) {
      results.set(sample.sourceRecordId, this.validateMetricSemantics(sample));
    }
    return results;
  }
  async insertSamples(
    samples: InsertHealthSampleInput[],
    onBeforeCommit?: (insertedSamples: InsertHealthSampleInput[]) => Promise<void>,
  ): Promise<BatchInsertResult> {
    if (samples.length === 0) {
      return { inserted: 0, duplicatesSkipped: 0, errors: [] };
    }
    const validationErrors: Array<{ sourceRecordId: string; error: string }> = [];
    const validSamples: InsertHealthSampleInput[] = [];
    for (const sample of samples) {
      try {
        this.validateSampleInvariants(sample);
        validSamples.push(sample);
      } catch (error: unknown) {
        validationErrors.push({
          sourceRecordId: sample.sourceRecordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (validSamples.length === 0) {
      logger.warn('[HealthSampleRepository] All samples failed validation', {
        total: samples.length,
        errors: validationErrors.length,
      });
      return { inserted: 0, duplicatesSkipped: 0, errors: validationErrors };
    }
    const result: BatchInsertResult = {
      inserted: 0,
      duplicatesSkipped: 0,
      errors: validationErrors, 
    };
    try {
      if (onBeforeCommit) {
        const drizzle = this.getDrizzle();
        await drizzle.run(sql`BEGIN TRANSACTION`);
        try {
          await this.executeInsertCore(drizzle, validSamples, result);
          await onBeforeCommit(validSamples);
          await drizzle.run(sql`COMMIT`);
        } catch (innerError) {
          try {
            await drizzle.run(sql`ROLLBACK`);
          } catch (rollbackError) {
            logger.error('[HealthSampleRepository] ROLLBACK failed after insert error', {
              rollbackError: rollbackError instanceof Error
                ? { name: rollbackError.name, message: rollbackError.message }
                : { name: 'Error', message: String(rollbackError) },
            });
          }
          throw innerError;
        }
      } else {
        await this.executeDrizzleTransaction(async (tx) => {
          await this.executeInsertCore(tx, validSamples, result);
        });
      }
      logger.info('[HealthSampleRepository] Samples inserted (chunked bulk)', {
        total: samples.length,
        validSamples: validSamples.length,
        inserted: result.inserted,
        duplicatesSkipped: result.duplicatesSkipped,
        validationErrors: validationErrors.length,
        chunkSize: BULK_INSERT_CHUNK_SIZE,
        chunks: Math.ceil(validSamples.length / BULK_INSERT_CHUNK_SIZE),
        atomic: !!onBeforeCommit,
      });
      return result;
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error inserting samples (chunked bulk)', {
        count: samples.length,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to insert health samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  private async executeInsertCore(
    db: DrizzleDB | DrizzleTransactionClient,
    validSamples: InsertHealthSampleInput[],
    result: BatchInsertResult,
  ): Promise<void> {
    const now = Date.now();
    const samplesToInsert = validSamples; 
    const insertValues: DbHealthSampleInsert[] = samplesToInsert.map((sample) => {
      const sanitizedMetadata = sample.metadata
        ? sanitizeMetadata(sample.metadata as Record<string, unknown>)
        : null;
      return {
        id: sample.id ?? uuidv4(),
        userId: sample.userId,
        sourceId: sample.sourceId,
        sourceRecordId: sample.sourceRecordId,
        sampleType: sample.sampleType,
        valueKind: sample.valueKind,
        startTimestamp: sample.startTimestamp,
        endTimestamp: sample.endTimestamp,
        value: sample.value ?? null,
        unit: sample.unit ?? null,
        categoryCode: sample.categoryCode ?? null,
        durationSeconds: sample.durationSeconds ?? null,
        deviceId: sample.deviceId ?? null,
        externalUuid: sample.externalUuid ?? null,
        metadata: sanitizedMetadata ? JSON.stringify(sanitizedMetadata) : null,
        uploadStatus: 'pending',
        stagedBatchId: null,
        uploadedAt: null,
        uploadError: null,
        uploadAttemptCount: 0,
        nextUploadAttemptAt: null,
        stateUpdatedAtMs: now,
        createdAt: now,
        isDeleted: false,
        deletedAtMs: null,
      };
    });
    const generatedIds: string[] = [];
    for (let i = 0; i < insertValues.length; i += BULK_INSERT_CHUNK_SIZE) {
      const chunk = insertValues.slice(i, i + BULK_INSERT_CHUNK_SIZE);
      for (const value of chunk) {
        generatedIds.push(value.id);
      }
      await db
        .insert(healthSamples)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            healthSamples.userId,
            healthSamples.sourceId,
            healthSamples.sourceRecordId,
            healthSamples.startTimestamp,
          ],
          set: {
            value: sql`excluded.value`,
            unit: sql`excluded.unit`,
            categoryCode: sql`excluded.category_code`,
            valueKind: sql`excluded.value_kind`,
            endTimestamp: sql`excluded.end_timestamp`,
            durationSeconds: sql`excluded.duration_seconds`,
            deviceId: sql`COALESCE(excluded.device_id, ${healthSamples.deviceId})`,
            externalUuid: sql`COALESCE(excluded.external_uuid, ${healthSamples.externalUuid})`,
            metadata: sql`COALESCE(excluded.metadata, ${healthSamples.metadata})`,
            stateUpdatedAtMs: sql`excluded.state_updated_at_ms`,
          },
          where: eq(healthSamples.isDeleted, false),
        });
    }
    let actualInsertedCount = 0;
    for (let i = 0; i < generatedIds.length; i += BULK_INSERT_CHUNK_SIZE) {
      const chunk = generatedIds.slice(i, i + BULK_INSERT_CHUNK_SIZE);
      const countResult = await db
        .select({ count: count() })
        .from(healthSamples)
        .where(inArray(healthSamples.id, chunk))
        .get();
      actualInsertedCount += countResult?.count ?? 0;
    }
    const existingUpdatedCount = insertValues.length - actualInsertedCount;
    result.inserted = actualInsertedCount;
    result.duplicatesSkipped += existingUpdatedCount; 
  }
  async insertSample(sample: InsertHealthSampleInput): Promise<string> {
    const sampleId = sample.id ?? uuidv4();
    const sampleWithId: InsertHealthSampleInput = {
      ...sample,
      id: sampleId,
    };
    const result = await this.insertSamples([sampleWithId]);
    const firstError = result.errors[0];
    if (firstError !== undefined) {
      throw new Error(`Failed to insert sample: ${firstError.error}`);
    }
    return sampleId;
  }
  async insertSamplesAndUpdateCursorAtomic(
    samples: InsertHealthSampleInput[],
    cursorUpdate: {
      userId: string;
      sourceId: string;
      sampleType: string;
      input: UpdateCursorInput;
      scope?: CursorScope;
    },
    onBeforeCommit?: (insertedSamples: InsertHealthSampleInput[]) => Promise<void>,
  ): Promise<{
    insertResult: BatchInsertResult;
    cursorResult: CursorUpdateResult;
  }> {
    const validationErrors: Array<{ sourceRecordId: string; error: string }> = [];
    const validSamples: InsertHealthSampleInput[] = [];
    for (const sample of samples) {
      try {
        this.validateSampleInvariants(sample);
        validSamples.push(sample);
      } catch (error: unknown) {
        validationErrors.push({
          sourceRecordId: sample.sourceRecordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const insertResult: BatchInsertResult = {
      inserted: 0,
      duplicatesSkipped: 0,
      errors: validationErrors,
    };
    let cursorResult: CursorUpdateResult = { success: false };
    const drizzle = this.getDrizzle();
    try {
      await drizzle.run(sql`BEGIN TRANSACTION`);
      try {
        const now = Date.now();
        if (validSamples.length > 0) {
          const insertValues: DbHealthSampleInsert[] = validSamples.map((sample) => {
            const sanitizedMetadata = sample.metadata
              ? sanitizeMetadata(sample.metadata as Record<string, unknown>)
              : null;
            return {
              id: sample.id ?? uuidv4(),
              userId: sample.userId,
              sourceId: sample.sourceId,
              sourceRecordId: sample.sourceRecordId,
              sampleType: sample.sampleType,
              valueKind: sample.valueKind,
              startTimestamp: sample.startTimestamp,
              endTimestamp: sample.endTimestamp,
              value: sample.value ?? null,
              unit: sample.unit ?? null,
              categoryCode: sample.categoryCode ?? null,
              durationSeconds: sample.durationSeconds ?? null,
              deviceId: sample.deviceId ?? null,
              externalUuid: sample.externalUuid ?? null,
              metadata: sanitizedMetadata ? JSON.stringify(sanitizedMetadata) : null,
              uploadStatus: 'pending',
              stagedBatchId: null,
              uploadedAt: null,
              uploadError: null,
              uploadAttemptCount: 0,
              nextUploadAttemptAt: null,
              stateUpdatedAtMs: now,
              createdAt: now,
              isDeleted: false,
              deletedAtMs: null,
            };
          });
          const generatedIds: string[] = insertValues.map(v => v.id);
          for (let i = 0; i < insertValues.length; i += BULK_INSERT_CHUNK_SIZE) {
            const chunk = insertValues.slice(i, i + BULK_INSERT_CHUNK_SIZE);
            await drizzle
              .insert(healthSamples)
              .values(chunk)
              .onConflictDoUpdate({
                target: [
                  healthSamples.userId,
                  healthSamples.sourceId,
                  healthSamples.sourceRecordId,
                  healthSamples.startTimestamp,
                ],
                set: {
                  value: sql`excluded.value`,
                  unit: sql`excluded.unit`,
                  categoryCode: sql`excluded.category_code`,
                  valueKind: sql`excluded.value_kind`,
                  endTimestamp: sql`excluded.end_timestamp`,
                  durationSeconds: sql`excluded.duration_seconds`,
                  deviceId: sql`COALESCE(excluded.device_id, ${healthSamples.deviceId})`,
                  externalUuid: sql`COALESCE(excluded.external_uuid, ${healthSamples.externalUuid})`,
                  metadata: sql`COALESCE(excluded.metadata, ${healthSamples.metadata})`,
                  stateUpdatedAtMs: sql`excluded.state_updated_at_ms`,
                },
                where: eq(healthSamples.isDeleted, false),
              });
          }
          let actualInsertedCount = 0;
          for (let i = 0; i < generatedIds.length; i += BULK_INSERT_CHUNK_SIZE) {
            const chunk = generatedIds.slice(i, i + BULK_INSERT_CHUNK_SIZE);
            const countResult = await drizzle
              .select({ count: count() })
              .from(healthSamples)
              .where(inArray(healthSamples.id, chunk))
              .get();
            actualInsertedCount += countResult?.count ?? 0;
          }
          insertResult.inserted = actualInsertedCount;
          insertResult.duplicatesSkipped = insertValues.length - actualInsertedCount;
        }
        const { userId, sourceId, sampleType, input, scope: cursorScope } = cursorUpdate;
        const effectiveScope = cursorScope ?? DEFAULT_CURSOR_SCOPE;
        const newVersion = input.expectedVersion + 1;
        const effectiveLastIngestTimestamp = input.lastIngestTimestamp ?? now;
        if (input.expectedVersion === 0) {
          const insertData: DbHealthIngestCursorInsert = {
            userId,
            sourceId,
            sampleType,
            scope: effectiveScope,
            anchorData: input.anchorData,
            cursorVersion: 1,
            lastIngestTimestamp: effectiveLastIngestTimestamp,
            totalSamplesIngested: input.samplesIngested ?? 0,
            coldBackfillEndTs: input.coldBackfillEndTs ?? null,
            coldBackfillStartTs: input.coldBackfillStartTs ?? null,
            coldPageFromTs: input.coldPageFromTs ?? null,
            lastSyncAt: now,
            createdAt: now,
            updatedAt: now,
          };
          try {
            await drizzle.insert(healthIngestCursors).values(insertData);
            cursorResult = { success: true, newVersion: 1 };
          } catch (insertError: unknown) {
            const existing = await drizzle
              .select({ cursorVersion: healthIngestCursors.cursorVersion })
              .from(healthIngestCursors)
              .where(
                and(
                  eq(healthIngestCursors.userId, userId),
                  eq(healthIngestCursors.sourceId, sourceId),
                  eq(healthIngestCursors.sampleType, sampleType),
                  eq(healthIngestCursors.scope, effectiveScope)
                )
              )
              .get();
            cursorResult = {
              success: false,
              currentVersion: existing?.cursorVersion,
            };
            throw new Error('Cursor version conflict: expectedVersion=0 but cursor exists');
          }
        } else {
          const samplesIngested = input.samplesIngested ?? 0;
          const coldEndTs = input.coldBackfillEndTs !== undefined ? input.coldBackfillEndTs : null;
          const coldStartTs = input.coldBackfillStartTs !== undefined ? input.coldBackfillStartTs : null;
          const coldPageFromTsExplicit = input.coldPageFromTs !== undefined ? 1 : 0;
          const coldPageFromTsValue = typeof input.coldPageFromTs === 'number' ? input.coldPageFromTs : null;
          await drizzle.run(sql`
            UPDATE ${healthIngestCursors}
            SET
              anchor_data = ${input.anchorData},
              cursor_version = ${newVersion},
              last_ingest_timestamp = ${effectiveLastIngestTimestamp},
              total_samples_ingested = total_samples_ingested + ${samplesIngested},
              cold_backfill_end_ts = COALESCE(${coldEndTs}, cold_backfill_end_ts),
              cold_backfill_start_ts = COALESCE(${coldStartTs}, cold_backfill_start_ts),
              cold_page_from_ts = IIF(${coldPageFromTsExplicit} = 1, ${coldPageFromTsValue}, cold_page_from_ts),
              last_sync_at = ${now},
              updated_at = ${now}
            WHERE
              user_id = ${userId}
              AND source_id = ${sourceId}
              AND sample_type = ${sampleType}
              AND scope = ${effectiveScope}
              AND cursor_version = ${input.expectedVersion}
          `);
          const changesResult = await drizzle.get<{ affected: number }>(
            sql`SELECT changes() as affected`
          );
          const rowsAffected = changesResult?.affected ?? 0;
          if (rowsAffected === 1) {
            cursorResult = { success: true, newVersion };
          } else {
            const existing = await drizzle
              .select({ cursorVersion: healthIngestCursors.cursorVersion })
              .from(healthIngestCursors)
              .where(
                and(
                  eq(healthIngestCursors.userId, userId),
                  eq(healthIngestCursors.sourceId, sourceId),
                  eq(healthIngestCursors.sampleType, sampleType),
                  eq(healthIngestCursors.scope, effectiveScope)
                )
              )
              .get();
            cursorResult = {
              success: false,
              currentVersion: existing?.cursorVersion,
            };
            throw new Error(
              `Cursor CAS failure: expected ${input.expectedVersion}, got ${existing?.cursorVersion}`
            );
          }
        }
        if (onBeforeCommit && validSamples.length > 0) {
          await onBeforeCommit(validSamples);
        }
        await drizzle.run(sql`COMMIT`);
        logger.info('[HealthSampleRepository] Atomic ingest + cursor update completed', {
          samplesInserted: insertResult.inserted,
          duplicatesSkipped: insertResult.duplicatesSkipped,
          validationErrors: insertResult.errors.length,
          cursorSuccess: cursorResult.success,
          newCursorVersion: cursorResult.newVersion,
        });
        return { insertResult, cursorResult };
      } catch (innerError: unknown) {
        try {
          await drizzle.run(sql`ROLLBACK`);
        } catch (rollbackError: unknown) {
          logger.error('[HealthSampleRepository] ROLLBACK failed', {
            rollbackError: toLogError(rollbackError),
            originalError: toLogError(innerError),
          });
        }
        throw innerError; 
      }
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Atomic ingest + cursor update ROLLED BACK', {
        samplesAttempted: samples.length,
        cursorUpdate: {
          userId: cursorUpdate.userId,
          sourceId: cursorUpdate.sourceId,
          sampleType: cursorUpdate.sampleType,
          expectedVersion: cursorUpdate.input.expectedVersion,
        },
        error: toLogError(error),
      });
      return {
        insertResult: { inserted: 0, duplicatesSkipped: 0, errors: validationErrors },
        cursorResult: { success: false },
      };
    }
  }
  async stageForUpload(
    userId: string,
    limit: number = 500,
    now: number = Date.now()
  ): Promise<{ batchId: string; requestId: string } | null> {
    try {
      const drizzle = this.getDrizzle();
      const batchId = uuidv4();
      const requestId = uuidv4();
      const eligibleSamples = await drizzle
        .select({ id: healthSamples.id })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            isNull(healthSamples.stagedBatchId),
            eq(healthSamples.isDeleted, false), 
            or(
              eq(healthSamples.uploadStatus, 'pending'),
              and(
                eq(healthSamples.uploadStatus, 'failed'),
                lt(healthSamples.uploadAttemptCount, HEALTH_UPLOAD_RETRY_CONFIG.MAX_ATTEMPTS),
                or(
                  isNull(healthSamples.nextUploadAttemptAt),
                  lte(healthSamples.nextUploadAttemptAt, now)
                )
              )
            )
          )
        )
        .orderBy(asc(healthSamples.startTimestamp))
        .limit(limit);
      if (eligibleSamples.length === 0) {
        logger.debug('[HealthSampleRepository] No samples to stage', { userId });
        return null;
      }
      const eligibleIds = eligibleSamples.map((s) => s.id);
      await drizzle
        .update(healthSamples)
        .set({
          uploadStatus: 'staged',
          stagedBatchId: batchId,
          uploadRequestId: requestId,
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            inArray(healthSamples.id, eligibleIds),
            isNull(healthSamples.stagedBatchId) 
          )
        );
      const stagedCount = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(eq(healthSamples.stagedBatchId, batchId))
        .get();
      const rowsAffected = stagedCount?.count ?? 0;
      if (rowsAffected === 0) {
        logger.debug('[HealthSampleRepository] No samples staged (race condition)', { userId });
        return null;
      }
      logger.info('[HealthSampleRepository] Samples staged for upload', {
        batchId,
        requestId, 
        count: rowsAffected,
        userId,
      });
      return { batchId, requestId };
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error staging samples', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to stage samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getStagedSamples(batchId: string): Promise<DomainHealthSample[]> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(healthSamples)
        .where(eq(healthSamples.stagedBatchId, batchId))
        .orderBy(asc(healthSamples.startTimestamp));
      return rows.map(mapDbHealthSampleToDomain);
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error getting staged samples', {
        batchId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get staged samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getRequestIdForBatch(batchId: string): Promise<string | null> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select({ requestId: healthSamples.uploadRequestId })
        .from(healthSamples)
        .where(eq(healthSamples.stagedBatchId, batchId))
        .limit(1);
      return rows[0]?.requestId ?? null;
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error getting requestId for batch', {
        batchId,
        error: toLogError(error),
      });
      throw new Error(
        `Failed to get requestId for batch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getDeferredBatch(
    userId: string,
    now: number = Date.now()
  ): Promise<{ batchId: string; requestId: string } | null> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select({
          batchId: healthSamples.stagedBatchId,
          requestId: healthSamples.uploadRequestId,
        })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.uploadStatus, 'staged'),
            isNotNull(healthSamples.stagedBatchId),
            isNotNull(healthSamples.uploadRequestId),
            or(
              isNull(healthSamples.nextUploadAttemptAt),
              lte(healthSamples.nextUploadAttemptAt, now)
            )
          )
        )
        .orderBy(asc(healthSamples.nextUploadAttemptAt), asc(healthSamples.stateUpdatedAtMs))
        .limit(1);
      const row = rows[0];
      if (!row?.batchId || !row.requestId) {
        return null;
      }
      return { batchId: row.batchId, requestId: row.requestId };
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error getting deferred batch', {
        userId,
        error: toLogError(error),
      });
      throw new Error(
        `Failed to get deferred batch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async deferBatchForRetry(
    userId: string,
    batchId: string,
    retryAfterMs: number
  ): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      const now = Date.now();
      await drizzle
        .update(healthSamples)
        .set({
          uploadStatus: 'staged',
          nextUploadAttemptAt: now + retryAfterMs,
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.stagedBatchId, batchId),
            inArray(healthSamples.uploadStatus, ['staged', 'uploading'])
          )
        );
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error deferring batch', {
        userId,
        batchId,
        error: toLogError(error),
      });
      throw new Error(
        `Failed to defer batch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async unstageBatch(batchId: string): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      const now = Date.now();
      await drizzle
        .update(healthSamples)
        .set({
          uploadStatus: 'pending',
          stagedBatchId: null,
          uploadRequestId: null,
          stateUpdatedAtMs: now,
        })
        .where(eq(healthSamples.stagedBatchId, batchId));
      logger.debug('[HealthSampleRepository] Batch unstaged', { batchId });
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error unstaging batch', {
        batchId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to unstage batch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async markUploading(userId: string, sampleIds: string[]): Promise<StateTransitionResult> {
    if (sampleIds.length === 0) return { updated: 0, skipped: 0 };
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('[HealthSampleRepository] markUploading requires a valid userId for multi-user isolation');
    }
    try {
      const drizzle = this.getDrizzle();
      const now = Date.now();
      await drizzle
        .update(healthSamples)
        .set({
          uploadStatus: 'uploading',
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSamples.userId, userId), 
            inArray(healthSamples.id, sampleIds),
            eq(healthSamples.uploadStatus, 'staged') 
          )
        );
      const uploadingCount = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId), 
            inArray(healthSamples.id, sampleIds),
            eq(healthSamples.uploadStatus, 'uploading')
          )
        )
        .get();
      const updated = uploadingCount?.count ?? 0;
      const skipped = sampleIds.length - updated;
      if (skipped > 0) {
        logger.warn('[HealthSampleRepository] Some samples not transitioned to uploading', {
          userId,
          requested: sampleIds.length,
          updated,
          skipped,
          reason: 'Samples not in staged status or belong to different user (state guard + multi-user isolation)',
        });
      } else {
        logger.debug('[HealthSampleRepository] Samples marked as uploading', {
          userId,
          count: updated,
        });
      }
      return { updated, skipped };
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error marking samples as uploading', {
        userId,
        count: sampleIds.length,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to mark samples as uploading: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async markUploaded(userId: string, sampleIds: string[]): Promise<StateTransitionResult> {
    if (sampleIds.length === 0) return { updated: 0, skipped: 0 };
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('[HealthSampleRepository] markUploaded requires a valid userId for multi-user isolation');
    }
    try {
      const drizzle = this.getDrizzle();
      const now = Date.now();
      await drizzle
        .update(healthSamples)
        .set({
          uploadStatus: 'uploaded',
          uploadedAt: now,
          uploadError: null,
          stagedBatchId: null, 
          stateUpdatedAtMs: now,
        })
        .where(
          and(
            eq(healthSamples.userId, userId), 
            inArray(healthSamples.id, sampleIds),
            eq(healthSamples.uploadStatus, 'uploading') 
          )
        );
      const uploadedCount = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId), 
            inArray(healthSamples.id, sampleIds),
            eq(healthSamples.uploadStatus, 'uploaded')
          )
        )
        .get();
      const updated = uploadedCount?.count ?? 0;
      const skipped = sampleIds.length - updated;
      if (skipped > 0) {
        logger.warn('[HealthSampleRepository] Some samples not transitioned to uploaded', {
          userId,
          requested: sampleIds.length,
          updated,
          skipped,
          reason: 'Samples not in uploading status or belong to different user (state guard + multi-user isolation)',
        });
      } else {
        logger.debug('[HealthSampleRepository] Samples marked as uploaded', {
          userId,
          count: updated,
        });
      }
      return { updated, skipped };
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error marking samples as uploaded', {
        userId,
        count: sampleIds.length,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to mark samples as uploaded: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async markFailed(
    userId: string,
    sampleIds: string[],
    errorMessage: string,
    isRetryable: boolean = true,
    now: number = Date.now()
  ): Promise<{ failedCount: number; rejectedCount: number; skippedCount: number }> {
    if (sampleIds.length === 0) {
      return { failedCount: 0, rejectedCount: 0, skippedCount: 0 };
    }
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('[HealthSampleRepository] markFailed requires a valid userId for multi-user isolation');
    }
    try {
      const drizzle = this.getDrizzle();
      if (!isRetryable) {
        for (let i = 0; i < sampleIds.length; i += BULK_INSERT_CHUNK_SIZE) {
          const chunk = sampleIds.slice(i, i + BULK_INSERT_CHUNK_SIZE);
          await drizzle
            .update(healthSamples)
            .set({
              uploadStatus: 'rejected',
              stagedBatchId: null,
              uploadError: errorMessage,
              stateUpdatedAtMs: now,
            })
            .where(
              and(
                eq(healthSamples.userId, userId), 
                inArray(healthSamples.id, chunk),
                inArray(healthSamples.uploadStatus, ['uploading', 'staged'])
              )
            );
        }
        const rejectedCount = await drizzle
          .select({ count: count() })
          .from(healthSamples)
          .where(
            and(
              eq(healthSamples.userId, userId), 
              inArray(healthSamples.id, sampleIds),
              eq(healthSamples.uploadStatus, 'rejected')
            )
          )
          .get();
        const actualRejected = rejectedCount?.count ?? 0;
        const skipped = sampleIds.length - actualRejected;
        if (skipped > 0) {
          logger.warn('[HealthSampleRepository] Some samples not rejected (non-retryable)', {
            userId,
            requested: sampleIds.length,
            rejected: actualRejected,
            skipped,
            reason: 'Samples not in valid state for rejection or belong to different user (state guard + multi-user isolation)',
          });
        } else {
          logger.info('[HealthSampleRepository] Samples marked as rejected (non-retryable)', {
            userId,
            count: actualRejected,
            reason: errorMessage,
          });
        }
        return { failedCount: 0, rejectedCount: actualRejected, skippedCount: skipped };
      }
      const samples = await drizzle
        .select({
          id: healthSamples.id,
          uploadAttemptCount: healthSamples.uploadAttemptCount,
          uploadStatus: healthSamples.uploadStatus,
        })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId), 
            inArray(healthSamples.id, sampleIds),
            inArray(healthSamples.uploadStatus, ['staged', 'uploading'])
          )
        );
      const skippedCount = sampleIds.length - samples.length;
      if (skippedCount > 0) {
        logger.warn('[HealthSampleRepository] Some samples skipped in markFailed', {
          userId,
          requested: sampleIds.length,
          eligible: samples.length,
          skipped: skippedCount,
          reason: 'Samples not in staged/uploading state or belong to different user (state guard + multi-user isolation)',
        });
      }
      const toFail: Array<{ id: string; newAttemptCount: number; nextAttemptAt: number }> = [];
      const toReject: string[] = [];
      for (const sample of samples) {
        const currentAttempts = sample.uploadAttemptCount ?? 0;
        const newAttemptCount = currentAttempts + 1;
        if (newAttemptCount >= HEALTH_UPLOAD_RETRY_CONFIG.MAX_ATTEMPTS) {
          toReject.push(sample.id);
        } else {
          const backoffDelay = HEALTH_UPLOAD_RETRY_CONFIG.BASE_DELAY_MS * (1 << currentAttempts);
          toFail.push({
            id: sample.id,
            newAttemptCount,
            nextAttemptAt: now + backoffDelay,
          });
        }
      }
      for (const sample of toFail) {
        await drizzle
          .update(healthSamples)
          .set({
            uploadStatus: 'failed',
            stagedBatchId: null,
            uploadError: errorMessage,
            uploadAttemptCount: sample.newAttemptCount,
            nextUploadAttemptAt: sample.nextAttemptAt,
            stateUpdatedAtMs: now,
          })
          .where(
            and(
              eq(healthSamples.userId, userId), 
              eq(healthSamples.id, sample.id),
              inArray(healthSamples.uploadStatus, ['staged', 'uploading'])
            )
          );
      }
      for (const id of toReject) {
        const sample = samples.find((s) => s.id === id);
        const newAttemptCount = (sample?.uploadAttemptCount ?? 0) + 1;
        await drizzle
          .update(healthSamples)
          .set({
            uploadStatus: 'rejected',
            stagedBatchId: null,
            uploadError: errorMessage,
            uploadAttemptCount: newAttemptCount,
            nextUploadAttemptAt: null,
            stateUpdatedAtMs: now,
          })
          .where(
            and(
              eq(healthSamples.userId, userId), 
              eq(healthSamples.id, id),
              inArray(healthSamples.uploadStatus, ['staged', 'uploading'])
            )
          );
      }
      const failedCount = toFail.length;
      const rejectedCount = toReject.length;
      logger.info('[HealthSampleRepository] Samples marked for retry', {
        userId,
        totalCount: sampleIds.length,
        failedCount,
        rejectedCount,
        skippedCount,
        reason: errorMessage,
      });
      return { failedCount, rejectedCount, skippedCount };
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error marking samples as failed', {
        userId,
        count: sampleIds.length,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to mark samples as failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async markRejected(userId: string, sampleIds: string[], reason: string): Promise<StateTransitionResult> {
    if (sampleIds.length === 0) return { updated: 0, skipped: 0 };
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('[HealthSampleRepository] markRejected requires a valid userId for multi-user isolation');
    }
    try {
      const drizzle = this.getDrizzle();
      const now = Date.now();
      const eligibleCount = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId), 
            inArray(healthSamples.id, sampleIds),
            inArray(healthSamples.uploadStatus, ['staged', 'uploading', 'failed'])
          )
        )
        .get();
      const updated = eligibleCount?.count ?? 0;
      const skipped = sampleIds.length - updated;
      if (updated === 0) {
        logger.debug('[HealthSampleRepository] No eligible samples to reject', {
          userId,
          requested: sampleIds.length,
          skipped,
          reason: 'All samples already in terminal state, not in valid source state, or belong to different user',
        });
        return { updated: 0, skipped };
      }
      for (let i = 0; i < sampleIds.length; i += BULK_INSERT_CHUNK_SIZE) {
        const chunk = sampleIds.slice(i, i + BULK_INSERT_CHUNK_SIZE);
        await drizzle
          .update(healthSamples)
          .set({
            uploadStatus: 'rejected',
            stagedBatchId: null,
            uploadError: reason,
            stateUpdatedAtMs: now,
          })
          .where(
            and(
              eq(healthSamples.userId, userId), 
              inArray(healthSamples.id, chunk),
              inArray(healthSamples.uploadStatus, ['staged', 'uploading', 'failed'])
            )
          );
      }
      if (skipped > 0) {
        logger.warn('[HealthSampleRepository] Some samples not transitioned to rejected', {
          userId,
          requested: sampleIds.length,
          updated,
          skipped,
          reason: 'Samples not in valid pre-rejection state or belong to different user (state guard + multi-user isolation)',
        });
      } else {
        logger.debug('[HealthSampleRepository] Samples marked as rejected', {
          userId,
          count: updated,
          reason,
        });
      }
      return { updated, skipped };
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error marking samples as rejected', {
        userId,
        count: sampleIds.length,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to mark samples as rejected: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  public static DeletedSampleDetail = class {
    public readonly sampleType: string;
    public readonly startTimestamp: number;
    constructor(sampleType: string, startTimestamp: number) {
      this.sampleType = sampleType;
      this.startTimestamp = startTimestamp;
    }
  };
  public static SoftDeleteResult = class {
    public readonly deletedCount: number;
    public readonly alreadyDeletedCount: number;
    public readonly notFoundRecordIds: string[];
    public readonly deletedSampleDetails: ReadonlyArray<
      InstanceType<typeof HealthSampleRepository.DeletedSampleDetail>
    >;
    constructor(
      deletedCount: number,
      alreadyDeletedCount: number,
      notFoundRecordIds: string[],
      deletedSampleDetails: ReadonlyArray<
        InstanceType<typeof HealthSampleRepository.DeletedSampleDetail>
      > = []
    ) {
      this.deletedCount = deletedCount;
      this.alreadyDeletedCount = alreadyDeletedCount;
      this.notFoundRecordIds = notFoundRecordIds;
      this.deletedSampleDetails = deletedSampleDetails;
    }
  };
  async markSamplesDeletedBySourceRecordIds(
    userId: string,
    sourceId: string,
    sourceRecordIds: string[],
    yieldController?: CooperativeYieldController,
    onAfterDelete?: (deletedDetails: ReadonlyArray<InstanceType<typeof HealthSampleRepository.DeletedSampleDetail>>) => Promise<void>,
  ): Promise<InstanceType<typeof HealthSampleRepository.SoftDeleteResult>> {
    if (sourceRecordIds.length === 0) {
      return new HealthSampleRepository.SoftDeleteResult(0, 0, []);
    }
    try {
      const drizzle = this.getDrizzle();
      const now = Date.now();
      let totalDeleted = 0;
      let totalAlreadyDeleted = 0;
      const notFoundRecordIds: string[] = [];
      const allDeletedSampleDetails: InstanceType<typeof HealthSampleRepository.DeletedSampleDetail>[] = [];
      const foundSampleTimestamps = new Map<string, number>();
      let enqueuedCount = 0;
      let preciseModeCount = 0;
      let losslessModeCount = 0;
      await drizzle.run(sql`BEGIN TRANSACTION`);
      try {
        for (let i = 0; i < sourceRecordIds.length; i += BULK_INSERT_CHUNK_SIZE) {
          if (yieldController) {
            await yieldController.yieldIfNeeded('health_deletion_chunk_start');
          }
          const chunk = sourceRecordIds.slice(i, i + BULK_INSERT_CHUNK_SIZE);
          const existingSamples = await drizzle
            .select({
              sourceRecordId: healthSamples.sourceRecordId,
              startTimestamp: healthSamples.startTimestamp, 
              sampleType: healthSamples.sampleType,        
              isDeleted: healthSamples.isDeleted,
            })
            .from(healthSamples)
            .where(
              and(
                eq(healthSamples.userId, userId),
                eq(healthSamples.sourceId, sourceId),
                inArray(healthSamples.sourceRecordId, chunk)
              )
            );
          interface SampleInfo { isDeleted: boolean; startTimestamp: number; sampleType: string }
          const existingMap = new Map<string, SampleInfo>();
          for (const sample of existingSamples) {
            existingMap.set(sample.sourceRecordId, {
              isDeleted: sample.isDeleted ?? false,
              startTimestamp: sample.startTimestamp,
              sampleType: sample.sampleType,
            });
            foundSampleTimestamps.set(sample.sourceRecordId, sample.startTimestamp);
          }
          const recordIdsToDelete: string[] = [];
          for (const recordId of chunk) {
            const sampleInfo = existingMap.get(recordId);
            if (!sampleInfo) {
              notFoundRecordIds.push(recordId);
            } else if (sampleInfo.isDeleted === true) {
              totalAlreadyDeleted++;
            } else {
              recordIdsToDelete.push(recordId);
              allDeletedSampleDetails.push(
                new HealthSampleRepository.DeletedSampleDetail(
                  sampleInfo.sampleType,
                  sampleInfo.startTimestamp,
                )
              );
            }
          }
          if (recordIdsToDelete.length > 0) {
            await drizzle
              .update(healthSamples)
              .set({
                isDeleted: true,
                deletedAtMs: now,
                stateUpdatedAtMs: now,
              })
              .where(
                and(
                  eq(healthSamples.userId, userId),
                  eq(healthSamples.sourceId, sourceId),
                  inArray(healthSamples.sourceRecordId, recordIdsToDelete),
                  eq(healthSamples.isDeleted, false) 
                )
              );
            totalDeleted += recordIdsToDelete.length;
          }
        }
        if (onAfterDelete && allDeletedSampleDetails.length > 0) {
          await onAfterDelete(allDeletedSampleDetails);
        }
        const deletionQueueRepo = new HealthDeletionQueueRepository(drizzle);
        const deletionsToEnqueue: Array<{
          userId: string;
          sourceId: string;
          sourceRecordId: string;
          startTimestampMs: number | null;
          deletedAtMs: number;
        }> = [];
        for (const recordId of sourceRecordIds) {
          const startTimestamp = foundSampleTimestamps.get(recordId);
          if (startTimestamp !== undefined) {
            deletionsToEnqueue.push({
              userId,
              sourceId,
              sourceRecordId: recordId,
              startTimestampMs: startTimestamp,
              deletedAtMs: now,
            });
            preciseModeCount++;
          } else {
            deletionsToEnqueue.push({
              userId,
              sourceId,
              sourceRecordId: recordId,
              startTimestampMs: null,  
              deletedAtMs: now,
            });
            losslessModeCount++;
          }
        }
        if (deletionsToEnqueue.length > 0) {
          enqueuedCount = await deletionQueueRepo.enqueueDeletions(deletionsToEnqueue);
        }
        await drizzle.run(sql`COMMIT`);
      } catch (txnError: unknown) {
        try {
          await drizzle.run(sql`ROLLBACK`);
        } catch (rollbackError: unknown) {
          logger.error('[HealthSampleRepository] ROLLBACK failed during soft-delete', {
            userId, sourceId, rollbackError: toLogError(rollbackError),
          });
        }
        throw txnError;
      }
      logger.info('[HealthSampleRepository] Samples soft-deleted (ATOMIC)', {
        userId,
        sourceId,
        requestedCount: sourceRecordIds.length,
        deletedCount: totalDeleted,
        alreadyDeletedCount: totalAlreadyDeleted,
        notFoundLocally: notFoundRecordIds.length,
        enqueuedForSync: enqueuedCount,
        preciseModeEnqueued: preciseModeCount,    
        losslessModeEnqueued: losslessModeCount,  
      });
      return new HealthSampleRepository.SoftDeleteResult(
        totalDeleted,
        totalAlreadyDeleted,
        notFoundRecordIds,
        allDeletedSampleDetails,
      );
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error soft-deleting samples', {
        userId,
        sourceId,
        count: sourceRecordIds.length,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to soft-delete samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getDeletedSampleCount(userId: string): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.isDeleted, true)
          )
        )
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error counting deleted samples', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async purgeOldDeletedSamples(
    userId: string,
    retentionMs: number
  ): Promise<number> {
    if (retentionMs === undefined || retentionMs === null) {
      throw new Error(
        '[HealthSampleRepository] purgeOldDeletedSamples requires explicit retentionMs parameter. ' +
        'This prevents accidental data loss from default values.'
      );
    }
    if (retentionMs < 24 * 60 * 60 * 1000 && retentionMs > 0) {
      logger.warn('[HealthSampleRepository] Short purge retention period', {
        userId,
        retentionMs,
        retentionDays: retentionMs / (24 * 60 * 60 * 1000),
        warning: 'Retention less than 1 day may lose audit data',
      });
    }
    try {
      const drizzle = this.getDrizzle();
      const cutoffTime = Date.now() - retentionMs;
      const countResult = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.isDeleted, true),
            lte(healthSamples.deletedAtMs, cutoffTime)
          )
        )
        .get();
      const purgeCount = countResult?.count ?? 0;
      if (purgeCount === 0) {
        return 0;
      }
      await drizzle
        .delete(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.isDeleted, true),
            lte(healthSamples.deletedAtMs, cutoffTime)
          )
        );
      logger.info('[HealthSampleRepository] Purged old deleted samples', {
        userId,
        purgedCount: purgeCount,
        retentionDays: Math.floor(retentionMs / (24 * 60 * 60 * 1000)),
      });
      return purgeCount;
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error purging deleted samples', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async purgeUploadedSamplesOlderThan(
    userId: string,
    retentionMs: number,
    options?: {
      chunkSize?: number;
      dryRun?: boolean;
    }
  ): Promise<number> {
    if (retentionMs === undefined || retentionMs === null) {
      throw new Error(
        '[HealthSampleRepository] purgeUploadedSamplesOlderThan requires explicit retentionMs parameter. ' +
          'This prevents accidental data loss from default values.'
      );
    }
    if (retentionMs < 7 * 24 * 60 * 60 * 1000 && retentionMs > 0) {
      logger.warn('[HealthSampleRepository] Short retention period for uploaded samples', {
        userId,
        retentionMs,
        retentionDays: retentionMs / (24 * 60 * 60 * 1000),
        warning: 'Retention less than 7 days may cause data availability issues on device',
      });
    }
    try {
      const drizzle = this.getDrizzle();
      const cutoffTimestamp = Date.now() - retentionMs;
      const chunkSize = options?.chunkSize ?? BULK_INSERT_CHUNK_SIZE;
      const dryRun = options?.dryRun ?? false;
      const countResult = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.uploadStatus, 'uploaded'),
            eq(healthSamples.isDeleted, false),
            lte(healthSamples.endTimestamp, cutoffTimestamp)
          )
        )
        .get();
      const purgeCount = countResult?.count ?? 0;
      if (purgeCount === 0) {
        logger.debug('[HealthSampleRepository] No uploaded samples eligible for purge', {
          userId,
          cutoffTimestamp,
          retentionDays: Math.floor(retentionMs / (24 * 60 * 60 * 1000)),
        });
        return 0;
      }
      if (dryRun) {
        logger.info('[HealthSampleRepository] Dry run: would purge uploaded samples', {
          userId,
          wouldPurgeCount: purgeCount,
          cutoffTimestamp,
          retentionDays: Math.floor(retentionMs / (24 * 60 * 60 * 1000)),
        });
        return purgeCount;
      }
      let totalDeleted = 0;
      let hasMore = true;
      while (hasMore) {
        const idsToDelete = await drizzle
          .select({ id: healthSamples.id })
          .from(healthSamples)
          .where(
            and(
              eq(healthSamples.userId, userId),
              eq(healthSamples.uploadStatus, 'uploaded'),
              eq(healthSamples.isDeleted, false),
              lte(healthSamples.endTimestamp, cutoffTimestamp)
            )
          )
          .limit(chunkSize);
        if (idsToDelete.length === 0) {
          hasMore = false;
          break;
        }
        const ids = idsToDelete.map((row) => row.id);
        await drizzle.delete(healthSamples).where(inArray(healthSamples.id, ids));
        totalDeleted += ids.length;
        if (ids.length < chunkSize) {
          hasMore = false;
        }
      }
      logger.info('[HealthSampleRepository] Purged old uploaded samples', {
        userId,
        purgedCount: totalDeleted,
        retentionDays: Math.floor(retentionMs / (24 * 60 * 60 * 1000)),
        cutoffTimestamp,
      });
      return totalDeleted;
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error purging uploaded samples', {
        userId,
        retentionMs,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw error;
    }
  }
  async resetFailedToPending(userId: string): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const countResult = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(eq(healthSamples.userId, userId), eq(healthSamples.uploadStatus, 'failed'))
        )
        .get();
      const failedCount = countResult?.count ?? 0;
      if (failedCount === 0) {
        return 0;
      }
      await drizzle
        .update(healthSamples)
        .set({
          uploadStatus: 'pending',
          stagedBatchId: null,
          uploadError: null,
        })
        .where(
          and(eq(healthSamples.userId, userId), eq(healthSamples.uploadStatus, 'failed'))
        );
      logger.info('[HealthSampleRepository] Failed samples reset to pending', {
        userId,
        count: failedCount,
      });
      return failedCount;
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error resetting failed samples', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to reset samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async resetRejectedToPending(userId: string): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const countResult = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(eq(healthSamples.userId, userId), eq(healthSamples.uploadStatus, 'rejected'))
        )
        .get();
      const rejectedCount = countResult?.count ?? 0;
      if (rejectedCount === 0) {
        logger.info('[HealthSampleRepository] No rejected samples to reset', { userId });
        return 0;
      }
      await drizzle
        .update(healthSamples)
        .set({
          uploadStatus: 'pending',
          stagedBatchId: null,
          uploadError: null,
          uploadAttemptCount: 0, 
        })
        .where(
          and(eq(healthSamples.userId, userId), eq(healthSamples.uploadStatus, 'rejected'))
        );
      logger.info('[HealthSampleRepository] Rejected samples reset to pending', {
        userId,
        count: rejectedCount,
      });
      return rejectedCount;
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error resetting rejected samples', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to reset rejected samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  static readonly STUCK_UPLOADING_THRESHOLD_MS = 300_000; 
  async recoverStuckUploadingSamples(
    userId: string,
    stuckThresholdMs: number = HealthSampleRepository.STUCK_UPLOADING_THRESHOLD_MS,
    now: number = Date.now()
  ): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const cutoffTime = now - stuckThresholdMs;
      const stuckSamples = await drizzle
        .select({ id: healthSamples.id, stateUpdatedAtMs: healthSamples.stateUpdatedAtMs, createdAt: healthSamples.createdAt })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.uploadStatus, 'uploading'),
            or(
              and(
                sql`${healthSamples.stateUpdatedAtMs} IS NOT NULL`,
                lt(healthSamples.stateUpdatedAtMs, cutoffTime)
              ),
              and(
                isNull(healthSamples.stateUpdatedAtMs),
                lt(healthSamples.createdAt, cutoffTime)
              )
            )
          )
        );
      if (stuckSamples.length === 0) {
        logger.debug('[HealthSampleRepository] No stuck uploading samples to recover', { userId });
        return 0;
      }
      const stuckIds = stuckSamples.map((s) => s.id);
      for (let i = 0; i < stuckIds.length; i += BULK_INSERT_CHUNK_SIZE) {
        const chunk = stuckIds.slice(i, i + BULK_INSERT_CHUNK_SIZE);
        await drizzle
          .update(healthSamples)
          .set({
            uploadStatus: 'pending',      
            stagedBatchId: null,          
            uploadError: 'Recovered from crash - retrying',
            stateUpdatedAtMs: now,
          })
          .where(
            and(
              inArray(healthSamples.id, chunk),
              eq(healthSamples.uploadStatus, 'uploading')
            )
          );
      }
      logger.info('[HealthSampleRepository] Recovered stuck uploading samples', {
        userId,
        count: stuckIds.length,
        threshold: stuckThresholdMs,
        sampleIds: stuckIds.slice(0, 10), 
        hasMore: stuckIds.length > 10,
      });
      this.recordCrashRecoverySuccess('stuckUploading');
      return stuckIds.length;
    } catch (error: unknown) {
      const alertTriggered = this.recordCrashRecoveryFailure('stuckUploading');
      logger.error('[HealthSampleRepository] Error recovering stuck samples', {
        userId,
        alertTriggered,
        consecutiveFailures: this.crashRecoveryState.stuckUploading.consecutiveFailures,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to recover stuck samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async releaseExpiredStagedSamples(
    userId: string,
    now: number = Date.now(),
    leaseMs: number = STAGED_LEASE_TIMEOUT_MS
  ): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const cutoffTime = now - leaseMs;
      const stuckSamples = await drizzle
        .select({ id: healthSamples.id, stagedBatchId: healthSamples.stagedBatchId })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.uploadStatus, 'staged'),
            or(
              and(
                sql`${healthSamples.stateUpdatedAtMs} IS NOT NULL`,
                lt(healthSamples.stateUpdatedAtMs, cutoffTime)
              ),
              and(
                isNull(healthSamples.stateUpdatedAtMs),
                lt(healthSamples.createdAt, cutoffTime)
              )
            )
          )
        );
      if (stuckSamples.length === 0) {
        logger.debug('[HealthSampleRepository] No expired staged samples to release', { userId });
        return 0;
      }
      const stuckIds = stuckSamples.map((s) => s.id);
      for (let i = 0; i < stuckIds.length; i += BULK_INSERT_CHUNK_SIZE) {
        const chunk = stuckIds.slice(i, i + BULK_INSERT_CHUNK_SIZE);
        await drizzle
          .update(healthSamples)
          .set({
            uploadStatus: 'pending',
            stagedBatchId: null,
            uploadRequestId: null,
            uploadError: null,
            stateUpdatedAtMs: now,
          })
          .where(
            and(
              inArray(healthSamples.id, chunk),
              eq(healthSamples.uploadStatus, 'staged') 
            )
          );
      }
      logger.info('[HealthSampleRepository] Released expired staged samples', {
        userId,
        count: stuckIds.length,
        leaseMs,
        cutoffTime,
      });
      this.recordCrashRecoverySuccess('expiredStaged');
      return stuckIds.length;
    } catch (error: unknown) {
      const alertTriggered = this.recordCrashRecoveryFailure('expiredStaged');
      logger.error('[HealthSampleRepository] Error releasing expired staged samples', {
        userId,
        alertTriggered,
        consecutiveFailures: this.crashRecoveryState.expiredStaged.consecutiveFailures,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to release expired staged samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getPendingCount(userId: string): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.uploadStatus, 'pending')
          )
        )
        .get();
      return result?.count ?? 0;
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error getting pending count', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get pending count: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getSamplesByTypeAndTimeRange(
    userId: string,
    sampleType: string,
    startTimestamp: number,
    endTimestamp: number,
    limit: number = 1000
  ): Promise<DomainHealthSample[]> {
    try {
      const drizzle = this.getDrizzle();
      const rows = await drizzle
        .select()
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.sampleType, sampleType),
            sql`${healthSamples.startTimestamp} >= ${startTimestamp}`,
            sql`${healthSamples.startTimestamp} <= ${endTimestamp}`,
            eq(healthSamples.isDeleted, false)  
          )
        )
        .orderBy(asc(healthSamples.startTimestamp))
        .limit(limit);
      return rows.map(mapDbHealthSampleToDomain);
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error getting samples by type', {
        userId,
        sampleType,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getStats(userId: string, now: number = Date.now()): Promise<HealthSampleStats> {
    try {
      const drizzle = this.getDrizzle();
      const result = await drizzle
        .select({
          pendingCount: sql<number>`SUM(CASE WHEN ${healthSamples.uploadStatus} = 'pending' THEN 1 ELSE 0 END)`,
          stagedCount: sql<number>`SUM(CASE WHEN ${healthSamples.uploadStatus} = 'staged' THEN 1 ELSE 0 END)`,
          uploadingCount: sql<number>`SUM(CASE WHEN ${healthSamples.uploadStatus} = 'uploading' THEN 1 ELSE 0 END)`,
          uploadedCount: sql<number>`SUM(CASE WHEN ${healthSamples.uploadStatus} = 'uploaded' THEN 1 ELSE 0 END)`,
          failedCount: sql<number>`SUM(CASE WHEN ${healthSamples.uploadStatus} = 'failed' THEN 1 ELSE 0 END)`,
          rejectedCount: sql<number>`SUM(CASE WHEN ${healthSamples.uploadStatus} = 'rejected' THEN 1 ELSE 0 END)`,
          totalCount: count(),
          oldestPendingTimestamp: sql<number | null>`MIN(CASE WHEN ${healthSamples.uploadStatus} = 'pending' THEN ${healthSamples.startTimestamp} ELSE NULL END)`,
          retryEligibleCount: sql<number>`SUM(CASE
            WHEN ${healthSamples.uploadStatus} = 'failed'
              AND ${healthSamples.uploadAttemptCount} < ${HEALTH_UPLOAD_RETRY_CONFIG.MAX_ATTEMPTS}
              AND (${healthSamples.nextUploadAttemptAt} IS NULL OR ${healthSamples.nextUploadAttemptAt} <= ${now})
            THEN 1 ELSE 0 END)`,
        })
        .from(healthSamples)
        .where(eq(healthSamples.userId, userId))
        .get();
      return {
        pendingCount: result?.pendingCount ?? 0,
        stagedCount: result?.stagedCount ?? 0,
        uploadingCount: result?.uploadingCount ?? 0,
        uploadedCount: result?.uploadedCount ?? 0,
        failedCount: result?.failedCount ?? 0,
        rejectedCount: result?.rejectedCount ?? 0,
        totalCount: result?.totalCount ?? 0,
        oldestPendingTimestamp: result?.oldestPendingTimestamp ?? null,
        retryEligibleCount: result?.retryEligibleCount ?? 0,
      };
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error getting stats', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get stats: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async getAggregatedTelemetryBuckets(
    userId: string,
    sampleType: string,
    windowStartMs: number,
    windowEndMs: number,
    bucketSizeMs: number
  ): Promise<AggregatedTelemetryResult> {
    try {
      const drizzle = this.getDrizzle();
      const whereClause = and(
        eq(healthSamples.userId, userId),
        eq(healthSamples.sampleType, sampleType),
        sql`${healthSamples.startTimestamp} >= ${windowStartMs}`,
        sql`${healthSamples.startTimestamp} <= ${windowEndMs}`,
        isNotNull(healthSamples.value),
        eq(healthSamples.isDeleted, false)  
      );
      const bucketedResults = await drizzle
        .select({
          bucketIdx: sql<number>`cast(((${healthSamples.startTimestamp} - ${windowStartMs}) / ${bucketSizeMs}) as integer)`,
          minVal: sql<number>`min(${healthSamples.value})`,
          maxVal: sql<number>`max(${healthSamples.value})`,
          avgVal: sql<number>`avg(${healthSamples.value})`,
          sumVal: sql<number>`sum(${healthSamples.value})`,  
          sampleCount: sql<number>`count(*)`,
        })
        .from(healthSamples)
        .where(whereClause)
        .groupBy(sql`cast(((${healthSamples.startTimestamp} - ${windowStartMs}) / ${bucketSizeMs}) as integer)`)
        .orderBy(sql`cast(((${healthSamples.startTimestamp} - ${windowStartMs}) / ${bucketSizeMs}) as integer)`);
      const statsResult = await drizzle
        .select({
          min: sql<number>`min(${healthSamples.value})`,
          max: sql<number>`max(${healthSamples.value})`,
          avg: sql<number>`avg(${healthSamples.value})`,
          totalCount: count(),
        })
        .from(healthSamples)
        .where(whereClause)
        .get();
      const gapThresholdMs = bucketSizeMs * 2; 
      const gaps: Array<{ startMs: number; endMs: number }> = [];
      const rawTimestamps = await drizzle
        .select({
          timestamp: healthSamples.startTimestamp,
        })
        .from(healthSamples)
        .where(whereClause)
        .orderBy(healthSamples.startTimestamp);
      for (let i = 1; i < rawTimestamps.length; i++) {
        const prev = rawTimestamps[i - 1];
        const curr = rawTimestamps[i];
        if (prev && curr) {
          const delta = curr.timestamp - prev.timestamp;
          if (delta > gapThresholdMs) {
            gaps.push({
              startMs: prev.timestamp,
              endMs: curr.timestamp,
            });
          }
        }
      }
      const buckets: TelemetryBucket[] = bucketedResults.map((row) => ({
        bucketCenterMs: windowStartMs + (row.bucketIdx * bucketSizeMs) + Math.floor(bucketSizeMs / 2),
        value: row.avgVal ?? 0,
        minVal: row.minVal ?? 0,
        maxVal: row.maxVal ?? 0,
        sumVal: row.sumVal ?? 0,  
        sampleCount: row.sampleCount ?? 0,
      }));
      return {
        buckets,
        totalSampleCount: statsResult?.totalCount ?? 0,
        stats: {
          min: statsResult?.min ?? 0,
          max: statsResult?.max ?? 0,
          avg: statsResult?.avg ?? 0,
        },
        gaps,
      };
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error getting aggregated telemetry', {
        userId,
        sampleType,
        windowStartMs,
        windowEndMs,
        bucketSizeMs,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to get aggregated telemetry: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async cleanupUploadedSamples(userId: string, daysToKeep: number = 30): Promise<number> {
    try {
      const drizzle = this.getDrizzle();
      const cutoffTimestamp = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
      const countResult = await drizzle
        .select({ count: count() })
        .from(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.uploadStatus, 'uploaded'),
            lt(healthSamples.uploadedAt, cutoffTimestamp)
          )
        )
        .get();
      const countToDelete = countResult?.count ?? 0;
      if (countToDelete === 0) {
        return 0;
      }
      await drizzle
        .delete(healthSamples)
        .where(
          and(
            eq(healthSamples.userId, userId),
            eq(healthSamples.uploadStatus, 'uploaded'),
            lt(healthSamples.uploadedAt, cutoffTimestamp)
          )
        );
      logger.info('[HealthSampleRepository] Cleanup completed', {
        userId,
        daysToKeep,
        deletedCount: countToDelete,
      });
      return countToDelete;
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error cleaning up samples', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to cleanup samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async clearAll(userId: string): Promise<void> {
    try {
      const drizzle = this.getDrizzle();
      await drizzle.delete(healthSamples).where(eq(healthSamples.userId, userId));
      logger.warn('[HealthSampleRepository] All samples cleared', { userId });
    } catch (error: unknown) {
      logger.error('[HealthSampleRepository] Error clearing samples', {
        userId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Error', message: String(error) },
      });
      throw new Error(
        `Failed to clear samples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
