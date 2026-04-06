import type { EntityType } from '@shared/contracts';
import type {
  OutboxPort,
  TombstonePort,
  IdMapPort,
  CursorPort,
  CursorUpdateStats,
  IPushEngineRepositories,
  IPullEngineRepositories,
  ISyncCoordinatorRepositories,
} from '../interfaces';
import type { OutboxRepository, OutboxCommand, DeduplicationResult } from '../../../../repositories/offline/OutboxRepository';
import type { TombstoneRepository } from '../../../../repositories/offline/TombstoneRepository';
import type { IdMapRepository } from '../../../../repositories/offline/IdMapRepository';
import type { CursorRepository } from '../../../../repositories/offline/CursorRepository';
export interface RawRepositories {
  readonly outbox: OutboxRepository;
  readonly tombstone: TombstoneRepository;
  readonly idMap: IdMapRepository;
  readonly cursor: CursorRepository;
}
export interface AdaptedPorts {
  readonly outbox: OutboxPort;
  readonly tombstone: TombstonePort;
  readonly idMap: IdMapPort;
  readonly cursor: CursorPort;
}
function createOutboxPort(repo: OutboxRepository): OutboxPort {
  return {
    dequeueDeduplicatedByEntity: (limit: number, userId: string): Promise<DeduplicationResult> =>
      repo.dequeueDeduplicatedByEntity(limit, userId),
    markSynced: (outboxEventId: string): Promise<void> =>
      repo.markSynced(outboxEventId),
    markFailed: (outboxEventId: string, errorMessage: string): Promise<void> =>
      repo.markFailed(outboxEventId, errorMessage),
    markDeadLetter: (outboxEventId: string, errorMessage?: string): Promise<void> =>
      repo.markDeadLetter(outboxEventId, errorMessage),
    markCompletedByIds: (ids: string[]): Promise<void> =>
      repo.markCompletedByIds(ids),
    updateAggregateId: (
      entityType: EntityType,
      oldId: string,
      newId: string,
      userId: string
    ): Promise<void> => {
      if ('updateAggregateIdForEntity' in repo && typeof (repo as any).updateAggregateIdForEntity === 'function') {
        return (repo as any).updateAggregateIdForEntity(entityType, oldId, newId, userId);
      }
      return repo.updateAggregateId(oldId, newId, userId);
    },
    countPending: (userId: string): Promise<number> =>
      repo.getPendingCount(userId),
    countActionable: (userId: string): Promise<number> =>
      repo.countActionable(userId),
    updatePayloadAndVersion: (
      outboxEventId: string,
      payload: Record<string, unknown>,
      version: number
    ): Promise<void> =>
      repo.updatePayloadAndVersion(outboxEventId, payload, version),
    markRetryExhaustedAsDeadLetter: (userId: string): Promise<number> =>
      repo.markRetryExhaustedAsDeadLetter(userId),
    findEventIdByAggregateId: (aggregateId: string, userId: string): Promise<string | null> =>
      repo.findEventIdByAggregateId(aggregateId, userId),
  };
}
function createTombstonePort(repo: TombstoneRepository): TombstonePort {
  const mapToPortShape = (tombstones: Array<{ entityId: string; entityType: string }>) =>
    tombstones.map((t) => ({
      id: t.entityId,
      entityType: t.entityType as EntityType,
      entityId: t.entityId,
    }));
  return {
    getPendingTombstones: async (
      limit: number,
      userId: string
    ): Promise<Array<{ id: string; entityType: EntityType; entityId: string }>> => {
      const tombstones = await repo.getPendingTombstones(limit, userId);
      return mapToPortShape(tombstones);
    },
    getActionableTombstones: async (
      limit: number,
      userId: string
    ): Promise<Array<{ id: string; entityType: EntityType; entityId: string }>> => {
      const tombstones = await repo.getActionableTombstones(limit, userId);
      return mapToPortShape(tombstones);
    },
    markSynced: (entityId: string): Promise<void> =>
      repo.markSynced(entityId),
    markFailed: (entityId: string, errorMessage: string): Promise<void> =>
      repo.markFailed(entityId, errorMessage),
    countPending: (userId: string): Promise<number> =>
      repo.getPendingCount(userId),
    countActionable: (userId: string): Promise<number> =>
      repo.countActionable(userId),
  };
}
function createIdMapPort(repo: IdMapRepository): IdMapPort {
  return {
    getServerId: (clientId: string): Promise<string | null> =>
      repo.getServerId(clientId),
    getClientId: (serverId: string): Promise<string | null> =>
      repo.getClientId(serverId),
    saveMapping: (entityType: EntityType, clientId: string, serverId: string): Promise<void> =>
      repo.saveMapping(entityType, clientId, serverId),
    saveBulkMappings: (
      mappings: Array<{ entityType: EntityType; clientId: string; serverId: string }>
    ): Promise<void> => {
      const idMappings = mappings.map((m) => ({
        entity_type: m.entityType,
        client_id: m.clientId,
        server_id: m.serverId,
      }));
      return repo.saveBulkMappings(idMappings);
    },
  };
}
function createCursorPort(repo: CursorRepository): CursorPort {
  return {
    getCursor: (entityType: EntityType): Promise<string | null> =>
      repo.getCursor(entityType),
    setCursor: (
      entityType: EntityType,
      cursor: string | null,
      stats: CursorUpdateStats
    ): Promise<void> =>
      repo.setCursor(entityType, cursor, {
        records_synced: stats.recordsSynced,
        has_more: stats.hasMore,
      }),
    setMultipleCursors: async (
      updates: Array<{ entityType: EntityType; cursor: string | null; stats: CursorUpdateStats }>
    ): Promise<void> => {
      if (!('setMultipleCursors' in repo) || typeof (repo as any).setMultipleCursors !== 'function') {
        throw new Error(
          '[CursorPort] setMultipleCursors requires atomic batch update support. ' +
          'CursorRepository must implement setMultipleCursors() method. ' +
          'Falling back to sequential updates would risk partial cursor advancement.'
        );
      }
      const repoUpdates = updates.map((u) => ({
        entityType: u.entityType,
        cursor: u.cursor,
        stats: {
          records_synced: u.stats.recordsSynced,
          has_more: u.stats.hasMore,
        },
      }));
      return (repo as any).setMultipleCursors(repoUpdates);
    },
    getAllCursors: async (): Promise<Map<EntityType, string>> => {
      const cursors = await repo.getAllCursors();
      const cursorMap = new Map<EntityType, string>();
      for (const cursor of cursors) {
        if (cursor.cursorValue !== null) {
          cursorMap.set(cursor.entityType, cursor.cursorValue);
        }
      }
      return cursorMap;
    },
  };
}
export function createEnginePorts(repos: RawRepositories): AdaptedPorts {
  return {
    outbox: createOutboxPort(repos.outbox),
    tombstone: createTombstonePort(repos.tombstone),
    idMap: createIdMapPort(repos.idMap),
    cursor: createCursorPort(repos.cursor),
  };
}
export function createPushEnginePorts(repos: RawRepositories): IPushEngineRepositories {
  const ports = createEnginePorts(repos);
  return {
    outbox: ports.outbox,
    idMap: ports.idMap,
    tombstone: ports.tombstone,
  };
}
export function createPullEnginePorts(repos: RawRepositories): IPullEngineRepositories {
  const ports = createEnginePorts(repos);
  return {
    cursor: {
      getCursor: ports.cursor.getCursor,
      getAllCursors: ports.cursor.getAllCursors,
    },
    idMap: {
      getServerId: ports.idMap.getServerId,
      getClientId: ports.idMap.getClientId,
    },
  };
}
export function createSyncCoordinatorPorts(repos: RawRepositories): ISyncCoordinatorRepositories {
  const ports = createEnginePorts(repos);
  return {
    cursor: {
      setCursor: ports.cursor.setCursor,
      setMultipleCursors: ports.cursor.setMultipleCursors,
    },
    outbox: {
      countPending: ports.outbox.countPending,
      countActionable: ports.outbox.countActionable,
    },
    tombstone: {
      countPending: ports.tombstone.countPending,
      countActionable: ports.tombstone.countActionable,
    },
  };
}
