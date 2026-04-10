import {
  type MergeContext,
  type MergeResult,
  getMonotonicTransitions,
} from '@shared/contracts';
import { SessionStatus } from '../../../../types';
export { SessionStatus };
export interface SessionMergeData {
  id: string;
  userId: string;
  purchaseId?: string | null;
  deviceId?: string | null;
  clientSessionId?: string | null;
  primaryProductId?: string | null;
  sessionStartTimestamp: string;
  sessionEndTimestamp?: string | null;
  hitCount?: number;
  totalDurationMs?: number;
  avgHitDurationMs?: number;
  sessionTypeHeuristic?: string | null;
  observationFeature?: number | null;
  status: SessionStatus;
  notes?: string | null;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}
const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = [
  SessionStatus.COMPLETED,
  SessionStatus.CANCELLED,
] as const;
function resolveMonotonicStatus(
  localStatus: SessionStatus | undefined,
  serverStatus: SessionStatus | undefined,
  transitions: readonly SessionStatus[]
): { value: SessionStatus | undefined; source?: 'local' | 'server' } {
  if (serverStatus && TERMINAL_SESSION_STATUSES.includes(serverStatus)) {
    return { value: serverStatus, source: 'server' };
  }
  if (localStatus && TERMINAL_SESSION_STATUSES.includes(localStatus)) {
    return { value: localStatus, source: 'local' };
  }
  const localIdx = localStatus ? transitions.indexOf(localStatus) : -1;
  const serverIdx = serverStatus ? transitions.indexOf(serverStatus) : -1;
  if (localIdx === -1 && serverIdx === -1) {
    if (serverStatus) return { value: serverStatus, source: 'server' };
    if (localStatus) return { value: localStatus, source: 'local' };
    return { value: undefined };
  }
  if (localIdx >= 0 && serverIdx < 0) {
    return { value: localStatus, source: 'local' };
  }
  if (serverIdx >= 0 && localIdx < 0) {
    return { value: serverStatus, source: 'server' };
  }
  if (localIdx > serverIdx) {
    return { value: localStatus, source: 'local' };
  }
  return { value: serverStatus, source: 'server' };
}
export function mergeSession(
  local: SessionMergeData,
  server: SessionMergeData,
  context: MergeContext
): MergeResult<SessionMergeData> {
  const resolvedFromLocal: string[] = [];
  const resolvedFromServer: string[] = [];
  const mergedFields: string[] = [];
  const merged: SessionMergeData = { ...local, ...server };
  merged.hitCount = server.hitCount ?? local.hitCount ?? 0;
  resolvedFromServer.push('hitCount');
  merged.totalDurationMs = server.totalDurationMs ?? local.totalDurationMs ?? 0;
  resolvedFromServer.push('totalDurationMs');
  merged.avgHitDurationMs = server.avgHitDurationMs ?? (
    merged.hitCount > 0 ? Math.round(merged.totalDurationMs / merged.hitCount) : 0
  );
  resolvedFromServer.push('avgHitDurationMs');
  merged.sessionStartTimestamp = server.sessionStartTimestamp || local.sessionStartTimestamp;
  resolvedFromServer.push('sessionStartTimestamp');
  merged.sessionEndTimestamp = server.sessionEndTimestamp ?? local.sessionEndTimestamp ?? null;
  resolvedFromServer.push('sessionEndTimestamp');
  const statusTransitions = (getMonotonicTransitions('sessions', 'status') as readonly SessionStatus[] | undefined) ?? [
    SessionStatus.ACTIVE,
    SessionStatus.PAUSED,
    SessionStatus.CANCELLED,
    SessionStatus.COMPLETED,
  ];
  const resolvedStatus = resolveMonotonicStatus(local.status, server.status, statusTransitions);
  if (resolvedStatus.value !== undefined) {
    merged.status = resolvedStatus.value;
    if (resolvedStatus.source === 'local') {
      resolvedFromLocal.push('status');
    } else if (resolvedStatus.source === 'server') {
      resolvedFromServer.push('status');
    }
  } else {
    merged.status = merged.status ?? SessionStatus.ACTIVE;
    resolvedFromServer.push('status');
  }
  if (server.userId) {
    merged.userId = server.userId;
    resolvedFromServer.push('userId');
  }
  if (server.primaryProductId !== undefined) {
    merged.primaryProductId = server.primaryProductId;
    resolvedFromServer.push('primaryProductId');
  }
  if (local.notes !== undefined && local.notes !== null) {
    merged.notes = local.notes;
    resolvedFromLocal.push('notes');
  } else {
    merged.notes = server.notes ?? null;
    resolvedFromServer.push('notes');
  }
  merged.clientSessionId = local.clientSessionId || server.clientSessionId;
  if (local.clientSessionId) {
    resolvedFromLocal.push('clientSessionId');
  } else {
    resolvedFromServer.push('clientSessionId');
  }
  if (server.purchaseId !== undefined) {
    merged.purchaseId = server.purchaseId ?? null;
    resolvedFromServer.push('purchaseId');
  } else if (local.purchaseId !== undefined) {
    merged.purchaseId = local.purchaseId ?? null;
    resolvedFromLocal.push('purchaseId');
  }
  if (server.deviceId !== undefined) {
    merged.deviceId = server.deviceId ?? null;
    resolvedFromServer.push('deviceId');
  } else if (local.deviceId !== undefined) {
    merged.deviceId = local.deviceId ?? null;
    resolvedFromLocal.push('deviceId');
  }
  if (server.sessionTypeHeuristic !== undefined) {
    merged.sessionTypeHeuristic = server.sessionTypeHeuristic ?? null;
    resolvedFromServer.push('sessionTypeHeuristic');
  } else if (local.sessionTypeHeuristic !== undefined) {
    merged.sessionTypeHeuristic = local.sessionTypeHeuristic ?? null;
    resolvedFromLocal.push('sessionTypeHeuristic');
  }
  if (server.observationFeature !== undefined) {
    merged.observationFeature = server.observationFeature ?? null;
    resolvedFromServer.push('observationFeature');
  } else if (local.observationFeature !== undefined) {
    merged.observationFeature = local.observationFeature ?? null;
    resolvedFromLocal.push('observationFeature');
  }
  const newVersion = Math.max(
    context.localVersion,
    context.serverVersion
  ) + 1;
  merged.version = newVersion;
  merged.updatedAt = context.now;
  merged.createdAt = server.createdAt ?? local.createdAt;
  return {
    data: merged,
    version: newVersion,
    resolvedFromLocal: Object.freeze(resolvedFromLocal),
    resolvedFromServer: Object.freeze(resolvedFromServer),
    mergedFields: Object.freeze(mergedFields),
    updatedAt: context.now,
  };
}
