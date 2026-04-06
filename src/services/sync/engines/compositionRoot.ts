import type { SQLiteDatabase } from 'expo-sqlite';
import type { QueryClient } from '@tanstack/react-query';
import type { OutboxRepository } from '../../../repositories/offline/OutboxRepository';
import type { TombstoneRepository } from '../../../repositories/offline/TombstoneRepository';
import type { IdMapRepository } from '../../../repositories/offline/IdMapRepository';
import type { CursorRepository } from '../../../repositories/offline/CursorRepository';
import type { FrontendSyncHandlerRegistry } from '../handlers/FrontendSyncHandlerRegistry';
import type { BackendAPIClient } from '../../api/BackendAPIClient';
import { IntegrityGate } from '../IntegrityGate';
import { PushEngine } from './PushEngine';
import { PullEngine } from './PullEngine';
import { ApplyEngine } from './ApplyEngine';
import { SyncCoordinator } from './SyncCoordinator';
import {
  createEnginePorts,
  createPushEnginePorts,
  createPullEnginePorts,
  createSyncCoordinatorPorts,
  type RawRepositories,
} from './adapters';
import type {
  IPushEngine,
  IPullEngine,
  IApplyEngine,
  ISyncCoordinator,
} from './interfaces';
import { logger } from '../../../utils/logger';
export interface SyncEngineStackDependencies {
  readonly db: SQLiteDatabase;
  readonly apiClient: BackendAPIClient;
  readonly outboxRepo: OutboxRepository;
  readonly cursorRepo: CursorRepository;
  readonly idMapRepo: IdMapRepository;
  readonly tombstoneRepo: TombstoneRepository;
  readonly handlerRegistry: FrontendSyncHandlerRegistry;
  readonly queryClient?: QueryClient;
  readonly getCurrentUserId?: () => string | null;
}
export interface SyncEngineStack {
  readonly pushEngine: IPushEngine;
  readonly pullEngine: IPullEngine;
  readonly applyEngine: IApplyEngine;
  readonly coordinator: ISyncCoordinator;
  readonly integrityGate: IntegrityGate;
}
export function createSyncEngineStack(
  deps: SyncEngineStackDependencies,
): SyncEngineStack {
  logger.debug('[CompositionRoot] Creating sync engine stack');
  const rawRepositories: RawRepositories = {
    outbox: deps.outboxRepo,
    tombstone: deps.tombstoneRepo,
    idMap: deps.idMapRepo,
    cursor: deps.cursorRepo,
  };
  const ports = createEnginePorts(rawRepositories);
  if (!deps.db) {
    throw new Error('[CompositionRoot] Database not initialized');
  }
  const getDatabase = () => Promise.resolve(deps.db);
  const integrityGate = new IntegrityGate(getDatabase);
  const applyEngine = new ApplyEngine({
    db: deps.db,
    handlerRegistry: deps.handlerRegistry,
    idMap: ports.idMap,
  });
  const pushEngine = new PushEngine({
    repositories: createPushEnginePorts(rawRepositories),
    apiClient: deps.apiClient,
    handlerRegistry: deps.handlerRegistry,
    queryClient: deps.queryClient,
  });
  const pullEngine = new PullEngine({
    repositories: createPullEnginePorts(rawRepositories),
    apiClient: deps.apiClient,
    applyEngine,
  });
  const coordinator = new SyncCoordinator({
    pushEngine,
    pullEngine,
    repositories: createSyncCoordinatorPorts(rawRepositories),
    integrityGate,
    getCurrentUserId: deps.getCurrentUserId ?? (() => null),
  });
  logger.info('[CompositionRoot] Sync engine stack created successfully');
  return {
    pushEngine,
    pullEngine,
    applyEngine,
    coordinator,
    integrityGate,
  };
}
export interface TestSyncEngineStackOptions {
  pushEngine?: IPushEngine;
  pullEngine?: IPullEngine;
  applyEngine?: IApplyEngine;
  integrityGateResult?: 'ok' | 'violations' | 'failed';
}
export function createTestSyncEngineStack(
  deps: SyncEngineStackDependencies,
  overrides?: TestSyncEngineStackOptions,
): SyncEngineStack {
  const baseStack = createSyncEngineStack(deps);
  return {
    pushEngine: overrides?.pushEngine ?? baseStack.pushEngine,
    pullEngine: overrides?.pullEngine ?? baseStack.pullEngine,
    applyEngine: overrides?.applyEngine ?? baseStack.applyEngine,
    coordinator: baseStack.coordinator,
    integrityGate: baseStack.integrityGate,
  };
}
