import type { EntityType } from '@shared/contracts';
import type { SyncBatchContext } from '../SyncBatchContext';
import type { OutboxCommand, DeduplicationResult } from '../../../repositories/offline';
import type {
  SyncRunContext,
  PushReport,
  PullReport,
  ApplyReport,
  SyncReport,
  SyncOptions,
  PullChangeItem,
  ResolvedCommand,
} from './types';
export interface IPushEngine {
  push(ctx: SyncRunContext): Promise<PushReport>;
  resolveForeignKeys(command: OutboxCommand): Promise<ResolvedCommand>;
  getStats(): PushEngineStats;
}
export interface PushEngineStats {
  readonly totalCommandsPushed: number;
  readonly totalTombstonesPushed: number;
  readonly totalConflicts: number;
  readonly totalFailures: number;
  readonly lastPushTime: number | null;
}
export interface IPullEngine {
  pull(ctx: SyncRunContext): Promise<PullReport>;
  pullForEntityTypes(entityTypes: readonly EntityType[], ctx: SyncRunContext): Promise<PullReport>;
  getStats(): PullEngineStats;
}
export interface PullEngineStats {
  readonly totalChangesPulled: number;
  readonly totalIterations: number;
  readonly lastPullTime: number | null;
  readonly lastCursor: string | null;
}
export interface IApplyEngine {
  applyBatch(changes: readonly PullChangeItem[], ctx: SyncRunContext): Promise<ApplyReport>;
  applySingle(change: PullChangeItem, ctx: SyncRunContext): Promise<ApplyReport>;
}
export interface ISyncCoordinator {
  initialize(userId: string): Promise<void>;
  performFullSync(options?: SyncOptions): Promise<SyncReport>;
  getSyncState(): SyncCoordinatorState;
  isSyncing(): boolean;
  cleanup(): void;
  resetForUserChange(reason: string): Promise<void>;
  onNetworkReconnect(): void;
  onAppForeground(): void;
  onAppBackground(): void;
  startPeriodicSync(intervalMs?: number): void;
  stopPeriodicSync(): void;
}
export interface SyncCoordinatorState {
  readonly status: SyncCoordinatorStatus;
  readonly lastSyncTime: number | null;
  readonly pendingUploads: number;
  readonly isSyncing: boolean;
  readonly errorMessage: string | null;
}
export type SyncCoordinatorStatus =
  | 'idle'
  | 'syncing'
  | 'success'
  | 'error'
  | 'offline';
export interface CursorUpdateStats {
  readonly recordsSynced: number;
  readonly hasMore: boolean;
}
export interface OutboxPort {
  dequeueDeduplicatedByEntity(limit: number, userId: string): Promise<DeduplicationResult>;
  markSynced(outboxEventId: string): Promise<void>;
  markFailed(outboxEventId: string, errorMessage: string): Promise<void>;
  markDeadLetter(outboxEventId: string, errorMessage?: string): Promise<void>;
  markCompletedByIds(ids: string[]): Promise<void>;
  updateAggregateId(entityType: EntityType, oldId: string, newId: string, userId: string): Promise<void>;
  countPending(userId: string): Promise<number>;
  countActionable(userId: string): Promise<number>;
  updatePayloadAndVersion(outboxEventId: string, payload: Record<string, unknown>, version: number): Promise<void>;
  markRetryExhaustedAsDeadLetter(userId: string): Promise<number>;
  findEventIdByAggregateId(aggregateId: string, userId: string): Promise<string | null>;
}
export interface TombstonePort {
  getPendingTombstones(limit: number, userId: string): Promise<Array<{ id: string; entityType: EntityType; entityId: string }>>;
  getActionableTombstones(limit: number, userId: string): Promise<Array<{ id: string; entityType: EntityType; entityId: string }>>;
  markSynced(entityId: string): Promise<void>;
  markFailed(entityId: string, errorMessage: string): Promise<void>;
  countPending(userId: string): Promise<number>;
  countActionable(userId: string): Promise<number>;
}
export interface IdMapPort {
  getServerId(clientId: string): Promise<string | null>;
  getClientId(serverId: string): Promise<string | null>;
  saveMapping(entityType: EntityType, clientId: string, serverId: string): Promise<void>;
  saveBulkMappings(mappings: Array<{ entityType: EntityType; clientId: string; serverId: string }>): Promise<void>;
}
export interface CursorPort {
  getCursor(entityType: EntityType): Promise<string | null>;
  setCursor(entityType: EntityType, cursor: string | null, stats: CursorUpdateStats): Promise<void>;
  setMultipleCursors(updates: Array<{ entityType: EntityType; cursor: string | null; stats: CursorUpdateStats }>): Promise<void>;
  getAllCursors(): Promise<Map<EntityType, string>>;
}
export interface IPushEngineRepositories {
  readonly outbox: OutboxPort;
  readonly idMap: IdMapPort;
  readonly tombstone: TombstonePort;
}
export interface IPullEngineRepositories {
  readonly cursor: Pick<CursorPort, 'getCursor' | 'getAllCursors'>;
  readonly idMap: Pick<IdMapPort, 'getServerId' | 'getClientId'>;
}
export interface ISyncCoordinatorRepositories {
  readonly cursor: Pick<CursorPort, 'setCursor' | 'setMultipleCursors'>;
  readonly outbox: Pick<OutboxPort, 'countPending' | 'countActionable'>;
  readonly tombstone: Pick<TombstonePort, 'countPending' | 'countActionable'>;
}
