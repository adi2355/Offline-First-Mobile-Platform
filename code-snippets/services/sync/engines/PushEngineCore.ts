import {
  type EntityType,
  tryCanonicalizeEntityType,
  canonicalizeEntityType,
  getSyncOrder,
  getForeignKeyFields,
  getOptionalForeignKeyFields,
  getTargetEntityForFkField,
  isEntityType,
} from '@shared/contracts';
import type { OutboxCommand } from '../../../repositories/offline';
import type {
  ResolvedCommand,
  PushSuccessItem,
  PushFailedItem,
  PushConflictItem,
  PushReport,
} from './types';
import { sha256 } from '../../../utils/sha256';
export interface PushRequestChange {
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly changeType: 'CREATE' | 'UPDATE' | 'DELETE';
  readonly clientId: string;
  readonly requestId: string;
  readonly data: Record<string, unknown>;
  readonly version: number;
  readonly timestamp: string;
}
export interface PushRequestBody {
  readonly deviceId: string;
  readonly changes: readonly PushRequestChange[];
  readonly syncOperationId: string;
  readonly lastSyncCursor?: string;
}
export interface PushResponseBody {
  readonly successful: readonly PushSuccessItem[];
  readonly failed: readonly PushFailedItem[];
  readonly conflicts: readonly PushConflictItem[];
}
export interface FkResolutionFieldResult {
  readonly field: string;
  readonly clientId: string;
  readonly serverId: string | null;
  readonly isOptional: boolean;
  readonly action: 'resolved' | 'nullified' | 'kept' | 'pending';
}
export interface FkResolutionInput {
  readonly entityType: EntityType;
  readonly payload: Record<string, unknown>;
  readonly idMappings: ReadonlyMap<string, string>; 
  readonly pendingCreateIds: ReadonlyMap<EntityType, ReadonlySet<string>>; 
}
export interface FkResolutionOutput {
  readonly resolvedPayload: Record<string, unknown>;
  readonly fieldResults: readonly FkResolutionFieldResult[];
  readonly unresolvedMandatoryFields: readonly string[];
  readonly canPush: boolean;
}
export function orderCommands(commands: readonly OutboxCommand[]): OutboxCommand[] {
  const OP_ORDER = { CREATE: 1, UPDATE: 2, DELETE: 3 } as const;
  return [...commands].sort((a, b) => {
    const opDiff = OP_ORDER[a.eventType] - OP_ORDER[b.eventType];
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
export function collectCreateIds(
  commands: readonly OutboxCommand[],
): Map<EntityType, Set<string>> {
  const createIdsByEntity = new Map<EntityType, Set<string>>();
  for (const cmd of commands) {
    if (cmd.eventType !== 'CREATE') continue;
    const entityType = tryCanonicalizeEntityType(cmd.aggregateType);
    if (!entityType) continue; 
    const set = createIdsByEntity.get(entityType) ?? new Set<string>();
    set.add(cmd.aggregateId);
    createIdsByEntity.set(entityType, set);
  }
  return createIdsByEntity;
}
export function resolveForeignKeysInPayload(input: FkResolutionInput): FkResolutionOutput {
  const { entityType, payload, idMappings, pendingCreateIds } = input;
  const resolvedPayload = { ...payload };
  const fieldResults: FkResolutionFieldResult[] = [];
  const unresolvedMandatoryFields: string[] = [];
  const fkFields = getForeignKeyFields(entityType);
  const optionalFkFields = getOptionalForeignKeyFields(entityType);
  for (const field of fkFields) {
    const clientId = payload[field];
    if (typeof clientId !== 'string' || !clientId) {
      continue;
    }
    const isOptional = optionalFkFields.has(field);
    const serverId = idMappings.get(clientId) ?? null;
    if (serverId) {
      resolvedPayload[field] = serverId;
      fieldResults.push({
        field,
        clientId,
        serverId,
        isOptional,
        action: 'resolved',
      });
    } else {
      const referencedType = getTargetEntityForFkField(entityType, field);
      const pendingCreates = referencedType ? pendingCreateIds.get(referencedType) : undefined;
      const isPending = pendingCreates?.has(clientId) ?? false;
      if (isPending) {
        fieldResults.push({
          field,
          clientId,
          serverId: null,
          isOptional,
          action: 'pending',
        });
      } else if (isOptional) {
        const isStableId = field === 'deviceId' || field === 'sessionId';
        const looksLikeValidId = clientId.length >= 17; 
        if (isStableId && looksLikeValidId) {
          fieldResults.push({
            field,
            clientId,
            serverId: null,
            isOptional,
            action: 'kept',
          });
        } else {
          resolvedPayload[field] = null;
          fieldResults.push({
            field,
            clientId,
            serverId: null,
            isOptional,
            action: 'nullified',
          });
        }
      } else {
        unresolvedMandatoryFields.push(field);
        fieldResults.push({
          field,
          clientId,
          serverId: null,
          isOptional,
          action: 'kept',
        });
      }
    }
  }
  return {
    resolvedPayload,
    fieldResults,
    unresolvedMandatoryFields,
    canPush: unresolvedMandatoryFields.length === 0,
  };
}
export interface BuildPushRequestOptions {
  readonly deviceId: string;
  readonly syncOperationId: string;
  readonly lastSyncCursor?: string;
}
export interface PushChangeInput {
  readonly command: OutboxCommand;
  readonly resolvedPayload: Record<string, unknown>;
  readonly resolvedAggregateId: string;
  readonly timestamp: string;
  readonly version: number;
}
export function buildPushRequest(
  changes: readonly PushChangeInput[],
  options: BuildPushRequestOptions,
): PushRequestBody {
  const requestChanges: PushRequestChange[] = changes.map((input) => {
    const entityType = canonicalizeEntityType(input.command.aggregateType);
    const commandId = input.command.id;
    if (!commandId) {
      throw new Error(
        `[buildPushRequest] Command missing id for aggregate ${input.command.aggregateId} ` +
        `(${input.command.aggregateType}/${input.command.eventType}) — cannot build requestId`
      );
    }
    return {
      entityType,
      entityId: input.resolvedAggregateId,
      changeType: input.command.eventType,
      clientId: input.command.aggregateId,
      requestId: commandId,
      data: input.resolvedPayload,
      version: input.version,
      timestamp: input.timestamp,
    };
  });
  return {
    deviceId: options.deviceId,
    changes: requestChanges,
    syncOperationId: options.syncOperationId,
    lastSyncCursor: options.lastSyncCursor,
  };
}
export interface ProcessPushResponseContext {
  readonly startTime: number;
  readonly commandsSent: number;
  readonly commandsDeferred: number;
  readonly tombstonesSent: number;
}
export function processPushResponse(
  response: PushResponseBody,
  context: ProcessPushResponseContext,
): PushReport {
  const durationMs = Date.now() - context.startTime;
  const successful: PushSuccessItem[] = response.successful.map((item) => ({
    clientId: item.clientId,
    serverId: item.serverId,
    entityType: isEntityType(item.entityType) ? item.entityType : ('unknown' as EntityType),
    requestId: item.requestId,
  }));
  const failed: PushFailedItem[] = response.failed.map((item) => ({
    clientId: item.clientId,
    error: item.error,
    retryable: item.retryable ?? false,
    requestId: item.requestId,
    errorCode: item.errorCode,
    details: item.details,
  }));
  const conflicts: PushConflictItem[] = response.conflicts.map((item) => ({
    id: item.id,
    entityType: isEntityType(item.entityType) ? item.entityType : ('unknown' as EntityType),
    entityId: item.entityId,
    userId: item.userId,
    requestId: item.requestId,
    remoteVersion: item.remoteVersion,
  }));
  return {
    successful,
    failed,
    conflicts,
    commandsProcessed: context.commandsSent,
    commandsDeferred: context.commandsDeferred,
    tombstonesProcessed: context.tombstonesSent,
    durationMs,
    success: failed.length === 0,
  };
}
export function shouldSkipCommand(
  command: OutboxCommand,
  hasServerIdMapping: boolean,
  hasPendingCreateInBatch: boolean = false,
): { skip: boolean; reason?: string } {
  if (command.eventType === 'DELETE' && !hasServerIdMapping) {
    return {
      skip: true,
      reason: 'DELETE skipped: entity CREATE not yet synced',
    };
  }
  if (command.eventType === 'UPDATE' && !hasServerIdMapping && !hasPendingCreateInBatch) {
    return {
      skip: true,
      reason: 'UPDATE skipped: no server ID mapping (entity CREATE may not have synced yet)',
    };
  }
  return { skip: false };
}
export function isSyncableEntityType(
  entityType: EntityType,
  syncableTypes: ReadonlySet<EntityType>,
): boolean {
  return syncableTypes.has(entityType);
}
export function groupSuccessfulByEntityType(
  successful: readonly PushSuccessItem[],
): Set<EntityType> {
  const types = new Set<EntityType>();
  for (const item of successful) {
    if (isEntityType(item.entityType)) {
      types.add(item.entityType);
    }
  }
  return types;
}
export function computeDeterministicSyncOperationId(
  outboxEventIds: readonly string[],
  prefix = 'sync',
): string {
  const sorted = [...outboxEventIds].sort();
  const input = sorted.join('|');
  const digest = sha256(input);
  return `${prefix}-${digest}`;
}
export function categorizeFailed(
  failed: readonly PushFailedItem[],
): { retryable: PushFailedItem[]; nonRetryable: PushFailedItem[] } {
  const retryable: PushFailedItem[] = [];
  const nonRetryable: PushFailedItem[] = [];
  for (const item of failed) {
    if (item.retryable) {
      retryable.push(item);
    } else {
      nonRetryable.push(item);
    }
  }
  return { retryable, nonRetryable };
}
