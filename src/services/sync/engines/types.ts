import type { EntityType } from '@shared/contracts';
import type { SyncBatchContext } from '../SyncBatchContext';
import type { OutboxCommand } from '../../../repositories/offline';
import type { SyncSource } from './SyncCoordinationState';
import type { CooperativeYieldController } from '../SyncScheduler';
export interface SyncRunContext {
  readonly batchContext: SyncBatchContext;
  readonly correlationId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly startedAt: Date;
  readonly source: SyncSource;
  readonly forced: boolean;
  readonly yieldController?: CooperativeYieldController;
  readonly leaseId?: string;
}
export function createSyncRunContext(
  batchContext: SyncBatchContext,
  userId: string,
  deviceId: string,
  source: SyncSource,
  forced: boolean = false,
  yieldController?: CooperativeYieldController,
  leaseId?: string,
): SyncRunContext {
  return {
    batchContext,
    correlationId: batchContext.batchId,
    userId,
    deviceId,
    startedAt: batchContext.startedAt,
    source,
    forced,
    yieldController,
    leaseId,
  };
}
export interface ResolvedCommand {
  readonly original: OutboxCommand;
  readonly resolvedPayload: Record<string, unknown>;
  readonly unresolvedFkFields: readonly string[];
  readonly unresolvedClientIds: readonly string[];
  readonly canPush: boolean;
}
export interface PushSuccessItem {
  readonly clientId: string;
  readonly serverId: string;
  readonly entityType: EntityType;
  readonly requestId?: string;
}
export interface PushFailedItem {
  readonly clientId: string;
  readonly error: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly errorCode?: string;
  readonly details?: Record<string, unknown>;
}
export interface PushConflictItem {
  readonly id: string;
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly userId: string;
  readonly requestId?: string;
  readonly remoteVersion?: Record<string, unknown>;
}
export interface PushReport {
  readonly successful: readonly PushSuccessItem[];
  readonly failed: readonly PushFailedItem[];
  readonly conflicts: readonly PushConflictItem[];
  readonly commandsProcessed: number;
  readonly commandsDeferred: number;
  readonly tombstonesProcessed: number;
  readonly durationMs: number;
  readonly success: boolean;
}
export function createEmptyPushReport(durationMs: number = 0): PushReport {
  return {
    successful: [],
    failed: [],
    conflicts: [],
    commandsProcessed: 0,
    commandsDeferred: 0,
    tombstonesProcessed: 0,
    durationMs,
    success: true,
  };
}
export interface PullChangeItem {
  readonly entityType: EntityType;
  readonly operation: 'CREATE' | 'UPDATE' | 'DELETE';
  readonly serverId: string;
  readonly data?: Record<string, unknown>;
  readonly timestamp: string;
}
export type EntityCursorMap = Readonly<Record<EntityType, string>>;
export interface PullReport {
  readonly changes: readonly PullChangeItem[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly entityCursors: EntityCursorMap;
  readonly recordsReturned: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly error?: string;
}
export function createEmptyPullReport(durationMs: number = 0): PullReport {
  return {
    changes: [],
    cursor: null,
    hasMore: false,
    entityCursors: {} as EntityCursorMap,
    recordsReturned: 0,
    durationMs,
    success: true,
  };
}
export type ApplyChangeResult =
  | { readonly status: 'applied'; readonly entityType: EntityType; readonly serverId: string }
  | { readonly status: 'skipped'; readonly entityType: EntityType; readonly serverId: string; readonly reason: string }
  | { readonly status: 'conflict_resolved'; readonly entityType: EntityType; readonly serverId: string; readonly outcome: string }
  | { readonly status: 'failed'; readonly entityType: EntityType; readonly serverId: string; readonly error: string };
export interface ApplyReport {
  readonly applied: readonly { entityType: EntityType; serverId: string }[];
  readonly skipped: readonly { entityType: EntityType; serverId: string; reason: string }[];
  readonly conflictsResolved: readonly { entityType: EntityType; serverId: string; outcome: string }[];
  readonly failed: readonly { entityType: EntityType; serverId: string; error: string }[];
  readonly failedByType: Readonly<Partial<Record<EntityType, readonly string[]>>>;
  readonly totalProcessed: number;
  readonly durationMs: number;
  readonly success: boolean;
}
export function createEmptyApplyReport(durationMs: number = 0): ApplyReport {
  return {
    applied: [],
    skipped: [],
    conflictsResolved: [],
    failed: [],
    failedByType: {},
    totalProcessed: 0,
    durationMs,
    success: true,
  };
}
export type { IntegrityReport } from '../IntegrityGate';
export interface SyncReport {
  readonly syncId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly source: SyncSource;
  readonly success: boolean;
  readonly durationMs: number;
  readonly push: PushReport | null;
  readonly pull: PullReport | null;
  readonly apply: ApplyReport | null;
  readonly integrityPassed: boolean | null;
  readonly error: SyncEngineError | null;
  readonly completedAt: Date;
}
export function createFailedSyncReport(
  syncId: string,
  userId: string,
  deviceId: string,
  source: SyncSource,
  error: SyncEngineError,
  durationMs: number,
): SyncReport {
  return {
    syncId,
    userId,
    deviceId,
    source,
    success: false,
    durationMs,
    push: null,
    pull: null,
    apply: null,
    integrityPassed: null,
    error,
    completedAt: new Date(),
  };
}
export type SyncEngineType = 'PUSH' | 'PULL' | 'APPLY' | 'COORDINATOR' | 'INTEGRITY';
export const SYNC_ERROR_CODES = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  CURSOR_CORRUPTED: 'CURSOR_CORRUPTED',
  CURSOR_BACKWARD: 'CURSOR_BACKWARD',
  UNKNOWN_ENTITY_TYPE: 'UNKNOWN_ENTITY_TYPE',
  FK_RESOLUTION_FAILED: 'FK_RESOLUTION_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  CONFLICT_UNRESOLVED: 'CONFLICT_UNRESOLVED',
  CONFLICT_MANUAL_REQUIRED: 'CONFLICT_MANUAL_REQUIRED',
  INTEGRITY_VIOLATION: 'INTEGRITY_VIOLATION',
  ORPHAN_FK_DETECTED: 'ORPHAN_FK_DETECTED',
  INITIALIZATION_FAILED: 'INITIALIZATION_FAILED',
  LOCK_ACQUISITION_FAILED: 'LOCK_ACQUISITION_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;
export type SyncErrorCode = typeof SYNC_ERROR_CODES[keyof typeof SYNC_ERROR_CODES];
export class SyncEngineError extends Error {
  public override readonly name = 'SyncEngineError';
  constructor(
    public readonly engine: SyncEngineType,
    public readonly code: SyncErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    public readonly context?: Record<string, unknown>,
    public readonly cause?: Error,
  ) {
    super(`[${engine}] ${code}: ${message}`);
    Object.setPrototypeOf(this, SyncEngineError.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SyncEngineError);
    }
  }
  public static fromUnknown(
    engine: SyncEngineType,
    error: unknown,
    context?: Record<string, unknown>,
  ): SyncEngineError {
    if (error instanceof SyncEngineError) {
      return error;
    }
    const message = error instanceof Error
      ? error.message
      : String(error);
    return new SyncEngineError(
      engine,
      SYNC_ERROR_CODES.UNEXPECTED_ERROR,
      message,
      false,
      context,
      error instanceof Error ? error : undefined,
    );
  }
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      engine: this.engine,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
      stack: this.stack,
    };
  }
}
export interface SyncOptions {
  readonly source?: SyncSource;
  readonly force?: boolean;
  readonly bustCache?: boolean;
  readonly entityTypes?: readonly EntityType[];
  readonly skipPush?: boolean;
  readonly skipPull?: boolean;
  readonly skipIntegrityCheck?: boolean;
  readonly timeoutMs?: number;
  readonly yieldController?: CooperativeYieldController;
  readonly leaseId?: string;
}
export const DEFAULT_SYNC_OPTIONS: Required<Omit<SyncOptions, 'entityTypes' | 'timeoutMs' | 'yieldController' | 'leaseId'>> = {
  source: 'EXTERNAL',
  force: false,
  bustCache: false,
  skipPush: false,
  skipPull: false,
  skipIntegrityCheck: false,
};
