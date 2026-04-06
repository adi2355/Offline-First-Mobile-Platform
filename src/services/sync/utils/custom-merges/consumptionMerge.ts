import {
  type MergeContext,
  type MergeResult,
} from '@shared/contracts';
export interface ConsumptionMergeData {
  id: string;
  userId: string;
  serverId?: string | null;
  clientConsumptionId?: string | null;
  sessionId?: string | null;
  productId?: string | null;
  purchaseId?: string | null;
  deviceId?: string | null;
  clientPurchaseId?: string | null;
  timestamp: string;
  method?: string | null;
  notes?: string | null;
  intensity?: number | null;
  durationMs?: number | null;
  quantity?: string | number | null;
  estimatedThcMg?: string | number | null;
  isJournaled?: boolean;
  _offline?: boolean;
  _pendingSync?: boolean;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}
function normalizeDecimalString(
  value: string | number | null | undefined,
  precision: number
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) {
    return undefined;
  }
  return num.toFixed(precision);
}
export function mergeConsumption(
  local: ConsumptionMergeData,
  server: ConsumptionMergeData,
  context: MergeContext
): MergeResult<ConsumptionMergeData> {
  const resolvedFromLocal: string[] = [];
  const resolvedFromServer: string[] = [];
  const mergedFields: string[] = [];
  const merged: ConsumptionMergeData = { ...server };
  merged.clientConsumptionId = local.clientConsumptionId || server.clientConsumptionId;
  if (local.clientConsumptionId) {
    resolvedFromLocal.push('clientConsumptionId');
  } else {
    resolvedFromServer.push('clientConsumptionId');
  }
  merged.id = local.id ?? server.id;
  if (local.id) {
    resolvedFromLocal.push('id');
  } else {
    resolvedFromServer.push('id');
  }
  if (server.id !== undefined) {
    merged.serverId = server.id;
    resolvedFromServer.push('serverId');
  } else if (local.serverId !== undefined) {
    merged.serverId = local.serverId;
    resolvedFromLocal.push('serverId');
  }
  merged.userId = server.userId;
  resolvedFromServer.push('userId');
  merged.sessionId = server.sessionId; 
  resolvedFromServer.push('sessionId');
  merged.productId = server.productId; 
  resolvedFromServer.push('productId');
  merged.purchaseId = server.purchaseId; 
  resolvedFromServer.push('purchaseId');
  merged.deviceId = server.deviceId; 
  resolvedFromServer.push('deviceId');
  merged.createdAt = server.createdAt;
  resolvedFromServer.push('createdAt');
  merged.updatedAt = server.updatedAt;
  resolvedFromServer.push('updatedAt');
  merged.version = server.version;
  resolvedFromServer.push('version');
  if (local.notes !== undefined) {
    merged.notes = local.notes;
    resolvedFromLocal.push('notes');
  } else {
    resolvedFromServer.push('notes');
  }
  if (local.intensity !== undefined) {
    merged.intensity = local.intensity;
    resolvedFromLocal.push('intensity');
  } else {
    resolvedFromServer.push('intensity');
  }
  if (local.isJournaled !== undefined) {
    merged.isJournaled = local.isJournaled;
    resolvedFromLocal.push('isJournaled');
  } else {
    resolvedFromServer.push('isJournaled');
  }
  if (local.durationMs !== undefined) {
    merged.durationMs = local.durationMs;
    resolvedFromLocal.push('durationMs');
  } else {
    resolvedFromServer.push('durationMs');
  }
  if (local.quantity !== undefined) {
    merged.quantity = local.quantity;
    resolvedFromLocal.push('quantity');
  } else {
    resolvedFromServer.push('quantity');
  }
  if (local.estimatedThcMg !== undefined) {
    merged.estimatedThcMg = local.estimatedThcMg;
    resolvedFromLocal.push('estimatedThcMg');
  } else {
    resolvedFromServer.push('estimatedThcMg');
  }
  if (local.method !== undefined) {
    merged.method = local.method;
    resolvedFromLocal.push('method');
  } else {
    merged.method = server.method;
    resolvedFromServer.push('method');
  }
  if (local._pendingSync) {
    merged._pendingSync = true;
    resolvedFromLocal.push('_pendingSync');
  }
  if (!merged.clientPurchaseId && local.clientPurchaseId) {
    merged.clientPurchaseId = local.clientPurchaseId;
    resolvedFromLocal.push('clientPurchaseId');
  }
  if (local.timestamp) {
    merged.timestamp = local.timestamp;
    resolvedFromLocal.push('timestamp');
  } else {
    merged.timestamp = server.timestamp;
    resolvedFromServer.push('timestamp');
  }
  if (merged.quantity !== undefined) {
    const normalized = normalizeDecimalString(merged.quantity, 3);
    if (normalized) {
      merged.quantity = normalized;
    }
  }
  if (merged.estimatedThcMg !== undefined) {
    const normalized = normalizeDecimalString(merged.estimatedThcMg, 2);
    if (normalized) {
      merged.estimatedThcMg = normalized;
    }
  }
  if (!merged._pendingSync) {
    merged._offline = undefined;
  }
  const newVersion = Math.max(
    context.localVersion,
    context.serverVersion
  ) + 1;
  merged.version = newVersion;
  merged.updatedAt = context.now;
  return {
    data: merged,
    version: newVersion,
    resolvedFromLocal: Object.freeze(resolvedFromLocal),
    resolvedFromServer: Object.freeze(resolvedFromServer),
    mergedFields: Object.freeze(mergedFields),
    updatedAt: context.now,
  };
}
